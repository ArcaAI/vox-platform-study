import { ForbiddenException, HttpException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { confirmationsStub } from './confirmations.stub';
import { routeLmStudioThroughAgent } from './lmstudio-agent-route';
import { READINESS_CHECK_IDS } from '../model-residency.types';

/**
 * TASK-1051 lane B1 — identity (F1), admission budget (F8), the dry-run load
 * preview, replace rollback (F9), the unload reason (F10), standing
 * recommendations + dismiss (F4), report-time freshness (F7), runtime-key links
 * and the enforce-readiness checklist.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const LIVE_ASR = 'arcaai-whisper-ml-en-ggml';
const RAD_ASR = 'radiology-asr-en';
const NER = 'blaze999/Medical-NER';
const GEMMA_WIRE = 'gemma-4-e2b-it-qat';
const GEMMA_INSTANCE = 'gemma-4-e2b-it-qat@q4_0';

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
    ...overrides,
  };
}

function build(opts: { enforce?: boolean } = {}) {
  const state = {
    roles: ['SUPER_ADMIN'] as string[],
    tenantId: undefined as string | undefined,
    settings: { 'residency.enforce': opts.enforce ?? false } as Record<string, unknown>,
    sttModels: [agentModel()] as Record<string, unknown>[],
    nlpModels: [] as Record<string, unknown>[],
    lmsModels: [] as Record<string, unknown>[],
    sttReportedAt: new Date().toISOString(),
    freeMib: { '0': 12_000, '1': 15_998 } as Record<string, number>,
    usedMib: { '0': 4_000, '1': 2 } as Record<string, number>,
    catalogue: [
      aiModel({ id: 'model-asr', slug: LIVE_ASR, sourceUri: 's3://asr', name: 'ArcaAI Whisper ml-en', servedBy: 'stt' }),
      aiModel({ id: 'model-rad', slug: RAD_ASR, sourceUri: 's3://rad', name: 'Radiology ASR', servedBy: 'stt' }),
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', servedBy: 'nlp' }),
      aiModel({
        id: 'model-gemma',
        slug: 'lms-gemma',
        sourceUri: 'lmstudio://gemma',
        wireModelId: GEMMA_WIRE,
        name: 'Gemma 4 E2B',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
      }),
    ] as Record<string, unknown>[],
    policies: [] as Record<string, unknown>[],
    livePath: [] as Record<string, unknown>[],
  };

  const cls = {
    get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: state.roles } : key === 'tenantId' ? state.tenantId : undefined)),
  };
  const eventEmitter = { emit: vi.fn() };
  const policies = { findAll: vi.fn(async () => state.policies) };
  const aiModels = {
    findAll: vi.fn(async () => state.catalogue),
    findById: vi.fn(async (id: string) => {
      const row = state.catalogue.find((m) => m.id === id);
      if (!row) throw new DataNotFoundException('aiModel', id);
      return { ...row };
    }),
    update: vi.fn(async (id: string, entity: Record<string, unknown>) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity };
      return state.catalogue[index];
    }),
    // TASK-1051 review finding 9 — a runtime-key link is a versioned write.
    updateWithVersion: vi.fn(async (id: string, entity: Record<string, unknown>) => {
      const index = state.catalogue.findIndex((m) => m.id === id);
      state.catalogue[index] = { ...entity };
      return state.catalogue[index];
    }),
  };
  const agents = {
    report: vi.fn(async (service: 'stt' | 'nlp') => ({
      service,
      instance: `hope-${service}-pod`,
      reportedAt: service === 'stt' ? state.sttReportedAt : new Date().toISOString(),
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
  const livePath = {
    read: vi.fn(async () => state.livePath),
    status: vi.fn(() => ({ at: Date.now(), error: null, liveAssignments: 0, consumers: 0 })),
  };
  const specs = { build: vi.fn(async () => ({ resolved_spec: {} })) };

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
    confirmationsStub(),
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

const internals = (service: ModelResidencyService) => service as unknown as Record<string, (...args: unknown[]) => unknown>;

describe('ModelResidencyService — TASK-1051 lane B1', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── F1 identity ─────────────────────────────────────────────────────────────

  describe('F1 — a reported engine key resolves to its catalogue row', () => {
    it('an LM Studio `key@q4_0` instance is the row whose wireModelId is the bare key', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      const view = await h.service.getView();
      expect(view.models.find((m) => m.service === 'lm-studio')).toMatchObject({
        modelRef: GEMMA_INSTANCE,
        aiModelId: 'model-gemma',
        aiModelName: 'Gemma 4 E2B',
      });
    });

    it('an operator-confirmed runtime key matches exactly', async () => {
      h.state.catalogue[3].metaData = { residency: { runtimeKeys: ['custom-gemma-build'] } };
      h.state.lmsModels = [lmsInstance('custom-gemma-build')];
      const view = await h.service.getView();
      expect(view.models.find((m) => m.service === 'lm-studio')?.aiModelId).toBe('model-gemma');
    });

    it('a live-path model resident under a suffixed key is NOT recommended for load again (shadow) and never loaded twice (enforce)', async () => {
      const livePath = [{ service: 'lm-studio', modelRef: GEMMA_WIRE, aiModelId: 'model-gemma', tenantId: SYSTEM_TENANT_ID, agentSlug: 'summary' }];
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      h.state.livePath = livePath;
      await h.service.tick();
      expect((await h.service.getView()).recommendations.filter((r) => r.action === 'load')).toEqual([]);

      const e = build({ enforce: true });
      e.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      e.state.livePath = livePath;
      await e.service.tick();
      await e.service.drain();
      expect(e.lmStudio.load).not.toHaveBeenCalled();
    });

    it('a load by catalogue ref of a model resident under a suffixed key answers 200 already_loaded', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      const result = await h.service.load({ service: 'lm-studio', modelRef: GEMMA_WIRE });
      expect(result).toMatchObject({ status: 200, body: { outcome: 'already_loaded', model: { modelRef: GEMMA_INSTANCE } } });
      expect(h.lmStudio.load).not.toHaveBeenCalled();
    });

    it('an unload by catalogue ref unloads the instance the engine reports', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      await expect(h.service.unload({ service: 'lm-studio', modelRef: GEMMA_WIRE })).resolves.toMatchObject({ outcome: 'unloaded' });
      expect(h.lmStudio.unload).toHaveBeenCalledWith(GEMMA_INSTANCE);
    });
  });

  describe('live path by catalogue identity (lane B3 contract)', () => {
    it('classifies by aiModelId when known: a live-path row pins its model under whatever key the service reports', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      h.state.livePath = [
        {
          service: 'lm-studio',
          modelRef: 'some-other-spelling',
          aiModelId: 'model-gemma',
          tenantId: SYSTEM_TENANT_ID,
          agentSlug: 'summary',
          role: 'primary',
        },
      ];
      const view = await h.service.getView();
      expect(view.models.find((m) => m.service === 'lm-studio')).toMatchObject({ class: 'PINNED', classSource: 'implicit-live-path' });
    });

    it('never recommends (or enforces) a load for a pipeline-stage-only pin; a resident stage model is still never idle-unloaded', async () => {
      const stage = {
        service: 'stt',
        modelRef: RAD_ASR,
        aiModelId: 'model-rad',
        tenantId: SYSTEM_TENANT_ID,
        agentSlug: 'realtime',
        role: 'pipeline_stage',
      };
      h.state.livePath = [stage];
      await h.service.tick();
      expect((await h.service.getView()).recommendations.filter((r) => r.action === 'load')).toEqual([]);

      const e = build({ enforce: true });
      e.state.sttModels = [];
      e.state.livePath = [stage];
      await e.service.tick();
      await e.service.drain();
      expect(e.agents.load).not.toHaveBeenCalled();

      const r = build();
      r.state.sttModels = [agentModel({ modelRef: RAD_ASR, lastUsedAt: new Date(Date.now() - 86_400_000).toISOString() })];
      r.state.policies = [];
      r.state.livePath = [stage];
      await r.service.tick();
      const view = await r.service.getView();
      expect(view.models.find((m) => m.modelRef === RAD_ASR)).toMatchObject({ class: 'PINNED' });
      expect(view.recommendations.filter((x) => x.action === 'unload')).toEqual([]);
    });
  });

  // ── F8 admission ────────────────────────────────────────────────────────────

  describe('F8 — never-measured models are budgeted at catalogue × 1.2', () => {
    it('refuses OVER_BUDGET when the catalogue estimate × 1.2 exceeds what is free, and reports that need', async () => {
      h.state.sttModels = [];
      // gpu0 usable = 12 000 − 15 % × 16 380 = 9 543 MiB; 8 000 MiB × 1.2 = 9 600 MiB does not fit, 8 000 alone would.
      h.state.catalogue[1].memorySizeMb = 8_000;
      const refused = await httpBody(h.service.load({ service: 'stt', modelRef: RAD_ASR }));
      expect(refused).toMatchObject({ status: 409, body: { code: 'OVER_BUDGET', needBytes: Math.ceil(8_000 * MiB * 1.2) } });
    });

    it('refuses NO_SIZE with neither a measurement nor a catalogue size, unless forced WITH a reason', async () => {
      h.state.sttModels = [];
      h.state.catalogue[1].memorySizeMb = null;
      expect(await httpBody(h.service.load({ service: 'stt', modelRef: RAD_ASR }))).toMatchObject({ status: 409, body: { code: 'NO_SIZE' } });
      expect(await httpBody(h.service.load({ service: 'stt', modelRef: RAD_ASR, force: true }))).toMatchObject({
        status: 409,
        body: { code: 'NO_SIZE' },
      });
      const forced = await h.service.load({ service: 'stt', modelRef: RAD_ASR, force: true, reason: 'size unknown, measuring it' });
      expect(forced.status).toBe(202);
      await h.service.drain();
    });
  });

  // ── preview ─────────────────────────────────────────────────────────────────

  describe('POST load/preview — the dry-run admission', () => {
    function arrangeTightCard() {
      h.state.sttModels = [agentModel()]; // ON_DEMAND, idle 30 min, 1.5 GiB on gpu0
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      h.state.livePath = [{ service: 'lm-studio', modelRef: GEMMA_WIRE, aiModelId: 'model-gemma', tenantId: SYSTEM_TENANT_ID, agentSlug: 'summary' }];
      h.state.catalogue[1].memorySizeMb = 8_000;
    }

    it('answers need, free, headroom, unattributed, shortfall, evictable and pinned — and changes nothing', async () => {
      arrangeTightCard();
      const preview = await h.service.previewLoad({ service: 'stt', modelRef: RAD_ASR });

      const need = Math.ceil(8_000 * MiB * 1.2);
      const free = 12_000 * MiB;
      const headroom = 16_380 * MiB * 0.15;
      expect(preview).toMatchObject({
        service: 'stt',
        modelRef: RAD_ASR,
        device: 'gpu0',
        needBytes: need,
        needSource: 'catalogue',
        freeBytes: free,
        refusal: 'OVER_BUDGET',
        fits: false,
      });
      expect(preview.headroomBytes).toBeCloseTo(headroom, -1);
      expect(preview.shortfallBytes).toBeCloseTo(need - (free - headroom), -1);
      // TASK-1055 — ONE unattributed formula with the catalogue (it also counts the split LM Studio instance's estimated share).
      expect(preview.unattributedBytes).toBe((await h.service.getCatalogue()).devices.find((d) => d.id === 'gpu0')!.unattributedBytes);
      expect(preview.evictable).toEqual([
        { service: 'stt', modelRef: LIVE_ASR, name: 'ArcaAI Whisper ml-en', bytes: 1.5 * GiB, reason: 'On demand · idle 30 min' },
      ]);
      expect(preview.pinned).toEqual([
        { service: 'lm-studio', modelRef: GEMMA_INSTANCE, name: 'Gemma 4 E2B', bytes: null, reason: 'Used by a live-consultation agent' },
      ]);

      expect(h.agents.load).not.toHaveBeenCalled();
      expect(h.agents.unload).not.toHaveBeenCalled();
      expect(h.eventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
      expect((await h.service.getView()).recommendations).toEqual([]);
    });

    it('agrees with load(): a fitting preview is admitted, ALREADY_LOADED and NO_SIZE are named', async () => {
      h.state.sttModels = [];
      const ok = await h.service.previewLoad({ service: 'stt', modelRef: RAD_ASR });
      expect(ok).toMatchObject({ fits: true, refusal: null, shortfallBytes: 0, needSource: 'catalogue' });
      await expect(h.service.load({ service: 'stt', modelRef: RAD_ASR })).resolves.toMatchObject({ status: 202 });
      await h.service.drain();

      h = build();
      expect(await h.service.previewLoad({ service: 'stt', modelRef: LIVE_ASR })).toMatchObject({ refusal: 'ALREADY_LOADED', fits: false });
      h.state.catalogue[1].memorySizeMb = null;
      expect(await h.service.previewLoad({ service: 'stt', modelRef: RAD_ASR })).toMatchObject({
        refusal: 'NO_SIZE',
        needBytes: null,
        needSource: 'unknown',
      });
    });
  });

  // ── F9 replace rollback ─────────────────────────────────────────────────────

  describe('F9 — a failed replace re-loads the previous instance', () => {
    it('restores the old instance and says so on the failed operation', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_WIRE)];
      h.lmStudio.load.mockRejectedValueOnce(new Error('CUDA out of memory'));
      const { body } = await h.service.load({ service: 'lm-studio', modelRef: GEMMA_WIRE, replace: true, options: { contextLength: 32_768 } });
      await h.service.drain();

      expect(h.lmStudio.load).toHaveBeenCalledTimes(2);
      // TASK-1055 — the profile load_spec: the request's override first, the plain profile on the restore.
      expect(h.lmStudio.load).toHaveBeenNthCalledWith(1, GEMMA_WIRE, expect.objectContaining({ context_length: 32_768 }));
      expect(h.lmStudio.load).toHaveBeenNthCalledWith(2, GEMMA_WIRE, expect.objectContaining({ context_length: 65_536 }));
      const op = await h.service.getOperation(body.operationId!);
      expect(op.status).toBe('failed');
      expect(op.error?.message).toMatch(/previous instance was restored/);
    });

    it('says when the old instance could NOT be restored', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_WIRE)];
      h.lmStudio.load.mockRejectedValueOnce(new Error('CUDA out of memory')).mockRejectedValueOnce(new Error('still out of memory'));
      const { body } = await h.service.load({ service: 'lm-studio', modelRef: GEMMA_WIRE, replace: true });
      await h.service.drain();
      const op = await h.service.getOperation(body.operationId!);
      expect(op.status).toBe('failed');
      expect(op.error?.message).toMatch(/NOT restored/);
    });
  });

  // ── F10 ─────────────────────────────────────────────────────────────────────

  it('F10 — a plain (unforced) unload audits its reason', async () => {
    await h.service.unload({ service: 'stt', modelRef: LIVE_ASR, reason: 'make room for radiology' });
    expect(h.eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({
        data: expect.objectContaining({ action: 'model-residency.unload', force: false, reason: 'make room for radiology' }),
      }),
    );
  });

  // ── F4 standing recommendations ─────────────────────────────────────────────

  describe('F4 — standing recommendations', () => {
    function arrangeIdleNer() {
      h.state.policies = [{ id: 'p1', aiModelId: 'model-ner', service: 'nlp', class: 'ON_DEMAND', idleTtlSeconds: 60, priority: 0, version: 1 }];
      h.state.nlpModels = [
        agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cpu', lastUsedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      ];
    }

    it('a repeat updates `at` and `repeats` and keeps `id` and `firstSeenAt`', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
      arrangeIdleNer();
      await h.service.tick();
      const [first] = (await h.service.getView()).recommendations;

      vi.setSystemTime(new Date('2026-10-07T10:00:10Z'));
      await h.service.tick();
      const rows = (await h.service.getView()).recommendations.filter((r) => r.modelRef === NER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.id, firstSeenAt: '2026-10-07T10:00:00.000Z', at: '2026-10-07T10:00:10.000Z', repeats: 2 });
    });

    it('a standing row not re-confirmed for 60 s is stale and omitted', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
      arrangeIdleNer();
      await h.service.tick();
      expect((await h.service.getView()).recommendations).toHaveLength(1);
      vi.setSystemTime(new Date('2026-10-07T10:01:01Z'));
      expect((await h.service.getView()).recommendations).toEqual([]);
    });

    // TASK-1051 review finding 4 changed this on purpose: classifying a model PINNED is the REASON for the pin, not
    // proof of it — a pin is satisfied (and not recommended) only once the runtime itself holds the model pinned.
    it('never recommends pinning a model the runtime already holds pinned', async () => {
      h.state.sttModels = [agentModel({ pinned: true })];
      h.state.livePath = [{ service: 'stt', modelRef: LIVE_ASR, aiModelId: 'model-asr', tenantId: SYSTEM_TENANT_ID, agentSlug: 'realtime' }];
      await h.service.tick();
      expect((await h.service.getView()).recommendations.filter((r) => r.action === 'pin')).toEqual([]);
    });

    it('dismiss: 404 for an unknown id; hidden until a DIFFERENT conclusion is recorded for the model', async () => {
      await expect(h.service.dismissSuggestion('nope')).rejects.toBeInstanceOf(HttpException);
      arrangeIdleNer();
      await h.service.tick();
      const [row] = (await h.service.getView()).recommendations;
      await expect(h.service.dismissSuggestion(row.id)).resolves.toEqual({ id: row.id, dismissed: true });

      await h.service.tick();
      expect((await h.service.getView()).recommendations).toEqual([]);
      expect((await h.service.getCatalogue()).suggestions).toEqual([]);

      // A different conclusion for the same model clears the dismissal… (TASK-1055: one the state does not already satisfy —
      // a `load` of a resident model is withdrawn at once.)
      internals(h.service).record(
        { action: 'unload', service: 'nlp', modelRef: NER, reason: 'make_room', devices: [], bytes: null },
        'shadow',
        false,
      );
      await h.service.tick();
      // …so the original conclusion is visible again.
      expect((await h.service.getView()).recommendations.map((r) => r.reason)).toEqual(
        expect.arrayContaining(['idle_ttl_expired', 'make_room']),
      );
    });

    it('counts a load recommended while the model sat resident under an unmatched key with a strong candidate', async () => {
      h.state.lmsModels = [lmsInstance(GEMMA_INSTANCE)];
      await h.service.getView();
      const ledger = (h.service as unknown as { ledger: { entries: Array<{ modelRef: string; aiModelId: string | null }> } }).ledger;
      ledger.entries.find((e) => e.modelRef === GEMMA_INSTANCE)!.aiModelId = null; // as it was before F1
      internals(h.service).record(
        { action: 'load', service: 'lm-studio', modelRef: GEMMA_WIRE, reason: 'live_path_pin', devices: [], bytes: null },
        'shadow',
        false,
        ledger,
      );
      expect((await h.service.getReadiness()).shadow).toMatchObject({ loads: 1, duplicateLoads: 1 });
    });
  });

  // ── F7 freshness ────────────────────────────────────────────────────────────

  it('F7 — freshness is measured from the OLDEST agent report time, in the view and the catalogue', async () => {
    h.state.sttReportedAt = new Date(Date.now() - 42_000).toISOString();
    const view = await h.service.getView();
    expect(view.freshness.oldestReportAt).toBe(h.state.sttReportedAt);
    expect(view.freshness.maxAgeSeconds).toBeGreaterThanOrEqual(42);
    expect((await h.service.getCatalogue()).freshness.oldestReportAt).toBe(h.state.sttReportedAt);
  });

  // ── links ───────────────────────────────────────────────────────────────────

  describe('POST links — confirm a runtime key', () => {
    it('404 for an unknown model; 400 when the row is not served by that service', async () => {
      expect(await httpBody(h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'x', aiModelId: 'nope' }))).toMatchObject({ status: 404 });
      expect(await httpBody(h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'x', aiModelId: 'model-asr' }))).toMatchObject({
        status: 400,
      });
    });

    it('appends the key (deduplicated, other metadata kept), audits it, and the next read matches the instance', async () => {
      h.state.catalogue[3].metaData = { serving: { vramGiB: 6 }, residency: { runtimeKeys: ['old-key'] } };
      h.state.lmsModels = [lmsInstance('weird-engine-name')];
      expect((await h.service.getView()).models.find((m) => m.service === 'lm-studio')?.aiModelId).toBeNull();

      const response = await h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'weird-engine-name', aiModelId: 'model-gemma' });
      await h.service.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'weird-engine-name', aiModelId: 'model-gemma' });

      expect(response).toEqual({ aiModelId: 'model-gemma', service: 'lm-studio', runtimeKeys: [GEMMA_WIRE, 'old-key', 'weird-engine-name'] });
      expect(h.state.catalogue[3].metaData).toEqual({ serving: { vramGiB: 6 }, residency: { runtimeKeys: ['old-key', 'weird-engine-name'] } });
      expect(h.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          data: expect.objectContaining({
            aiModelId: 'model-gemma',
            service: 'lm-studio',
            runtimeKey: 'weird-engine-name',
            surface: 'model-residency.link',
          }),
        }),
      );
      expect((await h.service.getView()).models.find((m) => m.service === 'lm-studio')?.aiModelId).toBe('model-gemma');
    });
  });

  // ── readiness ───────────────────────────────────────────────────────────────

  describe('GET readiness', () => {
    it('answers every check in order with evidence, and the shadow counts', async () => {
      h.state.lmsModels = [lmsInstance('mystery-model')];
      h.state.freeMib['0'] = 1_000; // below 15 % of the 16 380 MiB card
      h.state.usedMib['0'] = 15_000;
      const readiness = await h.service.getReadiness();

      expect(readiness.mode).toBe('shadow');
      expect(readiness.checks.map((c) => c.id)).toEqual([...READINESS_CHECK_IDS]);
      expect(readiness.total).toBe(8);
      expect(readiness.passed).toBe(readiness.checks.filter((c) => c.passed).length);
      const check = (id: string) => readiness.checks.find((c) => c.id === id)!;
      expect(check('shadow_review_recorded').passed).toBe(false);
      expect(check('instances_matched')).toMatchObject({ passed: false, detail: expect.stringContaining('mystery-model') });
      expect(check('gpus_inside_headroom')).toMatchObject({ passed: false, detail: expect.stringContaining('gpu0') });
      expect(check('shared_decision_state').passed).toBe(false);
      expect(check('shadow_days').passed).toBe(false);
      for (const id of ['usage_complete', 'unmeasured_budgeted', 'actions_audited'])
        expect(check(id)).toMatchObject({ passed: true, detail: expect.stringMatching(/\S/) });
      expect(readiness.shadow).toEqual({ since: expect.any(String), loads: 0, unloads: 0, refusedOverBudget: 0, duplicateLoads: 0 });
    });

    it('passes the review check once `residency.shadowReviewedAt` is set', async () => {
      h.state.settings['residency.shadowReviewedAt'] = '2026-10-14T09:00:00Z';
      const readiness = await h.service.getReadiness();
      expect(readiness.checks.find((c) => c.id === 'shadow_review_recorded')).toMatchObject({
        passed: true,
        detail: expect.stringContaining('2026-10-14'),
      });
    });
  });

  // ── the gate ────────────────────────────────────────────────────────────────

  describe('platform-admin gate on the four new methods', () => {
    const calls: Array<[string, (s: ModelResidencyService) => Promise<unknown>]> = [
      ['previewLoad', (s) => s.previewLoad({ service: 'stt', modelRef: LIVE_ASR })],
      ['linkRuntimeKey', (s) => s.linkRuntimeKey({ service: 'lm-studio', runtimeKey: 'x', aiModelId: 'model-gemma' })],
      ['dismissSuggestion', (s) => s.dismissSuggestion('x')],
      ['getReadiness', (s) => s.getReadiness()],
    ];
    for (const [name, call] of calls) {
      it(`${name}: 403 for a tenant admin, before anything is read`, async () => {
        h.state.roles = ['TENANT_ADMIN'];
        h.state.tenantId = 'aaaaaaaa-0000-0000-0000-000000000001';
        await expect(call(h.service)).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.agents.report).not.toHaveBeenCalled();
        expect(h.aiModels.findById).not.toHaveBeenCalled();
      });
    }
  });
});
