/**
 * TASK-890 §3.12 — the readiness sweep's keys, defaults and vocabulary.
 *
 * Kept in its own module so the settings descriptors can import the keys and
 * the defaults WITHOUT importing the service (the registry is pure metadata and
 * must not pull a Nest provider graph behind it — the `metering.descriptors.ts`
 * precedent, which imports `*.constants.ts` for exactly this reason).
 */

/** `global-kv` key: master switch for the scheduled readiness sweep. */
export const INFERENCE_READINESS_ENABLED_KEY = 'inference.readiness.enabled';

/** `global-kv` key: minimum seconds between two sweeps. */
export const INFERENCE_READINESS_INTERVAL_KEY = 'inference.readiness.intervalSeconds';

/**
 * `global-kv` key: minimum seconds between two re-resolutions of a SYSTEM cloud
 * connection. A cloud credential resolve is a Vault decrypt (and, once the
 * vendor-listing probe lands, a METERED vendor call), so it is deliberately
 * slower than the engine sweep.
 */
export const INFERENCE_READINESS_CLOUD_PROBE_INTERVAL_KEY = 'inference.readiness.cloudProbeIntervalSeconds';

/**
 * The code defaults — the LAST fallback of the cascade, and the values the
 * descriptors declare. Pre-production posture is "ship complete and ENABLED"
 * (owner rule: build for day-1), so the sweep is ON: a platform admin turns it
 * off, it does not have to be turned on.
 *
 * `intervalSeconds` matches the six-service heartbeat cadence
 * (`ServiceHealthMonitoringService`, `@Cron(EVERY_30_SECONDS)`) because the
 * sweep JOINS those heartbeats — reading them faster than they are written buys
 * nothing.
 */
export const INFERENCE_READINESS_DEFAULTS = {
  enabled: true,
  intervalSeconds: 30,
  cloudProbeIntervalSeconds: 900,
} as const;

/**
 * The ONE Redis key holding the snapshot. A single hash rather than a key per
 * model: the console and the catalogue both read the WHOLE observation, and
 * `checkedAt` is a property of the sweep, not of a row.
 */
export const INFERENCE_READINESS_SNAPSHOT_KEY = 'inference:readiness:snapshot';

/** Snapshot TTL multiplier: a snapshot older than three sweeps is not an observation. */
export const INFERENCE_READINESS_TTL_INTERVALS = 3;

/** Redis key prefix the heartbeat cron writes (`ServiceHealthMonitoringService`). */
export const HEARTBEAT_KEY_PREFIX = 'monitoring:heartbeat:';

/**
 * A heartbeat older than this is STALE — the service is treated as down even if
 * its last sample said `up`. Three heartbeat intervals, the same tolerance the
 * snapshot TTL uses.
 */
export const HEARTBEAT_STALE_AFTER_SECONDS = 90;

/**
 * The six deployables that write a heartbeat, in the order
 * `ServiceHealthMonitoringService.initializeServices()` declares them.
 */
export const READINESS_SERVICE_KEYS = ['text', 'nlp', 'stt', 'tts', 'guardrail', 'harness'] as const;

export type ReadinessServiceKey = (typeof READINESS_SERVICE_KEYS)[number];

/**
 * Providers served by an ENGINE the platform runs (LM Studio, Ollama, vLLM,
 * llama.cpp). `lmstudio` is the wire alias LM Studio's own OpenAI-compatible
 * surface reports; both spellings mean the same engine.
 *
 * INTERIM COPY. TASK-890 L1 moves the canonical set to
 * `ai-provider-connection/constants.ts` (with `providerClassOf`) in the same
 * wave; this lane may not edit that file, so the set lives here until the merge
 * repoints it. The four probe-able spellings are already shared —
 * `DISCOVERABLE_AI_MODEL_PROVIDERS` — and this adds only the alias.
 */
export const ENGINE_SERVED_PROVIDERS: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']);

/**
 * Engines whose listing carries NO per-model load state: being listed IS being
 * served (vLLM serves the single model it was started with; llama.cpp answers
 * `/health`). For these, "listed" resolves to `ready` rather than `loadable`.
 */
export const STATELESS_LISTING_ENGINES: ReadonlySet<string> = new Set(['vllm', 'llama-cpp']);

/**
 * The `AiModel.provider` sentinel meaning "one of the platform's own services
 * serves this from the models bucket" (23 of the 33 seeded rows). Readiness for
 * such a row is bucket availability × the `servedBy` service's heartbeat.
 */
export const PLATFORM_SELF_HOST_SENTINEL = 'built-in';

/** Canonical spelling for an engine provider (folds the `lmstudio` alias). */
export function normalizeEngineProvider(provider: string): string {
  return provider === 'lmstudio' ? 'lm-studio' : provider;
}
