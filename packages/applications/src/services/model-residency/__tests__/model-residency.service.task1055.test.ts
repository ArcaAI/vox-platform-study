import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpException, Logger } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectiveConfigService } from '../../effective-config/effective-config.service';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { ModelResidencyService } from '../model-residency.service';
import { ResidencyAgentError } from '../residency-agent.client';

/**
 * TASK-1055 lane G — the gateway residency controller:
 *  1. LM Studio is commanded through its residency agent (no REST, no in-memory pins, no DCGM delta);
 *  2. its `load_spec` is the model's resolved serving profile — the SAME resolution as the boot plan;
 *  3. device-aware admission: `device`, per-device candidates, the suggested device, the 409 bodies;
 *  4. makeDefault (OD-4); 5. live-path unload with a reason (OD-2); 6. honest per-device numbers and
 *  the measurement guard; 7. pin recommendations satisfied by the agent's own pin; 8. warn logging.
 * Numbers are `tests/contracts/model-residency-task1055.fixture.json` → `gateway`.
 */
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'));

const MiB = 1024 * 1024;
const CARD = 17_175_674_880; // 16 380 MiB: used + free + 380 reserved
const UUID0 = 'GPU-be50f6fc-59ec-9c5b-c925-c962344c734c';
const UUID1 = 'GPU-55c35bac-8291-a08a-2cb2-a43648336aa5';
const GLIGUARD = 'fastino/gliguard-LLMGuardrails-300M';
const NER = 'blaze999/Medical-NER';
const GEMMA = 'gemma-4-e2b-it-qat';
const GRANITE = 'granite-guardian-4.1-8b';
const ASR = 'arcaai-whisper-ml-en-ggml';

type Row = Record<string, unknown>;

function agentModel(overrides: Row = {}): Row {
  return {
    modelRef: ASR,
    aiModelId: null,
    cache: 'asr',
    state: 'loaded',
    device: 'cuda:0',
    bytes: 1_500 * MiB,
    bytesSource: 'measured',
    inFlight: 0,
    pinned: false,
    adminPinned: false,
    ttlSeconds: 900,
    loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 1_800_000).toISOString(),
    loadSeconds: 6.8,
    ...overrides,
  };
}

function lmsModel(overrides: Row = {}): Row {
  return agentModel({
    modelRef: GEMMA,
    engineKey: `${GEMMA}@q4_0`,
    instanceId: GEMMA,
    cache: 'llm',
    device: 'cuda:1',
    bytes: 4 * 1024 * MiB,
    bytesSource: 'measured',
    deviceBytes: { 'cuda:1': 4 * 1024 * MiB },
    inFlight: null,
    ttlSeconds: null,
    loadConfig: {
      contextLength: 65536,
      parallel: 10,
      flashAttention: true,
      kvCacheQuant: { k: 'f16', v: 'f16' },
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
    },
    ...overrides,
  });
}

function aiModel(overrides: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    servedBy: 'stt',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: 1_000,
    resourceStatus: 'ENABLED',
    name: 'model',
    format: 'GGUF',
    version: 3,
    metaData: {},
    ...overrides,
  };
}

const gpuDevices = () => [
  { id: 'cuda:0', kind: 'gpu', totalBytes: CARD, freeBytes: 0, index: 0, name: 'NVIDIA RTX 2000 Ada Generation', uuid: UUID0 },
  { id: 'cuda:1', kind: 'gpu', totalBytes: CARD, freeBytes: 0, index: 1, name: 'NVIDIA RTX 2000 Ada Generation', uuid: UUID1 },
];

