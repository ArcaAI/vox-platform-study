// TASK-525 — Python service-runtime descriptors (the effective-config pull path).
//
// These are the SERVICE-LEVEL knobs the stt-v2 and nlp services consume through
// `GET /api/v1/internal/effective-config` (TASK-525 §3.2). They are deliberately
// NOT per-request model selection: SMR's stateless-gateway contract
// (`apps/smr/src/smr_v2/core/config.py:1-9`) stays intact, and SMR's own tunables
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
//   nlp.inference.maxConcurrent  NEW — nlp had NO bound at all (GAP-L4)
//
// ⚠️ Deliberate divergence from the legacy seed: the orphaned GlobalSetting row
// `stt.config/model_cache/max_memory_mb` (`seed/06-stt.ts`) carries 16384, but the
// running code has always used the 10000 ctor fallback — that row never had a
// reader (D-11). Adopting 16384 here would SILENTLY raise the cache's memory
// ceiling by 64% on first deploy, which is precisely the D-07 failure mode
// ("wiring a dead field flips real defaults"). The code value wins; reconciling
// or retiring the legacy row belongs to the seed owner (TASK-524/529).

import { SettingDescriptor } from '../registry.types';

/**
 * Registry keys → the consuming Python service's current fallback. Shared by the
 * descriptors below and the effective-config read service, so the two can never
 * drift apart.
 */
export const SERVICE_RUNTIME_DEFAULTS = {
  'stt.modelCache.maxModels': 5,
  'stt.modelCache.ttlSeconds': 3600,
  'stt.modelCache.maxMemoryMb': 10000,
  'stt.workers.concurrency': 4,
  'stt.streaming.maxConcurrent': 0,
  'nlp.inference.maxConcurrent': 4,
} as const;

export type ServiceRuntimeKey = keyof typeof SERVICE_RUNTIME_DEFAULTS;

const META: Record<ServiceRuntimeKey, { label: string; description: string }> = {
  'stt.modelCache.maxModels': {
    label: 'STT model cache size',
    description: 'Maximum number of ASR models held in the stt-v2 LRU cache.',
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
      'Ceiling on concurrent NER/classification/diagnosis inferences. Before TASK-525 the nlp service had ' +
      'no bound of any kind, so concurrent requests piled onto the model unbounded (GAP-L4).',
  },
};

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
    category: 'Service Runtime',
    label: META[key].label,
    description: META[key].description,
    default: SERVICE_RUNTIME_DEFAULTS[key],
  }),
);
