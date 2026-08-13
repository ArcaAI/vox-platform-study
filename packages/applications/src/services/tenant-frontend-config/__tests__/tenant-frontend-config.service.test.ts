/**
 * TenantFrontendConfigService Unit Tests
 *
 * TESTING APPROACH
 * - Real domain entities via the factory (so create/update mutations exercise
 *   the actual entity behavior + change tracking).
 * - Mock only the external boundaries: the repository (I/O), the event emitter
 *   (side effects), and the CLS request context.
 *
 * Pins the acceptance behaviors: upsert PERSISTS (create + update branches),
 * OCC on update (updateWithVersion with the expectedVersion; versionless
 * update refused; concurrency conflict propagates), and tenant scoping.
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantFrontendConfigService } from '../tenant-frontend-config.service';

const SysEventType = {
  ResourceCreated: 'SysEvent.ResourceCreated',
  ResourceUpdated: 'SysEvent.ResourceUpdated',
  ResourceViewed: 'SysEvent.ResourceViewed',
} as const;

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockConfigRepository = {
  findByTenant: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
};
// The service reads the platform capability (a single SYSTEM_TENANT_ID
// `GlobalSetting`) from the boot-time AppSettings cache, keyed flat by `key`.
const mockAppSettings = { getValueWithDefault: vi.fn() };

function makeService(): TenantFrontendConfigService {
  return new TenantFrontendConfigService(mockConfigRepository as any, mockEventEmitter as any, mockClsService as any, mockAppSettings as any);
}

/** Default CLS: a tenant admin pinned to tenant-1. */
function asTenantAdmin() {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'user-1', roles: ['TENANT_ADMIN'] };
      case 'tenantId':
        return 'tenant-1';
      default:
        return null;
    }
  });
}

function asGlobalAdmin() {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'super-1', roles: ['GLOBAL_ADMIN'] };
      case 'tenantId':
        return null;
      default:
        return null;
    }
  });
}

