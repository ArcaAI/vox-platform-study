import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { ModelResidencyClass, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { register } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { routeLmStudioThroughAgent } from './lmstudio-agent-route';
import { ResidencyAgentError } from '../residency-agent.client';
import { RESIDENCY_DECISIONS_TOTAL } from '../residency-metrics';

/**
 * TASK-1005 §8.3 — the controller: shadow vs enforce, the one-load-per-GPU
 * gate, the operator surface (async load, replace, OVER_BUDGET, IN_FLIGHT),
 * the platform-admin gate, and the GET shape pinned by the admin fixture.
 */

const ADMIN_FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-admin.fixture.json'), 'utf8'));

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const LIVE_ASR = 'arcaai-whisper-ml-en-ggml';
const NER = 'blaze999/Medical-NER';
const GEMMA = 'gemma-4-e4b-it-qat@q4_0';

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

function aiModel(overrides: Record<string, unknown>) {
  // TASK-1051 F8: a catalogue size, so a never-measured model is admitted against size × 1.2 (no size at all is NO_SIZE).
  return {
    tenantId: SYSTEM_TENANT_ID,
    servedBy: 'stt',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: 1_000,
    name: 'model',
    ...overrides,
  };
}

function deferred<T>() {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolveFn = r));
  return { promise, resolve: resolveFn };
}

function build(opts: { enforce?: boolean } = {}) {
  const state = {
    roles: ['SUPER_ADMIN'] as string[],
    tenantId: undefined as string | undefined,
    settings: { 'residency.enforce': opts.enforce ?? false } as Record<string, unknown>,
    sttModels: [agentModel()] as Record<string, unknown>[],
    nlpModels: [] as Record<string, unknown>[],
    lmsModels: [] as Record<string, unknown>[],
    /** DCGM free MiB per card. */
    freeMib: { '0': 12_000, '1': 15_998 } as Record<string, number>,
    usedMib: { '0': 4_000, '1': 2 } as Record<string, number>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: LIVE_ASR, name: 'ArcaAI Whisper ml-en (GGML)', servedBy: 'stt' }),
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', servedBy: 'nlp' }),
      aiModel({ id: 'model-gemma', slug: 'gemma', wireModelId: GEMMA, name: 'Gemma 4 e4b', servedBy: 'text', provider: 'lm-studio' }),
    ] as Record<string, unknown>[],
    policies: [] as Record<string, unknown>[],
    livePath: [] as Record<string, unknown>[],
  };

  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: state.roles } : key === 'tenantId' ? state.tenantId : undefined)),
  };
  const eventEmitter = { emit: vi.fn() };

  const policies = {
    findAll: vi.fn(async () => state.policies),
    findById: vi.fn(async (id: string) => state.policies.find((p) => p.id === id)),
    findByModelAndService: vi.fn(async () => null),
    create: vi.fn(async (entity: unknown) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: Record<string, unknown>) => ({ ...entity, version: 2 })),
    softDelete: vi.fn(async (id: string) => state.policies.find((p) => p.id === id)),
  };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => ({ ...state.catalogue.find((m) => m.id === id) })),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
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
      models: service === 'stt' ? state.sttModels : state.nlpModels,
    })),
    load: vi.fn(async (_service: string, request: { modelRef: string }) => ({
      outcome: 'loaded',
      model: agentModel({ modelRef: request.modelRef, bytes: 1_000 * MiB, loadSeconds: 1.2 }),
    })),
    unload: vi.fn(async (_service: string, request: { modelRef: string }) => ({ outcome: 'unloaded', modelRef: request.modelRef })),
    setPolicy: vi.fn(async (_service: string, modelRef: string, request: { adminPinned?: boolean }) =>
      agentModel({ modelRef, adminPinned: request.adminPinned === true, pinned: request.adminPinned === true }),
    ),
  };
  const lmStudio = {
    report: vi.fn(async () => ({
      service: 'lm-studio',
      instance: 'hope-lmstudio:1234',
      reportedAt: new Date().toISOString(),
      devices: [],
      models: state.lmsModels,
    })),
    load: vi.fn(async (modelKey: string) => {
      // The engine now holds 2 GiB more on each card.
      state.usedMib['0'] += 2_048;
      state.usedMib['1'] += 2_048;
      return { outcome: 'loaded', model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 98.4, cache: 'llm' } };
    }),
    unload: vi.fn(async (instanceId: string) => ({ outcome: 'unloaded', instanceId })),
  };
  const prometheus = {
    isConfigured: () => true,
    instant: vi.fn(),
    range: vi.fn(),
    instantVector: vi.fn(async (query: string) => {
      const perGpu = (values: Record<string, number>, extra: Record<string, string> = {}) =>
        Object.entries(values).map(([gpu, value]) => ({ metric: { gpu, ...extra }, value }));
      if (query.includes('timestamp(')) return perGpu({ '0': Date.now() / 1000 + 60, '1': Date.now() / 1000 + 60 });
      if (query.includes('FB_USED')) return perGpu(state.usedMib, { modelName: 'NVIDIA RTX 2000 Ada Generation' });
      if (query.includes('FB_FREE')) return perGpu(state.freeMib);
      if (query.includes('FB_RESERVED')) return perGpu({ '0': 380, '1': 380 });
      if (query.includes('GPU_UTIL')) return perGpu({ '0': 1.5, '1': 0.3 });
      if (query.includes('model_running_instances')) return [];
      if (query.includes('_count')) return [{ metric: { job: 'stt', exported_service: 'stt', model: LIVE_ASR }, value: 4.2 }];
      if (query.includes('histogram_quantile')) return [{ metric: { job: 'stt', exported_service: 'stt', model: LIVE_ASR }, value: 0.31 }];
      return [];
    }),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => (key in state.settings ? { key, value: state.settings[key], sourceScope: 'system' } : null)),
  };
  const livePath = { read: vi.fn(async () => state.livePath) };
  const specs = { build: vi.fn(async () => ({ resolved_spec: { models: { asr: { slug: LIVE_ASR } } } })) };

  routeLmStudioThroughAgent(agents as never, lmStudio as never);
  const service = new ModelResidencyService(
    policies as never,
    aiModels as never,
    agents as never,
    prometheus as never,
    effectiveSettings as never,
    livePath as never,
    specs as never,
    { read: vi.fn(async () => new Map()) } as never,
    eventEmitter as never,
    cls as never,
  );
  // DCGM is scraped, not live; the test's fake stamps every sample in the future.
  Object.assign(service, { measurementPollMs: 1, measurementMaxWaitMs: 50 });

  return { service, state, cls, eventEmitter, policies, aiModels, agents, lmStudio, prometheus, livePath, specs };
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