function build(opts: { enforce?: boolean } = {}) {
  const state = {
    settings: { 'residency.enforce': opts.enforce ?? false } as Record<string, unknown>,
    // DCGM, in MiB (the exporter's unit). gpu0 holds the live path; gpu1 is nearly empty (fixture `gateway` numbers).
    freeMib: { '0': 1_843.2, '1': 13_830 } as Record<string, number>,
    usedMib: { '0': 14_156.8, '1': 2_170 } as Record<string, number>,
    dcgmUuid: { '0': UUID0, '1': UUID1 } as Record<string, string>,
    devices: { stt: gpuDevices(), nlp: gpuDevices(), 'lm-studio': gpuDevices() } as Record<string, Row[]>,
    models: { stt: [agentModel()], nlp: [], 'lm-studio': [lmsModel()] } as Record<string, Row[]>,
    reachable: { stt: true, nlp: true, 'lm-studio': true } as Record<string, boolean>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: ASR, sourceUri: 's3://asr', name: 'ArcaAI Whisper ml-en', servedBy: 'stt' }),
      aiModel({ id: 'model-gliguard', slug: 'gliguard', sourceUri: GLIGUARD, name: 'GLiGuard', servedBy: 'nlp', observedMemoryMb: 1_136 }),
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', servedBy: 'nlp', taskType: 'TOKEN_CLASSIFICATION' }),
      aiModel({
        id: 'model-gemma',
        slug: 'lms-gemma-4-e2b-it-qat',
        sourceUri: GEMMA,
        wireModelId: GEMMA,
        name: 'Gemma 4 E2B',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        observedMemoryMb: 4_096,
        metaData: {
          contextLength: 65536,
          serving: { contextLength: 65536, parallel: 10, gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] } },
        },
      }),
      aiModel({
        id: 'model-granite',
        slug: GRANITE,
        sourceUri: GRANITE,
        wireModelId: GRANITE,
        name: 'Granite Guardian',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        observedMemoryMb: 4_900,
        metaData: {
          serving: {
            contextLength: 16384,
            parallel: 10,
            flashAttention: true,
            gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] },
            kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
          },
        },
      }),
    ] as Row[],
    policies: [] as Row[],
    livePath: [] as Row[],
    usage: new Map<string, Row>(),
  };

  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? undefined : undefined)),
  };
  const eventEmitter = { emit: vi.fn() };
  const policies = { findAll: vi.fn(async () => state.policies), create: vi.fn(), updateWithVersion: vi.fn(), softDelete: vi.fn() };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => {
      const row = state.catalogue.find((m) => m.id === id);
      if (!row) throw new DataNotFoundException('aiModel', id);
      return { ...row };
    }),
    findBySlug: vi.fn(async (_t: string, slug: string) => state.catalogue.find((m) => m.slug === slug) ?? null),
    findByProviderAndSourceUri: vi.fn(
      async (_t: string, provider: string, sourceUri: string) =>
        state.catalogue.find((m) => m.provider === provider && m.sourceUri === sourceUri) ?? null,
    ),
    update: vi.fn(async (id: string, entity: Row) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity };
      return state.catalogue[index];
    }),
    updateWithVersion: vi.fn(async (id: string, entity: Row) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity, version: Number(entity.version ?? 0) + 1 };
      return state.catalogue[index];
    }),
  };
  // An agent reads the free memory of the PHYSICAL card it sees (matched here by uuid).
  const gpuOf = (uuid: unknown) => Object.keys(state.dcgmUuid).find((gpu) => state.dcgmUuid[gpu] === uuid);
  const agentDevices = (service: string) =>
    state.devices[service].map((d) => ({
      ...d,
      freeBytes: d.kind === 'gpu' ? Math.round((state.freeMib[gpuOf(d.uuid) ?? '0'] ?? 0) * MiB) : d.freeBytes,
    }));
  const agents = {
    report: vi.fn(async (service: string) => {
      if (!state.reachable[service]) throw Object.assign(new Error(`${service} down`), { code: 'SERVICE_UNREACHABLE' });
      return {
        service,
        instance: `hope-${service}-pod`,
        reportedAt: new Date().toISOString(),
        devices: agentDevices(service),
        models: state.models[service],
      };
    }),
    load: vi.fn(async (_service: string, request: { modelRef: string; device?: string }) => ({
      outcome: 'loaded',
      model: agentModel({ modelRef: request.modelRef, bytes: 1_100 * MiB, loadSeconds: 1.2, device: request.device ?? 'cuda:0' }),
    })),
    unload: vi.fn(async (_service: string, request: { modelRef: string }) => ({ outcome: 'unloaded', modelRef: request.modelRef })),
    setPolicy: vi.fn(async (_service: string, modelRef: string) => agentModel({ modelRef })),
  };
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: (gpu: string) => Record<string, string> = () => ({})) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra(gpu) }, value }));
      if (query.includes('FB_USED'))
        return perGpu(state.usedMib, (gpu) => ({ modelName: 'NVIDIA RTX 2000 Ada Generation', UUID: state.dcgmUuid[gpu] }));
      if (query.includes('FB_FREE')) return perGpu(state.freeMib);
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      return [];
    }),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (key in state.settings) return { key, value: state.settings[key], sourceScope: 'system' };
      if (key.startsWith('lmStudio.serving.')) return { key, value: HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, sourceScope: 'code-default' };
      return null;
    }),
  };
  const livePath = {
    read: vi.fn(async () => state.livePath),
    status: vi.fn(() => ({ at: Date.now(), error: null, liveAssignments: 0, consumers: 0 })),
  };
  const specs = { build: vi.fn(async (_service: string, modelRef: string) => ({ cache: 'nlp_gliner2_guard', model_path: `/models/${modelRef}` })) };
  const usage = { read: vi.fn(async () => ({ get: (id: string) => state.usage.get(id) })) };

  const service = new ModelResidencyService(
    policies as never,
    aiModels as never,
    agents as never,
    prometheus as never,
    effectiveSettings as never,
    livePath as never,
    specs as never,
    usage as never,
    eventEmitter as never,
    cls as never,
  );
  return { service, state, eventEmitter, aiModels, agents, policies, effectiveSettings };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException)) throw error;
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

