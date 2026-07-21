/**
 * Rolling-monthly metering constants.
 *
 * The reconcile job PERSISTS per-(tenant, metric, window) snapshots into
 * `TenantUsageMeter` from Postgres aggregates. It ships OFF by default (like the
 * audit-retention purge): capability/usage READS are always a live aggregate
 * (`MeteringService.getCurrentUsage`) and therefore correct even with the job
 * off — the job only warms the persisted snapshot table (history + a future
 * fast-path). Keys are read through `IAppSettingsService` (DB-backed
 * `GlobalSetting` cache) so cron/enabled can be tuned live per-env.
 */
export const METERING_JOB_NAME = 'tenant-usage-meter-reconcile';

export const METERING_ENABLED_KEY = 'metering.reconcile.enabled';
export const METERING_CRON_KEY = 'metering.reconcile.cron';

export const METERING_DEFAULTS = {
  /** Snapshot persistence is opt-in per-env; reads never depend on it. */
  enabled: false,
  /** Every 15 minutes — "near-realtime" snapshot refresh cadence. */
  cron: '*/15 * * * *',
} as const;
