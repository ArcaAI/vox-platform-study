/**
 * The headline proof for:
 *
 *   changing the SYSTEM `TenantStorageConfig` row changes the resolved storage
 *   configuration with NO redeploy.
 *
 * Integration-style: the REAL `BlobStorageProviderFactory` and the REAL
 * `TenantStorageConfigService` are wired together against an in-memory repository
 * (no live Postgres in this environment). Only the two SDK-backed provider
 * classes are mocked, so the assertion is on the resolved configuration the
 * provider is constructed with.
 *
 * It also pins the full resolution order the Prisma model declares:
 *   bucket row → tenant default → SYSTEM default row → env.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageProviderType, StorageTopologyType, SYSTEM_TENANT_ID, TenantStorageConfigEntity, TenantStorageConfigFactory } from '@arcaai/domains';

const h = vi.hoisted(() => ({
  S3BlobProvider: vi.fn(),
  AzureBlobProvider: vi.fn(),
}));

vi.mock('../../baseServices/storage/providers/s3-blob.provider', () => ({ S3BlobProvider: h.S3BlobProvider }));
vi.mock('../../baseServices/storage/providers/azure-blob.provider', () => ({ AzureBlobProvider: h.AzureBlobProvider }));

import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import { TenantStorageConfigService } from '../tenant-storage-config.service';

const TENANT = 'tenant-1';
const ADMIN = 'global-admin-1';

/** Minimal in-memory stand-in for `TenantStorageConfigRepository`. */
class FakeConfigRepo {
  rows: TenantStorageConfigEntity[] = [];

  async findSystemDefault(): Promise<TenantStorageConfigEntity | null> {
    return this.rows.find((r) => r.tenantId === SYSTEM_TENANT_ID && !r.bucketId) ?? null;
  }
  async findTenantDefault(tenantId: string): Promise<TenantStorageConfigEntity | null> {
    return this.rows.find((r) => r.tenantId === tenantId && !r.bucketId) ?? null;
  }
  async findAllTenantDefaults(tenantId: string): Promise<TenantStorageConfigEntity[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && !r.bucketId);
  }
  async findForBucket(tenantId: string, bucketId: string): Promise<TenantStorageConfigEntity | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.bucketId === bucketId) ?? null;
  }
  async create(entity: TenantStorageConfigEntity): Promise<TenantStorageConfigEntity> {
    this.rows.push(entity);
    return entity;
  }
  async updateWithVersion(_id: string, entity: TenantStorageConfigEntity): Promise<TenantStorageConfigEntity> {
    return entity;
  }
  async update(_id: string, entity: TenantStorageConfigEntity): Promise<TenantStorageConfigEntity> {
    return entity;
  }
  async findAllByTenant(): Promise<TenantStorageConfigEntity[]> {
    return this.rows;
  }
  async findById(): Promise<TenantStorageConfigEntity | null> {
    return null;
  }
  async softDelete(): Promise<TenantStorageConfigEntity | null> {
    return null;
  }
}

function appSettings(settings: Record<string, unknown> = {}) {
  return { getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)) };
}

function secrets(values: Record<string, string> = {}) {
  return { getSecretOptional: vi.fn(async (key: string) => values[key]) };
}

