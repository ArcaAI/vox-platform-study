import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantStorageConfigAdminController } from '../tenant-storage-config-admin.controller';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from '../../../common/tenant-owned-resource.decorator';
import { REQUIRES_IF_MATCH_KEY } from '../../../decorators/requiresIfMatch.decorator';

const mockService = {
  listConfigs: vi.fn(),
  getEffectiveConfig: vi.fn(),
  upsertConfig: vi.fn(),
  deleteConfig: vi.fn(),
  getPlatformDefault: vi.fn(),
  upsertPlatformDefault: vi.fn(),
};

describe('TenantStorageConfigAdminController', () => {
  let controller: TenantStorageConfigAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TenantStorageConfigAdminController(mockService as any);
  });

  describe('listConfigs', () => {
    it('delegates to the service (enabled-only by default)', async () => {
      mockService.listConfigs.mockResolvedValue([{ id: 'c1' }]);
      const result = await controller.listConfigs();
      expect(result).toHaveLength(1);
      expect(mockService.listConfigs).toHaveBeenCalledWith({ includeDisabled: false });
    });

    it('passes includeDisabled=true when the query flag is set', async () => {
      mockService.listConfigs.mockResolvedValue([]);
      await controller.listConfigs('true');
      expect(mockService.listConfigs).toHaveBeenCalledWith({ includeDisabled: true });
    });
  });

  describe('getEffectiveConfig', () => {
    it('forwards the bucketId query param', async () => {
      mockService.getEffectiveConfig.mockResolvedValue(null);
      await controller.getEffectiveConfig('bucket-1');
      expect(mockService.getEffectiveConfig).toHaveBeenCalledWith('bucket-1');
    });
  });

  describe('upsertConfig', () => {
    it('delegates the request body to the service', async () => {
      const body = { provider: 'AWS_S3', topology: 'SHARED' };
      mockService.upsertConfig.mockResolvedValue({ id: 'c1', ...body });
      const result = await controller.upsertConfig(body as any);
      expect(result).toMatchObject({ id: 'c1' });
      expect(mockService.upsertConfig).toHaveBeenCalledWith(body);
    });
  });

  describe('deleteConfig', () => {
    it('delegates to the service', async () => {
      mockService.deleteConfig.mockResolvedValue({ id: 'c1' });
      await controller.deleteConfig('c1');
      expect(mockService.deleteConfig).toHaveBeenCalledWith('c1');
    });

    it('is guarded by @TenantOwnedResource for TenantStorageConfig', () => {
      const meta = Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, TenantStorageConfigAdminController.prototype.deleteConfig) as
        TenantOwnedResourceOptions | undefined;
      expect(meta).toMatchObject({ modelName: 'TenantStorageConfig', paramName: 'id' });
    });
  });

  describe('platform default (SYSTEM row)', () => {
    it('delegates the read to the service', async () => {
      mockService.getPlatformDefault.mockResolvedValue({ id: 'sys', version: 3 });
      await expect(controller.getPlatformDefault()).resolves.toMatchObject({ version: 3 });
      expect(mockService.getPlatformDefault).toHaveBeenCalledTimes(1);
    });

    it('prefers the If-Match version over a body-supplied expectedVersion', async () => {
      mockService.upsertPlatformDefault.mockResolvedValue({ id: 'sys', version: 5 });

      await controller.upsertPlatformDefault({ provider: 'MINIO', expectedVersion: 1 } as any, 4);

      expect(mockService.upsertPlatformDefault).toHaveBeenCalledWith({ provider: 'MINIO', expectedVersion: 4 });
    });

    it('falls back to the body expectedVersion when the header carries none', async () => {
      mockService.upsertPlatformDefault.mockResolvedValue({ id: 'sys', version: 1 });

      await controller.upsertPlatformDefault({ provider: 'MINIO', expectedVersion: 0 } as any, undefined);

      expect(mockService.upsertPlatformDefault).toHaveBeenCalledWith({ provider: 'MINIO', expectedVersion: 0 });
    });

    it('requires If-Match on the write route (428 guard metadata present)', () => {
      const meta = Reflect.getMetadata(REQUIRES_IF_MATCH_KEY, TenantStorageConfigAdminController.prototype.upsertPlatformDefault) as unknown;
      expect(meta).toBeTruthy();
    });

    it('is NOT guarded by @TenantOwnedResource — the SYSTEM row is cross-tenant by design', () => {
      const meta = Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, TenantStorageConfigAdminController.prototype.upsertPlatformDefault) as
        TenantOwnedResourceOptions | undefined;
      expect(meta).toBeUndefined();
    });
  });
});
