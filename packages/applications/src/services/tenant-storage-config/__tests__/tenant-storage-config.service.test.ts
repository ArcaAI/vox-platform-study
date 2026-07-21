/**
 * TenantStorageConfigService Unit Tests
 *
 * Repositories + provider factory are faked; the real factory/entity/mapper are
 * used so the tests exercise actual create/update/validate behaviour. Focus:
 * upsert create-vs-update, DEDICATED validation (→ 400), bucket-ownership guard,
 * effective-config precedence, soft-delete, and provider-cache invalidation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StorageProviderType, StorageTopologyType, SysEventType, TenantStorageConfigFactory } from '@arcaai/domains';

import { TenantStorageConfigService } from '../tenant-storage-config.service';

const TENANT = 'tenant-1';
const USER = 'user-1';

function makeCls(store: Record<string, unknown> = { tenantId: TENANT, user: { id: USER } }) {
  return { get: vi.fn((key: string) => store[key]) };
}

function defaultEntity() {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: TENANT,
    bucketId: null,
    provider: StorageProviderType.MINIO,
    topology: StorageTopologyType.SHARED,
  });
}

function build(overrides: {
  configRepo?: any;
  bucketRepo?: any;
  factory?: any;
  cls?: Record<string, unknown>;
}) {
  const configRepo = {
    findAllByTenant: vi.fn(),
    findForBucket: vi.fn().mockResolvedValue(null),
    findTenantDefault: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    create: vi.fn(async (e) => e),
    update: vi.fn(async (_id, e) => e),
    softDelete: vi.fn(),
    ...overrides.configRepo,
  };
  const bucketRepo = { findById: vi.fn(), ...overrides.bucketRepo };
  const factory = { invalidate: vi.fn(), ...overrides.factory };
  const eventEmitter = { emit: vi.fn() };
  const cls = makeCls(overrides.cls);

  const service = new TenantStorageConfigService(
    configRepo as any,
    bucketRepo as any,
    factory as any,
    eventEmitter as any,
    cls as any,
  );
  return { service, configRepo, bucketRepo, factory, eventEmitter };
}

describe('TenantStorageConfigService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('upsertConfig', () => {
    it('creates a new tenant-default config and busts the provider cache', async () => {
      const { service, configRepo, factory, eventEmitter } = build({});

      const res = await service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED });

      expect(configRepo.create).toHaveBeenCalledTimes(1);
      expect(configRepo.update).not.toHaveBeenCalled();
      expect(factory.invalidate).toHaveBeenCalledWith(TENANT);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
      expect(res.tenantId).toBe(TENANT);
      expect(res.provider).toBe(StorageProviderType.AWS_S3);
    });

    it('updates the existing config when one already exists for the scope', async () => {
      const existing = defaultEntity();
      const { service, configRepo, eventEmitter } = build({
        configRepo: { findTenantDefault: vi.fn().mockResolvedValue(existing) },
      });

      await service.upsertConfig({ provider: StorageProviderType.AZURE_BLOB, topology: StorageTopologyType.SHARED });

      expect(configRepo.update).toHaveBeenCalledTimes(1);
      expect(configRepo.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
    });

    it('rejects a DEDICATED config without credentialsRef (400)', async () => {
      const { service, configRepo, factory } = build({});

      await expect(
        service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.DEDICATED }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(configRepo.create).not.toHaveBeenCalled();
      expect(factory.invalidate).not.toHaveBeenCalled();
    });

    it('rejects a per-bucket override when the bucket is not owned by the tenant', async () => {
      const { service } = build({
        bucketRepo: { findById: vi.fn().mockResolvedValue({ id: 'b1', tenantId: 'other' }) },
      });

      await expect(
        service.upsertConfig({ bucketId: 'b1', provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requires a tenant context', async () => {
      const { service } = build({ cls: { user: { id: USER } } });

      await expect(
        service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getEffectiveConfig', () => {
    it('returns the per-bucket override when present', async () => {
      const override = TenantStorageConfigFactory.CreateConfig({
        tenantId: TENANT,
        bucketId: 'b1',
        provider: StorageProviderType.AZURE_BLOB,
        topology: StorageTopologyType.SHARED,
      });
      const { service, configRepo } = build({
        configRepo: { findForBucket: vi.fn().mockResolvedValue(override) },
      });

      const res = await service.getEffectiveConfig('b1');

      expect(res?.provider).toBe(StorageProviderType.AZURE_BLOB);
      expect(configRepo.findTenantDefault).not.toHaveBeenCalled();
    });

    it('falls back to the tenant default, returning null when none exists', async () => {
      const { service } = build({});
      await expect(service.getEffectiveConfig('b1')).resolves.toBeNull();
    });
  });

  describe('deleteConfig', () => {
    it('soft-deletes, invalidates the cache and emits an event', async () => {
      const existing = defaultEntity();
      const { service, configRepo, factory, eventEmitter } = build({
        configRepo: {
          findById: vi.fn().mockResolvedValue(existing),
          softDelete: vi.fn().mockResolvedValue(existing),
        },
      });

      await service.deleteConfig(existing.id);

      expect(configRepo.softDelete).toHaveBeenCalledWith(existing.id, USER);
      expect(factory.invalidate).toHaveBeenCalledWith(TENANT);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.any(Object));
    });

    it('forbids deleting a config owned by a different tenant', async () => {
      const foreign = TenantStorageConfigFactory.CreateConfig({
        tenantId: 'other-tenant',
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
      });
      const { service } = build({
        configRepo: { findById: vi.fn().mockResolvedValue(foreign) },
      });

      await expect(service.deleteConfig(foreign.id)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the config does not exist', async () => {
      const { service } = build({
        configRepo: { findById: vi.fn().mockRejectedValue(new Error('not found')) },
      });

      await expect(service.deleteConfig('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listConfigs', () => {
    it('returns mapped configs for the active tenant', async () => {
      const a = defaultEntity();
      const { service, configRepo } = build({
        configRepo: { findAllByTenant: vi.fn().mockResolvedValue([a]) },
      });

      const res = await service.listConfigs();

      expect(configRepo.findAllByTenant).toHaveBeenCalledWith(TENANT, undefined);
      expect(res).toHaveLength(1);
      expect(res[0]!.id).toBe(a.id);
    });
  });
});
