// TASK-1025 — tenant bucket lifecycle: retention after tenant deletion (G2)
// and the app-side storage quota check (G3).
//
// Dependency-free on purpose (enums only): the blob-storage gate in
// `baseServices/storage`, the tenant-bucket service, the purge job and the
// settings descriptors all read these, and none of them may pull another's
// module graph in to do it.

import { ResourceStatusType } from '@arcaai/domains';

// ── G2 — retain, then purge on schedule (owner decision OD-2) ───────────────

/**
 * Status a tenant's ENABLED bucket rows move to when the TENANT is
 * soft-deleted: access is cut, objects are kept. Restoring the tenant within
 * the retention window moves them back to ENABLED.
 */
export const TENANT_DELETION_RETAINED_STATUS = ResourceStatusType.ARCHIVED;

/**
 * Status a retained row moves to the moment the purge job starts on it. It is
 * NOT restorable: some of its objects may already be gone, and a restore must
 * never present a half-emptied bucket as the tenant's data. The row reaches
 * DELETED once the purge completes; a run that fails part-way leaves it here
 * and the next run resumes it.
 */
export const TENANT_STORAGE_PURGING_STATUS = ResourceStatusType.SUSPENDED;

/** Bucket row statuses every data-plane path refuses (404, never the objects). */
export const TENANT_BUCKET_INACCESSIBLE_STATUSES: ReadonlySet<string> = new Set([TENANT_DELETION_RETAINED_STATUS, TENANT_STORAGE_PURGING_STATUS]);

export const TENANT_STORAGE_RETENTION_DAYS_KEY = 'storage.tenantDeletion.retentionDays';
export const TENANT_STORAGE_PURGE_CRON_KEY = 'storage.tenantDeletion.purgeCron';

export const TENANT_STORAGE_RETENTION_DEFAULTS = {
  /** Owner decision OD-2: 30 days. */
  retentionDays: 30,
  /** Daily, 04:15 UTC — off the hour and clear of the 02:15 storage snapshot and 03:00 audit retention. */
  purgeCron: '15 4 * * *',
} as const;

/** Bounds on the retention window. Out-of-bounds values are refused by the write lane AND skipped by the job. */
export const TENANT_STORAGE_RETENTION_BOUNDS = { minDays: 1, maxDays: 3650 } as const;

/** Name the purge job registers under in the SchedulerRegistry. */
export const TENANT_STORAGE_PURGE_JOB_NAME = 'tenant-storage-purge';

// ── G3 — app-side quota across BOTH system buckets (owner decision OD-3) ────

export const TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY = 'storage.tenantQuota.usageCacheSeconds';

export const TENANT_STORAGE_QUOTA_DEFAULTS = {
  /**
   * How long a measured per-tenant usage figure is reused before the two
   * system buckets are listed again. Uploads made through the gateway add to
   * the cached figure immediately, so this only bounds how late bytes written
   * OUTSIDE the gateway (the STT worker) are noticed.
   */
  usageCacheSeconds: 300,
} as const;

export const TENANT_STORAGE_USAGE_CACHE_BOUNDS = { minSeconds: 0, maxSeconds: 86_400 } as const;

/** Whole number within [min, max]; the shared shape of both bounded knobs above. */
export function isWholeNumberWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
