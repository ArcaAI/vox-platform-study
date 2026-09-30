import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  PlanEntitlementRepository,
  TenantBucketRepository,
  TenantBucketType,
  TenantEntitlementRepository,
  TenantPlan,
  TenantRepository,
} from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { IAppSettingsService } from '../_meta/appSettings/IAppSettingsService';
import { IRedisCacheService } from '../redis/redis-cache.service';
import { BlobStorageProviderFactory } from './providers/blob-storage.provider.factory';
// Leaf files only (never the `entitlements` barrel): its module file imports
// TenantBucketServiceModule, which depends on this gate through BlobStorageService.
import {
  ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT,
  ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
  entitlementsEnabledKey,
} from '../../entitlements/entitlements.constants';
import { wouldExceedLimit } from '../../entitlements/enforcement';
import { effectivePlan, resolveEntitlements } from '../../entitlements/resolve-entitlements';
import {
  TENANT_BUCKET_INACCESSIBLE_STATUSES,
  TENANT_STORAGE_QUOTA_DEFAULTS,
  TENANT_STORAGE_USAGE_CACHE_BOUNDS,
  TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY,
  isWholeNumberWithin,
} from '../../tenant-bucket/tenant-bucket-lifecycle.constants';

/** The bucket row facts the gate acts on. */
export interface GatedBucket {
  name: string;
  tenantId: string;
  bucketType?: string | null;
  resourceStatus?: string | null;
}

const USAGE_KEY_PREFIX = 'tenant-storage-usage:';
/** Adds to a cached usage figure only if one exists — a missing key must be MEASURED, never started from zero. */
const INCR_IF_CACHED = "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCRBY', KEYS[1], ARGV[1]) end return nil";

/**
 * TASK-1025 — the tenant-bucket checks that must hold on EVERY object
 * operation, applied once, at {@link BlobStorageService}: the one chokepoint the
 * storage controller, the transcription upload path and the tenant-bucket
 * service all go through by bucket NAME.
 *
 * G2 (owner decision OD-2): a bucket retained after its tenant was deleted
 * (ARCHIVED) or one the purge job is emptying (SUSPENDED) is refused with a
 * 404 — the objects are kept, but nothing reaches them. Not cached: "access is
 * cut the moment the tenant is deleted" must hold on every replica at once, and
 * the lookup is a single indexed read of a globally unique name.
 *
 * G3 (owner decision OD-3): before an upload or a presigned PUT into one of a
 * tenant's two SYSTEM buckets, the tenant's usage across BOTH is checked
 * against its resolved plan `storageQuotaBytes`. This is the
 * `IEntitlementsService.assertQuantityQuota` pattern — same kill-switch
 * (`entitlements.enabled`), same resolver (seeded plan ← plan row ← tenant
 * override), same `QuotaExceededException` (409) and quota-blocked event —
 * built from the entitlements module's pure parts, because the service itself
 * cannot be injected here (it depends, through TenantService, on this gate).
 *
 * Usage is MEASURED by listing the two buckets and cached per tenant in Redis
 * for `storage.tenantQuota.usageCacheSeconds` (default 300). Every upload made
 * through the gateway adds its bytes to the cached figure at once, so the
 * listing runs at most once per window per tenant, not per upload; a delete
 * drops the figure (usage can only have shrunk). What the cache cannot see
 * until it expires is bytes written OUTSIDE the gateway (the STT worker
 * writing recordings straight to the store). Like `assertMeterQuota`, the
 * check FAILS OPEN when usage cannot be measured: a storage hiccup must not
 * block a clinical upload.
 */
@Injectable()
export class TenantBucketStorageGate {
  private readonly logger = new Logger(TenantBucketStorageGate.name);

  constructor(
    @Optional() private readonly bucketRepo?: TenantBucketRepository,
    @Optional() private readonly tenantRepo?: TenantRepository,
    @Optional() private readonly planEntitlementRepo?: PlanEntitlementRepository,
    @Optional() private readonly tenantEntitlementRepo?: TenantEntitlementRepository,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
    @Optional() private readonly providerFactory?: BlobStorageProviderFactory,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
  ) {}

  /** G2 — refuse an object operation on a bucket that is retained or being purged. Returns the row, if any. */
  async assertAccessible(bucketName: string): Promise<GatedBucket | null> {
    const row = await this.lookup(bucketName);
    if (row?.resourceStatus && TENANT_BUCKET_INACCESSIBLE_STATUSES.has(row.resourceStatus)) {
      throw new NotFoundException(`Bucket ${bucketName} not found`);
    }
    return row;
  }

  /**
   * G2 + G3 — before writing `bytes` (a presigned PUT, whose size is unknown,
   * passes 1: it is refused once the tenant is AT its quota).
   */
  async assertCanWrite(bucketName: string, bytes: number): Promise<GatedBucket | null> {
    const row = await this.assertAccessible(bucketName);
    if (row && this.isQuotaCovered(row)) {
      await this.assertWithinQuota(row.tenantId, bytes);
    }
    return row;
  }

  /** G3 — after a successful gateway upload: add it to the tenant's cached usage (no-op when nothing is cached). */
  async recordWrite(row: GatedBucket | null, bytes: number): Promise<void> {
    if (!row || !this.redis || !this.isQuotaCovered(row)) return;
    try {
      await this.redis.eval(INCR_IF_CACHED, 1, `${USAGE_KEY_PREFIX}${row.tenantId}`, bytes);
    } catch {
      // A stale figure only delays the next measurement; never fail the upload that already succeeded.
    }
  }