/** The resolved S3 config the factory constructed the provider with. */
function lastS3Config(): Record<string, unknown> {
  const calls = h.S3BlobProvider.mock.calls;
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

describe('platform storage cascade — SYSTEM row over env, no redeploy', () => {
  let repo: FakeConfigRepo;
  let factory: BlobStorageProviderFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    h.S3BlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 's3', config, provider: 'minio' };
    });
    h.AzureBlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 'azure', config, provider: 'azure_blob' };
    });

    repo = new FakeConfigRepo();
    factory = new BlobStorageProviderFactory(
      appSettings() as never,
      secrets({ S3_ACCESS_KEY: 'dev-ak', S3_SECRET_KEY: 'dev-sk' }) as never,
      repo as never,
      undefined,
    );
  });

  function service(roles: string[] = ['SUPER_ADMIN'], tenantId = ''): TenantStorageConfigService {
    const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : { id: ADMIN, roles })) };
    return new TenantStorageConfigService(repo as never, { findById: vi.fn() } as never, factory, { emit: vi.fn() } as never, cls as never);
  }

  it('uses the MINIO_* env bootstrap tier before the SYSTEM row exists', async () => {
    const previous = process.env.MINIO_ENDPOINT;
    process.env.MINIO_ENDPOINT = 'localhost:9000';
    try {
      await factory.getProvider();
      expect(lastS3Config()).toMatchObject({ endpoint: 'http://localhost:9000', accessKeyId: 'dev-ak' });
    } finally {
      if (previous === undefined) delete process.env.MINIO_ENDPOINT;
      else process.env.MINIO_ENDPOINT = previous;
    }
  });

  it('THE PROOF: a global admin writing the SYSTEM row changes the resolved config on the SAME live factory', async () => {
    process.env.MINIO_ENDPOINT = 'localhost:9000';

    // 1. Boot-time state: env tier.
    await factory.getProvider();
    expect(lastS3Config()).toMatchObject({ endpoint: 'http://localhost:9000' });

    // 2. A global admin edits the platform default through the admin API.
    const created = await service().upsertPlatformDefault({
      provider: StorageProviderType.MINIO,
      topology: StorageTopologyType.SHARED,
      endpoint: 'https://s3.eu-central-1.example.com',
      region: 'eu-central-1',
      forcePathStyle: false,
      expectedVersion: 0,
    });
    expect(created.tenantId).toBe(SYSTEM_TENANT_ID);

    // 3. Same process, same factory instance, no restart — the next file
    //    operation resolves the NEW backend.
    await factory.getProvider();
    expect(lastS3Config()).toMatchObject({
      endpoint: 'https://s3.eu-central-1.example.com',
      region: 'eu-central-1',
      forcePathStyle: false,
    });

    delete process.env.MINIO_ENDPOINT;
  });

  it('a tenant-scoped SHARED bucket also picks up the new platform backend (per-tenant cache is busted too)', async () => {
    repo.rows.push(
      TenantStorageConfigFactory.CreateConfig({
        tenantId: TENANT,
        bucketId: null,
        provider: StorageProviderType.MINIO,
        // SHARED = "defer to the platform config".
        topology: StorageTopologyType.SHARED,
      }),
    );

    process.env.MINIO_ENDPOINT = 'localhost:9000';
    await factory.getProviderForBucket(TENANT);
    expect(lastS3Config()).toMatchObject({ endpoint: 'http://localhost:9000' });

    await service().upsertPlatformDefault({
      provider: StorageProviderType.MINIO,
      topology: StorageTopologyType.SHARED,
      endpoint: 'https://new-platform:9000',
      expectedVersion: 0,
    });

    await factory.getProviderForBucket(TENANT);
    expect(lastS3Config()).toMatchObject({ endpoint: 'https://new-platform:9000' });

    delete process.env.MINIO_ENDPOINT;
  });

  it('a DEDICATED tenant row still wins over the SYSTEM default', async () => {
    await service().upsertPlatformDefault({
      provider: StorageProviderType.MINIO,
      topology: StorageTopologyType.SHARED,
      endpoint: 'https://platform:9000',
      expectedVersion: 0,
    });
    repo.rows.push(
      TenantStorageConfigFactory.CreateConfig({
        tenantId: TENANT,
        bucketId: null,
        provider: StorageProviderType.AWS_S3,
        topology: StorageTopologyType.DEDICATED,
        region: 'ap-south-1',
        credentialsRef: 'tenant/byo',
      }),
    );

    await factory.getProviderForBucket(TENANT);

    expect(lastS3Config()).toMatchObject({ region: 'ap-south-1' });
  });

  it('the SYSTEM row supplies only a credentialsRef — the key pair still comes from the secrets manager', async () => {
    const created = await service().upsertPlatformDefault({
      provider: StorageProviderType.MINIO,
      topology: StorageTopologyType.SHARED,
      endpoint: 'https://platform:9000',
      credentialsRef: 'platform/storage/minio',
      expectedVersion: 0,
    });

    // Nothing key-shaped is persisted on the row.
    expect(created.credentialsRef).toBe('platform/storage/minio');
    expect(JSON.stringify(created)).not.toContain('dev-sk');

    await factory.getProvider();
    // No Vault entry at that path in this environment → the pre-existing
    // S3_ACCESS_KEY / S3_SECRET_KEY secrets keep dev working unchanged.
    expect(lastS3Config()).toMatchObject({ accessKeyId: 'dev-ak', secretAccessKey: 'dev-sk' });
  });
});
