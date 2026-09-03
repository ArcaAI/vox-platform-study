import { AiUsageUnit, UsageMeterMetric } from '@arcaai/domains';

/**
 * Shadow-metering report job.
 *
 * research-findings.md: "shadow-meter one full billing cycle before
 * enforcing anything … alert on drift > 2%". This job never enforces
 * anything itself — it is read-only, comparing three surfaces that should
 * agree within tolerance:
 *   1. Ledger totals (`AiUsageRollupDaily` — the system of record, same
 *      source `MeteringService` reads).
 *   2. `SummaryMeta` token-column sums (LLM only — the prior legacy
 *      capture path, kept as an independent cross-check).
 *   3. Persisted `TenantUsageMeter` rows (catches a stalled/failed reconcile
 *      job — a stale snapshot IS a drift even though it is computed from the
 *      same rollup table, because it is written at a past point in time).
 *
 * Same self-scheduling shape as {@link MeteringService} /
 * `AuditRetentionService`: config from `IAppSettingsService`, re-synced on
 * `app-settings.cache-refreshed`, OFF by default (a report job with zero
 * consumers should never surprise an operator by running).
 */
export const SHADOW_METERING_JOB_NAME = 'usage-shadow-metering-report';

export const SHADOW_METERING_ENABLED_KEY = 'metering.shadowReport.enabled';
export const SHADOW_METERING_CRON_KEY = 'metering.shadowReport.cron';

export const SHADOW_METERING_DEFAULTS = {
  enabled: false,
  /** Once a day at 04:00 UTC — a report job, not a hot path. */
  cron: '0 4 * * *',
} as const;

/** research-findings.md — the alert threshold, restated here for the settings description. */
export const SHADOW_METERING_DRIFT_THRESHOLD_PCT = 2;

/** The event name emitted (via `EventEmitter2`) when any comparison in a tenant's report breaches. Mirrors `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` — a narrow, purpose-built payload, not a full `SysEvent`. No consumer is wired in this lane (owns the reconciliation folder only, not `sysEvent.service.ts`); a future subscriber can persist an audit row the same way `handleEntitlementsQuotaBlockedEvent` does. */
export const SHADOW_METERING_DRIFT_DETECTED_EVENT = 'metering.shadow-drift-detected';

/**
 * Emitted when a PROVIDER's own usage/cost report disagrees with the ledger by
 * more than the threshold (rule 5). Alert-only by design: the
 * append-only ledger is corrected by a compensating event after a human looks,
 * never by the reconciler assuming the vendor is right.
 */
export const PROVIDER_DRIFT_DETECTED_EVENT = 'metering.provider-drift-detected';

/** The six ledger-derived `UsageMeterMetric` values `MeteringService.reconcileTenant` persists — the shadow report re-derives the same live aggregate and diffs it against the persisted snapshot. */
export const RECONCILED_METER_METRICS: UsageMeterMetric[] = [
  UsageMeterMetric.STT_SESSION_SECONDS,
  UsageMeterMetric.LLM_TOKENS,
  UsageMeterMetric.TTS_CHARACTERS,
  UsageMeterMetric.NLP_TEXT_UNITS,
  UsageMeterMetric.GUARDRAIL_CALLS,
  UsageMeterMetric.EMBEDDING_TOKENS,
] as const;

/** All five billable token kinds — mirrors `MeteringService`'s `TOKEN_UNITS` (kept local: that constant is not exported). */
export const SHADOW_TOKEN_UNITS: AiUsageUnit[] = [
  AiUsageUnit.INPUT_TOKEN,
  AiUsageUnit.OUTPUT_TOKEN,
  AiUsageUnit.CACHE_READ_TOKEN,
  AiUsageUnit.CACHE_WRITE_TOKEN,
  AiUsageUnit.REASONING_TOKEN,
];
