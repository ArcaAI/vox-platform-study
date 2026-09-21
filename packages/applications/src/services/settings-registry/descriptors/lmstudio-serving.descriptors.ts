// TASK-996 Phase 2b — the PLATFORM tier of LM Studio's serving configuration.
//
// WHY THESE KEYS EXIST AT ALL. `LMS_CONTEXT`, `LMS_PARALLEL` and the JIT
// defaults in `~/.lmstudio/settings.json` are the values the serving engine
// loads a model with, and today every one of them is a Deployment env var or a
// file baked into the image — so changing one is a manifest edit plus a pod
// restart. `00-project-context.md` §Configuration Principles already forbids
// that: env is the bootstrap floor, and a value that must change without a
// redeploy is `global-kv`. This family is the correction, not new scope.
//
// TWO TIERS, and only two. The PER-MODEL profile lives on
// `AiModel._metadata.serving` (`@arcaai/types` `AiModelServingProfile`, owner
// decision D-7), because R-6 — "this model on that GPU" — is a statement about
// a MODEL and no flat key can express it. What is registered HERE is the
// FALLBACK a row with no `serving` block inherits, resolved by
// `resolveServingProfile` (ai-model service), which widens ONLY on absence.
//
// SCOPE: platform-only (`maxScope: 'system'`, `globalOnly: true`). These decide
// how much VRAM one process takes on a shared, time-sliced pair of cards that
// also hosts `hope-stt` and the guardrail model; a tenant admin raising a
// context window would evict another tenant's workload from the same GPU. There
// is no tenant opinion to express here, so there is no tenant tier — this is the
// documented super-admin-only shape of rule 2, not an omission.
//
// FAIL MODE: `open-to-default` throughout, and deliberately. `closed` is for
// secrets and for provider/model SELECTION — an unresolved selection must never
// silently become somebody else's. NOTHING in this family selects a provider or
// a model: every key is a load-time TUNING knob whose code default is exactly
// what the engine does today, so an unreadable row degrades to current
// behaviour rather than refusing to serve the whole AI plane. (The Phase 1
// loader's own fail-closed posture is a different thing: it governs a REJECTED
// kvConfig, an ERROR, which propagates unchanged — `failMode` governs an ABSENT
// VALUE only. See `registry.types.ts` `SettingFailMode`.)
//
// DEFAULTS ARE TODAY'S MEASURED BEHAVIOUR, not the target state. `flashAttention`
// ships `false` and both cache types ship `f16` because that is what
// `llama-server` is running with on the live pod (measured 2026-09-21,
// ticket §2.1) — registering these keys must change ZERO serving behaviour.
// Turning flash attention on and quantizing the KV cache is the point of the
// ticket, but it is a MEASURED change a platform admin makes after Phase 0's
// baseline, not a default that arrives with a descriptor file.
//
// NOT REGISTERED HERE, on purpose: `gpuSplit.disabledGpus` / `.priority` /
// `.customRatio`. A platform-wide "never use GPU 1" is not a sensible default
// for every model at once, and per-MODEL placement is exactly what the row-level
// profile is for. Only the STRATEGY has a meaningful platform-wide answer.

import { SettingDescriptor } from '../registry.types';

const CATEGORY = 'Service Runtime';

/**
 * Registry key -> the value the platform falls back to when no row is written.
 *
 * `lmStudio.serving.*` transcribes what `hope-lmstudio` runs with today (the
 * context/parallel pair as lowered by TASK-995 and this review's Phase 0);
 * `lmStudio.jit.*` transcribes `~/.lmstudio/settings.json` in the image.
 */
export const LM_STUDIO_SERVING_DEFAULTS = {
  'lmStudio.serving.contextLength': 65536,
  'lmStudio.serving.parallel': 4,
  'lmStudio.serving.flashAttention': false,
  'lmStudio.serving.kvCacheQuantK': 'f16',
  'lmStudio.serving.kvCacheQuantV': 'f16',
  'lmStudio.serving.gpuSplitStrategy': 'evenly',
  'lmStudio.jit.defaultContextLength': 8192,
  'lmStudio.jit.modelTtlSeconds': 3600,
} as const;

export type LmStudioServingKey = keyof typeof LM_STUDIO_SERVING_DEFAULTS;

/**
 * The write-lane gate for one closed-vocabulary key. The vocabularies live in
 * `@arcaai/types` so the descriptor, the row parser and the admin UI share ONE
 * table; they are inlined as a `readonly string[]` here rather than imported so
 * the descriptor stays pure metadata with no cross-package dependency, and
 * `lmstudio-serving.descriptors.test.ts` asserts the two agree.
 */
