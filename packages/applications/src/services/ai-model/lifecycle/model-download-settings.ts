/**
 * The two `global-kv` knobs that govern a model download (TASK-1019 D-4).
 * A LEAF module — the settings descriptors import these keys, so this file
 * must not pull in Nest, BullMQ or a repository.
 */
export const MODEL_DOWNLOAD_SETTING_KEYS = {
  /** A DOWNLOADING row whose heartbeat is older than this derives as DOWNLOAD_FAILED (STALLED). */
  staleAfterSeconds: 'modelRegistry.download.staleAfterSeconds',
  /** BullMQ `attempts` for one download (exponential backoff between them). */
  maxAttempts: 'modelRegistry.download.maxAttempts',
} as const;

export const MODEL_DOWNLOAD_SETTING_DEFAULTS = {
  staleAfterSeconds: 300,
  maxAttempts: 3,
} as const;

/** First retry waits this long; BullMQ doubles it per attempt. */
export const MODEL_DOWNLOAD_BACKOFF_DELAY_MS = 30_000;

export interface ModelDownloadSettings {
  staleAfterMs: number;
  maxAttempts: number;
}

/** The subset of `IAppSettingsService` this reads — a synchronous, cache-backed lookup. */
export interface DownloadSettingsSource {
  getValueWithDefault<T>(key: string, defaultValue: T): T;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Resolve both knobs, falling back to the descriptor defaults when the source is
 * absent or a stored value is not a positive number (`failMode: open-to-default`).
 */
export function readModelDownloadSettings(source?: DownloadSettingsSource | null): ModelDownloadSettings {
  const read = (key: string, fallback: number): number => {
    if (!source) return fallback;
    return positiveInteger(source.getValueWithDefault<unknown>(key, fallback), fallback);
  };
  return {
    staleAfterMs: read(MODEL_DOWNLOAD_SETTING_KEYS.staleAfterSeconds, MODEL_DOWNLOAD_SETTING_DEFAULTS.staleAfterSeconds) * 1000,
    maxAttempts: read(MODEL_DOWNLOAD_SETTING_KEYS.maxAttempts, MODEL_DOWNLOAD_SETTING_DEFAULTS.maxAttempts),
  };
}
