/**
 * TenantStorageConfigService Unit Tests
 *
 * Repositories + provider factory are faked; the real factory/entity/mapper are
 * used so the tests exercise actual create/update/validate behaviour. Focus:
 * upsert create-vs-update, DEDICATED validation (→ 400), bucket-ownership guard,
 * effective-config precedence, soft-delete, and provider-cache invalidation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { StorageProviderType, StorageTopologyType, SYSTEM_TENANT_ID, SysEventType, TenantStorageConfigFactory } from '@arcaai/domains';

import { TenantStorageConfigService } from '../tenant-storage-config.service';
import { PLATFORM_STORAGE_CREDENTIALS_REF } from '../platform-storage-config';

const TENANT = 'tenant-1';
const USER = 'user-1';

function makeCls(store: Record<string, unknown> = { tenantId: TENANT, user: { id: USER } }) {
  return { get: vi.fn((key: string) => store[key]) };
}

/** CLS for a platform (SUPER_ADMIN) caller — no tenant binding. */
function globalAdminCls() {
  return { tenantId: '', user: { id: USER, roles: ['SUPER_ADMIN'] } };
}

function systemDefaultEntity() {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: SYSTEM_TENANT_ID,
    bucketId: null,
    provider: StorageProviderType.MINIO,
    topology: StorageTopologyType.SHARED,
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentialsRef: PLATFORM_STORAGE_CREDENTIALS_REF,
  });
}

function defaultEntity() {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: TENANT,
    bucketId: null,
    provider: StorageProviderType.MINIO,
    topology: StorageTopologyType.SHARED,
  });
}

