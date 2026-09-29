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
export const NON_RETRYABLE_PUBLISHER_CODES: ReadonlySet<string> = new Set([MODEL_STORE_CREDENTIAL_MISSING, STAGING_SPACE_INSUFFICIENT, MODEL_STORE_PREFIX_REFUSED]);
