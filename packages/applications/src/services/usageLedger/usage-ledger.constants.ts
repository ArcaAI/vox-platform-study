import { JobQueue } from '@arcaai/domains';

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
 * Promoted into the shared `JobQueue` enum home (`@arcaai/domains`) per the
 * WS-B handoff (TASK-615 WS-D2 item 4c) — the value is unchanged
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