const audits = (h: ReturnType<typeof build>) =>
  h.eventEmitter.emit.mock.calls.map(([, event]) => (event as { data?: Row }).data ?? {}).filter((d) => typeof d.action === 'string');

afterEach(() => vi.restoreAllMocks());

// ── 1. LM Studio through its residency agent ────────────────────────────────────

describe('1 — LM Studio is commanded through its residency agent', () => {
  it('observes LM Studio from the agent: the instance on GPU 1 by uuid, its measured bytes, pin and load config', async () => {
    const h = build();
    h.state.models['lm-studio'] = [lmsModel({ pinned: true, adminPinned: true })];

    const view = await h.service.getView();
    const gemma = view.models.find((m) => m.service === 'lm-studio');

    expect(h.agents.report).toHaveBeenCalledWith('lm-studio');
    expect(gemma).toMatchObject({
      modelRef: GEMMA,
      aiModelId: 'model-gemma',
      device: 'gpu1',
      bytes: 4 * 1024 * MiB,
      bytesSource: 'measured',
      adminPinned: true,
    });

    const catalogue = await h.service.getCatalogue();
    const row = catalogue.services.find((s) => s.service === 'lm-studio')!.models.find((m) => m.aiModelId === 'model-gemma')!;
    expect(row.residency).toMatchObject({
      device: 'gpu1',
      deviceBytes: [{ device: 'gpu1', bytes: 4 * 1024 * MiB }],
      loadConfig: { contextLength: 65536, parallel: 10, flashAttention: true, kvCacheQuantK: 'f16', kvCacheQuantV: 'f16', device: 'gpu1' },
    });
  });

  it('loads, unloads and pins LM Studio over the agent client', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];

    const accepted = await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
    await h.service.drain();
    expect(accepted.status).toBe(202);
    expect(h.agents.load).toHaveBeenCalledWith('lm-studio', expect.objectContaining({ modelRef: GEMMA, pin: false }));

    h.state.models['lm-studio'] = [lmsModel()];
    await h.service.pin({ service: 'lm-studio', modelRef: GEMMA, pinned: true });
    expect(h.agents.setPolicy).toHaveBeenCalledWith('lm-studio', GEMMA, { adminPinned: true });

    await h.service.unload({ service: 'lm-studio', modelRef: GEMMA, reason: 'test' });
    expect(h.agents.unload).toHaveBeenCalledWith('lm-studio', expect.objectContaining({ modelRef: GEMMA, reason: 'admin' }));
  });

  it('an unreachable LM Studio agent is a stale, unreachable service — and a load is 503 SERVICE_UNREACHABLE, never a REST fallback', async () => {
    const h = build();
    h.state.reachable['lm-studio'] = false;
    h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('SERVICE_UNREACHABLE', 'LMSTUDIO_AGENT_URL is not set', 0));

    const catalogue = await h.service.getCatalogue();
    expect(catalogue.services.find((s) => s.service === 'lm-studio')).toMatchObject({ reachable: false });

    await h.service.load({ service: 'lm-studio', modelRef: GEMMA, force: true, reason: 'test' });
    await h.service.drain();
    const failed = audits(h).find((a) => a.action === 'model-residency.load.failed');
    expect(failed).toMatchObject({ error: { code: 'SERVICE_UNREACHABLE' } });
  });
});

