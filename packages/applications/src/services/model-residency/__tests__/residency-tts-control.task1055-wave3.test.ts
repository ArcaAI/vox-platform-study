import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/audio';
import { TTS_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/tts';
import { CATALOGUE_SERVICES, RESIDENCY_CONTROLLED_SERVICES, residencyServiceOf } from '../model-residency.types';
import { ResidencyAgentClient } from '../residency-agent.client';
import { type CatalogueBuildInput, type CatalogueModelRow, type CatalogueResidentEntry, buildResidencyCatalogue } from '../residency-catalogue';

/**
 * TASK-1055 wave 3 (G3) — tts is under console control: a controlled service whose agent lives at
 * `TTS_URL`, a "Text-to-speech" catalogue section that runs on CPU and lists the self-hosted tts rows.
 * (G2) — an stt stage row (Silero VAD) offers Load with no blocked reason. Rows are the SEED rows.
 */

const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'));
const MiB = 1024 * 1024;

const seed = (slug: string, o: Record<string, unknown> = {}): CatalogueModelRow => {
  const row = [...TTS_AI_MODELS, ...AUDIO_AI_MODELS].find((m) => m.slug === slug);
  if (!row) throw new Error(`seed row ${slug} missing`);
  return { ...(row as unknown as CatalogueModelRow), ...o };
};
const KOKORO = seed('kokoro');
const PARLER = seed('indic-parler-tts');
const VAD = seed('silero-vad');
// A self-hosted row on a cloud engine still holds nothing.
const SARVAM_SELF = seed('sarvam-bulbul', { deploymentKind: 'SELF_HOSTED' });

const usage = {
  get: () => ({
    agentCount: 0,
    tenantCount: 0,
    liveConsultation: false,
    uses: [],
    consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  }),
} as never;

function input(o: Partial<CatalogueBuildInput> = {}): CatalogueBuildInput {
  return {
    now: Date.now(),
    mode: 'shadow',
    reportedAt: 't',
    freshness: { maxAgeSeconds: 1, staleServices: [], oldestReportAt: null } as never,
    headroomPercent: 15,
    devices: [],
    staleServices: [],
    entries: [],
    failed: [],
    loading: [],
    catalogue: [KOKORO, PARLER, SARVAM_SELF, VAD],
    modelById: () => undefined,
    usage,
    classify: () => ({ class: 'ON_DEMAND', classSource: 'default', policy: null }),
    observedBytes: () => undefined,
    observedLoadSeconds: () => null,
    recommendations: [],
    ...o,
  };
}

const kokoroEntry = {
  service: 'tts',
  instance: 'hope-tts-0',
  modelRef: KOKORO.slug,
  aiModelId: KOKORO.id,
  aiModelName: KOKORO.name,
  device: 'cpu',
  state: 'loaded',
  bytes: 330 * MiB,
  bytesSource: 'estimated',
  inFlight: 0,
  requestsPerMin: null,
  p50LatencyMs: null,
  loadedAt: null,
  lastUsedAt: null,
  loadSeconds: null,
  ttlSeconds: null,
  adminPinned: false,
} as unknown as CatalogueResidentEntry;

describe('tts is a controlled residency service (contract wave3.gateway)', () => {
  it('the controlled services are exactly the contract`s', () => {
    expect([...RESIDENCY_CONTROLLED_SERVICES]).toEqual(contract.wave3.gateway.controlledServices);
    expect(CATALOGUE_SERVICES).toContain('tts');
  });

  it('a tts-served row belongs to the tts service; the tts worker is still not governed', () => {
    expect(residencyServiceOf({ servedBy: 'tts', provider: 'built-in' })).toBe('tts');
    expect(residencyServiceOf({ servedBy: 'tts-worker' })).toBeNull();
  });
});

describe('the "Text-to-speech" catalogue section', () => {
  const ttsSection = (o: Partial<CatalogueBuildInput> = {}) => buildResidencyCatalogue(input(o)).services.find((s) => s.service === 'tts')!;

  it('runs on CPU, is controllable, and lists the self-hosted tts rows — a cloud engine as remote', () => {
    const section = ttsSection();
    expect(section).toMatchObject({ label: 'Text-to-speech', runsOn: 'cpu', controllable: true });
    const bySlug = Object.fromEntries(section.models.map((m) => [m.slug, m]));
    expect(Object.keys(bySlug).sort()).toEqual(['indic-parler-tts', 'kokoro', 'sarvam-bulbul']);
    expect(bySlug.kokoro).toMatchObject({ kind: 'resident', modelRef: 'kokoro', status: 'not_loaded' });
    expect(bySlug.kokoro.actions).toContain('load');
    expect(bySlug.kokoro).not.toHaveProperty('loadBlockedReason');
    expect(bySlug['sarvam-bulbul']).toMatchObject({ kind: 'remote', actions: [] });
  });

  it('a loaded Kokoro (device cpu) offers unload and keeps the section on CPU', () => {
    const section = ttsSection({ entries: [kokoroEntry] });
    const kokoro = section.models.find((m) => m.slug === 'kokoro')!;
    expect(kokoro.status).toBe('loaded');
    expect(kokoro.actions).toContain('unload');
    expect(section.runsOn).toBe('cpu');
  });
});

describe('stt stage rows load from the console (G2)', () => {
  it('Silero VAD offers load with no blocked reason', () => {
    const vad = buildResidencyCatalogue(input())
      .services.find((s) => s.service === 'stt')!
      .models.find((m) => m.slug === 'silero-vad')!;
    expect(vad.actions).toContain('load');
    expect(vad).not.toHaveProperty('loadBlockedReason');
  });
});

describe('ResidencyAgentClient — the tts agent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is reached at TTS_URL with the shared INTERNAL_ACCESS_TOKEN', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ service: 'tts', instance: 'hope-tts-0', reported_at: 't', devices: [], models: [] })));
    vi.stubGlobal('fetch', fetchMock);
    const config = { getConfigValue: vi.fn((key: string) => (key === 'TTS_URL' ? 'http://hope-tts:8865' : '')) };
    const secrets = {
      getSecretOptional: vi.fn(async (key: string) => (key === 'INTERNAL_ACCESS_TOKEN' ? 'svc-token' : key === 'NLP_SERVICE_TOKEN' ? 'nlp-token' : undefined)),
    };

    await new ResidencyAgentClient(config as never, secrets as never).report('tts');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://hope-tts:8865/internal/residency');
    expect(init.headers).toMatchObject({ 'X-Service-Token': 'svc-token' });
  });
});
