/**
 * The two `global-kv` knobs that bound a HUNG transfer in the model-publisher
 * worker (TASK-1019 I7). Liveness used to be time-based — a half-open socket
 * kept the job, and the whole concurrency-1 queue behind it, alive forever.
 *
 *   idleTimeoutSeconds     a Hub download that receives no byte for this long
 *                          is aborted (`DOWNLOAD_IDLE_TIMEOUT`, retryable);
 *   requestTimeoutSeconds  one request of the publisher's S3 client (a part
 *                          upload, a put, a delete) that takes longer fails.
 *
 * A LEAF module — the settings descriptors import these keys, so this file
 * must not pull in Nest, BullMQ or a repository.
 */
export const MODEL_PUBLISHER_TIMEOUT_KEYS = {
  idleTimeoutSeconds: 'modelRegistry.download.idleTimeoutSeconds',
  requestTimeoutSeconds: 'modelRegistry.download.requestTimeoutSeconds',
} as const;

export const MODEL_PUBLISHER_TIMEOUT_DEFAULTS = {
  idleTimeoutSeconds: 120,
  requestTimeoutSeconds: 600,
} as const;

/** Below this a timeout would fire on an ordinary network hiccup. */
export const MODEL_PUBLISHER_TIMEOUT_MIN_SECONDS = 10;

export interface ModelPublisherTimeouts {
  idleTimeoutMs: number;
  requestTimeoutMs: number;
}

/** The subset of `IAppSettingsService` this reads — a synchronous, cache-backed lookup. */
export interface PublisherTimeoutSettingsSource {
  getValueWithDefault<T>(key: string, defaultValue: T): T;
}

function wholeSecondsAtLeastFloor(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MODEL_PUBLISHER_TIMEOUT_MIN_SECONDS ? value : fallback;
}

/**
 * Resolve both knobs, falling back to the defaults when the source is absent or
 * a stored value is malformed / below the floor (`failMode: open-to-default` —
 * a bad value must never DISABLE the bound).
 */
export function readModelPublisherTimeouts(source?: PublisherTimeoutSettingsSource | null): ModelPublisherTimeouts {
  const read = (key: string, fallback: number): number =>
    source ? wholeSecondsAtLeastFloor(source.getValueWithDefault<unknown>(key, fallback), fallback) : fallback;
  return {
    idleTimeoutMs: read(MODEL_PUBLISHER_TIMEOUT_KEYS.idleTimeoutSeconds, MODEL_PUBLISHER_TIMEOUT_DEFAULTS.idleTimeoutSeconds) * 1000,
    requestTimeoutMs: read(MODEL_PUBLISHER_TIMEOUT_KEYS.requestTimeoutSeconds, MODEL_PUBLISHER_TIMEOUT_DEFAULTS.requestTimeoutSeconds) * 1000,
  };
}