// ── 2. LM Studio load_spec = the boot plan's entry ───────────────────────────────

describe('2 — the LM Studio load_spec is the boot-plan resolution', () => {
  async function bootPlanEntry(h: ReturnType<typeof build>, slug: string) {
    const config = new EffectiveConfigService(
      h.effectiveSettings as never,
      { list: vi.fn(async () => []) } as never,
      undefined,
      undefined,
      h.aiModels as never,
    );
    h.state.settings['lmStudio.serving.preload'] = [slug];
    const plan = (await config.resolveForService('lmstudio')).lmStudioServing as { preload: Array<Record<string, unknown>> };
    delete h.state.settings['lmStudio.serving.preload'];
    return plan.preload[0];
  }

  it.each([
    [GEMMA, 'gemma-4-e2b-it-qat'],
    [GRANITE, GRANITE],
  ])('%s: identifier = wireModelId and every profile field equals the boot plan entry', async (modelRef, slug) => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.freeMib = { '0': 13_000, '1': 13_830 };
    const entry = await bootPlanEntry(h, slug);

    await h.service.load({ service: 'lm-studio', modelRef });
    await h.service.drain();

    const [, request] = h.agents.load.mock.calls[0] as unknown as [string, { modelRef: string; loadSpec: Record<string, unknown>; device?: string }];
    const split = entry.gpuSplit as { strategy: string; priority?: number[]; disabledGpus?: number[] } | null;
    expect(request.modelRef).toBe(modelRef);
    expect(request.device).toBeUndefined();
    expect(request.loadSpec).toEqual({
      identifier: modelRef,
      context_length: entry.contextLength,
      parallel: entry.parallel,
      flash_attention: entry.flashAttention,
      kv_cache_quant: entry.kvCacheQuant,
      gpu_split: split
        ? { strategy: split.strategy, priority: split.priority ?? [], disabled_gpus: split.disabledGpus ?? [], custom_ratio: [] }
        : { strategy: 'priorityOrder', priority: [entry.gpu], disabled_gpus: [0, 1].filter((i) => i !== entry.gpu), custom_ratio: [] },
      ttl_seconds: null,
    });
  });

  it('a model with no profile of its own gets the platform GPU (the boot loader`s `gpu: n` rule)', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.freeMib = { '0': 13_000, '1': 13_830 };
    h.state.catalogue.push(
      aiModel({
        id: 'model-e4b',
        slug: 'lms-gemma-4-e4b',
        sourceUri: 'gemma-4-e4b-it-qat',
        wireModelId: 'gemma-4-e4b-it-qat',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
      }),
    );
    const entry = await bootPlanEntry(h, 'lms-gemma-4-e4b');

    await h.service.load({ service: 'lm-studio', modelRef: 'gemma-4-e4b-it-qat' });
    await h.service.drain();

    const [, request] = h.agents.load.mock.calls[0] as unknown as [string, { loadSpec: Record<string, unknown> }];
    expect(entry.gpu).toBe(1);
    expect(request.loadSpec).toMatchObject({
      context_length: entry.contextLength,
      parallel: entry.parallel,
      gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
    });
  });

  it('request options override context length and flash attention; anything else is refused OPTIONS_UNSUPPORTED', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.freeMib = { '0': 13_000, '1': 13_830 };
    await h.service.load({ service: 'lm-studio', modelRef: GRANITE, options: { contextLength: 8192, flashAttention: false } });
    await h.service.drain();
    const [, request] = h.agents.load.mock.calls[0] as unknown as [string, { loadSpec: Record<string, unknown> }];
    expect(request.loadSpec).toMatchObject({ context_length: 8192, flash_attention: false, parallel: 10, kv_cache_quant: { k: 'q8_0', v: 'q8_0' } });

    const refused = await refusal(h.service.load({ service: 'lm-studio', modelRef: GRANITE, options: { evalBatchSize: 512 } }));
    expect(refused).toMatchObject({ status: 400, body: { code: 'OPTIONS_UNSUPPORTED' } });
  });

  it('an engine key that resolves to the row is loaded under its catalogue ref', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    await h.service.load({ service: 'lm-studio', modelRef: `${GEMMA}@q4_0` });
    await h.service.drain();
    expect(h.agents.load).toHaveBeenCalledWith(
      'lm-studio',
      expect.objectContaining({ modelRef: GEMMA, loadSpec: expect.objectContaining({ identifier: GEMMA }) }),
    );
  });
});

