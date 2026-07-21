/**
 * (Q4 trial-expiry + Q10 downgrade) — lifecycle-job constants.
 *
 * The trial-expiry job flips `plan = STARTER` for every tenant whose trial
 * clock has elapsed (`trialEndsAt <= now`) — a PURE plan change, leaving
 * `resourceStatus` untouched (proposal §4). It ships OFF by default and is
 * scheduled exactly like the metering reconcile / audit-retention purge:
 * cron + enabled read live off `IAppSettingsService`, re-synced on
 * `app-settings.cache-refreshed`.
 *
 * The downgrade action (Q10) is a separate, explicit super-admin trigger — NOT
 * scheduled — that additionally SOFT-DISABLES newest-first overflow resources
 * (reversible status flip, never a delete), gated behind the enforcement
 * kill-switch.
 */

/** `SchedulerRegistry` key for the self-scheduling trial-expiry cron. */
export const TRIAL_EXPIRY_JOB_NAME = 'entitlements-trial-expiry';

export const TRIAL_EXPIRY_ENABLED_KEY = 'entitlements.trial-expiry.enabled';
export const TRIAL_EXPIRY_CRON_KEY = 'entitlements.trial-expiry.cron';

export const TRIAL_EXPIRY_DEFAULTS = {
  /** OFF by default — like every other entitlements kill-switch knob. */
  enabled: false,
  /** Hourly on the hour — trial windows are day-scale, so hourly is ample. */
  cron: '0 * * * *',
} as const;

/**
 * Domain event emitted when the trial-expiry job downgrades a tenant
 * TRIAL → STARTER. A named event (subscribers persist it to `AuditLog`)
 * complementing the `SysEventType.ResourceUpdated` broadcast.
 */
export const ENTITLEMENTS_TRIAL_EXPIRED_EVENT = 'entitlements.trial-expired';

/**
 * Domain event emitted when an explicit downgrade action soft-disables
 * newest-first overflow resources (Q10). Carries the disabled ids per
 * capability so the audit trail records exactly what was reclaimed.
 */
export const ENTITLEMENTS_DOWNGRADE_APPLIED_EVENT = 'entitlements.downgrade-applied';