function build(overrides: { configRepo?: any; bucketRepo?: any; factory?: any; cls?: Record<string, unknown> }) {
  const configRepo = {
    findAllByTenant: vi.fn(),
    findForBucket: vi.fn().mockResolvedValue(null),
    findTenantDefault: vi.fn().mockResolvedValue(null),
    findAllTenantDefaults: vi.fn().mockResolvedValue([]),
    findSystemDefault: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    create: vi.fn(async (e) => e),
    update: vi.fn(async (_id, e) => e),
    updateWithVersion: vi.fn(async (_id, e) => e),
    softDelete: vi.fn(),
    ...overrides.configRepo,
  };
  const bucketRepo = { findById: vi.fn(), ...overrides.bucketRepo };
  const factory = { invalidate: vi.fn(), invalidatePlatform: vi.fn(), ...overrides.factory };
  const eventEmitter = { emit: vi.fn() };
  const cls = makeCls(overrides.cls);

  const service = new TenantStorageConfigService(configRepo as any, bucketRepo as any, factory as any, eventEmitter as any, cls as any);
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

      await expect(service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.DEDICATED })).rejects.toBeInstanceOf(
        BadRequestException,
      );

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

      await expect(service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED })).rejects.toBeInstanceOf(
        BadRequestException,
      );
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

    it('404s (never 403) on a config owned by a different tenant — no existence leak', async () => {
      const foreign = TenantStorageConfigFactory.CreateConfig({
        tenantId: 'other-tenant',
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
      });
      const { service, configRepo } = build({
        configRepo: { findById: vi.fn().mockResolvedValue(foreign) },
      });

      await expect(service.deleteConfig(foreign.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deleteConfig(foreign.id)).rejects.not.toBeInstanceOf(ForbiddenException);
      expect(configRepo.softDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete the SYSTEM platform default through the tenant route', async () => {
      const platform = systemDefaultEntity();
      // A global admin whose WORKING tenant is SYSTEM: the tenant-ownership
      // check would otherwise pass. The platform row has exactly one
      // authoritative editor — the platform route.
      const { service, configRepo } = build({
        cls: { tenantId: SYSTEM_TENANT_ID, user: { id: USER, roles: ['SUPER_ADMIN'] } },
        configRepo: { findById: vi.fn().mockResolvedValue(platform) },
      });

      await expect(service.deleteConfig(platform.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(configRepo.softDelete).not.toHaveBeenCalled();
    });

    it('404s when the config does not exist', async () => {
      const { service } = build({
        configRepo: { findById: vi.fn().mockRejectedValue(new Error('not found')) },
      });

      await expect(service.deleteConfig('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('single tenant-default enforcement (Postgres cannot: NULLs are distinct)', () => {
    it('409s rather than creating a SECOND tenant-wide default row', async () => {
      // A pre-existing duplicate (or a concurrent writer) makes
      // `findTenantDefault` non-authoritative — the count is.
      const { service, configRepo } = build({
        configRepo: { findAllTenantDefaults: vi.fn().mockResolvedValue([defaultEntity()]) },
      });

      await expect(service.upsertConfig({ provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(configRepo.create).not.toHaveBeenCalled();
    });

    it('does not run the guard for a per-bucket override (the DB unique index covers it)', async () => {
      const { service, configRepo } = build({
        bucketRepo: { findById: vi.fn().mockResolvedValue({ id: 'b1', tenantId: TENANT }) },
      });

      await service.upsertConfig({ bucketId: 'b1', provider: StorageProviderType.AWS_S3, topology: StorageTopologyType.SHARED });

      expect(configRepo.findAllTenantDefaults).not.toHaveBeenCalled();
      expect(configRepo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getEffectiveConfig cascade', () => {
    it('falls through the tenant default to the SYSTEM platform default', async () => {
      const platform = systemDefaultEntity();
      const { service, configRepo } = build({
        configRepo: { findSystemDefault: vi.fn().mockResolvedValue(platform) },
      });

      const res = await service.getEffectiveConfig();

      expect(configRepo.findTenantDefault).toHaveBeenCalledWith(TENANT);
      expect(configRepo.findSystemDefault).toHaveBeenCalledTimes(1);
      expect(res?.id).toBe(platform.id);
      expect(res?.tenantId).toBe(SYSTEM_TENANT_ID);
    });

    it('prefers the tenant default over the SYSTEM default', async () => {
      const tenantDefault = defaultEntity();
      const { service, configRepo } = build({
        configRepo: {
          findTenantDefault: vi.fn().mockResolvedValue(tenantDefault),
          findSystemDefault: vi.fn().mockResolvedValue(systemDefaultEntity()),
        },
      });

      const res = await service.getEffectiveConfig();

      expect(res?.id).toBe(tenantDefault.id);
      expect(configRepo.findSystemDefault).not.toHaveBeenCalled();
    });

    it('returns null when no row exists at any tier (runtime then uses the env fallback)', async () => {
      const { service } = build({});
      await expect(service.getEffectiveConfig()).resolves.toBeNull();
    });
  });

  describe('platform default (SYSTEM row) — SUPER_ADMIN only', () => {
    it('reads the SYSTEM row for a global admin', async () => {
      const platform = systemDefaultEntity();
      const { service } = build({
        cls: globalAdminCls(),
        configRepo: { findSystemDefault: vi.fn().mockResolvedValue(platform) },
      });

      const res = await service.getPlatformDefault();

      expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(res.credentialsRef).toBe(PLATFORM_STORAGE_CREDENTIALS_REF);
      expect(res.version).toBe(platform.version);
    });

    it('returns a version:0 placeholder when the SYSTEM row has not been seeded yet', async () => {
      const { service } = build({ cls: globalAdminCls() });

      const res = await service.getPlatformDefault();

      expect(res.version).toBe(0);
      expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
    });

    it('403s for a tenant admin reading the platform default (privilege, not tenancy)', async () => {
      const { service } = build({ cls: { tenantId: TENANT, user: { id: USER, roles: ['TENANT_ADMIN'] } } });

      await expect(service.getPlatformDefault()).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('403s for a tenant admin writing the platform default', async () => {
      const { service, configRepo } = build({ cls: { tenantId: TENANT, user: { id: USER, roles: ['TENANT_ADMIN'] } } });

      await expect(
        service.upsertPlatformDefault({ provider: StorageProviderType.MINIO, topology: StorageTopologyType.SHARED, expectedVersion: 0 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(configRepo.create).not.toHaveBeenCalled();
    });

    it('creates the SYSTEM row on expectedVersion 0 and busts the PLATFORM provider cache', async () => {
      const { service, configRepo, factory, eventEmitter } = build({ cls: globalAdminCls() });

      const res = await service.upsertPlatformDefault({
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        endpoint: 'http://minio.internal:9000',
        expectedVersion: 0,
      });

      expect(configRepo.create).toHaveBeenCalledTimes(1);
      expect(res.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(res.bucketId).toBeNull();
      expect(res.endpoint).toBe('http://minio.internal:9000');
      expect(factory.invalidatePlatform).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.any(Object));
    });

    it('rejects a create whose expectedVersion is not 0 (OCC)', async () => {
      const { service, configRepo } = build({ cls: globalAdminCls() });

      await expect(
        service.upsertPlatformDefault({ provider: StorageProviderType.MINIO, topology: StorageTopologyType.SHARED, expectedVersion: 3 }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
      expect(configRepo.create).not.toHaveBeenCalled();
    });

    it('CAS-updates an existing SYSTEM row through updateWithVersion', async () => {
      const platform = systemDefaultEntity();
      const { service, configRepo, factory, eventEmitter } = build({
        cls: globalAdminCls(),
        configRepo: { findSystemDefault: vi.fn().mockResolvedValue(platform) },
      });

      await service.upsertPlatformDefault({
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        endpoint: 'http://minio.newhost:9000',
        expectedVersion: platform.version,
      });

      expect(configRepo.updateWithVersion).toHaveBeenCalledWith(platform.id, platform, platform.version);
      expect(configRepo.update).not.toHaveBeenCalled();
      expect(factory.invalidatePlatform).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.any(Object));
    });

    it('rejects an update that changes nothing', async () => {
      const platform = systemDefaultEntity();
      const { service } = build({
        cls: globalAdminCls(),
        configRepo: { findSystemDefault: vi.fn().mockResolvedValue(platform) },
      });

      await expect(
        service.upsertPlatformDefault({
          provider: platform.provider,
          topology: platform.topology,
          endpoint: platform.endpoint,
          region: platform.region,
          forcePathStyle: platform.forcePathStyle,
          credentialsRef: platform.credentialsRef,
          expectedVersion: platform.version,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never accepts inline credentials — only a credentialsRef reaches the row', async () => {
      const { service, configRepo } = build({ cls: globalAdminCls() });

      await service.upsertPlatformDefault({
        provider: StorageProviderType.MINIO,
        topology: StorageTopologyType.SHARED,
        credentialsRef: PLATFORM_STORAGE_CREDENTIALS_REF,
        expectedVersion: 0,
      });

      const created = configRepo.create.mock.calls[0]![0];
      expect(created.credentialsRef).toBe(PLATFORM_STORAGE_CREDENTIALS_REF);
      expect(Object.keys(created)).not.toContain('secretAccessKey');
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
