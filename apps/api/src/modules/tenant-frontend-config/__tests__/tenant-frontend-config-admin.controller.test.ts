import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantFrontendConfigAdminController } from '../tenant-frontend-config-admin.controller';

const mockService = {
  getByTenant: vi.fn(),
  upsert: vi.fn(),
};

describe('TenantFrontendConfigAdminController', () => {
  let controller: TenantFrontendConfigAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TenantFrontendConfigAdminController(mockService as any);
  });

  describe('get', () => {
    it('forwards no tenantId for a tenant admin (CLS-scoped)', async () => {
      mockService.getByTenant.mockResolvedValue(null);
      const result = await controller.get();
      expect(result).toBeNull();
      expect(mockService.getByTenant).toHaveBeenCalledWith(undefined);
    });

    it('forwards the tenantId query param for a super admin', async () => {
      mockService.getByTenant.mockResolvedValue({ id: 'c1', tenantId: 't-2' });
      await controller.get('t-2');
      expect(mockService.getByTenant).toHaveBeenCalledWith('t-2');
    });
  });

  describe('upsert', () => {
    it('delegates the body unchanged when no If-Match header is present (create path)', async () => {
      const body = { asrModel: 'whisper-large-v3', noiseCancel: true };
      mockService.upsert.mockResolvedValue({ id: 'c1', ...body, version: 1 });
      const result = await controller.upsert(body as any, undefined, undefined);
      expect(result).toMatchObject({ id: 'c1' });
      expect(mockService.upsert).toHaveBeenCalledWith(body, undefined);
    });

    it('folds the If-Match version into expectedVersion (update path), header wins over body', async () => {
      const body = { vad: false, expectedVersion: 1 };
      mockService.upsert.mockResolvedValue({ id: 'c1', version: 8 });
      await controller.upsert(body as any, 7, 't-2');
      expect(mockService.upsert).toHaveBeenCalledWith({ vad: false, expectedVersion: 7 }, 't-2');
    });

    // The new audio-console fields ride the existing
    // UpsertTenantFrontendConfigRequest DTO; the controller forwards them to the
    // service unchanged (no signature change, gating unchanged).
    it('round-trips the new transcriptionMode / transcriptionModeLocked / captureMode fields through the service', async () => {
      const body = {
        transcriptionMode: 'LOCAL',
        transcriptionModeLocked: true,
        captureMode: 'RAW_ONLY',
        expectedVersion: 2,
      };
      mockService.upsert.mockResolvedValue({ id: 'c1', ...body, version: 3 });
      await controller.upsert(body as any, undefined, 't-9');
      expect(mockService.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptionMode: 'LOCAL',
          transcriptionModeLocked: true,
          captureMode: 'RAW_ONLY',
        }),
        't-9',
      );
    });
  });
});