// ── 3. device-aware admission ────────────────────────────────────────────────────

describe('3 — device-aware admission, candidates and the suggested device', () => {
  it('preview: every GPU nlp reports, best first, with the fixture`s arithmetic and suggestion', async () => {
    const h = build();

    const preview = await h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0' });

    const expected = FIXTURE.gateway.loadPreviewResponseAdditions;
    expect(preview.candidates.map(({ livePathModels: _l, evictable: _e, ...c }) => c)).toEqual(
      expected.candidates.map(({ livePathModels: _l, evictable: _e, ...c }: Row) => c),
    );
    expect(preview.suggestedDevice).toBe('gpu1');
    expect(preview.suggestionReason).toBe(expected.suggestionReason);
    expect(preview).toMatchObject({ device: 'gpu0', needBytes: 1_191_182_336, fits: false, refusal: 'OVER_BUDGET', shortfallBytes: 1_834_798_285 });
  });

  it('suggestion tie-breaks: equal room → fewer live-path models → lower index; none fits → smallest shortfall', async () => {
    const even = () => {
      const h = build();
      h.state.freeMib = { '0': 13_830, '1': 13_830 };
      h.state.usedMib = { '0': 2_170, '1': 2_170 };
      return h;
    };
    const h1 = even();
    h1.state.models.stt = [];
    expect((await h1.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD })).suggestedDevice).toBe('gpu0');

    // Same room on both cards, but gpu0 holds a live-path model (an ASR the agent reports without a size).
    const h2 = even();
    h2.state.models.stt = [agentModel({ device: 'cuda:0', bytes: null, bytesSource: 'unknown' })];
    h2.state.livePath = [
      { service: 'stt', modelRef: ASR, aiModelId: 'model-asr', aiModelIds: ['model-asr'], tenantId: 't', agentSlug: 'a', role: 'primary' },
    ];
    const withLive = await h2.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });
    expect(withLive.candidates.map((c) => [c.device, c.livePathModels])).toEqual([
      ['gpu1', 0],
      ['gpu0', 1],
    ]);
    expect(withLive.suggestedDevice).toBe('gpu1');

    const h3 = build();
    h3.state.freeMib = { '0': 2_800, '1': 3_200 }; // headroom 2 457 MiB: neither holds 1 136 MiB
    h3.state.usedMib = { '0': 13_200, '1': 12_800 };
    const none = await h3.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });
    expect(none.candidates.every((c) => !c.fits)).toBe(true);
    expect(none.suggestedDevice).toBe('gpu1');
    expect(none.suggestionReason).toMatch(/^No device can hold it: GPU 1 is the closest/);
  });

  it('LM Studio candidates are every GPU plus `multi`; its default device is the profile`s card', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE });
    expect(preview.device).toBe('gpu0');
    expect(preview.candidates.map((c) => c.device).sort()).toEqual(['gpu0', 'gpu1', 'multi']);
  });

  it('load on an over-budget device is 409 OVER_BUDGET with the device, shortfall, suggestion and candidates', async () => {
    const h = build();
    const { status, body } = await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0' }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'OVER_BUDGET', device: 'gpu0', shortfallBytes: 1_834_798_285, suggestedDevice: 'gpu1' });
    expect((body.candidates as Row[]).map((c) => c.device)).toEqual(['gpu1', 'gpu0']);
    expect(String(body.message)).toContain('GPU 1');
    expect(h.agents.load).not.toHaveBeenCalled();
  });

  it('a forced load whose need exceeds the card`s FREE memory is 409 EXCEEDS_DEVICE even with force (OD-5)', async () => {
    const h = build();
    h.state.freeMib['0'] = 900; // < 1 136 MiB need
    const { status, body } = await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0', force: true, reason: 'please' }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'EXCEEDS_DEVICE', device: 'gpu0', suggestedDevice: 'gpu1' });
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(h.agents.load).not.toHaveBeenCalled();
  });

  it('a forced over-budget load that still fits in free memory proceeds (force + reason)', async () => {
    const h = build();
    const accepted = await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0', force: true, reason: 'tight but ok' });
    await h.service.drain();
    expect(accepted.status).toBe(202);
    expect(h.agents.load).toHaveBeenCalledWith('nlp', expect.objectContaining({ device: 'cuda:0' }));
  });

  it('an unknown device is 400 DEVICE_UNAVAILABLE', async () => {
    const h = build();
    const { status, body } = await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu2' }));
    expect(status).toBe(400);
    expect(body).toEqual({ code: 'DEVICE_UNAVAILABLE', message: 'nlp has no device gpu2', device: 'gpu2' });
    expect(await refusal(h.service.load({ service: 'lm-studio', modelRef: GEMMA, device: 'cpu' }))).toMatchObject({
      status: 400,
      body: { code: 'DEVICE_UNAVAILABLE' },
    });
    expect(await refusal(h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu7' }))).toMatchObject({ status: 400 });
  });

  it('gpu<N> maps to the agent device by UUID, not by index', async () => {
    const h = build();
    // The pod sees the cards in the opposite order: its cuda:0 is DCGM's gpu1.
    h.state.devices.nlp = [
      { ...gpuDevices()[0], uuid: UUID1 },
      { ...gpuDevices()[1], uuid: UUID0 },
    ];
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    await h.service.drain();
    expect(h.agents.load).toHaveBeenCalledWith('nlp', expect.objectContaining({ device: 'cuda:0' }));
  });

  it('the load gate claims ONLY the chosen card: a second load on the other card is admitted meanwhile', async () => {
    const h = build();
    let release!: () => void;
    h.agents.load.mockImplementationOnce(
      () =>
        new Promise((resolveLoad) => {
          release = () => resolveLoad({ outcome: 'loaded', model: agentModel({ modelRef: GLIGUARD, device: 'cuda:1' }) });
        }) as never,
    );
    h.state.freeMib['0'] = 13_000;
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    const busy = await refusal(h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1', force: true, reason: 'x' }));
    expect(busy.body).toMatchObject({ code: 'LOAD_IN_PROGRESS' });
    const other = await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu0' });
    expect(other.status).toBe(202);
    release();
    await h.service.drain();
  });

  it('without `device`, the model`s `_metadata.residency.defaultDevice` decides', async () => {
    const h = build();
    h.state.catalogue[1].metaData = { residency: { defaultDevice: 'gpu1' } };
    const preview = await h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });
    expect(preview).toMatchObject({ device: 'gpu1', fits: true });
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD });
    await h.service.drain();
    expect(h.agents.load).toHaveBeenCalledWith('nlp', expect.objectContaining({ device: 'cuda:1' }));
  });

  it('LM Studio on one card: the agent gets `cuda:<n>` and a single-card split; `multi` sends no device and an even split', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.freeMib = { '0': 13_000, '1': 13_830 };
    await h.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'gpu1' });
    await h.service.drain();
    expect(h.agents.load).toHaveBeenLastCalledWith(
      'lm-studio',
      expect.objectContaining({
        device: 'cuda:1',
        loadSpec: expect.objectContaining({ gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] } }),
      }),
    );

    const h2 = build();
    h2.state.models['lm-studio'] = [];
    h2.state.freeMib = { '0': 13_000, '1': 13_830 };
    await h2.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'multi' });
    await h2.service.drain();
    const [, request] = h2.agents.load.mock.calls[0] as unknown as [string, { device?: string; loadSpec: Row }];
    expect(request.device).toBeUndefined();
    expect(request.loadSpec.gpu_split).toEqual({ strategy: 'evenly', priority: [], disabled_gpus: [], custom_ratio: [] });
  });
});