async function decisionCount(labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(RESIDENCY_DECISIONS_TOTAL);
  const values = (await metric?.get())?.values ?? [];
  return values.filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value)).reduce((sum, v) => sum + v.value, 0);
}

describe('ModelResidencyService (TASK-1005)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  // ── GET shape ──────────────────────────────────────────────────────────────

  describe('GET — the admin fixture shape', () => {
    it('answers exactly the fixture key sets (top level, freshness, devices, models, recommendations)', async () => {
      h.state.policies = [
        { id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: ModelResidencyClass.ON_DEMAND, idleTtlSeconds: 60, priority: 0, version: 1 },
      ];
      h.state.nlpModels = [
        agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cpu', lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      ];
      await h.service.tick(); // shadow: produces a recommendation (idle_ttl_expired)

      const view = await h.service.getView();
      const fixture = ADMIN_FIXTURE.get.response;

      expect(Object.keys(view).sort()).toEqual(Object.keys(fixture).sort());
      expect(Object.keys(view.freshness).sort()).toEqual(Object.keys(fixture.freshness).sort());
      expect(Object.keys(view.devices[0]).sort()).toEqual(Object.keys(fixture.devices[0]).sort());
      expect(Object.keys(view.models[0]).sort()).toEqual(Object.keys(fixture.models[0]).sort());
      expect(view.recommendations.length).toBeGreaterThan(0);
      expect(Object.keys(view.recommendations[0]).sort()).toEqual(Object.keys(fixture.recommendations[0]).sort());
      expect(view.mode).toBe('shadow');
    });

    it("maps stt's own `cuda:0` to the physical card by free memory, and enriches rate and p50 from Prometheus", async () => {
      const view = await h.service.getView();
      const asr = view.models.find((m) => m.modelRef === LIVE_ASR)!;
      expect(asr).toMatchObject({
        service: 'stt',
        device: 'gpu0',
        aiModelId: 'model-asr',
        requestsPerMin: 4.2,
        p50LatencyMs: 310,
        bytesSource: 'measured',
      });
      expect(view.devices.map((d) => d.id)).toEqual(['gpu0', 'gpu1']);
      expect(view.devices[0]).toMatchObject({
        kind: 'gpu',
        usedBytes: 4_000 * MiB,
        freeBytes: 12_000 * MiB,
        totalBytes: 16_380 * MiB,
        headroomPercent: 15,
      });
    });

    it('labels an implicit live-path model PINNED (classSource implicit-live-path)', async () => {
      h.state.livePath = [
        { service: 'stt', modelRef: LIVE_ASR, aiModelId: 'model-asr', tenantId: SYSTEM_TENANT_ID, agentSlug: 'realtime-transcription' },
      ];
      const view = await h.service.getView();
      expect(view.models[0]).toMatchObject({ class: 'PINNED', classSource: 'implicit-live-path', pinned: true, policyId: null });
    });

    it('lists a service that did not answer as stale', async () => {
      h.agents.report.mockImplementation(async (service: string) => {
        throw new ResidencyAgentError('SERVICE_UNREACHABLE', `${service} down`, 0);
      });
      const view = await h.service.getView();
      expect(view.freshness.staleServices).toEqual(expect.arrayContaining(['stt', 'nlp']));
    });
  });

  // ── the admin gate ────────────────────────────────────────────────────────

  describe('platform-admin gate (403, row-independent, runs first)', () => {
    const calls: Array<[string, (s: ModelResidencyService) => Promise<unknown>]> = [
      ['getView', (s) => s.getView()],
      ['load', (s) => s.load({ service: 'stt', modelRef: LIVE_ASR })],
      ['unload', (s) => s.unload({ service: 'nlp', modelRef: NER })],
      ['pin', (s) => s.pin({ service: 'stt', modelRef: LIVE_ASR, pinned: true })],
      ['listPolicies', (s) => s.listPolicies()],
      ['getOperation', (s) => s.getOperation('nope')],
    ];

    for (const [name, call] of calls) {
      it(`${name}: 403 for a tenant admin`, async () => {
        h.state.roles = ['TENANT_ADMIN'];
        h.state.tenantId = 'aaaaaaaa-0000-0000-0000-000000000001';
        await expect(call(h.service)).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.agents.report).not.toHaveBeenCalled();
      });

      it(`${name}: 403 for a super admin WITH a working tenant selected`, async () => {
        h.state.tenantId = 'aaaaaaaa-0000-0000-0000-000000000001';
        await expect(call(h.service)).rejects.toBeInstanceOf(ForbiddenException);
      });
    }
  });

  // ── shadow vs enforce ─────────────────────────────────────────────────────

  describe('the decision loop', () => {
    function arrangeWork(state: ReturnType<typeof build>['state']) {
      // (1) an idle ON_DEMAND nlp model past its policy TTL → unload idle_ttl_expired
      state.policies = [
        { id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: ModelResidencyClass.ON_DEMAND, idleTtlSeconds: 60, priority: 0, version: 1 },
      ];
      state.nlpModels = [
        agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cpu', lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      ];
      // (2) a live-path LM Studio model that is not resident → load live_path_pin
      // (3) the live-path ASR is resident but not agent-pinned → pin live_path_pin
      state.livePath = [
        { service: 'lm-studio', modelRef: GEMMA, aiModelId: 'model-gemma', tenantId: SYSTEM_TENANT_ID, agentSlug: 'general-medicine-summarization' },
        { service: 'stt', modelRef: LIVE_ASR, aiModelId: 'model-asr', tenantId: SYSTEM_TENANT_ID, agentSlug: 'realtime-transcription' },
      ];
    }

    it('SHADOW mode sends NO command — it records and meters the recommendations only', async () => {
      arrangeWork(h.state);
      const before = await decisionCount({ mode: 'shadow' });

      await h.service.tick();
      await h.service.drain();

      expect(h.agents.load).not.toHaveBeenCalled();
      expect(h.agents.unload).not.toHaveBeenCalled();
      expect(h.agents.setPolicy).not.toHaveBeenCalled();
      expect(h.lmStudio.load).not.toHaveBeenCalled();
      expect(h.lmStudio.unload).not.toHaveBeenCalled();

      const view = await h.service.getView();
      // TASK-1051 review finding 4: classifying the live-path ASR PINNED is the reason to pin it, not proof the runtime
      // holds it pinned — the agent reports it unpinned, so shadow records "pin it" (as enforce would send it).
      expect(view.recommendations.map((r) => [r.action, r.modelRef, r.reason, r.mode, r.applied])).toEqual(
        expect.arrayContaining([
          ['unload', NER, 'idle_ttl_expired', 'shadow', false],
          ['load', GEMMA, 'live_path_pin', 'shadow', false],
          ['pin', LIVE_ASR, 'live_path_pin', 'shadow', false],
        ]),
      );
      expect(await decisionCount({ mode: 'shadow' })).toBe(before + 3);
    });

    it('a repeated shadow recommendation is not logged again every tick', async () => {
      arrangeWork(h.state);
      await h.service.tick();
      await h.service.tick();
      const view = await h.service.getView();
      expect(view.recommendations.filter((r) => r.modelRef === NER)).toHaveLength(1);
    });

    it('ENFORCE mode sends the commands (unload with reason policy, pin, and the load behind the gate)', async () => {
      h = build({ enforce: true });
      arrangeWork(h.state);

      await h.service.tick();
      await h.service.drain();

      expect(h.agents.unload).toHaveBeenCalledWith('nlp', { modelRef: NER, force: false, reason: 'policy' });
      expect(h.agents.setPolicy).toHaveBeenCalledWith('stt', LIVE_ASR, { adminPinned: true });
      // TASK-1055 — through the LM Studio agent, with the model's resolved serving profile as its load_spec.
      expect(h.lmStudio.load).toHaveBeenCalledWith(GEMMA, expect.objectContaining({ identifier: GEMMA }));
      const view = await h.service.getView();
      expect(view.mode).toBe('enforce');
      expect(view.recommendations.find((r) => r.modelRef === GEMMA)).toMatchObject({ mode: 'enforce', applied: true });
    });
  });

  // ── the one-load-per-physical-GPU gate ────────────────────────────────────

  // TASK-1055 — the gate claims the CHOSEN devices: a split (`multi`) LM Studio load holds both cards.
  it('an LM Studio load split across cards holds BOTH cards: an stt load is refused 409 LOAD_IN_PROGRESS until it settles', async () => {
    h.state.sttModels = [];
    const engine = deferred<unknown>();
    h.lmStudio.load.mockImplementationOnce(async (modelKey: string) => {
      await engine.promise;
      return { outcome: 'loaded', model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 98.4, cache: 'llm' } };
    });

    const lms = await h.service.load({ service: 'lm-studio', modelRef: GEMMA, device: 'multi' });
    expect(lms.status).toBe(202);

    const refused = await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'LOAD_IN_PROGRESS' } });

    engine.resolve(undefined);
    await h.service.drain();
    await expect(h.service.load({ service: 'stt', modelRef: LIVE_ASR })).resolves.toMatchObject({ status: 202 });
  });

  // ── operator load ─────────────────────────────────────────────────────────

  describe('operator load', () => {
    it('answers 202 + an operation that runs in the background and completes', async () => {
      h.state.sttModels = [];
      const result = await h.service.load({ service: 'stt', modelRef: LIVE_ASR, pin: true });

      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({ outcome: 'accepted', operationId: expect.any(String), model: { modelRef: LIVE_ASR, state: 'loading' } });
      expect(Object.keys(result.body.model).sort()).toEqual(Object.keys(ADMIN_FIXTURE.get.response.models[0]).sort());

      await h.service.drain();
      const op = await h.service.getOperation(result.body.operationId!);
      expect(op).toMatchObject({ action: 'load', service: 'stt', modelRef: LIVE_ASR, status: 'succeeded', error: null });
      expect(Object.keys(op).sort()).toEqual(Object.keys(ADMIN_FIXTURE.operation.response).sort());
      expect(h.agents.load).toHaveBeenCalledWith('stt', {
        modelRef: LIVE_ASR,
        loadSpec: { resolved_spec: { models: { asr: { slug: LIVE_ASR } } } },
        pin: true,
        ttlSeconds: null,
      });
      // The agent's measured footprint is written back to the catalogue (D-2).
      expect(h.aiModels.update).toHaveBeenCalledWith('model-asr', expect.objectContaining({ observedMemoryMb: 1_000, observedLoadSeconds: 1.2 }));
    });

    it('a failed load ends as a failed operation carrying the agent`s code', async () => {
      h.state.sttModels = [];
      h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('LOAD_FAILED', 'bad digest', 500));
      const { body } = await h.service.load({ service: 'stt', modelRef: LIVE_ASR });
      await h.service.drain();
      await expect(h.service.getOperation(body.operationId!)).resolves.toMatchObject({ status: 'failed', error: { code: 'LOAD_FAILED' } });
    });

    it('answers 200 `already_loaded` for a resident model and creates no operation', async () => {
      const result = await h.service.load({ service: 'stt', modelRef: LIVE_ASR });
      expect(result).toMatchObject({ status: 200, body: { outcome: 'already_loaded', model: { modelRef: LIVE_ASR, state: 'loaded' } } });
      expect(result.body.operationId).toBeUndefined();
      expect(h.agents.load).not.toHaveBeenCalled();
    });

    it('refuses LM Studio `options` on any other service (400 OPTIONS_UNSUPPORTED)', async () => {
      const refused = await httpBody(h.service.load({ service: 'nlp', modelRef: NER, options: { contextLength: 8192 } }));
      expect(refused).toMatchObject({ status: 400, body: { code: 'OPTIONS_UNSUPPORTED' } });
    });

    it('OVER_BUDGET (409) without force — and still without a non-empty reason — then admitted and audited with force + reason', async () => {
      h.state.sttModels = [];
      // 11 GiB measured footprint vs 12 000 MiB free − 15 % of 16 380 MiB headroom: over budget, but inside the card's
      // free memory (TASK-1055 OD-5 — a need beyond FREE memory is EXCEEDS_DEVICE, which no force lifts).
      h.state.catalogue[0].observedMemoryMb = 11 * 1024;

      expect(await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR }))).toMatchObject({ status: 409, body: { code: 'OVER_BUDGET' } });
      expect(await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR, force: true }))).toMatchObject({
        status: 409,
        body: { code: 'OVER_BUDGET' },
      });
      expect(await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR, force: true, reason: '   ' }))).toMatchObject({
        status: 409,
        body: { code: 'OVER_BUDGET' },
      });

      const forced = await h.service.load({ service: 'stt', modelRef: LIVE_ASR, force: true, reason: 'demo at 14:00 needs the large model' });
      expect(forced.status).toBe(202);
      expect(h.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceType: 'ModelResidencyPolicy',
          responsibleEntityId: 'admin-1',
          data: expect.objectContaining({
            action: 'model-residency.load',
            force: true,
            reason: 'demo at 14:00 needs the large model',
            overBudget: true,
          }),
        }),
      );
      await h.service.drain();
    });

    it('`replace` = unload THEN load, as one operation, with the LM Studio options', async () => {
      h.state.lmsModels = [
        { modelRef: GEMMA, instanceId: GEMMA, cache: 'llm', state: 'loaded', device: 'multi', bytes: null, bytesSource: 'unknown', inFlight: null },
      ];

      const result = await h.service.load({
        service: 'lm-studio',
        modelRef: GEMMA,
        replace: true,
        options: { contextLength: 8192, flashAttention: true, evalBatchSize: null },
      });
      expect(result.status).toBe(202);
      await h.service.drain();

      expect(h.lmStudio.unload).toHaveBeenCalledWith(GEMMA);
      expect(h.lmStudio.load).toHaveBeenCalledWith(GEMMA, expect.objectContaining({ context_length: 8192, flash_attention: true }));
      expect(h.lmStudio.unload.mock.invocationCallOrder[0]).toBeLessThan(h.lmStudio.load.mock.invocationCallOrder[0]);
      await expect(h.service.getOperation(result.body.operationId!)).resolves.toMatchObject({ action: 'replace', status: 'succeeded' });
    });

    it('`replace` of a model serving requests is 409 IN_FLIGHT unless forced', async () => {
      h.state.sttModels = [agentModel({ inFlight: 2 })];
      const refused = await httpBody(h.service.load({ service: 'stt', modelRef: LIVE_ASR, replace: true }));
      expect(refused).toMatchObject({ status: 409, body: { code: 'IN_FLIGHT', inFlight: 2 } });
    });

    // TASK-1055 — the DCGM-delta measurement is retired: the LM Studio agent measures its own load per card.
    it('writes back the footprint the LM Studio AGENT measured (D-2)', async () => {
      h.lmStudio.load.mockImplementationOnce(async (modelKey: string) => ({
        outcome: 'loaded',
        model: { modelRef: modelKey, instanceId: modelKey, loadSeconds: 98.4, cache: 'llm', bytes: 4_096 * 1024 * 1024, bytesSource: 'measured' },
      }));
      const result = await h.service.load({ service: 'lm-studio', modelRef: GEMMA });
      await h.service.drain();

      await expect(h.service.getOperation(result.body.operationId!)).resolves.toMatchObject({ status: 'succeeded' });
      expect(h.aiModels.update).toHaveBeenCalledWith('model-gemma', expect.objectContaining({ observedMemoryMb: 4_096, observedLoadSeconds: 98.4 }));
    });
  });

  // ── unload / pin ──────────────────────────────────────────────────────────

  it("unload maps the agent's IN_FLIGHT refusal to 409 with the in-flight count", async () => {
    h.agents.unload.mockRejectedValueOnce(new ResidencyAgentError('IN_FLIGHT', `${NER} is serving 2 request(s)`, 409, 2));
    const refused = await httpBody(h.service.unload({ service: 'nlp', modelRef: NER }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'IN_FLIGHT', inFlight: 2 } });
  });

  it('unload is audited and starts the reload cool-down', async () => {
    await expect(h.service.unload({ service: 'nlp', modelRef: NER, reason: 'free RAM' })).resolves.toEqual({
      outcome: 'unloaded',
      service: 'nlp',
      modelRef: NER,
    });
    expect(h.eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ data: expect.objectContaining({ action: 'model-residency.unload', reason: 'free RAM' }) }),
    );
  });

  it('pin goes through the agent policy verb and returns the fixture model shape', async () => {
    const { model } = await h.service.pin({ service: 'stt', modelRef: LIVE_ASR, pinned: true, ttlSeconds: null });
    expect(h.agents.setPolicy).toHaveBeenCalledWith('stt', LIVE_ASR, { adminPinned: true, ttlSeconds: null });
    expect(Object.keys(model).sort()).toEqual(Object.keys(ADMIN_FIXTURE.get.response.models[0]).sort());
  });

  // ── policies ──────────────────────────────────────────────────────────────

  describe('policies (SYSTEM rows, OCC)', () => {
    const row = () => ({
      id: 'p1',
      tenantId: SYSTEM_TENANT_ID,
      aiModelId: 'model-asr',
      service: 'stt',
      class: ModelResidencyClass.PINNED,
      idleTtlSeconds: null,
      priority: 100,
      maxInstances: 1,
      preferredDevice: 'gpu0',
      version: 1,
      updatedAt: new Date('2026-09-24T12:00:00Z'),
      updatedBy: '60000000-0000-0000-0000-000000000000',
      hasChanges: true,
      changes: { priority: 50 },
      validate: vi.fn(),
    });

    it('list answers the fixture item shape (plus `version`, the field the ETag interceptor reads)', async () => {
      h.state.policies = [row()];
      const [item] = await h.service.listPolicies();
      expect(Object.keys(item).sort()).toEqual([...Object.keys(ADMIN_FIXTURE.policies.item), 'version'].sort());
      expect(item).toMatchObject({ _version: 1, version: 1, class: 'PINNED', updatedAt: '2026-09-24T12:00:00.000Z' });
    });

    it('update is a compare-and-set on the expected version, and a drift propagates (412)', async () => {
      h.state.policies = [row()];
      await h.service.updatePolicy('p1', { priority: 50, expectedVersion: 1 });
      expect(h.policies.updateWithVersion).toHaveBeenCalledWith('p1', expect.anything(), 1);
      expect(h.eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'p1' }));

      h.policies.updateWithVersion.mockRejectedValueOnce(
        new OptimisticConcurrencyException('modelResidencyPolicy', 'p1', { expectedVersion: 1, currentVersion: 2 }),
      );
      await expect(h.service.updatePolicy('p1', { priority: 60, expectedVersion: 1 })).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    });

    it('update without an expected version is refused', async () => {
      h.state.policies = [row()];
      await expect(h.service.updatePolicy('p1', { priority: 50 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create refuses a second policy for the same (model, service) pair', async () => {
      h.policies.findByModelAndService.mockResolvedValueOnce(row());
      const refused = await httpBody(h.service.createPolicy({ aiModelId: 'model-asr', service: 'stt' }));
      expect(refused).toMatchObject({ status: 409, body: { code: 'POLICY_EXISTS' } });
    });

    it('delete is a soft delete, audited', async () => {
      h.state.policies = [row()];
      await h.service.deletePolicy('p1');
      expect(h.policies.softDelete).toHaveBeenCalledWith('p1', 'admin-1');
      expect(h.eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: 'p1' }));
    });
  });

  it('an unknown operation id is a 404', async () => {
    await expect(h.service.getOperation('nope')).rejects.toBeInstanceOf(HttpException);
    await expect(h.service.getOperation('nope')).rejects.not.toBeInstanceOf(ConflictException);
  });
});
