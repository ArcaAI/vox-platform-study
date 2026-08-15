// Python service-runtime descriptors (the effective-config pull path).
//
// These are the SERVICE-LEVEL knobs the stt and nlp services consume through
// `GET /api/v1/internal/effective-config`. They are deliberately
// NOT per-request model selection: SMR's stateless-gateway contract
// (`apps/text/src/text/core/config.py:1-9`) stays intact, and SMR's own tunables
// arrive as `AiRuntimeProfile` rows rather than registry keys.
//
// Registering them changes ZERO runtime behaviour: every `default` below is
// transcribed verbatim from the consuming Python service's own fallback, so a
// read that misses the DB resolves to exactly the value in force today.
//
// Sources of truth for the defaults (verified 2026-07-20):
//   stt.modelCache.maxModels     `settings.model_cache_max_models`      = 5
//   stt.modelCache.ttlSeconds    `settings.model_cache_ttl_seconds`     = 3600  (clamp ge=60 le=3600)
//   stt.modelCache.maxMemoryMb   `models/cache.py` ctor fallback        = 10000
//   stt.workers.concurrency      `settings.worker_concurrency`          = 4
//   stt.streaming.maxConcurrent  `settings.streaming_max_concurrent`    = 0 (0 = hardware auto-detect)
//   nlp.inference.maxConcurrent  NEW — nlp had NO bound at all
//
// ⚠️ Deliberate divergence from the legacy seed: the orphaned GlobalSetting row
// `stt.config/model_cache/max_memory_mb` (`seed/06-stt.ts`) carries 16384, but the
// running code has always used the 10000 ctor fallback — that row never had a
// reader. Adopting 16384 here would SILENTLY raise the cache's memory
// ceiling by 64% on first deploy ("wiring a dead field flips real defaults").
// The code value wins; reconciling or retiring the legacy row belongs to the
// seed owner.

import { SettingDescriptor } from '../registry.types';

/**
 * Registry keys → the consuming Python service's current fallback. Shared by the
 * descriptors below and the effective-config read service, so the two can never
 * drift apart.
 */
export const SERVICE_RUNTIME_DEFAULTS = {
  'stt.modelCache.maxModels': 5,
  'stt.modelCache.ttlSeconds': 600,
  'stt.modelCache.maxMemoryMb': 10000,
  'stt.modelCache.vramBudgetMb': 0,
  'stt.workers.concurrency': 4,
  'stt.streaming.maxConcurrent': 0,
  'nlp.inference.maxConcurrent': 4,

  // ── the remaining in-process caches ───────────────────────────
  // The `<svc>.modelCache.<knob>` grammar originally served stt only,
  // leaving guardrail/harness/tts as explicitly reserved subsets. This
  // fills them in the SAME family rather than adding a parallel
  // `models.retention.*` namespace: two key families for one knob would be
  // pure redundancy.
  //
  // `maxModels` values are transcribed verbatim from each service's own code
  // default, so residency is behaviour-preserving. `vramBudgetMb: 0` means
  // "unset" — no VRAM budget, the estimates path applies.
  'nlp.modelCache.ttlSeconds': 600,
  'nlp.modelCache.maxModels': 3,
  'nlp.modelCache.vramBudgetMb': 0,
  'guardrail.modelCache.ttlSeconds': 600,
  'guardrail.modelCache.maxModels': 2,
  'guardrail.modelCache.vramBudgetMb': 0,
  'harness.modelCache.ttlSeconds': 600,
  'harness.modelCache.maxModels': 1,
  'harness.modelCache.vramBudgetMb': 0,
  'tts.modelCache.ttlSeconds': 600,
  'tts.modelCache.maxModels': 2,
  'tts.modelCache.vramBudgetMb': 0,
  'smr.modelCache.ttlSeconds': 600,
} as const;

export type ServiceRuntimeKey = keyof typeof SERVICE_RUNTIME_DEFAULTS;

/**
 * The in-process caches this registry family governs. `smr` is deliberately ABSENT: it
 * holds no weights — its `smr.modelCache.ttlSeconds` is forwarded to
 * server-managed engines (Ollama `keep_alive`, LM Studio `ttl`), so it has no
 * `maxModels`/`vramBudgetMb` to speak of.
 */
export const MODEL_CACHE_SERVICES = ['stt', 'nlp', 'guardrail', 'harness', 'tts'] as const;

export type ModelCacheService = (typeof MODEL_CACHE_SERVICES)[number];

/** Human-facing service names for the generated retention descriptions. */
const SERVICE_LABEL: Record<ModelCacheService, string> = {
  stt: 'stt',
  nlp: 'nlp',
  guardrail: 'guardrail',
  harness: 'harness',
  tts: 'tts',
};

