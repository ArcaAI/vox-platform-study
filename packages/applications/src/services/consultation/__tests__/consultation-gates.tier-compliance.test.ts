/**
 * Configuration-tier compliance for the two consultation-pipeline
 * kill-switches (`harness.loop.enabled`, `consultation.ocr.enabled`).
 *
 * These four cases are the contract the migration off `process.env` has to buy.
 * They are written against the REAL `TenantSettingsService` over a fake
 * `IAppSettingsService` cache, not a stubbed resolver, because the property
 * under test IS the resolution path: a constructor-frozen env read would pass a
 * mocked-resolver test and still need a redeploy in production.
 *
 *   1. RUNTIME FLIP — a kill-switch changes effect with NO restart, i.e. the
 *      reader consults the control plane per call, not once in its constructor.
 *   2. DEFAULT OFF — with no stored value, both resolve OFF (fail-safe default), and the
 *      registry refuses to assemble a kill-switch that defaults ON.
 *   3. FAIL MODE — `open-to-default` substitutes the descriptor default for an
 *      ABSENT value, but a backend ERROR propagates and is never disguised as
 *      "the default" (registry.types.ts `SettingFailMode` / default-source rule).
 *   4. REGRESSION — with each knob in its PREVIOUS effective state, the
 *      surrounding behaviour is byte-for-byte what it was before the migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { ContextItemType } from '@arcaai/domains';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { CONSULTATION_OCR_ENABLED_KEY, HARNESS_LOOP_ENABLED_KEY } from '../consultation-gates.constants';
import { LoopContextSignalService } from '../loop/loop-context-signal.service';
import { OcrEnrichmentProcessor } from '../ocr/ocr-enrichment.processor';
import type { ContextAddedPayload } from '../events';

/**
 * A minimal stand-in for the `GlobalSetting` cache. `store` is mutated between
 * assertions to simulate an `app-settings:invalidate` push landing on this node
 * — which is exactly what a live operator write does.
 */
function fakeAppSettings(store: Map<string, unknown>, onRead?: () => void) {
  return {
    getValueFromCache: (key: string) => {
      onRead?.();
      return store.has(key) ? store.get(key) : null;
    },
    getTenantValueFromCache: () => null,
  } as never;
}

function loopPayload(overrides: Partial<ContextAddedPayload> = {}): ContextAddedPayload {
  return {
    consultationId: 'consultation-1',
    tenantId: 'tenant-1',
    timestamp: '2026-08-12T10:00:00.000Z',
    contextItemId: 'ctx-1',
    contextType: 'WORKNOTE',
    ...overrides,
  };
}

function buildLoopService(store: Map<string, unknown>) {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const tenantSettings = new TenantSettingsService(fakeAppSettings(store));
  const service = new LoopContextSignalService(harnessGatewayService as never, tenantSettings);
  return { service, harnessGatewayService, tenantSettings };
}

function buildOcrProcessor(store: Map<string, unknown>) {
  const contextItemRepository = { findById: vi.fn().mockResolvedValue(null), update: vi.fn() };
  const configService = { get: vi.fn().mockReturnValue(undefined) };
  const cls = { run: vi.fn(async (fn: () => Promise<void>) => fn()), set: vi.fn() };
  const tenantSettings = new TenantSettingsService(fakeAppSettings(store));
  const processor = new OcrEnrichmentProcessor(
    {} as never, // IBlobStorageService
    contextItemRepository as never,
    { axiosRef: { post: vi.fn() } } as never, // HttpService
    configService as never,
    { emit: vi.fn() } as never, // EventEmitter2
    cls as never,
    undefined, // SecretsService
    undefined, // MediaRepository
    tenantSettings,
  );
  return { processor, contextItemRepository, cls };
}

function ocrPayload(): ContextAddedPayload {
  return {
    consultationId: 'consultation-1',
    tenantId: 'tenant-1',
    timestamp: '2026-08-12T10:00:00.000Z',
    contextItemId: 'ctx-1',
    contextType: ContextItemType.ATTACHMENT,
  };
}