const oneOf = (allowed: readonly string[], what: string) => (value: unknown) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${what} must be one of ${allowed.join(', ')}.`;
  }
};

/** Mirrors `AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES` (`@arcaai/types`); parity-tested. */
const KV_CACHE_QUANTIZATION_TYPES: readonly string[] = ['f32', 'f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'];
/** Mirrors `AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES` (`@arcaai/types`); parity-tested. */
const GPU_SPLIT_STRATEGIES: readonly string[] = ['custom', 'evenly', 'priorityOrder', 'tensor'];

/** An inclusive integer bound, refused rather than clamped so an admin is told. */
const wholeNumberBetween = (min: number, max: number, what: string) => (value: unknown) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return `${what} must be a whole number between ${min} and ${max}.`;
  }
};

export const LM_STUDIO_SERVING_SETTINGS: SettingDescriptor[] = [
  // ── The platform fallback serving profile ────────────────────────────────
  {
    key: 'lmStudio.serving.contextLength',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Default served context window (tokens)',
    description:
      'The context window LM Studio LOADS a model with (`--context-length`), for any model whose `_metadata.serving` declares none. Distinct from the model catalogue`s declared `contextLength`, which is what callers are TOLD they may use: the declared value must never EXCEED this one, or the engine answers `exceed_context_size_error` after a pre-dispatch budget check has already passed. Under-claiming is safe. The binding cost is not this number alone — LM Studio gives EVERY decode slot the full window rather than dividing it, so KV-cache residency scales with context x parallel, and at 131072 x 10 that measured 13.9 GiB across two cards for ~6k-token prompts.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.contextLength'],
    validate: wholeNumberBetween(512, 1_048_576, 'Served context window'),
  },
  {
    key: 'lmStudio.serving.parallel',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Default decode slots (parallel)',
    description:
      'Concurrent decode slots LM Studio loads a model with (`--parallel`), for any model whose `_metadata.serving` declares none. This is a RESIDENCY decision before it is a throughput one: each slot is given the FULL context window, so VRAM scales linearly with it. Raising it on a card that also hosts the STT models is how both workloads meet a CUDA OOM — GPU time-slicing gives no memory isolation.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.parallel'],
    validate: wholeNumberBetween(1, 64, 'Decode slots'),
  },
  {
    key: 'lmStudio.serving.flashAttention',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Flash attention',
    description:
      'Whether models load with flash attention (`--flash-attn`). Ships OFF because that is what the live engine runs today, and the latency it costs has not yet been separated from the two other causes measured alongside it (a cross-card layer split and GPU time-slicing). It is ALSO the precondition for quantizing the V-cache: llama.cpp refuses the pair, so a quantized `kvCacheQuantV` with this off is rejected at save time rather than at load time.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.flashAttention'],
  },
  {
    key: 'lmStudio.serving.kvCacheQuantK',
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'K-cache element type',
    description:
      'Element type for the KEY half of the KV cache (`--cache-type-k`). `f16` is the engine default and what runs today; `q8_0` roughly halves the K-cache term and `q4_0` quarters it, which is the lever that makes a large context fit one card. Unlike the V half this carries no flash-attention precondition.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.kvCacheQuantK'],
    validate: oneOf(KV_CACHE_QUANTIZATION_TYPES, 'K-cache element type'),
  },
  {
    key: 'lmStudio.serving.kvCacheQuantV',
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'V-cache element type',
    description:
      'Element type for the VALUE half of the KV cache (`--cache-type-v`). Anything but `f32`/`f16` REQUIRES flash attention — llama.cpp throws on the pair, and the LM Studio daemon carries the same guard — so setting this without `lmStudio.serving.flashAttention` is refused when the profile is resolved, not discovered when the model fails to load.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.kvCacheQuantV'],
    validate: oneOf(KV_CACHE_QUANTIZATION_TYPES, 'V-cache element type'),
  },
  {
    key: 'lmStudio.serving.gpuSplitStrategy',
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'Default GPU split strategy',
    description:
      'How LM Studio spreads a model over the visible GPUs when its own `_metadata.serving.gpuSplit` says nothing. `evenly` is the engine default and is what produced the measured 4,996 / 8,908 MiB two-card split — every decoded token then pays a PCIe hop. Note that the Deployment`s `nvidia.com/gpu` request is capacity bookkeeping only and pins nothing: placement is entirely this decision. Confining a SPECIFIC model to a SPECIFIC card is a per-model choice (`disabledGpus` / `priority` on the model row), which is why those arrays are deliberately not platform-wide keys.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.gpuSplitStrategy'],
    validate: oneOf(GPU_SPLIT_STRATEGIES, 'GPU split strategy'),
  },

  // ── JIT defaults (owner decision D-4) ────────────────────────────────────
  // LM Studio JIT-loads any model that is not in `LMS_LOAD` — today that is
  // `granite-guardian-4.1-8b`, the model every guardrail decision runs on — and
  // JIT loading CANNOT be disabled (no CLI flag, no REST field, no settings key;
  // measured TASK-824). Managing only the preloaded model would therefore leave
  // the guardrail model entirely unmanaged, which is why these two are in scope.
  {
    key: 'lmStudio.jit.defaultContextLength',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'JIT-load context window (tokens)',
    description:
      'The context window LM Studio gives a model it loads on demand — `defaultContextLength` in `~/.lmstudio/settings.json`. Applies to every model NOT named in the preload list, which today means the guardrail LLM. It is why a model absent from `LMS_LOAD` comes up on 8192 regardless of anything the catalogue declares, and why declaring a wider `contextLength` on such a row is an over-claim: `lms load` is never invoked for it, so nothing carries the wider window to the engine.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.jit.defaultContextLength'],
    validate: wholeNumberBetween(512, 1_048_576, 'JIT-load context window'),
  },
  {
    key: 'lmStudio.jit.modelTtlSeconds',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CATEGORY,
    label: 'JIT-loaded model idle TTL (seconds)',
    description:
      'How long a JIT-loaded model stays resident with no traffic before LM Studio evicts it — `jitModelTTL` in `~/.lmstudio/settings.json`. Lowering it returns VRAM to the other workloads on the same cards sooner; raising it avoids paying a cold load on the first guardrail call after a quiet period. Eviction is why "unload" from an admin surface is ADVISORY: the next inference request loads the model straight back.',
    default: LM_STUDIO_SERVING_DEFAULTS['lmStudio.jit.modelTtlSeconds'],
    validate: wholeNumberBetween(0, 86_400, 'JIT-loaded model idle TTL'),
  },
];
