import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';
import { ResourceStatusType, ResourceType, SysEventType, TenantBucketEntity, TenantBucketRepository, TenantRepository } from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import type { IBlobStorageProvider } from '../../baseServices/storage/providers/IBlobStorageProvider';
import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import {
  TENANT_DELETION_RETAINED_STATUS,
  TENANT_STORAGE_PURGE_CRON_KEY,
  TENANT_STORAGE_PURGE_JOB_NAME,
  TENANT_STORAGE_PURGING_STATUS,
  TENANT_STORAGE_RETENTION_BOUNDS,
  TENANT_STORAGE_RETENTION_DAYS_KEY,
  TENANT_STORAGE_RETENTION_DEFAULTS,
  isWholeNumberWithin,
} from '../tenant-bucket-lifecycle.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LOCK_KEY = 'tenant-storage-purge:lock';
/** Longer than any realistic run; the lock is released explicitly at the end, this only bounds a crashed holder. */
const LOCK_TTL_SECONDS = 6 * 60 * 60;
/** Full list-and-delete passes per bucket before it is declared "not emptying" and left for the next run. */
const MAX_EMPTY_PASSES = 3;

/** Row statuses the purge takes: retained (ARCHIVED), already started (SUSPENDED), and admin-DISABLED rows, which hold data too. Never ENABLED. */
const PURGEABLE_STATUSES: ReadonlySet<string> = new Set([
  TENANT_DELETION_RETAINED_STATUS,
  TENANT_STORAGE_PURGING_STATUS,
  ResourceStatusType.DISABLED,
]);

export interface TenantStoragePurgeResult {
  /** Set when the run did nothing on purpose. */
  skipped?: 'invalid-retention' | 'locked';
  retentionDays: unknown;
  cutoff: Date | null;
  tenants: number;
  bucketsPurged: number;
  bucketsFailed: number;
  objectsDeleted: number;
}

/** A provider error that means "this bucket is not there" — the purge's end state already reached. */
function isMissingBucketError(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (error as { name?: string })?.name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchBucket' || name === 'ContainerNotFound';
}

/**
 * The error CLASS for a log line, never its message: provider messages can
 * quote the object key they failed on, and an object key can carry PHI.
 */
function errorClass(error: unknown): string {
  return (error as { name?: string })?.name ?? 'Error';
}

/**
 * TASK-1025 G2 (owner decision OD-2) — RETAIN, THEN PURGE ON SCHEDULE.
 *
 * Deleting a tenant moves its bucket rows to ARCHIVED (access cut, objects
 * kept; see `TenantBucketService.retainForTenantDeletion`). This job purges
 * them once the tenant has been deleted for longer than the platform setting
 * `storage.tenantDeletion.retentionDays` (default 30):
 *
 *   ARCHIVED ─(job starts)→ SUSPENDED ─(objects + bucket removed)→ DELETED
 *
 * SUSPENDED is the "purge in progress" state: never restorable (some objects
 * may already be gone), and resumed by the next run if this one stops part-way.
 * So the job is idempotent and safe to re-run — a bucket already gone counts as
 * purged, a row already DELETED is no longer listed.
 *
 * Self-scheduling like `AuditRetentionService`: the cron is read from
 * `storage.tenantDeletion.purgeCron` and re-synced on every settings-cache
 * refresh. There is no `enabled` switch: the owner decided deleted tenants'
 * storage IS purged, and the window is the control. Several gateway replicas
 * each schedule it; a Redis lock keeps one run at a time (without Redis the
 * runs overlap harmlessly — every step is idempotent).
 *
 * Object operations go through the PROVIDER FACTORY, not `BlobStorageService`:
 * the latter refuses these buckets by design (that is the access cut).
 *
 * PHI: object keys are never logged — counts, bucket names and error classes only.
 */
