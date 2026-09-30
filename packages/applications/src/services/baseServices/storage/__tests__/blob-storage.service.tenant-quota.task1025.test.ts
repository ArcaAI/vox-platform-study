/**
 * TASK-1025 G3 (owner decision OD-3) — the plan storage quota is ENFORCED by
 * the application, across BOTH of a tenant's system buckets
 * (`hope-attachments-<key>` + `hope-recordings-<key>`), before every upload and
 * every presigned PUT. Over quota → the existing `QuotaExceededException`
 * (HTTP 409) plus the entitlements quota-blocked event. No quota configured →
 * unlimited. Same kill-switch as every other entitlement (`entitlements.enabled`).
 *
 * Usage is measured by listing the two buckets, cached per tenant in Redis for
 * `storage.tenantQuota.usageCacheSeconds` and bumped on every gateway upload, so
 * a busy tenant is not re-listed per upload.
 */
import { QuotaExceededException } from '@arcaai/exceptions';
import { ResourceStatusType, TenantPlan } from '@arcaai/domains';
import { StorageProvider } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStorageService } from '../blob-storage.service';
import { TenantBucketStorageGate } from '../tenant-bucket-storage.gate';
import { ENTITLEMENTS_QUOTA_BLOCKED_EVENT } from '../../../entitlements/entitlements.constants';
import { TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY } from '../../../tenant-bucket/tenant-bucket-lifecycle.constants';

const TENANT = 'tenant-acme';
const ATTACHMENTS = {
  name: 'hope-attachments-acme',
  tenantId: TENANT,
  bucketType: 'SYSTEM',
  isSystemBucket: true,
  resourceStatus: ResourceStatusType.ENABLED,
};
const RECORDINGS = {
  name: 'hope-recordings-acme',
  tenantId: TENANT,
  bucketType: 'SYSTEM',
  isSystemBucket: true,
  resourceStatus: ResourceStatusType.ENABLED,
};
const CUSTOM = { name: 'hope-scans-acme', tenantId: TENANT, bucketType: 'CUSTOM', isSystemBucket: false, resourceStatus: ResourceStatusType.ENABLED };

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => void store.set(key, value)),
    del: vi.fn(async (key: string) => void store.delete(key)),
    eval: vi.fn(async (_script: string, _n: number, key: string, amount: string | number) => {
      if (!store.has(key)) return null;
      const next = Number(store.get(key)) + Number(amount);
      store.set(key, String(next));
      return next;
    }),
  };
}

