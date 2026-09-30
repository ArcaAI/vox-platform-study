/**
 * TASK-1025 G2 — the purge job empties a deleted tenant's buckets through the
 * provider factory. Those rows are ARCHIVED/SUSPENDED, which
 * `TenantBucketRepository.findByName` (ENABLED-only) cannot see — so a bucket
 * with a per-bucket DEDICATED override would silently resolve to the tenant
 * default instead, and the purge would list/delete in the WRONG store (and
 * then record a bucket it never touched as purged). The factory must still
 * find the row, in any live status, to pick its override.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageProviderType, StorageTopologyType } from '@arcaai/domains';

const h = vi.hoisted(() => ({ S3BlobProvider: vi.fn(), AzureBlobProvider: vi.fn() }));
vi.mock('../s3-blob.provider', () => ({ S3BlobProvider: h.S3BlobProvider }));
vi.mock('../azure-blob.provider', () => ({ AzureBlobProvider: h.AzureBlobProvider }));

import { BlobStorageProviderFactory } from '../blob-storage.provider.factory';

const TENANT = 'tenant-1';
const cfg = (partial: Record<string, unknown>) => ({
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
});

describe('BlobStorageProviderFactory — TASK-1025 retained-bucket override resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.S3BlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 's3', config };
    });
    h.AzureBlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 'azure', config };
    });
  });

  function build(bucketRepo: unknown, configRepo: unknown): BlobStorageProviderFactory {
    const appSettings = { getValueWithDefault: vi.fn((_key: string, def: unknown) => def) };
    const secrets = { getSecretOptional: vi.fn(async () => undefined) };
    return new BlobStorageProviderFactory(appSettings as never, secrets as never, configRepo as never, bucketRepo as never);
  }

  it('finds the per-bucket override of an ARCHIVED row that the ENABLED-only lookup misses', async () => {
    const bucketRepo = {
      findByName: vi.fn().mockResolvedValue(null),
      findAll: vi.fn().mockResolvedValue([{ id: 'bucket-1', tenantId: TENANT, resourceStatus: 'ARCHIVED' }]),
    };
    const configRepo = {
      findForBucket: vi.fn().mockResolvedValue(cfg({ provider: StorageProviderType.AZURE_BLOB, accountName: 'dedicated' })),
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ topology: StorageTopologyType.SHARED })),
      findSystemDefault: vi.fn().mockResolvedValue(null),
    };

    const provider = await build(bucketRepo, configRepo).getProviderForBucket(TENANT, 'hope-recordings-acme');

    expect(bucketRepo.findAll).toHaveBeenCalledWith({ filters: { name: 'hope-recordings-acme' } });
    expect(configRepo.findForBucket).toHaveBeenCalledWith(TENANT, 'bucket-1');
    expect((provider as { __kind: string }).__kind).toBe('azure');
  });

  it('falls through to the tenant default when the name matches no row at all', async () => {
    const bucketRepo = { findByName: vi.fn().mockResolvedValue(null), findAll: vi.fn().mockResolvedValue([]) };
    const configRepo = {
      findForBucket: vi.fn(),
      findTenantDefault: vi.fn().mockResolvedValue(cfg({ provider: StorageProviderType.AWS_S3 })),
      findSystemDefault: vi.fn().mockResolvedValue(null),
    };

    await build(bucketRepo, configRepo).getProviderForBucket(TENANT, 'nowhere');

    expect(configRepo.findForBucket).not.toHaveBeenCalled();
    expect(configRepo.findTenantDefault).toHaveBeenCalledWith(TENANT);
  });
});
