/**
 * Outbox-drainer tuning (TASK-615 WS-B).
 *
 * Retry state lives on the OUTBOX ROW (`attempts` / `availableAt` / `lastError`)
 * rather than in BullMQ's job options. That is WS-A's design and it is the right
 * one: retry state survives a Redis flush, a worker redeploy and a queue rename,
 * none of which a money pipeline should be able to lose. BullMQ here is a
 * scheduler and a cross-replica lock, not the retry mechanism.
 */

/**
 * BullMQ queue name.
 *
 * Deliberately NOT added to `JobQueue` in `@arcaai/domains`: that enum is WS-A's
 * file and this lane does not edit another lane's package. A local literal works
 * because `BullModule.forRootAsync` is registered globally by
 * `RedisServiceModule` — `registerQueue` here binds to the same connection. If a
 * later ticket wants it in the shared enum, that is a one-line move.
 */
export const USAGE_OUTBOX_QUEUE = 'AiUsageOutboxDrain';

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
