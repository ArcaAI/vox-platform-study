/**
 * TASK-1025 G2 (owner decision OD-2) — the scheduled purge of a deleted
 * tenant's buckets once the retention window (default 45 days) has passed.
 *
 * Pinned here: which tenants and rows it takes, the ARCHIVED → SUSPENDED →
 * DELETED progression, that a failure part-way leaves the row SUSPENDED for
 * the next run (idempotent, safe to re-run), that an out-of-range window skips
 * the run instead of purging early, the cross-replica lock, sys-events, and
 * that no object key ever reaches a log line.
 */
import { Logger } from '@nestjs/common';
import { ResourceStatusType, SysEventType, TenantBucketFactory } from '@arcaai/domains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantStoragePurgeService } from '../tenant-storage-purge.service';
import { TENANT_STORAGE_PURGE_JOB_NAME, TENANT_STORAGE_RETENTION_DAYS_KEY } from '../../tenant-bucket-lifecycle.constants';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-30T04:15:00Z');
const SECRET_KEY = 'patients/jane-doe/2026/visit.wav';

function bucketRow(slug: string, status: ResourceStatusType) {
  const row = TenantBucketFactory.CreateSystemBucket('tenant-dead', 'dead', slug);
  if (status === ResourceStatusType.ARCHIVED) row.archive();
  if (status === ResourceStatusType.SUSPENDED) row.suspend();
  if (status === ResourceStatusType.DISABLED) row.disable();
  row.clearChanges();
  return row;
}

function makeProvider(objects: Record<string, string[]>) {
  const store = new Map(Object.entries(objects).map(([bucket, keys]) => [bucket, new Set(keys)]));
  return {
    listObjects: vi.fn(async ({ bucket }: { bucket: string }) => {
      const keys = store.get(bucket);
      if (!keys) throw Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' });
      return { objects: [...keys].map((key) => ({ key, size: 10 })), isTruncated: false };
    }),
    deleteObject: vi.fn(async ({ bucket, key }: { bucket: string; key: string }) => {
      store.get(bucket)?.delete(key);
    }),
    deleteBucket: vi.fn(async (bucket: string) => {
      store.delete(bucket);
    }),
    _store: store,
  };
}

