import { JobQueue } from '@arcaai/domains';

/**
 * Outbox-drainer tuning.
 *
 * Retry state lives on the OUTBOX ROW (`attempts` / `availableAt` / `lastError`)
 * rather than in BullMQ's job options. That is 's design and it is the right
 * one: retry state survives a Redis flush, a worker redeploy and a queue rename,
 * none of which a money pipeline should be able to lose. BullMQ here is a
 * scheduler and a cross-replica lock, not the retry mechanism.
 */

/**
 * BullMQ queue name.
 *
 * Promoted into the shared `JobQueue` enum home (`@arcaai/domains`) per the
 * WS-B handoff — the value is unchanged
 * (`'AiUsageOutboxDrain'`), only the source of truth moved so a rename of one
 * can never silently drift from the other. `BullModule.forRootAsync` is
 * registered globally by `RedisServiceModule`, so `registerQueue` here still
 * binds to the same connection regardless of where the name comes from.
 */
export const USAGE_OUTBOX_QUEUE = JobQueue.AiUsageOutboxDrain;

/** Job name for the periodic sweep. */
export const USAGE_OUTBOX_DRAIN_JOB = 'drain';

/** Rows claimed per sweep. */
export const DEFAULT_DRAIN_BATCH_SIZE = 200;

/** First retry delay; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 30_000;

/** Backoff ceiling — a stuck row is still reattempted within the half hour. */
export const RETRY_MAX_DELAY_MS = 1_800_000;

/**
 * Attempts before a row is parked as FAILED.
 *
 * With the schedule above that is roughly three hours of retrying, which
 * comfortably outlasts a database failover or a deploy. Beyond that the fault is
 * not transient and a human should look; the row is evidence, not garbage, so it
 * is parked rather than dropped.
 */
export const MAX_DRAIN_ATTEMPTS = 8;

/** `lastError` is a diagnostic, never a payload dump. */
export const MAX_LAST_ERROR_LENGTH = 500;

// ── scheduler (AppSettings keys + defaults) ─────────────────────────────────

/** Master switch. ON by default: a ledger nobody drains is worse than no ledger. */
export const DRAIN_ENABLED_KEY = 'metering.outbox.drain.enabled';

/** Sweep interval in seconds. */
export const DRAIN_INTERVAL_SECONDS_KEY = 'metering.outbox.drain.intervalSeconds';

export const DRAIN_DEFAULTS = {
  enabled: true,
  intervalSeconds: 30,
} as const;

// ── DISPATCHED-outbox pruning (the WS-B handoff item) ───────
//
// A `DISPATCHED` outbox row has already produced its `AiUsageEvent` (or been
// permanently unrated) — it is a completed work item, not history. Pruning it
// bounds `AiUsageOutbox` growth the same way `AuditRetentionService` bounds
// `AuditLog` growth: a scheduled hard delete behind an OFF-by-default kill
// switch and a configurable retention window.

/** Master switch. OFF by default: pruning is a HARD delete, so an operator opts in explicitly (mirrors `audit-retention.enabled`). */
export const PRUNE_ENABLED_KEY = 'metering.outbox.prune.enabled';

export const PRUNE_CRON_KEY = 'metering.outbox.prune.cron';

/** How long a DISPATCHED row survives before it is eligible for deletion. */
export const PRUNE_RETENTION_DAYS_KEY = 'metering.outbox.prune.retentionDays';

export const PRUNE_DEFAULTS = {
  enabled: false,
  /** Once a day at 03:30 UTC — 30 minutes offset from `AuditRetentionService`'s 03:00 purge so the two maintenance jobs don't contend. */
  cron: '30 3 * * *',
  /** research-findings.md: "Compress raw events after ~7 days" — the outbox row's job (durable at-least-once delivery) is done well before that; 7 days keeps a short operational window for post-incident inspection. */
  retentionDays: 7,
} as const;

export const PRUNE_JOB_NAME = 'usage-outbox-prune';

/** Rows deleted per batch — same shape as `AuditRetentionService`'s batched purge (bounds a single transaction's lock footprint). */
export const PRUNE_BATCH_SIZE = 1000;

/** Caps a single scheduled tick's batch count, same purpose as `AuditRetentionService`'s `maxBatchesPerRun`. */
export const PRUNE_MAX_BATCHES_PER_RUN = 1000;
