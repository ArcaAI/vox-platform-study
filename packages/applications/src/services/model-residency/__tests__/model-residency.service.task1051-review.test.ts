import { HttpException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { residencyAdmissionRejectionsTotal } from '../residency-metrics';

/**
 * TASK-1051 review (lane FB) — the verified findings on the residency controller:
 *  1/6 a reported key resolves to ONE row (exact ref → confirmed → unambiguous normalised), so a
 *      sibling variant is never loaded-over, unloaded or claimed; a confirmed key cannot be re-linked;
 *  2   classify matches every id the live path holds under a key;
 *  3   an unsized live-path model is rejected (metered `no_size`), and readiness names it;
 *  4   shadow records a pin until the RUNTIME holds the model pinned;
 *  5   the preview agrees with load(): clamped shortfall, in-progress / in-flight / busy gate;
 *  6   a replace that fails part-way restores what it unloaded, with its pin and TTL;
 *  8   readiness is computed, not asserted;
 *  9   a link is an OCC write merged into the latest `_metadata`; dismiss 404 carries a code.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const LIVE_ASR = 'arcaai-whisper-ml-en-ggml';
const RAD_ASR = 'radiology-asr-en';
const GEMMA = 'gemma-4-e2b-it-qat';
const GEMMA_Q8 = 'gemma-4-e2b-it-qat@q8_0';
const GEMMA_Q4 = 'gemma-4-e2b-it-qat@q4_0';

function agentModel(overrides: Record<string, unknown> = {}) {
  return {
    modelRef: LIVE_ASR,
    aiModelId: null,
    cache: 'asr',
    state: 'loaded',
    device: 'cuda:0',
    bytes: 1.5 * GiB,
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

function lmsInstance(key: string, overrides: Record<string, unknown> = {}) {
  return {
    modelRef: key,
    instanceId: key,
    cache: 'llm',
    state: 'loaded',
    device: 'multi',
    bytes: null,
    bytesSource: 'unknown',
    inFlight: null,
    ...overrides,
  };
}

function aiModel(overrides: Record<string, unknown>) {
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
    ...overrides,
  };
}

const gemmaRow = (over: Record<string, unknown> = {}) =>
  aiModel({
    id: 'model-gemma',
    slug: 'lms-gemma',
    sourceUri: 'x',
    wireModelId: GEMMA,
    name: 'Gemma 4 E2B',
    servedBy: 'lmstudio',
    provider: 'lm-studio',
    ...over,
  });
const gemmaQ8Row = () =>
  aiModel({
    id: 'model-gemma-q8',
    slug: 'lms-gemma-q8',
    sourceUri: 'x',
    wireModelId: GEMMA_Q8,
    name: 'Gemma Q8',
    servedBy: 'lmstudio',
    provider: 'lm-studio',
  });

function build(opts: { enforce?: boolean } = {}) {
  const state = {
    settings: { 'residency.enforce': opts.enforce ?? false } as Record<string, unknown>,
    sttModels: [agentModel()] as Record<string, unknown>[],
    lmsModels: [] as Record<string, unknown>[],
    freeMib: { '0': 12_000, '1': 15_998 } as Record<string, number>,
    usedMib: { '0': 4_000, '1': 2 } as Record<string, number>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: LIVE_ASR, sourceUri: 's3://asr', name: 'ArcaAI Whisper ml-en' }),
      aiModel({ id: 'model-rad', slug: RAD_ASR, sourceUri: 's3://rad', name: 'Radiology ASR' }),
      gemmaRow(),
    ] as Record<string, unknown>[],
    policies: [] as Record<string, unknown>[],
    livePath: [] as Record<string, unknown>[],
    liveStatus: { at: Date.now(), error: null as string | null, liveAssignments: 1, consumers: 1 },
  };

  const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : undefined)) };
  const eventEmitter = { emit: vi.fn() };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => {
      const row = state.catalogue.find((m) => m.id === id);
      if (!row) throw new DataNotFoundException('aiModel', id);
      return { ...row };
    }),
    // `writeObserved` (a measured footprint) still uses the plain update; a link must not.
    update: vi.fn(async (id: string, entity: Record<string, unknown>) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity };
      return state.catalogue[index];
    }),
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>, expectedVersion: number) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      if (state.catalogue[index].version !== expectedVersion)
        throw new OptimisticConcurrencyException('aiModel', id, { expectedVersion, currentVersion: state.catalogue[index].version as number });
      state.catalogue[index] = { ...entity, version: expectedVersion + 1 };
      return state.catalogue[index];
    }),
  };
  const agents = {
    report: vi.fn(async (service: 'stt' | 'nlp') => ({
      service,
      instance: `hope-${service}-pod`,
      reportedAt: new Date().toISOString(),
      devices:
        service === 'stt'
          ? [{ id: 'cuda:0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: state.freeMib['0'] * MiB }]
          : [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 30 * GiB }],
      models: service === 'stt' ? state.sttModels : [],
    })),
    load: vi.fn(async (_service: string, request: { modelRef: string }) => ({
      outcome: 'loaded',
      model: agentModel({ modelRef: request.modelRef, bytes: 1_000 * MiB, loadSeconds: 1.2 }),
    })),
    unload: vi.fn(async (_service: string, request: { modelRef: string }) => ({ outcome: 'unloaded', modelRef: request.modelRef })),
    setPolicy: vi.fn(async (_service: string, modelRef: string) => agentModel({ modelRef })),
  };
  const lmStudio = {
    report: vi.fn(async () => ({
      service: 'lm-studio',
      instance: 'hope-lmstudio:1234',
      reportedAt: new Date().toISOString(),
      devices: [],
      models: state.lmsModels,
    })),
    load: vi.fn(async (modelKey: string) => ({
      outcome: 'loaded',
      model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 12, cache: 'llm' },
    })),
    unload: vi.fn(async (instanceId: string) => ({ outcome: 'unloaded', instanceId })),
  };
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: Record<string, string> = {}) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra }, value }));
      if (query.includes('timestamp(')) return perGpu({ '0': Date.now() / 1000 + 60, '1': Date.now() / 1000 + 60 });
      if (query.includes('FB_USED')) return perGpu(state.usedMib, { modelName: 'NVIDIA RTX 2000 Ada Generation' });
      if (query.includes('FB_FREE')) return perGpu(state.freeMib);
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      return [];
    }),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => (key in state.settings ? { key, value: state.settings[key], sourceScope: 'system' } : null)),
  };
  const livePath = { read: vi.fn(async () => state.livePath), status: vi.fn(() => state.liveStatus) };
  const specs = { build: vi.fn(async () => ({ resolved_spec: {} })) };

  const service = new ModelResidencyService(
    { findAll: vi.fn(async () => state.policies) } as never,
    aiModels as never,
    agents as never,
    lmStudio as never,
    prometheus as never,
    effectiveSettings as never,
    livePath as never,
    specs as never,
    { read: vi.fn(async () => new Map()) } as never,
    eventEmitter as never,
    cls as never,
  );
  Object.assign(service, { measurementPollMs: 1, measurementMaxWaitMs: 20 });
  return { service, state, eventEmitter, aiModels, agents, lmStudio };
}

async function httpBody(promise: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  if (!(error instanceof HttpException)) throw error;
  return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
}

const live = (over: Record<string, unknown>) => ({ tenantId: SYSTEM_TENANT_ID, agentSlug: 'rt', role: 'primary', ...over });
const emittedActions = (h: ReturnType<typeof build>) =>
  h.eventEmitter.emit.mock.calls.map(([, payload]) => (payload as { data?: { action?: string } })?.data?.action).filter(Boolean) as string[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

// ── 1 / 6 — one ranked key → row resolution ─────────────────────────────────────

describe('finding 1/6 — a reported key resolves to ONE row; sibling variants are never swept', () => {
  it('loading `foo` while only `foo@q8_0` (its own row) is resident is NOT already_loaded', async () => {
    const h = build();
    h.state.catalogue.push(gemmaQ8Row());
    h.state.lmsModels = [lmsInstance(GEMMA_Q8)];
    const result = await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
    expect(result.status).toBe(202);
    await h.service.drain();
    expect(h.lmStudio.load).toHaveBeenCalledWith(GEMMA, {});
  });

  it('unloading `foo` unloads foo`s instance only, never the `foo@q8_0` row`s', async () => {
    const h = build();
    h.state.catalogue.push(gemmaQ8Row());
    h.state.lmsModels = [lmsInstance(GEMMA), lmsInstance(GEMMA_Q8)];
    await h.service.unload({ service: 'lm-studio', modelRef: GEMMA });
    expect(h.lmStudio.unload.mock.calls.map(([id]) => id)).toEqual([GEMMA]);
  });

  it('a normalised key two rows share is UNMATCHED in the view (no first-row-wins)', async () => {
    const h = build();
    h.state.catalogue.push(gemmaQ8Row());
    h.state.lmsModels = [lmsInstance(GEMMA_Q4)];
    expect((await h.service.getView()).models.find((m) => m.modelRef === GEMMA_Q4)).toMatchObject({ aiModelId: null });
  });

  it('linking a key already confirmed on another row is 409 RUNTIME_KEY_TAKEN; so is another row`s own catalogue ref', async () => {
    const h = build();
    h.state.catalogue.push({ ...gemmaQ8Row(), metaData: { residency: { runtimeKeys: ['custom-build'] } } });
    expect(await httpBody(h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'custom-build', aiModelId: 'model-gemma' }))).toMatchObject({
      status: 409,
      body: { code: 'RUNTIME_KEY_TAKEN' },
    });
    expect(await httpBody(h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: GEMMA_Q8, aiModelId: 'model-gemma' }))).toMatchObject({
      status: 409,
      body: { code: 'RUNTIME_KEY_TAKEN' },
    });
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();
  });
});

// ── 2 — classify uses the pin set's full membership ─────────────────────────────

describe('finding 2 — classify matches every id the live path holds under a key', () => {
  it('a resident row whose id is the SECOND id of a pin entry is PINNED', async () => {
    const h = build();
    h.state.lmsModels = [lmsInstance(GEMMA)];
    h.state.livePath = [live({ service: 'lm-studio', modelRef: GEMMA, aiModelId: 'model-other', aiModelIds: ['model-other', 'model-gemma'] })];
    expect((await h.service.getView()).models.find((m) => m.modelRef === GEMMA)).toMatchObject({
      aiModelId: 'model-gemma',
      class: 'PINNED',
      classSource: 'implicit-live-path',
    });
  });
});

// ── 3 — unknown size is never admitted at 0 bytes ───────────────────────────────

describe('finding 3 — an unsized live-path model', () => {
  it('shadow records admission_rejected metered `no_size`, never a load', async () => {
    const h = build();
    const inc = vi.spyOn(residencyAdmissionRejectionsTotal, 'inc');
    h.state.catalogue[1].memorySizeMb = null;
    h.state.livePath = [live({ service: 'stt', modelRef: RAD_ASR, aiModelId: 'model-rad', aiModelIds: ['model-rad'] })];
    await h.service.tick();
    const recs = (await h.service.getView()).recommendations.filter((r) => r.modelRef === RAD_ASR);
    expect(recs.map((r) => [r.action, r.reason])).toEqual([['load', 'admission_rejected']]);
    expect(inc).toHaveBeenCalledWith({ reason: 'no_size' });
  });

  it('readiness `unmeasured_budgeted` fails and names the model; passes once it has a size', async () => {
    const h = build();
    h.state.catalogue[1].memorySizeMb = null;
    h.state.livePath = [live({ service: 'stt', modelRef: RAD_ASR, aiModelId: 'model-rad', aiModelIds: ['model-rad'] })];
    const check = async () => (await h.service.getReadiness()).checks.find((c) => c.id === 'unmeasured_budgeted')!;
    expect(await check()).toMatchObject({ passed: false, detail: expect.stringContaining('Radiology ASR') });

    h.state.catalogue[1].memorySizeMb = 2_000;
    (h.service as unknown as { ledger: unknown }).ledger = null;
    expect((await check()).passed).toBe(true);
  });
});

// ── 4 — shadow records pins the runtime does not hold ───────────────────────────

describe('finding 4 — shadow pin recommendations', () => {
  it('records a pin of a live-path model the runtime does not hold pinned; none once the runtime holds it pinned', async () => {
    const h = build();
    h.state.livePath = [live({ service: 'stt', modelRef: LIVE_ASR, aiModelId: 'model-asr', aiModelIds: ['model-asr'] })];
    await h.service.tick();
    expect((await h.service.getView()).recommendations.filter((r) => r.action === 'pin').map((r) => r.modelRef)).toEqual([LIVE_ASR]);

    const p = build();
    p.state.sttModels = [agentModel({ pinned: true })];
    p.state.livePath = h.state.livePath;
    await p.service.tick();
    expect((await p.service.getView()).recommendations.filter((r) => r.action === 'pin')).toEqual([]);
  });
});

// ── 5 — the preview agrees with load() ──────────────────────────────────────────

describe('finding 5 — preview', () => {
  it('shortfall uses the same per-card clamped availability as `fits`', async () => {
    const h = build();
    // gpu0 below its headroom (usable 0), gpu1 usable 15 998 − 2 457 = 13 541 MiB; need 12 000 × 1.2 = 14 400 MiB.
    h.state.freeMib = { '0': 1_000, '1': 15_998 };
    h.state.usedMib = { '0': 15_000, '1': 2 }; // both cards total 16 380 MiB (used + free + 380 reserved)
    h.state.catalogue[2].memorySizeMb = 12_000;
    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GEMMA });
    expect(preview).toMatchObject({ fits: false, refusal: 'OVER_BUDGET' });
    const usable1 = 15_998 * MiB - 16_380 * MiB * 0.15;
    expect(preview.shortfallBytes).toBeCloseTo(Math.ceil(12_000 * MiB * 1.2) - usable1, -1);
  });

  it('does not fit while a load of the same model runs (load() answers LOAD_IN_PROGRESS)', async () => {
    const h = build();
    const pending = deferred<unknown>();
    h.lmStudio.load.mockImplementationOnce(() => pending.promise as never);
    await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
    // The DTO's `refusal` enum has no LOAD_IN_PROGRESS: the preview says it cannot be admitted through `fits`.
    expect(await h.service.previewLoad({ service: 'lm-studio', modelRef: GEMMA })).toMatchObject({ fits: false, refusal: null });
    expect(await httpBody(h.service.load({ service: 'lm-studio', modelRef: GEMMA }))).toMatchObject({ body: { code: 'LOAD_IN_PROGRESS' } });
    pending.resolve({ outcome: 'loaded', model: { modelRef: GEMMA, instanceId: GEMMA, loadSeconds: 1, cache: 'llm' } });
    await h.service.drain();
  });

  it('does not fit while another load holds the card (the busy gate)', async () => {
    const h = build();
    h.state.sttModels = [];
    const pending = deferred<unknown>();
    h.agents.load.mockImplementationOnce(() => pending.promise as never);
    await h.service.load({ service: 'stt', modelRef: LIVE_ASR });
    expect(await h.service.previewLoad({ service: 'stt', modelRef: RAD_ASR })).toMatchObject({ fits: false, refusal: null });
    expect(await httpBody(h.service.load({ service: 'stt', modelRef: RAD_ASR }))).toMatchObject({ body: { code: 'LOAD_IN_PROGRESS' } });
    pending.resolve({ outcome: 'loaded', model: agentModel() });
    await h.service.drain();
  });

  it('a replace of a model serving requests does not fit (load() answers IN_FLIGHT without force)', async () => {
    const h = build();
    h.state.sttModels = [agentModel({ inFlight: 2 })];
    expect(await h.service.previewLoad({ service: 'stt', modelRef: LIVE_ASR, replace: true })).toMatchObject({ fits: false, refusal: null });
    expect(await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR, replace: true }))).toMatchObject({ body: { code: 'IN_FLIGHT' } });
  });
});

// ── 6 — replace rollback ────────────────────────────────────────────────────────

describe('finding 6 — replace rollback', () => {
  it('an unload failing part-way restores the instances already unloaded, with their pin and TTL', async () => {
    const h = build();
    h.state.lmsModels = [lmsInstance(GEMMA_Q4), lmsInstance(`${GEMMA_Q4}:2`)];
    await h.service.pin({ service: 'lm-studio', modelRef: GEMMA, pinned: true, ttlSeconds: 600 });
    h.lmStudio.unload.mockImplementation(async (id: string) => {
      if (id === `${GEMMA_Q4}:2`) throw new Error('LM Studio refused');
      return { outcome: 'unloaded', instanceId: id };
    });

    const { body } = await h.service.load({ service: 'lm-studio', modelRef: GEMMA, replace: true, options: { contextLength: 32_768 } });
    await h.service.drain();

    expect(h.lmStudio.load.mock.calls).toEqual([[GEMMA_Q4, {}]]);
    const op = await h.service.getOperation(body.operationId!);
    expect(op.status).toBe('failed');
    expect(op.error?.message).toMatch(/restored/);

    h.state.lmsModels = [lmsInstance(GEMMA_Q4), lmsInstance(`${GEMMA_Q4}:2`)];
    (h.service as unknown as { ledger: unknown }).ledger = null;
    expect((await h.service.getView()).models.find((m) => m.modelRef === GEMMA_Q4)).toMatchObject({ adminPinned: true, ttlSeconds: 600 });
  });

  it('a failed replacement restores the previous agent instance with its pin and TTL', async () => {
    const h = build();
    h.state.sttModels = [agentModel({ adminPinned: true, pinned: true, ttlSeconds: 1_200 })];
    h.agents.load.mockRejectedValueOnce(new Error('CUDA out of memory'));
    await h.service.load({ service: 'stt', modelRef: LIVE_ASR, replace: true });
    await h.service.drain();
    expect(h.agents.load).toHaveBeenCalledTimes(2);
    expect(h.agents.load.mock.calls[1][1]).toMatchObject({ modelRef: LIVE_ASR, pin: true, ttlSeconds: 1_200 });
  });
});

// ── 8 — readiness honesty ───────────────────────────────────────────────────────

describe('finding 8 — readiness is computed', () => {
  const check = async (h: ReturnType<typeof build>, id: string) => (await h.service.getReadiness()).checks.find((c) => c.id === id)!;

  it('usage_complete fails when the consumer snapshot failed, or saw live assignments but no consumers', async () => {
    const h = build();
    expect((await check(h, 'usage_complete')).passed).toBe(true);
    h.state.liveStatus = { at: null as never, error: 'db down', liveAssignments: 0, consumers: 0 };
    expect(await check(h, 'usage_complete')).toMatchObject({ passed: false, detail: expect.stringContaining('db down') });
    h.state.liveStatus = { at: Date.now(), error: null, liveAssignments: 4, consumers: 0 };
    expect((await check(h, 'usage_complete')).passed).toBe(false);
  });

  it('shadow_days counts from process start, so a quiet fleet still accrues days', async () => {
    const h = build();
    Object.assign(h.service, { startedAt: Date.now() - 8 * 86_400_000 });
    expect(await check(h, 'shadow_days')).toMatchObject({ passed: true, detail: expect.stringContaining('8.0') });
  });

  it('actions_audited names every audit action — and every operator action emits one of them', async () => {
    const h = build();
    await h.service.pin({ service: 'stt', modelRef: LIVE_ASR, pinned: true });
    await h.service.pin({ service: 'stt', modelRef: LIVE_ASR, pinned: false });
    await h.service.unload({ service: 'stt', modelRef: LIVE_ASR });
    await h.service.load({ service: 'stt', modelRef: RAD_ASR });
    await h.service.drain();
    await h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'k', aiModelId: 'model-gemma' });
    const audited = await check(h, 'actions_audited');
    expect(audited.passed).toBe(true);
    for (const action of new Set(emittedActions(h))) expect(audited.detail).toContain(action);
    expect(emittedActions(h)).toEqual(expect.arrayContaining(['model-residency.link']));
  });
});

// ── 9 — link write safety, dismiss 404 ──────────────────────────────────────────

describe('finding 9 — link writes', () => {
  it('a link is a versioned write that merges into the LATEST _metadata, retrying once on drift', async () => {
    const h = build();
    h.state.catalogue[2].metaData = { residency: { runtimeKeys: ['old'] } };
    const realFindById = h.aiModels.findById.getMockImplementation()!;
    // Someone else writes the row between our read and our write.
    h.aiModels.findById.mockImplementationOnce(async (id: string) => {
      const read = await realFindById(id);
      h.state.catalogue[2] = { ...h.state.catalogue[2], metaData: { residency: { runtimeKeys: ['old'] }, serving: { vramGiB: 8 } }, version: 4 };
      return read;
    });

    const response = await h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'new', aiModelId: 'model-gemma' });
    expect(h.aiModels.updateWithVersion).toHaveBeenCalledTimes(2);
    expect(h.aiModels.update).not.toHaveBeenCalled();
    expect(h.state.catalogue[2]).toMatchObject({ version: 5, metaData: { serving: { vramGiB: 8 }, residency: { runtimeKeys: ['old', 'new'] } } });
    expect(response.runtimeKeys).toEqual([GEMMA, 'old', 'new']);
  });

  it('dismissing an unknown recommendation is 404 SUGGESTION_UNKNOWN', async () => {
    const h = build();
    expect(await httpBody(h.service.dismissSuggestion('nope'))).toMatchObject({ status: 404, body: { code: 'SUGGESTION_UNKNOWN' } });
  });
});
