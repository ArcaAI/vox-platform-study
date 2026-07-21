/**
 * BlobStorageProviderFactory — per-tenant / per-bucket resolution
 *
 * Mirrors the W1 selection suite: both provider modules are mocked so we assert
 * which provider gets constructed (and with what resolved config) without
 * pulling real AWS/Azure SDK clients in. Here we focus on the tenant-aware
 * resolution path: precedence (per-bucket → tenant default → global/shared),
 * DEDICATED credential loading, caching, and invalidation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageProvider } from '@arcaai/types';
import { StorageProviderType, StorageTopologyType } from '@arcaai/domains';

const h = vi.hoisted(() => ({
  S3BlobProvider: vi.fn(),
  AzureBlobProvider: vi.fn(),
}));

vi.mock('../s3-blob.provider', () => ({ S3BlobProvider: h.S3BlobProvider }));
vi.mock('../azure-blob.provider', () => ({ AzureBlobProvider: h.AzureBlobProvider }));

import { BlobStorageProviderFactory } from '../blob-storage.provider.factory';

const TENANT = 'tenant-1';

function makeAppSettings(settings: Record<string, unknown> = {}) {
  return { getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)) };
}

function makeSecrets(secrets: Record<string, string> = {}) {
  return { getSecretOptional: vi.fn(async (key: string) => secrets[key]) };
}

function cfg(partial: Record<string, unknown>): any {
  return {
    topology: StorageTopologyType.DEDICATED,
    provider: StorageProviderType.AWS_S3,
    bucketId: null,
    endpoint: null,
    region: null,
    forcePathStyle: null,
    accountName: null,
    endpointSuffix: null,
    credentialsRef: null,
    ...partial,
  };
}

function build(opts: {
  settings?: Record<string, unknown>;
  secrets?: Record<string, string>;
  configRepo?: any;
  bucketRepo?: any;
}): BlobStorageProviderFactory {
  return new BlobStorageProviderFactory(
    makeAppSettings(opts.settings ?? {}) as any,
    opts.secrets === undefined ? undefined : (makeSecrets(opts.secrets) as any),
    opts.configRepo,
    opts.bucketRepo,
  );
}

describe('BlobStorageProviderFactory — tenant resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.S3BlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 's3', config };
    });
    h.AzureBlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 'azure', config };
    });
  });

  it('falls back to the global provider when there is no tenant context', async () => {
    const configRepo = { findTenantDefault: vi.fn(), findForBucket: vi.fn() };
    const factory = build({ secrets: { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' }, configRepo });

    const provider = await factory.getProviderForBucket(undefined, 'audio');

    expect((provider as { __kind: string }).__kind).toBe('s3');
    expect(configRepo.findTenantDefault).not.toHaveBeenCalled();
  });

  it('falls back to the global provider when no config repo is wired', async () => {
    const factory = build({ secrets: { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });

    const provider = await factory.getProviderForBucket(TENANT, 'audio');

    expect((provider as { __kind: string }).__kind).toBe('s3');
  });

  it('uses the global provider when the tenant default is SHARED', async () => {
    const configRepo = {
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ topology: StorageTopologyType.SHARED })),
      findForBucket: vi.fn(),
    };
    const factory = build({ settings: { STORAGE_PROVIDER: 'minio' }, secrets: { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' }, configRepo });

    const provider = await factory.getProviderForBucket(TENANT);

    expect(configRepo.findTenantDefault).toHaveBeenCalledWith(TENANT);
    expect((provider as { __kind: string }).__kind).toBe('s3');
    expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: StorageProvider.MINIO }));
  });

  it('builds a DEDICATED S3 provider from the tenant default + credentialsRef', async () => {
    const configRepo = {
      findTenantDefault: vi.fn().mockResolvedValue(
        cfg({ provider: StorageProviderType.AWS_S3, region: 'eu-west-1', endpoint: 'https://s3.example', credentialsRef: 'TENANT_1_S3' }),
      ),
      findForBucket: vi.fn(),
    };
    const factory = build({
      secrets: { TENANT_1_S3: JSON.stringify({ accessKeyId: 'tak', secretAccessKey: 'tsk' }) },
      configRepo,
    });

    const provider = await factory.getProviderForBucket(TENANT);

    expect((provider as { __kind: string }).__kind).toBe('s3');
    expect(h.S3BlobProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: StorageProvider.AWS_S3,
        region: 'eu-west-1',
        endpoint: 'https://s3.example',
        accessKeyId: 'tak',
        secretAccessKey: 'tsk',
      }),
    );
  });

  it('builds a DEDICATED Azure provider from the tenant default', async () => {
    const configRepo = {
      findTenantDefault: vi.fn().mockResolvedValue(
        cfg({ provider: StorageProviderType.AZURE_BLOB, accountName: 'acct', endpointSuffix: 'core.windows.net', credentialsRef: 'TENANT_1_AZ' }),
      ),
      findForBucket: vi.fn(),
    };
    const factory = build({
      secrets: { TENANT_1_AZ: JSON.stringify({ connectionString: 'cs', accountKey: 'key==' }) },
      configRepo,
    });

    const provider = await factory.getProviderForBucket(TENANT);

    expect((provider as { __kind: string }).__kind).toBe('azure');
    expect(h.AzureBlobProvider).toHaveBeenCalledWith(
      expect.objectContaining({ accountName: 'acct', connectionString: 'cs', accountKey: 'key==' }),
    );
  });

  it('prefers a per-bucket override over the tenant default', async () => {
    const bucketRepo = { findByName: vi.fn().mockResolvedValue({ id: 'bucket-1', tenantId: TENANT }) };
    const configRepo = {
      findForBucket: vi.fn().mockResolvedValue(
        cfg({ provider: StorageProviderType.AZURE_BLOB, accountName: 'override', credentialsRef: 'OV' }),
      ),
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ provider: StorageProviderType.AWS_S3, credentialsRef: 'DEF' })),
    };
    const factory = build({ secrets: { OV: JSON.stringify({ accountKey: 'k==' }) }, configRepo, bucketRepo });

    const provider = await factory.getProviderForBucket(TENANT, 'physical-bucket');

    expect(bucketRepo.findByName).toHaveBeenCalledWith('physical-bucket');
    expect(configRepo.findForBucket).toHaveBeenCalledWith(TENANT, 'bucket-1');
    expect(configRepo.findTenantDefault).not.toHaveBeenCalled();
    expect((provider as { __kind: string }).__kind).toBe('azure');
  });

  it('ignores a bucket owned by a different tenant and uses the default', async () => {
    const bucketRepo = { findByName: vi.fn().mockResolvedValue({ id: 'bucket-x', tenantId: 'other-tenant' }) };
    const configRepo = {
      findForBucket: vi.fn(),
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ topology: StorageTopologyType.SHARED })),
    };
    const factory = build({ secrets: { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' }, configRepo, bucketRepo });

    await factory.getProviderForBucket(TENANT, 'foreign-bucket');

    expect(configRepo.findForBucket).not.toHaveBeenCalled();
    expect(configRepo.findTenantDefault).toHaveBeenCalledWith(TENANT);
  });

  it('caches the resolved provider per (tenant, bucket) until invalidated', async () => {
    const configRepo = {
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ provider: StorageProviderType.AWS_S3, credentialsRef: 'R' })),
      findForBucket: vi.fn(),
    };
    const factory = build({ secrets: { R: JSON.stringify({ accessKeyId: 'a', secretAccessKey: 'b' }) }, configRepo });

    const first = await factory.getProviderForBucket(TENANT);
    const second = await factory.getProviderForBucket(TENANT);

    expect(first).toBe(second);
    expect(configRepo.findTenantDefault).toHaveBeenCalledTimes(1);

    factory.invalidate(TENANT);
    await factory.getProviderForBucket(TENANT);

    expect(configRepo.findTenantDefault).toHaveBeenCalledTimes(2);
  });
});