@Injectable()
export class TenantStoragePurgeService extends BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantStoragePurgeService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantRepository: TenantRepository,
    private readonly tenantBucketRepository: TenantBucketRepository,
    private readonly providerFactory: BlobStorageProviderFactory,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantBucket);
  }

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  syncSchedulerFromConfig(): void {
    const cron = this.appSettings.getValueWithDefault<string>(TENANT_STORAGE_PURGE_CRON_KEY, TENANT_STORAGE_RETENTION_DEFAULTS.purgeCron);
    if (cron === this.activeCron) return;
    this.stopJob();
    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledPurge();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.schedulerRegistry.addCronJob(TENANT_STORAGE_PURGE_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;
      this.logger.log({ message: 'Deleted-tenant storage purge scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({ message: 'Failed to schedule the deleted-tenant storage purge', cron, error: errorClass(error) });
    }
  }

  async handleScheduledPurge(): Promise<void> {
    try {
      const result = await this.purgeExpired();
      this.logger.log({ message: 'Deleted-tenant storage purge finished', ...result, cutoff: result.cutoff?.toISOString() ?? null });
    } catch (error) {
      this.logger.error({ message: 'Deleted-tenant storage purge failed', error: errorClass(error) });
    }
  }

  /** One purge pass over every tenant deleted longer ago than the retention window. */
  async purgeExpired(): Promise<TenantStoragePurgeResult> {
    const retentionDays = this.appSettings.getValueWithDefault<unknown>(
      TENANT_STORAGE_RETENTION_DAYS_KEY,
      TENANT_STORAGE_RETENTION_DEFAULTS.retentionDays,
    );
    const result: TenantStoragePurgeResult = { retentionDays, cutoff: null, tenants: 0, bucketsPurged: 0, bucketsFailed: 0, objectsDeleted: 0 };

    // Refuse, never clamp: a window that reached the job out of bounds (a row
    // written around the registry's validation) must not purge PHI early.
    if (!isWholeNumberWithin(retentionDays, TENANT_STORAGE_RETENTION_BOUNDS.minDays, TENANT_STORAGE_RETENTION_BOUNDS.maxDays)) {
      this.logger.error({ message: 'Deleted-tenant storage retention window is out of bounds; purge skipped', retentionDays });
      return { ...result, skipped: 'invalid-retention' };
    }

    if (!(await this.acquireLock())) {
      this.logger.log({ message: 'Deleted-tenant storage purge already running on another replica; skipped' });
      return { ...result, skipped: 'locked' };
    }

    try {
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
      result.cutoff = cutoff;
      const tenants = await this.tenantRepository.findAll({
        filters: { resourceStatus: ResourceStatusType.DELETED, resourceStatusUpdatedAt: { lt: cutoff } },
      });
      result.tenants = tenants.length;

      for (const tenant of tenants) {
        await this.runAsWorker(tenant.id, async () => {
          const rows = await this.tenantBucketRepository.findAllByTenant(tenant.id, { includeDisabled: true });
          for (const row of rows) {
            if (!row.resourceStatus || !PURGEABLE_STATUSES.has(row.resourceStatus)) continue;
            const outcome = await this.purgeBucket(row, tenant.resourceStatusUpdatedAt ?? null, retentionDays);
            if (outcome.ok) {
              result.bucketsPurged += 1;
            } else {
              result.bucketsFailed += 1;
            }
            result.objectsDeleted += outcome.objectsDeleted;
          }
        });
      }
      return result;
    } finally {
      await this.releaseLock();
    }
  }

  private async purgeBucket(
    row: TenantBucketEntity,
    tenantDeletedAt: Date | null,
    retentionDays: number,
  ): Promise<{ ok: boolean; objectsDeleted: number }> {
    let objectsDeleted = 0;
    try {
      if (row.resourceStatus !== TENANT_STORAGE_PURGING_STATUS) {
        row.suspend();
        await this.tenantBucketRepository.update(row.id, row);
        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
          resourceId: row.id,
          data: { name: row.name, slug: row.slug, resourceStatus: TENANT_STORAGE_PURGING_STATUS, reason: 'tenant-deletion-purge-started' },
        });
      }

      const provider = await this.providerFactory.getProviderForBucket(row.tenantId, row.name);
      objectsDeleted = await this.emptyBucket(provider, row.name);
      const bucketRemoved = await this.removeBucket(provider, row.name);

      // The objects are gone, so the row must not claim otherwise — even when
      // the (now empty) bucket itself could not be removed.
      await this.tenantBucketRepository.softDelete(row.id);
      this.broadcastSysEvent(SysEventType.ResourceDeleted, {
        resourceId: row.id,
        data: {
          name: row.name,
          slug: row.slug,
          reason: 'tenant-deletion-retention-expired',
          tenantDeletedAt: tenantDeletedAt ? tenantDeletedAt.toISOString() : null,
          retentionDays,
          objectsDeleted,
          bucketRemoved,
        },
      });
      this.logger.log({ message: 'Purged a deleted tenant bucket', tenantId: row.tenantId, bucketName: row.name, objectsDeleted, bucketRemoved });
      return { ok: true, objectsDeleted };
    } catch (error) {
      this.logger.error({
        message: 'Could not finish purging a deleted tenant bucket; it stays SUSPENDED and the next run resumes it',
        tenantId: row.tenantId,
        bucketName: row.name,
        objectsDeleted,
        error: errorClass(error),
      });
      return { ok: false, objectsDeleted };
    }
  }

  /** Delete every object; returns how many. A bucket already gone is empty. */
  private async emptyBucket(provider: IBlobStorageProvider, bucket: string): Promise<number> {
    let deleted = 0;
    for (let pass = 0; pass < MAX_EMPTY_PASSES; pass += 1) {
      let token: string | undefined;
      let seen = 0;
      do {
        let page;
        try {
          page = await provider.listObjects({ bucket, continuationToken: token, maxKeys: 1000 });
        } catch (error) {
          if (isMissingBucketError(error)) return deleted;
          throw error;
        }
        for (const object of page.objects) {
          await provider.deleteObject({ bucket, key: object.key });
          deleted += 1;
        }
        seen += page.objects.length;
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      if (seen === 0) return deleted;
    }
    throw Object.assign(new Error('Bucket is still receiving objects after repeated purge passes'), { name: 'BucketNotEmptying' });
  }

  /** `true` when the bucket is gone afterwards. A refusal (e.g. no `s3:DeleteBucket`) is logged, not raised. */
  private async removeBucket(provider: IBlobStorageProvider, bucket: string): Promise<boolean> {
    try {
      await provider.deleteBucket(bucket);
      return true;
    } catch (error) {
      if (isMissingBucketError(error)) return true;
      this.logger.error({
        message: 'Purged every object but could not remove the empty bucket; it will show as an unregistered physical bucket',
        bucketName: bucket,
        error: errorClass(error),
      });
      return false;
    }
  }

  /** Tenant-scoped reads/writes and sys-event attribution need the deleted tenant in CLS. */
  private async runAsWorker(tenantId: string, work: () => Promise<void>): Promise<void> {
    await this.clsService.run(async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId, kind: 'tenant-storage-purge' }));
      try {
        await work();
      } catch (error) {
        this.logger.error({ message: 'Deleted-tenant storage purge failed for a tenant', tenantId, error: errorClass(error) });
      }
    });
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const reply = await this.redis.eval("return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])", 1, LOCK_KEY, 'held', LOCK_TTL_SECONDS);
      return reply === 'OK';
    } catch (error) {
      // Every step is idempotent, so an overlapping run is wasteful, not harmful.
      this.logger.warn({ message: 'Purge lock unavailable; running without it', error: errorClass(error) });
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(LOCK_KEY).catch(() => undefined);
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(TENANT_STORAGE_PURGE_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(TENANT_STORAGE_PURGE_JOB_NAME);
      }
    } catch {
      // No job registered — nothing to stop.
    }
    this.activeCron = null;
  }
}
