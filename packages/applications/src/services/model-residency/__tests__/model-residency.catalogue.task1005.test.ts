import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { ModelResidencyClass, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { ModelUsageIndexReader } from '../model-usage-index';

/**
 * TASK-1005 §13 — `GET admin/model-residency/catalogue`: every SELF_HOSTED
 * catalogue model grouped by the workload that runs it, merged with live
 * residency, the reverse usage index, the plain-language keep policy, the
 * per-card model list and the plain-sentence suggestions. The response shape is
 * PINNED by `tests/contracts/model-residency-catalogue.fixture.json`.
 */

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-catalogue.fixture.json'), 'utf8'));
const RESPONSE = FIXTURE.response;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const T1 = '50000000-0000-0000-0000-000000000001';
const T2 = '50000000-0000-0000-0000-000000000000';
const LIVE_ASR = 'arcaai-whisper-ml-en-ggml';
const RADIOLOGY = 'arcaai-whisper-radiology-en-f16';
const NER = 'blaze999/Medical-NER';
const GEMMA = 'gemma-4-e2b-it-qat';

// ── a tiny Prisma-`where` evaluator, so the fakes answer only what the query ASKS for ─────────────

type Row = Record<string, unknown>;
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (condition as Row[]).every((w) => matches(row, w));
    const value = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const c = condition as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      return false;
    }
    return value === condition;
  });
}
const fakeRepo = (rows: () => Row[]) => ({
  findAll: vi.fn(async (props: { filters?: Row } = {}) => rows().filter((r) => matches(r, props.filters))),
});

function agentModel(overrides: Record<string, unknown> = {}) {
  return {
    modelRef: LIVE_ASR,
    aiModelId: null,
    cache: 'asr',
    state: 'loaded',
    device: 'cuda:0',
    bytes: 1.5 * GiB,
    bytesSource: 'measured',
    inFlight: 1,
    pinned: false,
    adminPinned: false,
    ttlSeconds: 900,
    loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 5_000).toISOString(),
    loadSeconds: 6.8,
    ...overrides,
  };
}

function aiModel(overrides: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    deploymentKind: 'SELF_HOSTED',
    resourceStatus: 'ENABLED',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: null,
    provider: 'built-in',
    wireModelId: null,
    format: 'WHISPER_CPP',
    ...overrides,
  };
}

function agent(overrides: Row): Row {
  return { isActive: true, status: 'PUBLISHED', resourceStatus: 'ENABLED', ...overrides };
}