// ── 4. makeDefault (OD-4) ────────────────────────────────────────────────────────

describe('4 — makeDefault', () => {
  it('writes `_metadata.residency.defaultDevice` with OCC, keeping the rest of `_metadata`', async () => {
    const h = build();
    h.state.catalogue[1].metaData = { residency: { runtimeKeys: ['x'] }, other: 1 };
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1', makeDefault: true });
    await h.service.drain();
    expect(h.aiModels.updateWithVersion).toHaveBeenCalledWith('model-gliguard', expect.anything(), 3);
    expect(h.state.catalogue[1].metaData).toEqual({ residency: { runtimeKeys: ['x'], defaultDevice: 'gpu1' }, other: 1 });
  });

  it('LM Studio also writes `_metadata.serving.gpuSplit` so the boot plan follows', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.freeMib = { '0': 13_000, '1': 13_830 };
    await h.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'gpu1', makeDefault: true });
    await h.service.drain();
    const meta = h.state.catalogue[4].metaData as { residency: Row; serving: Row };
    expect(meta.residency.defaultDevice).toBe('gpu1');
    expect(meta.serving).toMatchObject({ contextLength: 16384, gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] } });
  });

  it('requires `device`', async () => {
    const h = build();
    const { status, body } = await refusal(h.service.load({ service: 'nlp', modelRef: GLIGUARD, makeDefault: true }));
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'DEVICE_UNAVAILABLE' });
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();
  });
});