describe('TenantBucketStorageGate — TASK-1025 G3 app-side quota across both system buckets', () => {
  const settings: Record<string, unknown> = {};
  const appSettings = { getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)) };
  const bucketRepo = { findAll: vi.fn(), findSystemBuckets: vi.fn() };
  const tenantRepo = { findById: vi.fn() };
  const planRepo = { findByPlan: vi.fn() };
  const overrideRepo = { findByTenant: vi.fn() };
  const events = { emit: vi.fn() };
  const factory = { getProviderForBucket: vi.fn() };
  const cls = { get: vi.fn(() => TENANT) };
  let redis: ReturnType<typeof makeRedis>;
  let sizes: Record<string, number[]>;
  let provider: {
    provider: StorageProvider;
    listObjects: ReturnType<typeof vi.fn>;
    putObject: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
    presignPut: ReturnType<typeof vi.fn>;
  };
  let service: BlobStorageService;

  function quota(bytes: number | null) {
    overrideRepo.findByTenant.mockResolvedValue(bytes === null ? null : { storageQuotaBytes: BigInt(bytes) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settings)) delete settings[key];
    redis = makeRedis();
    sizes = { [ATTACHMENTS.name]: [400], [RECORDINGS.name]: [200, 100] };
    provider = {
      provider: StorageProvider.MINIO,
      listObjects: vi.fn(async ({ bucket }: { bucket: string }) => ({
        objects: (sizes[bucket] ?? []).map((size, i) => ({ key: `k${i}`, size })),
        isTruncated: false,
      })),
      putObject: vi.fn().mockResolvedValue(undefined),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      presignPut: vi.fn().mockResolvedValue('https://signed/put'),
    };
    factory.getProviderForBucket.mockResolvedValue(provider);
    bucketRepo.findAll.mockImplementation(async ({ filters }: { filters: { name: string } }) =>
      [ATTACHMENTS, RECORDINGS, CUSTOM].filter((b) => b.name === filters.name),
    );
    bucketRepo.findSystemBuckets.mockResolvedValue([ATTACHMENTS, RECORDINGS]);
    tenantRepo.findById.mockResolvedValue({ id: TENANT, plan: TenantPlan.STARTER });
    planRepo.findByPlan.mockResolvedValue(null);
    quota(1000);
    const gate = new TenantBucketStorageGate(
      bucketRepo as never,
      tenantRepo as never,
      planRepo as never,
      overrideRepo as never,
      appSettings as never,
      factory as never,
      events as never,
      redis as never,
    );
    service = new BlobStorageService(factory as never, cls as never, gate);
  });

  const put = (bucket: string, bytes: number) => service.putObject({ bucket, key: 'new.wav', body: Buffer.alloc(bytes) });

  it('refuses an upload that would take the tenant over quota, counting BOTH system buckets (700 used + 301 > 1000)', async () => {
    await expect(put(RECORDINGS.name, 301)).rejects.toBeInstanceOf(QuotaExceededException);

    expect(provider.putObject).not.toHaveBeenCalled();
    expect(provider.listObjects).toHaveBeenCalledWith(expect.objectContaining({ bucket: ATTACHMENTS.name }));
    expect(provider.listObjects).toHaveBeenCalledWith(expect.objectContaining({ bucket: RECORDINGS.name }));
  });

  it('applies to the attachments bucket too, not only recordings', async () => {
    await expect(put(ATTACHMENTS.name, 301)).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('allows an upload that lands exactly on the quota (700 + 300 = 1000)', async () => {
    await expect(put(RECORDINGS.name, 300)).resolves.toBeUndefined();
    expect(provider.putObject).toHaveBeenCalledTimes(1);
  });

  it('emits the entitlements quota-blocked event with the storage capability and figures', async () => {
    await expect(put(RECORDINGS.name, 301)).rejects.toThrow();

    expect(events.emit).toHaveBeenCalledWith(
      ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
      expect.objectContaining({ tenantId: TENANT, capability: 'storageQuotaBytes', limit: 1000, used: 700, requested: 301 }),
    );
  });

  it('refuses a presigned PUT once the tenant is at its quota', async () => {
    sizes[RECORDINGS.name] = [600];

    await expect(service.presignPut({ bucket: RECORDINGS.name, key: 'new.wav', expiresInSeconds: 60 })).rejects.toBeInstanceOf(
      QuotaExceededException,
    );
    expect(provider.presignPut).not.toHaveBeenCalled();
  });

  it('treats no quota as unlimited (never lists the buckets)', async () => {
    tenantRepo.findById.mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000', plan: null });
    bucketRepo.findAll.mockResolvedValue([{ ...RECORDINGS, tenantId: '00000000-0000-0000-0000-000000000000' }]);

    await expect(put(RECORDINGS.name, 10_000)).resolves.toBeUndefined();
    expect(provider.listObjects).not.toHaveBeenCalled();
  });

  it('is inert when entitlement enforcement is switched off', async () => {
    settings['entitlements.enabled'] = false;

    await expect(put(RECORDINGS.name, 10_000)).resolves.toBeUndefined();
    expect(provider.listObjects).not.toHaveBeenCalled();
  });

  it('does not check a CUSTOM bucket (the plan quota covers the two system buckets)', async () => {
    await expect(put(CUSTOM.name, 10_000)).resolves.toBeUndefined();
    expect(provider.listObjects).not.toHaveBeenCalled();
  });

  it('measures once, then reuses the cached figure and adds each gateway upload to it', async () => {
    await put(RECORDINGS.name, 100); // lists: 700 used → cached 700, then +100 → 800
    await put(RECORDINGS.name, 100); // cached 800 → 900
    expect(provider.listObjects).toHaveBeenCalledTimes(2); // one measurement = one list per bucket

    await expect(put(RECORDINGS.name, 101)).rejects.toBeInstanceOf(QuotaExceededException); // 900 + 101 > 1000
    expect(redis.setex).toHaveBeenCalledWith(`tenant-storage-usage:${TENANT}`, 300, '700');
  });

  it('honours the usage-cache TTL setting, and 0 disables the cache', async () => {
    settings[TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY] = 0;

    await put(RECORDINGS.name, 100);
    await put(RECORDINGS.name, 100);

    expect(redis.setex).not.toHaveBeenCalled();
    expect(provider.listObjects).toHaveBeenCalledTimes(4);
  });

  it('forgets the cached figure when an object is deleted from a system bucket (it can only shrink)', async () => {
    await put(RECORDINGS.name, 100);
    await service.deleteObject({ bucket: RECORDINGS.name, key: 'old.wav' });

    expect(redis.store.has(`tenant-storage-usage:${TENANT}`)).toBe(false);
  });

  it('fails OPEN when usage cannot be measured (a storage hiccup must not block clinical uploads)', async () => {
    provider.listObjects.mockRejectedValue(new Error('SlowDown'));

    await expect(put(RECORDINGS.name, 5000)).resolves.toBeUndefined();
    expect(provider.putObject).toHaveBeenCalledTimes(1);
  });
});