const TTL_DESCRIPTION = (service: string): string =>
  `Idle TTL before a cached ${service} model is evicted. The service re-applies its own product clamp ` +
  '(min 60s / max 3600s) to whatever is served here, so an out-of-range value cannot take effect. ' +
  'Models pinned by an in-flight request are never evicted, so the TTL applies only after the last release.';

const MAX_MODELS_DESCRIPTION = (service: string): string =>
  `Maximum number of models held resident in the ${service} LRU cache. Under all-pinned load the cache ` +
  'deliberately exceeds this ceiling rather than drop a model serving a request.';

const VRAM_DESCRIPTION = (service: string): string =>
  `Per-service VRAM budget in MB for ${service}. 0 = unset (no VRAM budget — the memory-estimate path ` +
  'applies). Only takes effect where an NVML probe is available; CPU-only hosts ignore it.';

type KeyMeta = { label: string; description: string };

/**
 * Retention metadata for the four services added here, generated so
 * the wording can never drift between them. stt's three pre-existing entries
 * keep their hand-written text below (they are equivalent in substance).
 */
const RETENTION_META: Partial<Record<ServiceRuntimeKey, KeyMeta>> = Object.fromEntries(
  MODEL_CACHE_SERVICES.flatMap((service) => {
    const label = SERVICE_LABEL[service];
    return [
      [`${service}.modelCache.ttlSeconds`, { label: `${label} model cache idle TTL (s)`, description: TTL_DESCRIPTION(label) }],
      [`${service}.modelCache.maxModels`, { label: `${label} model cache size`, description: MAX_MODELS_DESCRIPTION(label) }],
      [`${service}.modelCache.vramBudgetMb`, { label: `${label} VRAM budget (MB)`, description: VRAM_DESCRIPTION(label) }],
    ];
  }),
) as Partial<Record<ServiceRuntimeKey, KeyMeta>>;

const HAND_WRITTEN_META: Partial<Record<ServiceRuntimeKey, KeyMeta>> = {
  'stt.modelCache.maxModels': {
    label: 'STT model cache size',
    description: 'Maximum number of ASR models held in the stt LRU cache.',
  },
  'stt.modelCache.ttlSeconds': {
    label: 'STT model cache idle TTL (s)',
    description:
      'Idle TTL before a cached ASR model is evicted. The service re-applies its own product clamp ' +
      '(min 60s / max 3600s) to whatever is served here, so an out-of-range value cannot take effect. ' +
      'Active sessions pin models, so the TTL applies only after the last release.',
  },
  'stt.modelCache.maxMemoryMb': {
    label: 'STT model cache memory ceiling (MB)',
    description: 'Upper bound on resident memory for cached ASR models before eviction is forced.',
  },
  'stt.workers.concurrency': {
    label: 'STT worker concurrency',
    description: 'Number of concurrent Dramatiq worker threads processing batch transcription jobs.',
  },
  'stt.streaming.maxConcurrent': {
    label: 'STT streaming max concurrent sessions',
    description: 'Ceiling on concurrent streaming sessions. 0 = auto-detect from the hardware execution profile.',
  },
  'nlp.inference.maxConcurrent': {
    label: 'NLP inference concurrency',
    description:
      'Ceiling on concurrent NER/classification/diagnosis inferences. Previously the nlp service had ' +
      'no bound of any kind, so concurrent requests piled onto the model unbounded.',
  },
  'smr.modelCache.ttlSeconds': {
    label: 'SMR engine retention TTL (s)',
    description:
      'Idle retention forwarded to SERVER-managed LLM engines — Ollama `keep_alive` and LM Studio `ttl`. ' +
      'SMR holds no weights itself, so this is a per-request hint to the engine rather than a cache bound. ' +
      'vLLM / llama.cpp-server load one model at launch and stay resident by design; this value does not apply ' +
      'to them. Clamped to [60s, 3600s] by the service.',
  },
};

/** Hand-written entries win; generated retention metadata fills the rest. */
const META: Record<ServiceRuntimeKey, KeyMeta> = {
  ...RETENTION_META,
  ...HAND_WRITTEN_META,
} as Record<ServiceRuntimeKey, KeyMeta>;

export const SERVICE_RUNTIME_SETTINGS: SettingDescriptor[] = (Object.keys(SERVICE_RUNTIME_DEFAULTS) as ServiceRuntimeKey[]).map<SettingDescriptor>(
  (key) => ({
    key,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Platform-owned capacity/retention knobs — never tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Capacity/retention TUNING — `EffectiveConfigService.resolveKey` already
    // degrades a control-plane miss to `env-fallback` so the Python client keeps
    // its bootstrap value. open-to-default keeps that contract exact; fail-closed
    // would make an unwritten row an effective-config endpoint failure.
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: META[key].label,
    description: META[key].description,
    default: SERVICE_RUNTIME_DEFAULTS[key],
  }),
);