describe('TenantFrontendConfigService', () => {
  let service: TenantFrontendConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: platform capability OFF unless a test opts in.
    mockAppSettings.getValueWithDefault.mockReturnValue(false);
    asTenantAdmin();
    service = makeService();
  });

  describe('getByTenant', () => {
    it('returns null when the tenant has no config yet', async () => {
      mockConfigRepository.findByTenant.mockResolvedValue(null);

      const result = await service.getByTenant();

      expect(result).toBeNull();
      expect(mockConfigRepository.findByTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('returns the mapped config when one exists', async () => {
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
        tenantId: 'tenant-1',
        asrModel: 'whisper-large-v3',
        noiseCancel: true,
        configJson: { vadThreshold: 0.5 },
      });
      mockConfigRepository.findByTenant.mockResolvedValue(entity);

      const result = await service.getByTenant();

      expect(result).not.toBeNull();
      expect(result!.asrModel).toBe('whisper-large-v3');
      expect(result!.noiseCancel).toBe(true);
      expect(result!.configJson).toEqual({ vadThreshold: 0.5 });
    });
  });

  describe('upsert — create branch', () => {
    it('creates and persists a new config when none exists (no version needed)', async () => {
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      const result = await service.upsert({
        asrModel: 'whisper-tiny',
        noiseCancel: true,
        vad: true,
        configJson: { sampleRate: 16000 },
      });

      // PERSISTENCE: the factory-built entity is written via create()
      expect(mockConfigRepository.create).toHaveBeenCalledTimes(1);
      const created = mockConfigRepository.create.mock.calls[0][0];
      expect(created.tenantId).toBe('tenant-1');
      expect(created.asrModel).toBe('whisper-tiny');
      expect(created.noiseCancel).toBe(true);
      expect(created.vad).toBe(true);
      // unspecified booleans default to false
      expect(created.diarization).toBe(false);

      expect(result.configJson).toEqual({ sampleRate: 16000 });
      expect(mockConfigRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: created.id }));
    });
  });

  describe('upsert — update branch (OCC)', () => {
    it('updates via updateWithVersion using the supplied expectedVersion', async () => {
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', noiseCancel: false });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);
      mockConfigRepository.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await service.upsert({ noiseCancel: true, diarization: true, expectedVersion: 1 });

      // BEHAVIORAL: the existing entity mutated
      expect(existing.noiseCancel).toBe(true);
      expect(existing.diarization).toBe(true);
      // OCC contract: CAS write fires with the expectedVersion; plain create does NOT
      expect(mockConfigRepository.updateWithVersion).toHaveBeenCalledWith(existing.id, existing, 1);
      expect(mockConfigRepository.create).not.toHaveBeenCalled();
      expect(result.noiseCancel).toBe(true);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: existing.id }));
    });

    it('refuses a versionless update (OCC required) and does NOT write', async () => {
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);

      await expect(service.upsert({ noiseCancel: true })).rejects.toThrow(BadRequestException);
      expect(mockConfigRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('propagates OptimisticConcurrencyException from the CAS write', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);
      mockConfigRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('TenantFrontendConfig', existing.id, { expectedVersion: 1, currentVersion: 2 }),
      );

      await expect(service.upsert({ noiseCancel: true, expectedVersion: 1 })).rejects.toThrow(OptimisticConcurrencyException);
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    });
  });

  describe('tenant scoping', () => {
    it('a global admin must pass tenantId', async () => {
      asGlobalAdmin();
      service = makeService();

      await expect(service.getByTenant()).rejects.toThrow(BadRequestException);
    });

    it('a global admin reads the tenant they target', async () => {
      asGlobalAdmin();
      service = makeService();
      mockConfigRepository.findByTenant.mockResolvedValue(null);

      const result = await service.getByTenant('tenant-xyz');

      expect(result).toBeNull();
      expect(mockConfigRepository.findByTenant).toHaveBeenCalledWith('tenant-xyz');
    });

    it('a tenant admin ignores any passed tenantId and uses the CLS tenant', async () => {
      mockConfigRepository.findByTenant.mockResolvedValue(null);

      await service.getByTenant('tenant-someone-else');

      expect(mockConfigRepository.findByTenant).toHaveBeenCalledWith('tenant-1');
    });
  });

  // ===========================================================================
  // Local raw-stream dual-capture
  // The tenant toggle persists like the other booleans; the SDK-facing
  // enablement is the SERVER-COMPUTED `platformCapability AND tenantToggle`.
  // ===========================================================================
  describe('captureRawAudio', () => {
    it('persists captureRawAudio on create (defaults false when omitted)', async () => {
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      await service.upsert({ captureRawAudio: true });
      const created = mockConfigRepository.create.mock.calls[0][0];
      expect(created.captureRawAudio).toBe(true);

      vi.clearAllMocks();
      mockAppSettings.getValueWithDefault.mockReturnValue(false);
      asTenantAdmin();
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);
      await service.upsert({ noiseCancel: true });
      const createdDefault = mockConfigRepository.create.mock.calls[0][0];
      expect(createdDefault.captureRawAudio).toBe(false);
    });

    it('updates captureRawAudio on the update branch (OCC)', async () => {
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', captureRawAudio: false });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);
      mockConfigRepository.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);

      await service.upsert({ captureRawAudio: true, expectedVersion: 1 });

      expect(existing.captureRawAudio).toBe(true);
      expect(mockConfigRepository.updateWithVersion).toHaveBeenCalledWith(existing.id, existing, 1);
    });

    it('response carries captureRawAudio and the server-computed platformRawCaptureCapable', async () => {
      const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
      const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', captureRawAudio: true });
      mockConfigRepository.findByTenant.mockResolvedValue(entity);
      mockAppSettings.getValueWithDefault.mockReturnValue(true);

      const result = await service.getByTenant();

      expect(result!.captureRawAudio).toBe(true);
      expect(result!.platformRawCaptureCapable).toBe(true);
      expect(mockAppSettings.getValueWithDefault).toHaveBeenCalledWith('enable-local-raw-capture', false);
    });

    describe('resolveEffectiveLocalRawCapture — platformCapability AND tenantToggle', () => {
      it.each([
        { platform: true, tenant: true, expected: true },
        { platform: true, tenant: false, expected: false },
        { platform: false, tenant: true, expected: false },
        { platform: false, tenant: false, expected: false },
      ])('platform=$platform tenant=$tenant -> $expected', async ({ platform, tenant, expected }) => {
        const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
        mockAppSettings.getValueWithDefault.mockReturnValue(platform);
        mockConfigRepository.findByTenant.mockResolvedValue(
          TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', captureRawAudio: tenant }),
        );

        const effective = await service.resolveEffectiveLocalRawCapture('tenant-1');

        expect(effective).toBe(expected);
      });

      it('is false when the tenant has no config row yet (even if platform-capable)', async () => {
        mockAppSettings.getValueWithDefault.mockReturnValue(true);
        mockConfigRepository.findByTenant.mockResolvedValue(null);

        expect(await service.resolveEffectiveLocalRawCapture('tenant-1')).toBe(false);
      });

      it('short-circuits the DB read when the platform capability is OFF', async () => {
        mockAppSettings.getValueWithDefault.mockReturnValue(false);

        const effective = await service.resolveEffectiveLocalRawCapture('tenant-1');

        expect(effective).toBe(false);
        expect(mockConfigRepository.findByTenant).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // Transcription mode + lock + capture mode
  // ===========================================================================
  describe('audio-console fields', () => {
    it('persists transcriptionMode / transcriptionModeLocked / captureMode on create', async () => {
      const { TranscriptionMode, CaptureMode } = await import('@arcaai/domains');
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      await service.upsert({
        transcriptionMode: TranscriptionMode.LOCAL,
        transcriptionModeLocked: true,
        captureMode: CaptureMode.RAW_ONLY,
      });

      const created = mockConfigRepository.create.mock.calls[0][0];
      expect(created.transcriptionMode).toBe(TranscriptionMode.LOCAL);
      expect(created.transcriptionModeLocked).toBe(true);
      expect(created.captureMode).toBe(CaptureMode.RAW_ONLY);
    });

    it('defaults transcriptionMode=BACKEND, locked=false, captureMode=null when omitted on create', async () => {
      const { TranscriptionMode } = await import('@arcaai/domains');
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      await service.upsert({ noiseCancel: true });

      const created = mockConfigRepository.create.mock.calls[0][0];
      expect(created.transcriptionMode).toBe(TranscriptionMode.BACKEND);
      expect(created.transcriptionModeLocked).toBe(false);
      expect(created.captureMode).toBeNull();
    });

    it('updates only the supplied new fields on the update branch (OCC)', async () => {
      const { TenantFrontendConfigFactory, TranscriptionMode, CaptureMode } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);
      mockConfigRepository.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);

      await service.upsert({
        transcriptionMode: TranscriptionMode.LOCAL,
        transcriptionModeLocked: true,
        captureMode: CaptureMode.NONE,
        expectedVersion: 1,
      });

      expect(existing.transcriptionMode).toBe(TranscriptionMode.LOCAL);
      expect(existing.transcriptionModeLocked).toBe(true);
      expect(existing.captureMode).toBe(CaptureMode.NONE);
      expect(mockConfigRepository.updateWithVersion).toHaveBeenCalledWith(existing.id, existing, 1);
    });

    it('carries the new fields in the broadcastSysEvent payload', async () => {
      const { TranscriptionMode, CaptureMode } = await import('@arcaai/domains');
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      await service.upsert({ transcriptionMode: TranscriptionMode.LOCAL, transcriptionModeLocked: true, captureMode: CaptureMode.PROCESSED_ONLY });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          data: expect.objectContaining({
            transcriptionMode: TranscriptionMode.LOCAL,
            transcriptionModeLocked: true,
            captureMode: CaptureMode.PROCESSED_ONLY,
          }),
        }),
      );
    });

    describe('resolveEffectiveLocalRawCapture — captureMode overrides the legacy column', () => {
      it.each([
        { captureMode: 'RAW_AND_PROCESSED', expected: true },
        { captureMode: 'RAW_ONLY', expected: true },
        { captureMode: 'PROCESSED_ONLY', expected: false },
        { captureMode: 'NONE', expected: false },
      ])('derives the local raw flag from captureMode=$captureMode → $expected (ignoring captureRawAudio)', async ({ captureMode, expected }) => {
        const { TenantFrontendConfigFactory, CaptureMode } = await import('@arcaai/domains');
        mockAppSettings.getValueWithDefault.mockReturnValue(true);
        mockConfigRepository.findByTenant.mockResolvedValue(
          // captureRawAudio is the OPPOSITE of the derived value to prove captureMode wins.
          TenantFrontendConfigFactory.CreateTenantFrontendConfig({
            tenantId: 'tenant-1',
            captureRawAudio: !expected,
            captureMode: CaptureMode[captureMode as keyof typeof CaptureMode],
          }),
        );

        expect(await service.resolveEffectiveLocalRawCapture('tenant-1')).toBe(expected);
      });

      it('falls back to the legacy captureRawAudio column when captureMode is null', async () => {
        const { TenantFrontendConfigFactory } = await import('@arcaai/domains');
        mockAppSettings.getValueWithDefault.mockReturnValue(true);
        mockConfigRepository.findByTenant.mockResolvedValue(
          TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', captureRawAudio: true, captureMode: null }),
        );

        expect(await service.resolveEffectiveLocalRawCapture('tenant-1')).toBe(true);
      });

      it('still returns false when the platform capability is OFF even with captureMode=RAW_ONLY', async () => {
        const { TenantFrontendConfigFactory, CaptureMode } = await import('@arcaai/domains');
        mockAppSettings.getValueWithDefault.mockReturnValue(false);
        mockConfigRepository.findByTenant.mockResolvedValue(
          TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1', captureMode: CaptureMode.RAW_ONLY }),
        );

        expect(await service.resolveEffectiveLocalRawCapture('tenant-1')).toBe(false);
        expect(mockConfigRepository.findByTenant).not.toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // Disable local (in-browser) transcription platform-wide.
  // The SERVED value is clamped to BACKEND/locked regardless of what the
  // tenant row stores; the stored column itself is untouched (reversible).
  // ===========================================================================
  describe('transcriptionMode clamp', () => {
    it('getByTenant serves BACKEND/locked=true even when the stored row says LOCAL/unlocked', async () => {
      const { TenantFrontendConfigFactory, TranscriptionMode } = await import('@arcaai/domains');
      const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
        tenantId: 'tenant-1',
        transcriptionMode: TranscriptionMode.LOCAL,
        transcriptionModeLocked: false,
      });
      mockConfigRepository.findByTenant.mockResolvedValue(entity);

      const result = await service.getByTenant();

      expect(result!.transcriptionMode).toBe(TranscriptionMode.BACKEND);
      expect(result!.transcriptionModeLocked).toBe(true);
      // The stored column is untouched (reversibility).
      expect(entity.transcriptionMode).toBe(TranscriptionMode.LOCAL);
      expect(entity.transcriptionModeLocked).toBe(false);
    });

    it('upsert (create branch) serves BACKEND/locked=true even when the request asks for LOCAL/unlocked', async () => {
      const { TranscriptionMode } = await import('@arcaai/domains');
      mockConfigRepository.findByTenant.mockResolvedValue(null);
      mockConfigRepository.create.mockImplementation(async (entity: any) => entity);

      const result = await service.upsert({ transcriptionMode: TranscriptionMode.LOCAL, transcriptionModeLocked: false });

      expect(result.transcriptionMode).toBe(TranscriptionMode.BACKEND);
      expect(result.transcriptionModeLocked).toBe(true);
      // The persisted entity (and its sys-event payload) still carries the
      // stored value — only the SERVED response is clamped.
      const created = mockConfigRepository.create.mock.calls[0][0];
      expect(created.transcriptionMode).toBe(TranscriptionMode.LOCAL);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ data: expect.objectContaining({ transcriptionMode: TranscriptionMode.LOCAL }) }),
      );
    });

    it('upsert (update branch) serves BACKEND/locked=true even when the stored row is updated to LOCAL/unlocked', async () => {
      const { TenantFrontendConfigFactory, TranscriptionMode } = await import('@arcaai/domains');
      const existing = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
      mockConfigRepository.findByTenant.mockResolvedValue(existing);
      mockConfigRepository.updateWithVersion.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await service.upsert({ transcriptionMode: TranscriptionMode.LOCAL, transcriptionModeLocked: false, expectedVersion: 1 });

      expect(result.transcriptionMode).toBe(TranscriptionMode.BACKEND);
      expect(result.transcriptionModeLocked).toBe(true);
      expect(existing.transcriptionMode).toBe(TranscriptionMode.LOCAL);
    });

    it('serves BACKEND/locked=true unchanged when the stored row is already BACKEND (no-op clamp)', async () => {
      const { TenantFrontendConfigFactory, TranscriptionMode } = await import('@arcaai/domains');
      const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
      mockConfigRepository.findByTenant.mockResolvedValue(entity);

      const result = await service.getByTenant();

      expect(result!.transcriptionMode).toBe(TranscriptionMode.BACKEND);
      expect(result!.transcriptionModeLocked).toBe(true);
    });
  });
});