describe('Consultation-gate tier compliance', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── 1. A kill-switch flips at runtime, with no restart ────────────────────
  describe('runtime flip (no restart)', () => {
    it('harness.loop.enabled starts OFF and begins signalling once the stored value flips', async () => {
      const store = new Map<string, unknown>();
      const { service, harnessGatewayService } = buildLoopService(store);

      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-off' }));
      expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();

      // An operator write + `app-settings:invalidate` push — NOT a restart.
      store.set(HARNESS_LOOP_ENABLED_KEY, true);

      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-on' }));
      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('harness.loop.enabled stops signalling again when flipped back OFF', async () => {
      const store = new Map<string, unknown>([[HARNESS_LOOP_ENABLED_KEY, true]]);
      const { service, harnessGatewayService } = buildLoopService(store);

      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-a' }));
      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);

      store.set(HARNESS_LOOP_ENABLED_KEY, false);

      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-b' }));
      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('the lifecycle-boundary loop signals honour the same live gate', async () => {
      const store = new Map<string, unknown>();
      const { service, harnessGatewayService } = buildLoopService(store);

      await service.signalConsultationEnding('consultation-1');
      await service.signalLoopCancel('consultation-1');
      expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
      expect(harnessGatewayService.signalLoopCancel).not.toHaveBeenCalled();

      store.set(HARNESS_LOOP_ENABLED_KEY, true);

      await service.signalConsultationEnding('consultation-1');
      await service.signalLoopCancel('consultation-1');
      expect(harnessGatewayService.signalConsultationEnding).toHaveBeenCalledTimes(1);
      expect(harnessGatewayService.signalLoopCancel).toHaveBeenCalledTimes(1);
    });

    it('consultation.ocr.enabled starts OFF and begins enriching once the stored value flips', async () => {
      const store = new Map<string, unknown>();
      const { processor, contextItemRepository } = buildOcrProcessor(store);

      await processor.handleContextAdded(ocrPayload());
      expect(contextItemRepository.findById).not.toHaveBeenCalled();

      store.set(CONSULTATION_OCR_ENABLED_KEY, true);

      await processor.handleContextAdded(ocrPayload());
      expect(contextItemRepository.findById).toHaveBeenCalledTimes(1);
    });

    it('reads the gate on EVERY event rather than caching it on the instance', async () => {
      const store = new Map<string, unknown>([[HARNESS_LOOP_ENABLED_KEY, true]]);
      let reads = 0;
      const tenantSettings = new TenantSettingsService(fakeAppSettings(store, () => (reads += 1)));
      const service = new LoopContextSignalService(
        { signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }) } as never,
        tenantSettings,
      );

      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-1' }));
      await service.handleContextAdded(loopPayload({ contextItemId: 'ctx-2' }));

      expect(reads).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 2. Kill-switches default OFF with no stored value ─────────────────────
  describe('defaults OFF', () => {
    it.each([HARNESS_LOOP_ENABLED_KEY, CONSULTATION_OCR_ENABLED_KEY])(
      '%s resolves false from the code default when nothing is stored',
      (key) => {
        const resolver = new TenantSettingsService(fakeAppSettings(new Map()));
        const resolved = resolver.resolvePlatform<boolean>(key);
        expect(resolved.value).toBe(false);
        expect(resolved.source).toBe('code-default');
      },
    );

    it.each([HARNESS_LOOP_ENABLED_KEY, CONSULTATION_OCR_ENABLED_KEY])('%s is a registered kill-switch', (key) => {
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(descriptor.killSwitch).toBe(true);
      expect(descriptor.tier).toBe('global-kv');
      expect(descriptor.default).toBe(false);
    });

    it('the registry refuses to assemble any kill-switch that defaults ON', () => {
      // Asserts the invariant is live for the WHOLE catalog, including the two
      // keys this ticket adds — `killSwitches()` throws on a default-ON switch.
      const switches = HOPE_SETTINGS_REGISTRY.killSwitches();
      expect(switches.map((d) => d.key)).toEqual(expect.arrayContaining([HARNESS_LOOP_ENABLED_KEY, CONSULTATION_OCR_ENABLED_KEY]));
      expect(switches.every((d) => d.default !== true)).toBe(true);
    });
  });

  // ── 3. failMode: absent value vs backend error ────────────────────────────
  describe('declared failMode', () => {
    it.each([HARNESS_LOOP_ENABLED_KEY, CONSULTATION_OCR_ENABLED_KEY])('%s declares open-to-default', (key) => {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).failMode).toBe('open-to-default');
    });

    it('an ABSENT value falls back to the descriptor default (open-to-default)', () => {
      const resolver = new TenantSettingsService(fakeAppSettings(new Map()));
      expect(resolver.resolvePlatform(HARNESS_LOOP_ENABLED_KEY).value).toBe(false);
    });

    it('a BACKEND ERROR propagates — it is never disguised as "the default"', () => {
      const exploding = {
        getValueFromCache: () => {
          throw new Error('settings cache unreachable');
        },
        getTenantValueFromCache: () => null,
      } as never;
      const resolver = new TenantSettingsService(exploding);

      expect(() => resolver.resolvePlatform(CONSULTATION_OCR_ENABLED_KEY)).toThrow('settings cache unreachable');
    });

    it('a fail-CLOSED key still raises rather than substituting a value', () => {
      // Guards the other half of the contract: `open-to-default` above must not
      // be the only branch that works. `models.*` are fail-closed.
      const closed = HOPE_SETTINGS_REGISTRY.list().find((d) => d.failMode === 'closed' && d.sensitivity !== 'secret');
      expect(closed).toBeDefined();
      const resolver = new TenantSettingsService(fakeAppSettings(new Map()));
      expect(() => resolver.resolvePlatform(closed!.key)).toThrow(ArgumentInvalidException);
    });
  });

  // ── 4. Regression: previous effective state ⇒ previous behaviour ──────────
  describe('regression at the previous effective state', () => {
    it('loop signalling with the gate ON sends the identical payload it sent before', async () => {
      const store = new Map<string, unknown>([[HARNESS_LOOP_ENABLED_KEY, true]]);
      const { service, harnessGatewayService } = buildLoopService(store);

      await service.handleContextAdded(loopPayload({ subType: 'LAB_RESULT', contentPreview: 'BP elevated' }));

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith('consultation-1', {
        tenantId: 'tenant-1',
        contextItemId: 'ctx-1',
        contextType: 'WORKNOTE',
        subType: 'LAB_RESULT',
        contentPreview: 'BP elevated',
        kindKey: undefined,
        occurredAt: '2026-08-12T10:00:00.000Z',
        depth: 0,
        content: undefined,
      });
    });

    it('loop de-duplication still holds with the gate ON', async () => {
      const store = new Map<string, unknown>([[HARNESS_LOOP_ENABLED_KEY, true]]);
      const { service, harnessGatewayService } = buildLoopService(store);

      await service.handleContextAdded(loopPayload());
      await service.handleContextAdded(loopPayload());

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('loop signalling stays best-effort with the gate ON (a gateway failure never throws)', async () => {
      const store = new Map<string, unknown>([[HARNESS_LOOP_ENABLED_KEY, true]]);
      const tenantSettings = new TenantSettingsService(fakeAppSettings(store));
      const service = new LoopContextSignalService(
        { signalContextAdded: vi.fn().mockRejectedValue(new Error('harness down')) } as never,
        tenantSettings,
      );

      await expect(service.handleContextAdded(loopPayload())).resolves.toBeUndefined();
    });

    it('OCR with the gate ON still ignores non-ATTACHMENT context types', async () => {
      const store = new Map<string, unknown>([[CONSULTATION_OCR_ENABLED_KEY, true]]);
      const { processor, contextItemRepository } = buildOcrProcessor(store);

      await processor.handleContextAdded({ ...ocrPayload(), contextType: ContextItemType.WORKNOTE });

      expect(contextItemRepository.findById).not.toHaveBeenCalled();
    });

    it('OCR with the gate OFF short-circuits before establishing CLS scope', async () => {
      const store = new Map<string, unknown>();
      const { processor, cls } = buildOcrProcessor(store);

      await processor.handleContextAdded(ocrPayload());

      expect(cls.run).not.toHaveBeenCalled();
    });
  });

  // ── Tier-policy guards ────────────────────────────────────────────────────
  describe('tier policy', () => {
    // The OBSERVABLE consequence of the migration, which is stronger than a
    // grep for `process.env`: setting the retired variables must have no effect
    // whatsoever, in either direction.
    it('neither gate is read from process.env any more', async () => {
      const previous = { loop: process.env.HARNESS_LOOP_ENABLED, ocr: process.env.OCR_ENABLED };
      process.env.HARNESS_LOOP_ENABLED = 'true';
      process.env.OCR_ENABLED = 'true';
      try {
        const store = new Map<string, unknown>();
        const { service, harnessGatewayService } = buildLoopService(store);
        const { processor, contextItemRepository } = buildOcrProcessor(store);

        await service.handleContextAdded(loopPayload());
        await processor.handleContextAdded(ocrPayload());

        expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
        expect(contextItemRepository.findById).not.toHaveBeenCalled();
      } finally {
        if (previous.loop === undefined) delete process.env.HARNESS_LOOP_ENABLED;
        else process.env.HARNESS_LOOP_ENABLED = previous.loop;
        if (previous.ocr === undefined) delete process.env.OCR_ENABLED;
        else process.env.OCR_ENABLED = previous.ocr;
      }
    });
  });
});
