import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LmStudioServingService } from '../lmstudio-serving.service';
import { LM_STUDIO_MODEL_KEY, kvCacheEstimateBytes } from '../vram-estimate';

/**
 * TASK-996 Phase 3 — the gateway's LM Studio serving-control plane.
 *
 * The gates, in the order the service applies them: a row-INDEPENDENT
 * super-admin 403 first (the promotion-route precedent, `05-nestjs-api.md`),
 * then existence (404), then the resolved profile's cross-field problems (400),
 * then the live VRAM budget (409), and only then the dispatch — which on this
 * engine build cannot happen at all (501, §2.8).
 */

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const MODEL_KEY = 'gemma-4-e2b-it-qat@q4_0';
/** Measured on the live pod 2026-09-21: `size_bytes` of the served row. */
const WEIGHTS_BYTES = 3_349_516_256;
const MIB = 1024 * 1024;

/** `AiModel._metadata` for the SYSTEM LM Studio row under test. */
function metaData(serving?: Record<string, unknown>, declaredContextLength = 65_536): Record<string, unknown> {
  return { capabilities: { contextLength: declaredContextLength }, ...(serving ? { serving } : {}) };
}

describe('LmStudioServingService (TASK-996 Phase 3)', () => {
  let aiModelRepository: { findAll: ReturnType<typeof vi.fn> };
  let engine: { snapshot: ReturnType<typeof vi.fn>; unload: ReturnType<typeof vi.fn> };
  let prometheus: { instantVector: ReturnType<typeof vi.fn> };
  let effectiveSettings: { resolveEffective: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let cls: { get: ReturnType<typeof vi.fn> };
  let service: LmStudioServingService;
  let roles: string[];

  /** Free VRAM, per `gpu`, in MiB — what `DCGM_FI_DEV_FB_FREE` answers. */
  let freeMibByGpu: Record<string, number>;

  beforeEach(() => {
    roles = ['SUPER_ADMIN'];
    freeMibByGpu = { '0': 14_504, '1': 12_346 };

    aiModelRepository = {
      findAll: vi.fn().mockResolvedValue([{ id: 'model-1', tenantId: SYSTEM_TENANT_ID, wireModelId: MODEL_KEY, metaData: metaData() }]),
    };
    engine = {
      snapshot: vi.fn().mockResolvedValue({
        reachable: true,
        models: [{ modelKey: MODEL_KEY, weightsBytes: WEIGHTS_BYTES, instances: [] }],
      }),
      unload: vi.fn().mockResolvedValue(undefined),
    };
    prometheus = {
      instantVector: vi.fn(async (query: string) => {
        if (query.includes('FB_USED')) {
          return [
            { metric: { gpu: '0', modelName: 'NVIDIA RTX 2000 Ada Generation' }, value: 1_445 },
            { metric: { gpu: '1', modelName: 'NVIDIA RTX 2000 Ada Generation' }, value: 3_603 },
          ];
        }
        if (query.includes('FB_FREE')) {
          return Object.entries(freeMibByGpu).map(([gpu, value]) => ({ metric: { gpu }, value }));
        }
        return [
          { metric: { gpu: '0' }, value: 430 },
          { metric: { gpu: '1' }, value: 430 },
        ];
      }),
    };
    effectiveSettings = {
      resolveEffective: vi.fn(async (key: string) => {
        const values: Record<string, unknown> = {
          'lmStudio.serving.contextLength': 65_536,
          'lmStudio.serving.parallel': 4,
          'lmStudio.serving.flashAttention': true,
          'lmStudio.serving.kvCacheQuantK': 'f16',
          'lmStudio.serving.kvCacheQuantV': 'f16',
          'lmStudio.serving.gpuSplitStrategy': 'evenly',
        };
        return { key, tier: 'global-kv', value: values[key], sourceScope: 'code-default' };
      }),
    };
    eventEmitter = { emit: vi.fn() };
    cls = {
      get: vi.fn((key: string) => {
        if (key === 'user') return { id: 'admin-1', tenantId: SYSTEM_TENANT_ID, roles };
        if (key === 'tenantId') return SYSTEM_TENANT_ID;
        return undefined;
      }),
    };

    service = new LmStudioServingService(
      aiModelRepository as never,
      engine as never,
      prometheus as never,
      effectiveSettings as never,
      eventEmitter as never,
      cls as never,
    );
  });

  /** Make the caller a tenant admin of its own tenant. */
  function asTenantAdmin(): void {
    roles = ['TENANT_ADMIN'];
    cls.get = vi.fn((key: string) => (key === 'user' ? { id: 'u', tenantId: TENANT_A, roles } : TENANT_A));
  }

  // ── the privilege boundary: a 403, never the 404-over-403 posture ─────────

  describe('super-admin only (row-independent, so it runs first)', () => {
    it('refuses a tenant admin reading the runtime', async () => {
      asTenantAdmin();
      await expect(service.runtime()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a tenant admin loading a model', async () => {
      asTenantAdmin();
      await expect(service.load(MODEL_KEY, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a tenant admin unloading an instance', async () => {
      asTenantAdmin();
      await expect(service.unload('gemma-4-e2b-it-qat')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers 403 for an UNKNOWN model key too — the gate is row-independent, so there is no existence oracle', async () => {
      asTenantAdmin();
      aiModelRepository.findAll.mockResolvedValue([]);
      await expect(service.load('no-such-model', {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(aiModelRepository.findAll).not.toHaveBeenCalled();
    });

    it('`force` never bypasses the 403', async () => {
      asTenantAdmin();
      await expect(service.load(MODEL_KEY, { force: true })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── GET /runtime ──────────────────────────────────────────────────────────

  describe('runtime()', () => {
    beforeEach(() => {
      engine.snapshot.mockResolvedValue({
        reachable: true,
        models: [
          {
            modelKey: MODEL_KEY,
            weightsBytes: WEIGHTS_BYTES,
            instances: [{ identifier: 'gemma-4-e2b-it-qat', contextLength: 65_536, parallel: 4, flashAttention: true }],
          },
        ],
      });
    });

    it('projects each device from DCGM, with total = used + free + reserved', async () => {
      const result = await service.runtime();
      expect(result.engine.reachable).toBe(true);
      expect(result.devices).toEqual([
        { index: 0, name: 'NVIDIA RTX 2000 Ada Generation', totalMib: 16_379, usedMib: 1_445, freeMib: 14_504 },
        { index: 1, name: 'NVIDIA RTX 2000 Ada Generation', totalMib: 16_379, usedMib: 3_603, freeMib: 12_346 },
      ]);
    });

    it('never groups the DCGM series by pod — the label is an arbitrary pick under time-slicing', async () => {
      await service.runtime();
      for (const [query] of prometheus.instantVector.mock.calls) {
        expect(query).toContain('by (gpu');
        expect(query).not.toContain('pod');
      }
    });

    it('reports the loaded instance with the config the ENGINE applied and a DERIVED KV estimate', async () => {
      const result = await service.runtime();
      expect(result.loaded).toHaveLength(1);
      const [loaded] = result.loaded;
      expect(loaded.identifier).toBe('gemma-4-e2b-it-qat');
      expect(loaded.modelKey).toBe(MODEL_KEY);
      expect(loaded.weightsBytes).toBe(WEIGHTS_BYTES);
      expect(loaded.status).toBe('IDLE');
      expect(loaded.effective).toEqual({ contextLength: 65_536, parallel: 4, flashAttention: true });
      expect(loaded.kvCacheEstimateBytes).toBe(kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4 }));
    });

    it('carries the platform default profile the registry resolves', async () => {
      const result = await service.runtime();
      expect(result.platformDefault).toEqual({
        contextLength: 65_536,
        parallel: 4,
        flashAttention: true,
        kvCacheQuant: { k: 'f16', v: 'f16' },
        gpuSplit: { strategy: 'evenly' },
      });
    });

    it('reports an unreachable engine rather than failing the read', async () => {
      engine.snapshot.mockResolvedValue({ reachable: false, models: [] });
      const result = await service.runtime();
      expect(result.engine.reachable).toBe(false);
      expect(result.loaded).toEqual([]);
      expect(result.devices).toHaveLength(2);
    });
  });

  // ── POST .../load ─────────────────────────────────────────────────────────

  describe('load() — existence, then the resolved profile, then the budget', () => {
    it('404s an unknown model key', async () => {
      aiModelRepository.findAll.mockResolvedValue([]);
      await expect(service.load('no-such-model', {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('`force` never bypasses the 404', async () => {
      aiModelRepository.findAll.mockResolvedValue([]);
      await expect(service.load('no-such-model', { force: true })).rejects.toBeInstanceOf(NotFoundException);
    });

    const problemCases: Array<[string, Record<string, unknown>]> = [
      ['a quantized V-cache with flash attention off', { kvCacheQuant: { v: 'q8_0' }, flashAttention: false }],
      ['strategy "custom" with no customRatio', { gpuSplit: { strategy: 'custom' } }],
      ['strategy "priorityOrder" with no priority', { gpuSplit: { strategy: 'priorityOrder' } }],
      ['a split that disables every preferred device', { gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [1] } }],
      ['a served window narrower than the declared one', { contextLength: 8_192 }],
    ];

    for (const [what, profile] of problemCases) {
      it(`400s on ${what}, naming the problem`, async () => {
        const error = await service.load(MODEL_KEY, { profile }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        const body = (error as BadRequestException).getResponse() as { problems: string[] };
        expect(body.problems.length).toBeGreaterThan(0);
      });
    }

    it('400s on a request field the profile vocabulary does not accept, instead of silently dropping it', async () => {
      const error = await service.load(MODEL_KEY, { profile: { parallel: 0, notAKnob: true } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { problems: string[] };
      expect(body.problems.join(' ')).toContain('parallel');
      expect(body.problems.join(' ')).toContain('notAKnob');
    });

    it('`force` never bypasses the 400', async () => {
      await expect(service.load(MODEL_KEY, { profile: { gpuSplit: { strategy: 'custom' } }, force: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('409s VRAM_BUDGET_EXCEEDED when the estimate exceeds the best single card', async () => {
      freeMibByGpu = { '0': 1_024, '1': 900 };
      const error = await service.load(MODEL_KEY, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { code: string; estimateBytes: number; freeBytes: number };
      expect(body.code).toBe('VRAM_BUDGET_EXCEEDED');
      expect(body.freeBytes).toBe(1_024 * MIB);
      expect(body.estimateBytes).toBeGreaterThan(body.freeBytes);
    });

    it('compares against the BEST SINGLE CARD, not the sum of both', async () => {
      // 4 GiB free on each card is 8 GiB in total but only 4 GiB on one, and a
      // model does not straddle a budget — that is the split this ticket exists
      // to stop.
      freeMibByGpu = { '0': 4_096, '1': 4_096 };
      const error = await service.load(MODEL_KEY, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(((error as ConflictException).getResponse() as { freeBytes: number }).freeBytes).toBe(4_096 * MIB);
    });

    it('`force: true` bypasses the 409 — and only the 409', async () => {
      freeMibByGpu = { '0': 1_024, '1': 900 };
      await expect(service.load(MODEL_KEY, { force: true })).rejects.toBeInstanceOf(NotImplementedException);
    });

    it('refuses with a TYPED, honest error instead of calling the engine`s broken REST load', async () => {
      const error = await service.load(MODEL_KEY, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotImplementedException);
      const body = (error as NotImplementedException).getResponse() as {
        code: string;
        applied: Record<string, unknown>;
        sources: Record<string, string>;
        estimateBytes: number;
      };
      expect(body.code).toBe('ENGINE_LOAD_UNSUPPORTED');
      // The precheck the console shows BEFORE arming its button still answers.
      expect(body.applied).toEqual({
        contextLength: 65_536,
        parallel: 4,
        flashAttention: true,
        kvCacheQuant: { k: 'f16', v: 'f16' },
        gpuSplit: { strategy: 'evenly' },
      });
      expect(body.sources.contextLength).toBe('platform');
      expect(body.estimateBytes).toBe(WEIGHTS_BYTES + kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4, kvCacheQuant: { k: 'f16', v: 'f16' } }));
    });

    it('labels each resolved field with the tier that supplied it — request over model over platform', async () => {
      aiModelRepository.findAll.mockResolvedValue([
        { id: 'model-1', tenantId: SYSTEM_TENANT_ID, wireModelId: MODEL_KEY, metaData: metaData({ parallel: 2 }) },
      ]);
      const error = await service.load(MODEL_KEY, { profile: { flashAttention: false } }).catch((e: unknown) => e);
      const body = (error as NotImplementedException).getResponse() as { sources: Record<string, string>; applied: Record<string, unknown> };
      expect(body.sources).toMatchObject({ flashAttention: 'request', parallel: 'model', contextLength: 'platform' });
      expect(body.applied).toMatchObject({ flashAttention: false, parallel: 2, contextLength: 65_536 });
    });

    it('never calls the engine`s load path', async () => {
      await service.load(MODEL_KEY, {}).catch(() => undefined);
      expect(Object.keys(engine)).not.toContain('load');
    });
  });

  // ── POST .../unload ───────────────────────────────────────────────────────

  describe('unload()', () => {
    beforeEach(() => {
      engine.snapshot.mockResolvedValue({
        reachable: true,
        models: [{ modelKey: MODEL_KEY, weightsBytes: WEIGHTS_BYTES, instances: [{ identifier: 'gemma-4-e2b-it-qat' }] }],
      });
    });

    it('unloads the named instance and states the JIT caveat', async () => {
      const result = await service.unload('gemma-4-e2b-it-qat');
      expect(engine.unload).toHaveBeenCalledWith('gemma-4-e2b-it-qat');
      expect(result).toEqual({ unloaded: true, jitReloadPossible: true });
    });

    it('404s an identifier that is not loaded', async () => {
      await expect(service.unload('not-loaded')).rejects.toBeInstanceOf(NotFoundException);
      expect(engine.unload).not.toHaveBeenCalled();
    });

    it('broadcasts a sys-event so a platform-disruptive action stays attributable', async () => {
      await service.unload('gemma-4-e2b-it-qat');
      expect(eventEmitter.emit).toHaveBeenCalled();
    });
  });

  // ── the estimate itself ───────────────────────────────────────────────────

  describe('kvCacheEstimateBytes', () => {
    it('scales with context x parallel, because every slot is given the FULL window', () => {
      const one = kvCacheEstimateBytes({ contextLength: 65_536, parallel: 1 });
      expect(kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4 })).toBe(one * 4);
      expect(kvCacheEstimateBytes({ contextLength: 131_072, parallel: 1 })).toBe(one * 2);
    });

    it('falls to roughly half on a q8_0 cache and to about a quarter on q4_0', () => {
      const f16 = kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4, kvCacheQuant: { k: 'f16', v: 'f16' } });
      const q8 = kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4, kvCacheQuant: { k: 'q8_0', v: 'q8_0' } });
      const q4 = kvCacheEstimateBytes({ contextLength: 65_536, parallel: 4, kvCacheQuant: { k: 'q4_0', v: 'q4_0' } });
      expect(q8 / f16).toBeCloseTo(0.53, 2);
      expect(q4 / f16).toBeCloseTo(0.28, 2);
    });

    it('is zero when neither tier declared a window or a slot count — an unknown is not a guess', () => {
      expect(kvCacheEstimateBytes({})).toBe(0);
    });

    it('names the catalogue column the engine model key is read from', () => {
      expect(LM_STUDIO_MODEL_KEY).toBe('wireModelId');
    });
  });
});