function build() {
  const state = {
    roles: ['SUPER_ADMIN'] as string[],
    tenantId: undefined as string | undefined,
    sttModels: [agentModel()] as Row[],
    nlpModels: [] as Row[],
    lmsModels: [
      { modelRef: GEMMA, instanceId: GEMMA, cache: 'llm', state: 'loaded', device: 'multi', bytes: null, bytesSource: 'unknown', inFlight: null },
    ] as Row[],
    catalogue: [
      // A CLOUD row carrying the SAME wire id as the LM Studio key, listed FIRST: the lm-studio lookup must skip it.
      aiModel({
        id: 'model-cloud',
        slug: 'azure-gemma',
        name: 'Gemma (Azure)',
        servedBy: 'text',
        provider: 'azure',
        deploymentKind: 'CLOUD',
        wireModelId: GEMMA,
      }),
      aiModel({
        id: 'model-asr',
        slug: LIVE_ASR,
        sourceUri: 's3://hope-models/asr',
        name: 'ArcaAI Whisper ml-en',
        servedBy: 'stt',
        memorySizeMb: 1500,
      }),
      aiModel({
        id: 'model-rad',
        slug: RADIOLOGY,
        sourceUri: 's3://hope-models/rad',
        name: 'ArcaAI Whisper radiology',
        servedBy: 'stt',
        memorySizeMb: 1536,
      }),
      aiModel({ id: 'model-worker', slug: 'whisper-batch', sourceUri: 's3://hope-models/batch', name: 'Whisper batch', servedBy: 'stt-worker' }),
      aiModel({
        id: 'model-ner',
        slug: 'medical-ner',
        sourceUri: NER,
        name: 'Medical NER',
        servedBy: 'nlp',
        format: 'SAFETENSOR',
        observedMemoryMb: 700,
        observedLoadSeconds: 3.2,
      }),
      aiModel({
        id: 'model-gemma',
        slug: 'lms-gemma',
        sourceUri: 'lmstudio://gemma',
        name: 'Gemma 4 E2B',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        wireModelId: GEMMA,
        format: 'GGUF',
      }),
      aiModel({ id: 'model-tts', slug: 'kokoro', sourceUri: 's3://hope-models/kokoro', name: 'Kokoro', servedBy: 'tts' }),
      aiModel({ id: 'model-gone', slug: 'retired', sourceUri: 's3://x', name: 'Retired', servedBy: 'stt', resourceStatus: 'DELETED' }),
    ] as Row[],
    policies: [] as Row[],
    livePath: [{ service: 'stt', modelRef: LIVE_ASR, aiModelId: 'model-asr', tenantId: T1, agentSlug: 'realtime-transcription-ml-en' }] as Row[],
    liveAgents: new Set<string>([`${T1}|realtime-transcription-ml-en`]),
    agents: [
      agent({
        id: 'a1',
        tenantId: T1,
        slug: 'realtime-transcription-ml-en',
        name: 'Realtime transcription (ml-en)',
        task: 'SPEECH_TO_TEXT',
        modelId: 'model-asr',
      }),
      agent({ id: 'a2', tenantId: T2, slug: 'realtime-transcription', name: 'Realtime transcription', task: 'SPEECH_TO_TEXT', modelId: 'model-asr' }),
      agent({ id: 'a3', tenantId: T1, slug: 'radiology', name: 'Radiology transcription', task: 'SPEECH_TO_TEXT', modelId: 'model-cloud' }),
      // Not a consumer: a DRAFT and an inactive version naming the same model.
      agent({
        id: 'a4',
        tenantId: T2,
        slug: 'radiology-draft',
        name: 'Radiology draft',
        task: 'SPEECH_TO_TEXT',
        modelId: 'model-rad',
        status: 'DRAFT',
      }),
      agent({ id: 'a5', tenantId: T2, slug: 'radiology-old', name: 'Radiology v1', task: 'SPEECH_TO_TEXT', modelId: 'model-rad', isActive: false }),
    ] as Row[],
    fallbacks: [
      { id: 'f1', tenantId: T1, agentId: 'a3', priority: 1, modelId: 'model-rad', enabled: true, resourceStatus: 'ENABLED' },
      // The fallback of an unpublished draft is not a consumer either.
      { id: 'f2', tenantId: T2, agentId: 'a4', priority: 1, modelId: 'model-ner', enabled: true, resourceStatus: 'ENABLED' },
    ] as Row[],
    routing: [
      {
        id: 'r1',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'nlp.ner',
        displayName: 'Medical NER (platform)',
        modelId: 'model-ner',
        status: 'ACTIVE',
        enabled: true,
        killSwitch: false,
        resourceStatus: 'ENABLED',
      },
      {
        id: 'r2',
        tenantId: T1,
        taskKey: 'guardrail.safety',
        displayName: null,
        modelId: 'model-ner',
        status: 'DRAFT',
        enabled: true,
        killSwitch: false,
        resourceStatus: 'ENABLED',
      },
    ] as Row[],
    tenants: [
      { id: SYSTEM_TENANT_ID, name: 'System' },
      { id: T1, name: 'ArcaAI' },
      { id: T2, name: 'Global' },
    ] as Row[],
  };

  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: state.roles } : key === 'tenantId' ? state.tenantId : undefined)),
  };
  const eventEmitter = { emit: vi.fn() };
  const policies = { findAll: vi.fn(async () => state.policies) };
  const aiModels = {
    findAll: vi.fn(async (props: { filters?: Row } = {}) =>
      // The ledger's own catalogue lookup (an OR over refs) is answered with every row, as before; any other query is evaluated.
      props.filters && 'OR' in props.filters ? state.catalogue : state.catalogue.filter((r) => matches(r, props.filters)),
    ),
    findById: vi.fn(async (id: string) => ({ ...state.catalogue.find((m) => m.id === id) })),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const agentsClient = {
    report: vi.fn(async (service: 'stt' | 'nlp') => ({
      service,
      instance: `hope-${service}-pod`,
      reportedAt: new Date().toISOString(),
      devices:
        service === 'stt'
          ? [{ id: 'cuda:0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: 12_000 * MiB }]
          : [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 30 * GiB }],
      models: service === 'stt' ? state.sttModels : state.nlpModels,
    })),
  };
  const lmStudio = {
    report: vi.fn(async () => ({
      service: 'lm-studio',
      instance: 'hope-lmstudio:1234',
      reportedAt: new Date().toISOString(),
      devices: [],
      models: state.lmsModels,
    })),
  };
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: Record<string, string> = {}) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra }, value }));
      if (query.includes('FB_USED')) return perGpu({ '0': 4_000, '1': 2_000 }, { modelName: 'NVIDIA RTX 2000 Ada Generation' });
      if (query.includes('FB_FREE')) return perGpu({ '0': 12_000, '1': 14_000 });
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      if (query.includes('GPU_UTIL')) return perGpu({ '0': 1.5, '1': 0.3 });
      if (query.includes('_count')) return [{ metric: { job: 'stt', exported_service: 'stt', model: LIVE_ASR }, value: 4.2 }];
      if (query.includes('histogram_quantile')) return [{ metric: { job: 'stt', exported_service: 'stt', model: LIVE_ASR }, value: 0.31 }];
      return [];
    }),
  };
  const effectiveSettings = { resolveEffective: vi.fn(async () => null) };
  const livePath = { read: vi.fn(async () => state.livePath), readLiveAgents: vi.fn(async () => state.liveAgents) };
  const specs = { build: vi.fn() };
  const repos = {
    agents: fakeRepo(() => state.agents),
    fallbacks: fakeRepo(() => state.fallbacks),
    routing: fakeRepo(() => state.routing),
    tenants: fakeRepo(() => state.tenants),
  };
  const usage = new ModelUsageIndexReader(
    repos.agents as never,
    repos.fallbacks as never,
    repos.routing as never,
    repos.tenants as never,
    livePath as never,
  );

  const service = new ModelResidencyService(
    policies as never,
    aiModels as never,
    agentsClient as never,
    lmStudio as never,
    prometheus as never,
    effectiveSettings as never,
    livePath as never,
    specs as never,
    usage,
    eventEmitter as never,
    cls as never,
  );
  return { service, state, repos, aiModels, agentsClient };
}