  /** G3 — after a delete from a system bucket, drop the cached figure so the next upload re-measures. */
  async recordDelete(row: GatedBucket | null): Promise<void> {
    if (!row || !this.redis || !this.isQuotaCovered(row)) return;
    await this.redis.del(`${USAGE_KEY_PREFIX}${row.tenantId}`).catch(() => undefined);
  }

  /** The plan quota covers a tenant's SYSTEM buckets: `hope-attachments-<key>` and `hope-recordings-<key>`. */
  private isQuotaCovered(row: GatedBucket): boolean {
    return row.bucketType === TenantBucketType.SYSTEM;
  }

  private async assertWithinQuota(tenantId: string, bytes: number): Promise<void> {
    if (!this.appSettings || !this.tenantRepo || !this.planEntitlementRepo || !this.tenantEntitlementRepo || !this.providerFactory) return;
    if (!this.appSettings.getValueWithDefault<boolean>(entitlementsEnabledKey(), ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT)) return;

    let limit: number | null;
    let used: number;
    try {
      limit = await this.resolveQuota(tenantId);
      if (limit === null) return; // no quota configured = unlimited
      used = await this.usage(tenantId);
    } catch (error) {
      this.logger.error({
        message: 'Tenant storage quota check skipped: usage or quota could not be read (failing open)',
        tenantId,
        error: error instanceof Error ? error.name : String(error),
      });
      return;
    }

    if (!wouldExceedLimit(limit, used, bytes)) return;

    this.eventEmitter?.emit(ENTITLEMENTS_QUOTA_BLOCKED_EVENT, {
      tenantId,
      capability: 'storageQuotaBytes',
      limit,
      used,
      requested: bytes,
      at: new Date(),
    });
    throw new QuotaExceededException(
      `Storage quota reached (${used}/${limit} bytes across the tenant's attachments and recordings buckets). ` +
        'Existing files are unaffected — delete files, or raise the plan or per-tenant override, to upload more.',
      { capability: 'storageQuotaBytes', limit, used, requested: bytes, tenantId },
    );
  }

  /** The tenant's resolved `storageQuotaBytes` — the same three layers `EntitlementsService.resolveForTenant` merges. */
  private async resolveQuota(tenantId: string): Promise<number | null> {
    const tenant = await this.tenantRepo!.findById(tenantId);
    const plan = effectivePlan(tenantId, tenant.plan as TenantPlan | null | undefined);
    const planRow = plan ? await this.planEntitlementRepo!.findByPlan(plan) : null;
    const override = await this.tenantEntitlementRepo!.findByTenant(tenantId);
    return resolveEntitlements(plan, planRow, override).limits.storageQuotaBytes;
  }

  /** Bytes held across the tenant's system buckets — cached, or measured and cached. */
  private async usage(tenantId: string): Promise<number> {
    const key = `${USAGE_KEY_PREFIX}${tenantId}`;
    const ttl = this.usageCacheSeconds();
    if (this.redis && ttl > 0) {
      const cached = await this.redis.get(key).catch(() => null);
      if (cached !== null && cached !== undefined && Number.isFinite(Number(cached))) return Number(cached);
    }

    const used = await this.measure(tenantId);
    if (this.redis && ttl > 0) {
      await this.redis.setex(key, ttl, String(used)).catch(() => undefined);
    }
    return used;
  }

  private async measure(tenantId: string): Promise<number> {
    const buckets = await this.bucketRepo!.findSystemBuckets(tenantId);
    let total = 0;
    for (const bucket of buckets) {
      const provider = await this.providerFactory!.getProviderForBucket(tenantId, bucket.name);
      let token: string | undefined;
      do {
        const page = await provider.listObjects({ bucket: bucket.name, continuationToken: token });
        for (const object of page.objects) total += object.size ?? 0;
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
    }
    return total;
  }

  private usageCacheSeconds(): number {
    const value = this.appSettings?.getValueWithDefault<unknown>(
      TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY,
      TENANT_STORAGE_QUOTA_DEFAULTS.usageCacheSeconds,
    );
    return isWholeNumberWithin(value, TENANT_STORAGE_USAGE_CACHE_BOUNDS.minSeconds, TENANT_STORAGE_USAGE_CACHE_BOUNDS.maxSeconds)
      ? value
      : TENANT_STORAGE_QUOTA_DEFAULTS.usageCacheSeconds;
  }

  /**
   * The bucket's row in ANY live status. `TenantBucketRepository.findByName`
   * answers ENABLED rows only, so it would miss exactly the rows G2 refuses;
   * the soft-delete extension still hides DELETED ones.
   *
   * A lookup FAILURE does not gate: the tenant-scope extension refuses a
   * tenant-scoped read from a context with no tenant and no platform role (a
   * background worker), and those paths predate this gate. It is logged — with
   * the bucket name only, never an object key.
   */
  private async lookup(bucketName: string): Promise<GatedBucket | null> {
    if (!this.bucketRepo) return null;
    try {
      const rows = await this.bucketRepo.findAll({ filters: { name: bucketName } });
      return (rows[0] as GatedBucket | undefined) ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Tenant bucket lookup failed; object operation not gated',
        bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