describe('TenantStoragePurgeService — TASK-1025 G2', () => {
  const settings: Record<string, unknown> = {};
  const appSettings = { getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)) };
  const scheduler = { addCronJob: vi.fn(), deleteCronJob: vi.fn(), getCronJob: vi.fn(() => undefined) };
  const tenantRepo = { findAll: vi.fn() };
  const bucketRepo = { findAllByTenant: vi.fn(), update: vi.fn(), softDelete: vi.fn() };
  const factory = { getProviderForBucket: vi.fn() };
  const events = { emit: vi.fn() };
  const clsStore = new Map<string, unknown>();
  const cls = {
    get: vi.fn((key: string) => clsStore.get(key)),
    set: vi.fn((key: string, value: unknown) => void clsStore.set(key, value)),
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
  const redis = { eval: vi.fn(), del: vi.fn() };
  let service: TenantStoragePurgeService;
  let provider: ReturnType<typeof makeProvider>;
  let logs: unknown[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const key of Object.keys(settings)) delete settings[key];
    clsStore.clear();
    tenantRepo.findAll.mockResolvedValue([{ id: 'tenant-dead', resourceStatusUpdatedAt: new Date(NOW.getTime() - 45 * DAY) }]);
    bucketRepo.update.mockImplementation(async (_id: string, entity: unknown) => entity);
    bucketRepo.softDelete.mockImplementation(async (id: string) => ({ id }));
    redis.eval.mockResolvedValue('OK');
    redis.del.mockResolvedValue(undefined);
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
    service = new TenantStoragePurgeService(
      appSettings as never,
      scheduler as never,
      tenantRepo as never,
      bucketRepo as never,
      factory as never,
      events as never,
      cls as never,
      redis as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('selects tenants soft-deleted more than the retention window (default 45 days) ago', async () => {
    bucketRepo.findAllByTenant.mockResolvedValue([]);

    const result = await service.purgeExpired();

    expect(result.retentionDays).toBe(45);
    expect(tenantRepo.findAll).toHaveBeenCalledWith({
      filters: { resourceStatus: ResourceStatusType.DELETED, resourceStatusUpdatedAt: { lt: new Date(NOW.getTime() - 45 * DAY) } },
    });
  });

  it('empties and removes a retained bucket, then marks its row DELETED — ARCHIVED → SUSPENDED → DELETED', async () => {
    const row = bucketRow('recordings', ResourceStatusType.ARCHIVED);
    bucketRepo.findAllByTenant.mockResolvedValue([row]);
    provider = makeProvider({ [row.name]: [SECRET_KEY, 'b.wav'] });
    factory.getProviderForBucket.mockResolvedValue(provider);

    const result = await service.purgeExpired();

    expect(bucketRepo.update).toHaveBeenCalledWith(row.id, expect.objectContaining({ resourceStatus: ResourceStatusType.SUSPENDED }));
    expect(provider.deleteObject).toHaveBeenCalledTimes(2);
    expect(provider.deleteBucket).toHaveBeenCalledWith(row.name);
    expect(bucketRepo.softDelete).toHaveBeenCalledWith(row.id);
    expect(factory.getProviderForBucket).toHaveBeenCalledWith('tenant-dead', row.name);
    expect(result).toMatchObject({ bucketsPurged: 1, bucketsFailed: 0, objectsDeleted: 2 });
  });

  it('broadcasts a ResourceDeleted sys-event for the purged bucket, attributed to the deleted tenant', async () => {
    const row = bucketRow('recordings', ResourceStatusType.ARCHIVED);
    bucketRepo.findAllByTenant.mockResolvedValue([row]);
    factory.getProviderForBucket.mockResolvedValue(makeProvider({ [row.name]: ['a'] }));

    await service.purgeExpired();

    expect(events.emit).toHaveBeenCalledWith(
      SysEventType.ResourceDeleted,
      expect.objectContaining({
        resourceId: row.id,
        tenantId: 'tenant-dead',
        data: expect.objectContaining({ reason: 'tenant-deletion-retention-expired', objectsDeleted: 1, bucketRemoved: true, retentionDays: 45 }),
      }),
    );
  });

  it('also purges a DISABLED row and resumes a SUSPENDED one (an interrupted earlier run)', async () => {
    const disabled = bucketRow('attachments', ResourceStatusType.DISABLED);
    const suspended = bucketRow('recordings', ResourceStatusType.SUSPENDED);
    bucketRepo.findAllByTenant.mockResolvedValue([disabled, suspended]);
    factory.getProviderForBucket.mockResolvedValue(makeProvider({ [disabled.name]: [], [suspended.name]: ['x'] }));

    const result = await service.purgeExpired();

    expect(bucketRepo.softDelete).toHaveBeenCalledWith(disabled.id);
    expect(bucketRepo.softDelete).toHaveBeenCalledWith(suspended.id);
    expect(result.bucketsPurged).toBe(2);
  });

  it('never touches an ENABLED row (a restore racing the job wins)', async () => {
    bucketRepo.findAllByTenant.mockResolvedValue([bucketRow('recordings', ResourceStatusType.ENABLED)]);

    await service.purgeExpired();

    expect(factory.getProviderForBucket).not.toHaveBeenCalled();
    expect(bucketRepo.update).not.toHaveBeenCalled();
    expect(bucketRepo.softDelete).not.toHaveBeenCalled();
  });

  it('leaves the row SUSPENDED (to resume next run) when an object delete fails, and carries on with the next bucket', async () => {
    const bad = bucketRow('attachments', ResourceStatusType.ARCHIVED);
    const good = bucketRow('recordings', ResourceStatusType.ARCHIVED);
    bucketRepo.findAllByTenant.mockResolvedValue([bad, good]);
    const p = makeProvider({ [bad.name]: ['x'], [good.name]: ['y'] });
    p.deleteObject.mockImplementation(async ({ bucket, key }: { bucket: string; key: string }) => {
      if (bucket === bad.name) throw new Error('SlowDown');
      p._store.get(bucket)?.delete(key);
    });
    factory.getProviderForBucket.mockResolvedValue(p);

    const result = await service.purgeExpired();

    expect(bucketRepo.softDelete).not.toHaveBeenCalledWith(bad.id);
    expect(bucketRepo.softDelete).toHaveBeenCalledWith(good.id);
    expect(result).toMatchObject({ bucketsPurged: 1, bucketsFailed: 1 });
  });

  it('marks the row DELETED once its objects are gone even if the empty bucket cannot be removed, and says so', async () => {
    const row = bucketRow('recordings', ResourceStatusType.ARCHIVED);
    bucketRepo.findAllByTenant.mockResolvedValue([row]);
    const p = makeProvider({ [row.name]: ['x'] });
    p.deleteBucket.mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    factory.getProviderForBucket.mockResolvedValue(p);

    await service.purgeExpired();

    expect(bucketRepo.softDelete).toHaveBeenCalledWith(row.id);
    expect(events.emit).toHaveBeenCalledWith(
      SysEventType.ResourceDeleted,
      expect.objectContaining({ data: expect.objectContaining({ bucketRemoved: false, objectsDeleted: 1 }) }),
    );
  });

  it('treats a bucket that is already gone as purged (idempotent re-run)', async () => {
    const row = bucketRow('recordings', ResourceStatusType.SUSPENDED);
    bucketRepo.findAllByTenant.mockResolvedValue([row]);
    factory.getProviderForBucket.mockResolvedValue(makeProvider({}));

    const result = await service.purgeExpired();

    expect(bucketRepo.softDelete).toHaveBeenCalledWith(row.id);
    expect(result).toMatchObject({ bucketsPurged: 1, objectsDeleted: 0 });
  });

  for (const bad of [0, -1, 3651, 7.5, 'thirty']) {
    it(`skips the run entirely for an out-of-range retention window (${String(bad)}) rather than purging early`, async () => {
      settings[TENANT_STORAGE_RETENTION_DAYS_KEY] = bad;

      const result = await service.purgeExpired();

      expect(result.skipped).toBe('invalid-retention');
      expect(tenantRepo.findAll).not.toHaveBeenCalled();
    });
  }

  it('skips the run when another replica holds the purge lock', async () => {
    redis.eval.mockResolvedValue(null);

    const result = await service.purgeExpired();

    expect(result.skipped).toBe('locked');
    expect(tenantRepo.findAll).not.toHaveBeenCalled();
  });

  it('never writes an object key into a log line', async () => {
    const row = bucketRow('recordings', ResourceStatusType.ARCHIVED);
    bucketRepo.findAllByTenant.mockResolvedValue([row]);
    const p = makeProvider({ [row.name]: [SECRET_KEY] });
    p.deleteObject.mockRejectedValue(new Error(`failed on ${SECRET_KEY}`));
    factory.getProviderForBucket.mockResolvedValue(p);

    await service.purgeExpired();

    expect(JSON.stringify(logs)).not.toContain('jane-doe');
  });

  it('registers its cron job under the configured schedule', () => {
    service.syncSchedulerFromConfig();

    expect(scheduler.addCronJob).toHaveBeenCalledWith(TENANT_STORAGE_PURGE_JOB_NAME, expect.anything());
    (scheduler.addCronJob.mock.calls[0]![1] as { stop: () => void }).stop();
  });
});