const keys = (value: unknown) => Object.keys(value as object).sort();
type CatalogueModel = Awaited<ReturnType<ModelResidencyService['getCatalogue']>>['services'][number]['models'][number];
function modelById(view: Awaited<ReturnType<ModelResidencyService['getCatalogue']>>, id: string): CatalogueModel | undefined {
  return view.services.flatMap((s) => s.models).find((m) => m.aiModelId === id);
}

describe('GET admin/model-residency/catalogue (TASK-1005 §13)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('answers exactly the fixture key sets, at every level', async () => {
    h.state.policies = [
      { id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: ModelResidencyClass.ON_DEMAND, idleTtlSeconds: 60, priority: 0, version: 1 },
    ];
    h.state.nlpModels = [
      agentModel({
        modelRef: NER,
        cache: 'nlp_token_classifier',
        device: 'cpu',
        inFlight: 0,
        lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    ];
    await h.service.tick(); // shadow: records an idle_ttl_expired recommendation for the NER model

    const view = await h.service.getCatalogue();
    expect(keys(view)).toEqual(keys(RESPONSE));
    expect(keys(view.freshness)).toEqual(keys(RESPONSE.freshness));
    expect(keys(view.devices[0])).toEqual(keys(RESPONSE.devices[0]));
    expect(keys(view.devices[0].models[0])).toEqual(keys(RESPONSE.devices[0].models[0]));
    expect(keys(view.services[0])).toEqual(keys(RESPONSE.services[0]));

    const loaded = modelById(view, 'model-asr')!;
    const fx = RESPONSE.services[0].models[0];
    expect(keys(loaded)).toEqual(keys(fx));
    expect(keys(loaded.size)).toEqual(keys(fx.size));
    expect(keys(loaded.residency)).toEqual(keys(fx.residency));
    expect(keys(loaded.usage)).toEqual(keys(fx.usage));
    expect(keys(loaded.usage.uses[0])).toEqual(keys(fx.usage.uses[0]));
    expect(keys(loaded.keepPolicy)).toEqual(keys(fx.keepPolicy));

    expect(view.suggestions.length).toBeGreaterThan(0);
    expect(keys(view.suggestions[0])).toEqual(keys(RESPONSE.suggestions[0]));
    expect(view.mode).toBe('shadow');
  });

  it('every enum value it emits is one the fixture declares', async () => {
    const view = await h.service.getCatalogue();
    const enums = FIXTURE.enums;
    expect(view.services.map((s) => s.service)).toEqual(enums.service);
    for (const s of view.services) {
      expect(enums.runsOn).toContain(s.runsOn);
      for (const m of s.models) {
        expect(enums.status).toContain(m.status);
        expect(enums.sizeSource).toContain(m.size.source);
        expect(enums.keepPolicyKind).toContain(m.keepPolicy.kind);
        expect(enums.keepPolicySource).toContain(m.keepPolicy.source);
        for (const a of m.actions) expect(enums.action).toContain(a);
        for (const u of m.usage.uses) expect(enums.useRole).toContain(u.role);
      }
    }
  });

  it('lists a SELF_HOSTED model that is NOT resident, as not_loaded with its catalogue size and a Load action', async () => {
    const view = await h.service.getCatalogue();
    const rad = modelById(view, 'model-rad')!;
    expect(view.services.find((s) => s.service === 'stt')!.models.map((m) => m.aiModelId)).toContain('model-rad');
    expect(rad).toMatchObject({
      name: 'ArcaAI Whisper radiology',
      slug: RADIOLOGY,
      modelRef: RADIOLOGY,
      status: 'not_loaded',
      residency: null,
      size: { bytes: 1536 * MiB, source: 'catalogue' },
      loadSeconds: null,
      actions: ['load', 'edit_policy'],
      keepPolicy: { kind: 'on_demand', label: 'Load when needed', source: 'default', policyId: null },
    });
  });

  it('never lists a CLOUD model, a model no residency workload runs (tts), or a DELETED one', async () => {
    const view = await h.service.getCatalogue();
    const ids = view.services.flatMap((s) => s.models.map((m) => m.aiModelId));
    expect(ids).not.toContain('model-cloud');
    expect(ids).not.toContain('model-tts');
    expect(ids).not.toContain('model-gone');
    // The catalogue read is explicit: SYSTEM rows, SELF_HOSTED only.
    expect(h.aiModels.findAll).toHaveBeenCalledWith({
      filters: expect.objectContaining({ tenantId: SYSTEM_TENANT_ID, deploymentKind: 'SELF_HOSTED', resourceStatus: { not: 'DELETED' } }),
    });
  });

  it('merges live residency into the loaded row: measured size, placement, activity', async () => {
    const view = await h.service.getCatalogue();
    const asr = modelById(view, 'model-asr')!;
    expect(asr).toMatchObject({
      status: 'loaded',
      size: { bytes: 1.5 * GiB, source: 'measured' },
      loadSeconds: 6.8,
      residency: {
        device: 'gpu0',
        instance: 'hope-stt-pod',
        bytes: 1.5 * GiB,
        bytesSource: 'measured',
        inFlight: 1,
        requestsPerMin: 4.2,
        p50LatencyMs: 310,
      },
      actions: ['unload', 'edit_policy'],
    });
    expect(view.services.find((s) => s.service === 'stt')).toMatchObject({
      label: expect.any(String),
      runsOn: 'gpu',
      controllable: true,
      reachable: true,
      loadedCount: 1,
    });
  });

  it('prefers a MEASURED footprint (observedMemoryMb) over the catalogue estimate for a model that is not loaded', async () => {
    const view = await h.service.getCatalogue();
    expect(modelById(view, 'model-ner')).toMatchObject({ status: 'not_loaded', size: { bytes: 700 * MiB, source: 'measured' }, loadSeconds: 3.2 });
    expect(modelById(view, 'model-worker')).toMatchObject({ size: { bytes: null, source: 'unknown' } });
  });

  describe('usage — the reverse index across ALL tenants', () => {
    it('attributes primary vs fallback vs routing, per tenant, counting only ACTIVE PUBLISHED agents', async () => {
      const view = await h.service.getCatalogue();

      const asr = modelById(view, 'model-asr')!;
      expect(asr.usage).toMatchObject({ agentCount: 2, tenantCount: 2, liveConsultation: true });
      expect(asr.usage.uses).toEqual(
        expect.arrayContaining([
          {
            tenantId: T1,
            tenantName: 'ArcaAI',
            agentSlug: 'realtime-transcription-ml-en',
            agentName: 'Realtime transcription (ml-en)',
            task: 'SPEECH_TO_TEXT',
            role: 'primary',
            liveConsultation: true,
          },
          {
            tenantId: T2,
            tenantName: 'Global',
            agentSlug: 'realtime-transcription',
            agentName: 'Realtime transcription',
            task: 'SPEECH_TO_TEXT',
            role: 'primary',
            liveConsultation: false,
          },
        ]),
      );
      expect(asr.usage.uses).toHaveLength(2);

      // A fallback link of a published agent counts; the DRAFT and the inactive version do not.
      const rad = modelById(view, 'model-rad')!;
      expect(rad.usage).toEqual({
        agentCount: 1,
        tenantCount: 1,
        liveConsultation: false,
        uses: [
          {
            tenantId: T1,
            tenantName: 'ArcaAI',
            agentSlug: 'radiology',
            agentName: 'Radiology transcription',
            task: 'SPEECH_TO_TEXT',
            role: 'fallback',
            liveConsultation: false,
          },
        ],
      });

      // An ACTIVE routing policy counts (no agent behind it); a DRAFT one and a draft agent's fallback do not.
      const ner = modelById(view, 'model-ner')!;
      expect(ner.usage).toEqual({
        agentCount: 0,
        tenantCount: 1,
        liveConsultation: false,
        uses: [
          {
            tenantId: SYSTEM_TENANT_ID,
            tenantName: 'System',
            agentSlug: null,
            agentName: 'Medical NER (platform)',
            task: 'nlp.ner',
            role: 'routing',
            liveConsultation: false,
          },
        ],
      });

      expect(modelById(view, 'model-worker')!.usage).toEqual({ agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [] });
    });

    it('reads the index with explicit, bounded queries — never one per row', async () => {
      await h.service.getCatalogue();
      expect(h.repos.agents.findAll).toHaveBeenCalledTimes(1);
      expect(h.repos.fallbacks.findAll).toHaveBeenCalledTimes(1);
      expect(h.repos.routing.findAll).toHaveBeenCalledTimes(1);
      expect(h.repos.tenants.findAll).toHaveBeenCalledTimes(1);
      expect(h.repos.agents.findAll).toHaveBeenCalledWith({
        filters: expect.objectContaining({ isActive: true, status: 'PUBLISHED', resourceStatus: 'ENABLED' }),
      });
    });
  });

  describe('keepPolicy — in plain words', () => {
    it('an implicit live-path model is "Always loaded" because a live-consultation agent uses it', async () => {
      const view = await h.service.getCatalogue();
      expect(modelById(view, 'model-asr')!.keepPolicy).toEqual({
        kind: 'always',
        label: 'Always loaded',
        reason: 'Used by a live-consultation agent',
        source: 'implicit-live-path',
        policyId: null,
        policyVersion: null,
        idleTtlSeconds: null,
      });
    });

    it('a PINNED policy row is "Always loaded" with the policy id; a WARM row is "Keep warm"', async () => {
      h.state.policies = [
        { id: 'p-rad', aiModelId: 'model-rad', service: 'stt', class: ModelResidencyClass.PINNED, idleTtlSeconds: null, priority: 10, version: 3 },
        { id: 'p-ner', aiModelId: 'model-ner', service: 'nlp', class: ModelResidencyClass.WARM, idleTtlSeconds: 600, priority: 0, version: 1 },
      ];
      const view = await h.service.getCatalogue();
      expect(modelById(view, 'model-rad')!.keepPolicy).toMatchObject({
        kind: 'always',
        label: 'Always loaded',
        source: 'policy',
        policyId: 'p-rad',
        policyVersion: 3,
      });
      expect(modelById(view, 'model-ner')!.keepPolicy).toMatchObject({
        kind: 'warm',
        label: 'Keep warm',
        source: 'policy',
        policyId: 'p-ner',
        idleTtlSeconds: 600,
      });
      for (const m of [modelById(view, 'model-rad')!, modelById(view, 'model-ner')!]) expect(m.keepPolicy.reason).toMatch(/\S/);
    });
  });

  it('LM Studio: grouped under lm-studio (servedBy `lmstudio`), spans every card, and names itself on each GPU', async () => {
    const view = await h.service.getCatalogue();
    const lms = view.services.find((s) => s.service === 'lm-studio')!;
    expect(lms.models.map((m) => m.aiModelId)).toEqual(['model-gemma']);
    expect(lms.models[0]).toMatchObject({ status: 'loaded', modelRef: GEMMA, residency: { device: 'multi' } });
    expect(lms.models[0].actions).toContain('unload');

    expect(view.devices.map((d) => d.id)).toEqual(['gpu0', 'gpu1']);
    expect(view.devices[0]).toMatchObject({ kind: 'gpu', label: 'GPU 0 — NVIDIA RTX 2000 Ada Generation', headroomPercent: 15 });
    expect(view.devices[0].models).toEqual(
      expect.arrayContaining([
        { service: 'stt', modelRef: LIVE_ASR, name: 'ArcaAI Whisper ml-en', bytes: 1.5 * GiB },
        { service: 'lm-studio', modelRef: GEMMA, name: 'Gemma 4 E2B', bytes: null },
      ]),
    );
    expect(view.devices[1].models).toEqual([{ service: 'lm-studio', modelRef: GEMMA, name: 'Gemma 4 E2B', bytes: null }]);
  });

  it('stt-worker is observed, not commanded: listed, but offered no load/unload', async () => {
    const view = await h.service.getCatalogue();
    const worker = view.services.find((s) => s.service === 'stt-worker')!;
    expect(worker).toMatchObject({ controllable: false });
    expect(worker.models.map((m) => m.aiModelId)).toEqual(['model-worker']);
    expect(worker.models[0].actions).toEqual(['edit_policy']);
  });

  it('a resident model the catalogue does not know still shows (memory is in use), with no policy action', async () => {
    h.state.sttModels = [agentModel(), agentModel({ modelRef: 'hand-copied-whisper', bytes: 900 * MiB })];
    const view = await h.service.getCatalogue();
    const stray = view.services.find((s) => s.service === 'stt')!.models.find((m) => m.modelRef === 'hand-copied-whisper')!;
    expect(stray).toMatchObject({
      aiModelId: null,
      name: 'hand-copied-whisper',
      status: 'loaded',
      size: { bytes: 900 * MiB, source: 'measured' },
      actions: ['unload'],
    });
  });

  it('suggestions are one plain sentence each, naming the model', async () => {
    h.state.policies = [
      { id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: ModelResidencyClass.ON_DEMAND, idleTtlSeconds: 60, priority: 0, version: 1 },
    ];
    h.state.nlpModels = [
      agentModel({
        modelRef: NER,
        cache: 'nlp_token_classifier',
        device: 'cpu',
        inFlight: 0,
        lastUsedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      }),
    ];
    await h.service.tick();

    const view = await h.service.getCatalogue();
    const unload = view.suggestions.find((s) => s.modelRef === NER)!;
    expect(unload).toMatchObject({ action: 'unload', service: 'nlp', applied: false });
    expect(unload.text).toBe('Unload Medical NER on nlp — idle for 20 minutes and no live agent uses it.');
  });

  describe('platform-admin gate (403 before anything is read)', () => {
    it('403 for a tenant admin', async () => {
      h.state.roles = ['TENANT_ADMIN'];
      h.state.tenantId = T1;
      await expect(h.service.getCatalogue()).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.aiModels.findAll).not.toHaveBeenCalled();
      expect(h.repos.agents.findAll).not.toHaveBeenCalled();
    });

    it('403 for a super admin with a working tenant selected', async () => {
      h.state.tenantId = T1;
      await expect(h.service.getCatalogue()).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.agentsClient.report).not.toHaveBeenCalled();
    });
  });
});

describe('catalogue lookup — the LM Studio guard (TASK-1005 §13.1)', () => {
  it('maps an LM Studio key to the LM Studio row, never to a CLOUD row that shares its wire id', async () => {
    const h = build();
    const view = await h.service.getView();
    const lms = view.models.find((m) => m.service === 'lm-studio')!;
    expect(lms).toMatchObject({ modelRef: GEMMA, aiModelId: 'model-gemma', aiModelName: 'Gemma 4 E2B' });
  });

  it('leaves the key unmapped when only a non-LM-Studio row carries it', async () => {
    const h = build();
    h.state.catalogue = h.state.catalogue.filter((m) => m.id !== 'model-gemma');
    const view = await h.service.getView();
    expect(view.models.find((m) => m.service === 'lm-studio')).toMatchObject({ modelRef: GEMMA, aiModelId: null, aiModelName: null });
  });
});
