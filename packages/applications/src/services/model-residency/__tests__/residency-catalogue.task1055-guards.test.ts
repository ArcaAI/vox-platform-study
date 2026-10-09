import { describe, expect, it } from 'vitest';
import { AUDIO_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/audio';
import { LLM_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/llm';
import { NLP_AI_MODELS } from '../../../../../database/src/prisma/db_main/seed/ai-models/nlp';
import { type CatalogueBuildInput, type CatalogueModelRow, type CatalogueResidentEntry, buildResidencyCatalogue } from '../residency-catalogue';

/**
 * TASK-1055 follow-up — Prompt Guard 2 and the judge models are managed from the console exactly like
 * every other model (load / unload / keep policy), and a model the platform cannot load from the
 * console says WHY on its row (`loadBlockedReason`, present only when there is one — additive).
 * Rows are the SEED rows.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const seed = (slug: string, o: Record<string, unknown> = {}): CatalogueModelRow => {
  const row = [...NLP_AI_MODELS, ...LLM_AI_MODELS, ...AUDIO_AI_MODELS].find((m) => m.slug === slug);
  if (!row) throw new Error(`seed row ${slug} missing`);
  return { ...(row as unknown as CatalogueModelRow), ...o };
};
const PG2 = seed('llama-prompt-guard-2-86m');
const QWEN = seed('qwen3guard-gen-0.6b');
const GRANITE = seed('granite-guardian-4.1-8b');
const MINICHECK = seed('minicheck-flan-t5-large');
const VAD = seed('silero-vad');

const usage = {
  get: () => ({
    agentCount: 0,
    tenantCount: 0,
    liveConsultation: false,
    uses: [],
    consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  }),
} as never;
const gpu = (id: string) => ({
  id,
  kind: 'gpu' as const,
  name: 'RTX',
  totalBytes: 16 * GiB,
  usedBytes: 4 * GiB,
  freeBytes: 12 * GiB,
  utilisationPercent: 1,
});

function input(o: Partial<CatalogueBuildInput> = {}): CatalogueBuildInput {
  return {
    now: Date.now(),
    mode: 'shadow',
    reportedAt: 't',
    freshness: { maxAgeSeconds: 1, staleServices: [], oldestReportAt: null } as never,
    headroomPercent: 15,
    devices: [gpu('gpu0'), gpu('gpu1')],
    staleServices: [],
    entries: [],
    failed: [],
    loading: [],
    catalogue: [PG2, QWEN, GRANITE, MINICHECK, VAD],
    modelById: () => undefined,
    usage,
    classify: () => ({ class: 'ON_DEMAND', classSource: 'default', policy: null }),
    observedBytes: () => undefined,
    observedLoadSeconds: () => null,
    recommendations: [],
    ...o,
  };
}
function entry(o: Partial<CatalogueResidentEntry>): CatalogueResidentEntry {
  return {
    service: 'nlp',
    instance: 'hope-nlp-0',
    modelRef: PG2.sourceUri,
    aiModelId: PG2.id,
    aiModelName: PG2.name,
    device: 'gpu0',
    state: 'loaded',
    bytes: 1100 * MiB,
    bytesSource: 'measured',
    inFlight: 0,
    requestsPerMin: null,
    p50LatencyMs: null,
    loadedAt: null,
    lastUsedAt: null,
    loadSeconds: 4,
    ttlSeconds: 900,
    adminPinned: false,
    ...o,
  };
}
const find = (r: ReturnType<typeof buildResidencyCatalogue>, id: string) => r.services.flatMap((s) => s.models).find((m) => m.aiModelId === id)!;

describe('Prompt Guard 2 and the judges are listed and managed like every other model', () => {
  it('not loaded: Prompt Guard 2 (nlp), Qwen3Guard and Granite Guardian (LM Studio) offer load + edit_policy, with no blocked reason', () => {
    const r = buildResidencyCatalogue(input());
    expect(r.services.find((s) => s.service === 'nlp')!.models.map((m) => m.aiModelId)).toContain(PG2.id);
    expect(r.services.find((s) => s.service === 'lm-studio')!.models.map((m) => m.aiModelId)).toEqual(expect.arrayContaining([QWEN.id, GRANITE.id]));
    for (const id of [PG2.id, QWEN.id, GRANITE.id]) {
      const m = find(r, id);
      expect(m.kind).toBe('resident');
      expect(m.actions).toEqual(['load', 'edit_policy']);
      expect(m).not.toHaveProperty('loadBlockedReason');
    }
  });

  it('loaded: Prompt Guard 2 offers unload + edit_policy and its keep policy / TTL is the classifier`s', () => {
    const r = buildResidencyCatalogue(
      input({
        entries: [entry({})],
        classify: (_s, _r, id) =>
          id === PG2.id
            ? { class: 'WARM', classSource: 'policy', policy: { id: 'p1', version: 2, idleTtlSeconds: 600 } }
            : { class: 'ON_DEMAND', classSource: 'default', policy: null },
      }),
    );
    const m = find(r, PG2.id);
    expect(m.status).toBe('loaded');
    expect(m.actions).toEqual(['unload', 'edit_policy']);
    expect(m.keepPolicy).toMatchObject({ kind: 'warm', policyId: 'p1', policyVersion: 2, idleTtlSeconds: 600 });
  });

  it('a pinned (always) judge on LM Studio offers unload + reload + edit_policy', () => {
    const r = buildResidencyCatalogue(
      input({
        entries: [entry({ service: 'lm-studio', modelRef: QWEN.wireModelId!, aiModelId: QWEN.id, aiModelName: QWEN.name, ttlSeconds: null })],
        classify: () => ({ class: 'PINNED', classSource: 'policy', policy: { id: 'p2', version: 1 } }),
      }),
    );
    const m = find(r, QWEN.id);
    expect(m.actions).toEqual(['unload', 'reload', 'edit_policy']);
    expect(m.keepPolicy.kind).toBe('always');
  });
});

describe('loadBlockedReason — why the console cannot load a model, stated on the row', () => {
  it('MiniCheck not published to the models bucket says so; once published it does not', () => {
    expect(find(buildResidencyCatalogue(input()), MINICHECK.id).loadBlockedReason).toMatch(/not published to the models bucket/);
    const published = { ...MINICHECK, bucketPrefix: 'nlp/minicheck', primaryObject: 'm.gguf' } as CatalogueModelRow;
    expect(find(buildResidencyCatalogue(input({ catalogue: [published] })), MINICHECK.id)).not.toHaveProperty('loadBlockedReason');
  });

  it('an stt stage model (Silero VAD) names the ASR-agent rule', () => {
    expect(find(buildResidencyCatalogue(input()), VAD.id).loadBlockedReason).toMatch(/speech-to-text agent/);
  });

  it('a resident model is never "blocked" (its action is unload)', () => {
    const r = buildResidencyCatalogue(
      input({ entries: [entry({ service: 'stt', modelRef: VAD.slug, aiModelId: VAD.id, aiModelName: VAD.name, instance: 'hope-stt-0' })] }),
    );
    expect(find(r, VAD.id)).not.toHaveProperty('loadBlockedReason');
  });
});