// ── 5. live-path unload (OD-2) ───────────────────────────────────────────────────

describe('5 — unloading a live-path model', () => {
  function livePathNer(h: ReturnType<typeof build>) {
    h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' })];
    h.state.livePath = [
      { service: 'nlp', modelRef: NER, aiModelId: 'model-ner', aiModelIds: ['model-ner'], tenantId: 't', agentSlug: 'ner', role: 'routing' },
    ];
    h.state.usage.set('model-ner', {
      agentCount: 10,
      tenantCount: 10,
      liveConsultation: true,
      uses: [],
      consumers: { agents: 10, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
    });
  }

  it('without a reason is 409 LIVE_PATH_REASON_REQUIRED naming its consumers in plain words', async () => {
    const h = build();
    livePathNer(h);
    const { status, body } = await refusal(h.service.unload({ service: 'nlp', modelRef: NER }));
    expect(status).toBe(409);
    expect(body).toEqual({
      code: 'LIVE_PATH_REASON_REQUIRED',
      message: 'Medical NER is on the live consultation path; give a reason to unload it',
      consumers: ['10 agents · 10 tenants (live consultations)'],
    });
    expect(h.agents.unload).not.toHaveBeenCalled();
  });

  it('with a reason it unloads, audits the reason, and never creates or changes a policy row', async () => {
    const h = build();
    livePathNer(h);
    const result = await h.service.unload({ service: 'nlp', modelRef: NER, reason: 'free GPU 1 for a test' });
    expect(result.outcome).toBe('unloaded');
    expect(audits(h).find((a) => a.action === 'model-residency.unload')).toMatchObject({ reason: 'free GPU 1 for a test', livePath: true });
    expect(h.policies.create).not.toHaveBeenCalled();
    expect(h.policies.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a PINNED policy row counts as live path too', async () => {
    const h = build();
    h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier' })];
    h.state.policies = [{ id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: 'PINNED', priority: 0, version: 1 }];
    expect(await refusal(h.service.unload({ service: 'nlp', modelRef: NER }))).toMatchObject({
      status: 409,
      body: { code: 'LIVE_PATH_REASON_REQUIRED' },
    });
  });

  it('`device` scopes the unload to that copy', async () => {
    const h = build();
    h.state.models.nlp = [
      agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:0' }),
      agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:1' }),
    ];
    await h.service.unload({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    expect(h.agents.unload).toHaveBeenCalledTimes(1);
    expect(h.agents.unload).toHaveBeenCalledWith('nlp', expect.objectContaining({ modelRef: GLIGUARD, device: 'cuda:1' }));
  });
});

// ── 6. honest numbers ────────────────────────────────────────────────────────────

describe('6 — honest numbers', () => {
  it('a split LM Studio model shows its MEASURED per-card bytes, not a used-ratio share', async () => {
    const h = build();
    h.state.models['lm-studio'] = [
      lmsModel({
        modelRef: GRANITE,
        instanceId: GRANITE,
        device: 'multi',
        bytes: 6_900 * MiB,
        deviceBytes: { 'cuda:0': 3_100 * MiB, 'cuda:1': 3_800 * MiB },
      }),
    ];
    const catalogue = await h.service.getCatalogue();
    const on = (id: string) => catalogue.devices.find((d) => d.id === id)!.models.find((m) => m.modelRef === GRANITE);
    expect(on('gpu0')).toMatchObject({ bytes: 3_100 * MiB, bytesSource: 'measured' });
    expect(on('gpu1')).toMatchObject({ bytes: 3_800 * MiB, bytesSource: 'measured' });
  });

  it('the preview`s unattributed bytes equal the catalogue`s for the same card (one formula)', async () => {
    const h = build();
    h.state.usedMib['1'] = 9_000;
    h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1', bytes: 400 * MiB })];
    const preview = await h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    const catalogue = await h.service.getCatalogue();
    expect(preview.unattributedBytes).toBe(catalogue.devices.find((d) => d.id === 'gpu1')!.unattributedBytes);
    expect(preview.unattributedBytes).toBe((9_000 - 400 - 4_096) * MiB);
  });

  it('a remeasure under 50 % of the stored value is not written (warned); a good one is', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = build();
    h.state.catalogue[1].observedMemoryMb = 947;
    h.agents.load.mockResolvedValueOnce({ outcome: 'loaded', model: agentModel({ modelRef: GLIGUARD, bytes: 376 * MiB, device: 'cuda:1' }) });
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    await h.service.drain();
    expect(h.aiModels.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'residency.observed.implausible', aiModelId: 'model-gliguard' }));

    h.agents.load.mockResolvedValueOnce({ outcome: 'loaded', model: agentModel({ modelRef: NER, bytes: 900 * MiB, device: 'cuda:1' }) });
    await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1' });
    await h.service.drain();
    expect(h.state.catalogue[2].observedMemoryMb).toBe(900);
  });

  it('an `estimated` size is never written back as a measurement', async () => {
    const h = build();
    h.agents.load.mockResolvedValueOnce({
      outcome: 'loaded',
      model: agentModel({ modelRef: NER, bytes: 900 * MiB, bytesSource: 'estimated', device: 'cuda:1' }),
    });
    await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1' });
    await h.service.drain();
    expect(h.aiModels.update).not.toHaveBeenCalled();
  });
});

// ── 7. pin recommendations ───────────────────────────────────────────────────────

describe('7 — pin recommendations', () => {
  const live = [{ service: 'stt', modelRef: ASR, aiModelId: 'model-asr', aiModelIds: ['model-asr'], tenantId: 't', agentSlug: 'a', role: 'primary' }];

  it('enforce: a live-path model the agent already reports pinned is not pinned again', async () => {
    const h = build({ enforce: true });
    h.state.livePath = live;
    h.state.models.stt = [agentModel({ pinned: true, adminPinned: false })];
    await h.service.tick();
    await h.service.tick();
    expect(h.agents.setPolicy).not.toHaveBeenCalled();
  });

  it('shadow: a standing pin row is withdrawn as soon as the agent reports the pin', async () => {
    const h = build();
    h.state.livePath = live;
    await h.service.tick();
    expect((await h.service.getView()).recommendations.filter((r) => r.action === 'pin')).toHaveLength(1);

    h.state.models.stt = [agentModel({ pinned: false, adminPinned: true })];
    await h.service.tick();
    expect((await h.service.getView()).recommendations.filter((r) => r.action === 'pin')).toEqual([]);
  });
});

// ── 8. failure reasons ───────────────────────────────────────────────────────────

describe('8 — failures carry the engine`s reason', () => {
  it('a failed load records the agent`s code and message on the operation and logs it at warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = build();
    h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('LOAD_FAILED', 'CUDA error: out of memory on cuda:1', 500));
    const accepted = await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    await h.service.drain();
    const op = await h.service.getOperation((accepted.body as { operationId: string }).operationId);
    expect(op).toMatchObject({ status: 'failed', error: { code: 'LOAD_FAILED', message: expect.stringContaining('CUDA error: out of memory') } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'residency.load.failed', code: 'LOAD_FAILED', service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' }),
    );
  });

  it('a failed unload is logged at warn with the agent`s reason', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = build();
    h.agents.unload.mockRejectedValueOnce(new ResidencyAgentError('AGENT_ERROR', 'shutdown raised', 500));
    await h.service.unload({ service: 'stt', modelRef: ASR }).catch(() => undefined);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'residency.unload.failed', code: 'AGENT_ERROR', reason: 'shutdown raised' }),
    );
  });
});
