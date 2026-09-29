/**
 * Coded failures of the model publisher (TASK-1019 lane P).
 *
 * The code leads the message (`<CODE>: <detail>`) because the message is what
 * lands in `AiModel._metadata.download.error` / `_metadata.unregister.error`,
 * and a reader of that string must be able to tell a configuration refusal
 * from a network fault without parsing prose.
 */

/** The publisher's own bucket credential (env-tier, publisher pod only — D-2 / C3) is not set. Never falls back. */
export const MODEL_STORE_CREDENTIAL_MISSING = 'MODEL_STORE_CREDENTIAL_MISSING';

/** The files to publish do not fit the staging directory's free space (D-3 pre-flight). */
export const STAGING_SPACE_INSUFFICIENT = 'STAGING_SPACE_INSUFFICIENT';

/** A bucket prefix that must never be deleted (empty, root, or not a directory). */
export const MODEL_STORE_PREFIX_REFUSED = 'MODEL_STORE_PREFIX_REFUSED';

/**
 * A Hub download received no byte for the idle window (I7). RETRYABLE — a dead
 * connection is exactly what the next attempt fixes.
 */
export const DOWNLOAD_IDLE_TIMEOUT = 'DOWNLOAD_IDLE_TIMEOUT';

/**
 * The worker's own re-check found a live referrer (an agent, fallback, routing
 * or residency policy, voice profile) bound AFTER the gateway accepted the
 * unregister — the row and its weights are kept (I9).
 */
export const MODEL_IN_USE = 'MODEL_IN_USE';

export class ModelPublisherError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ModelPublisherError';
  }
}

/**
 * Codes a retry can never fix — the processor fails such a job without
 * spending its remaining BullMQ attempts.
 */
export const NON_RETRYABLE_PUBLISHER_CODES: ReadonlySet<string> = new Set([
  MODEL_STORE_CREDENTIAL_MISSING,
  STAGING_SPACE_INSUFFICIENT,
  MODEL_STORE_PREFIX_REFUSED,
  MODEL_IN_USE,
]);

/** A coded publisher failure no retry can fix (see `NON_RETRYABLE_PUBLISHER_CODES`). */
export function isNonRetryablePublisherError(error: unknown): error is ModelPublisherError {
  return error instanceof ModelPublisherError && NON_RETRYABLE_PUBLISHER_CODES.has(error.code);
}
