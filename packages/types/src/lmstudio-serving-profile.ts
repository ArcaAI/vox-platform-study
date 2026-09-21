/**
 * TASK-996 Phase 2a (owner decision D-7) — `AiModelServingProfile`: the typed
 * shape of `AiModel._metadata.serving`.
 *
 * WHY THE ROW AND NOT A FLAT SETTING. `LMS_CONTEXT` / `LMS_PARALLEL` are env
 * vars on the LM Studio Deployment today, so every change to them is a manifest
 * edit plus a pod restart — a violation of `00-project-context.md`
 * §Configuration Principles, which says a value that must change without a
 * restart is not an env var. The obvious fix, a flat `GlobalSetting`, cannot
 * express the request that motivated the ticket at all: R-6 is "this model on
 * that GPU", which is a statement ABOUT A MODEL. So the profile lives on the
 * model row, exactly where `_metadata.asr` (TASK-934) already lives, and the
 * registry carries the PLATFORM FALLBACK for rows that declare nothing.
 *
 * This is CONFIGURATION, so it cascades model -> platform default and widens
 * ONLY on absence. It is NOT content: the SYSTEM rows are platform-owned and
 * shared-read, and nothing here is ever cloned into a tenant
 * (`00-project-context.md` §"Content is cloned; configuration cascades").
 *
 * The field names are the `@lmstudio/sdk@1.5.0` kvConfig stack's, verbatim
 * (`index.d.ts:2890`) — `llm.load.llama.flashAttention`,
 * `.kCacheQuantizationType` / `.vCacheQuantizationType`, `.gpuSplitConfig` —
 * because the Phase 1 loader hands them straight to the daemon and a rename
 * here would be a translation layer nobody asked for.
 *
 * TWO LAYERS, and the split is load-bearing:
 *
 *  - {@link parseAiModelServingProfile} is SHAPE ONLY. It reads admin-editable
 *    JSON and is per-field by necessity: a row may legitimately declare
 *    `gpuSplit` alone and inherit `flashAttention` from the platform default,
 *    so the parser cannot see enough to judge a cross-field rule. Every member
 *    is a TUNING knob, and tuning is `open-to-default` (rule 09 §Configuration
 *    Tiers): an unknown key or an out-of-range value is DROPPED and NAMED in
 *    `rejected` — never fail-closed (that posture is reserved for SELECTION),
 *    and never forwarded to a loader that refuses to serve on a bad key.
 *
 *  - {@link checkAiModelServingProfile} is CROSS-FIELD, and runs on the
 *    RESOLVED profile — the one the loader will actually use. It is where a bad
 *    COMBINATION is caught, which is the point: llama.cpp throws when a
 *    quantized V-cache meets flash attention off (measured, TASK-946), and a
 *    context window wider than the engine was loaded with produces
 *    `exceed_context_size_error` at inference time rather than at save time.
 */

/**
 * How LM Studio spreads one model's layers over the visible GPUs.
 * `@lmstudio/sdk@1.5.0` `gpuSplitConfig.strategy`. The default is `evenly`,
 * which is what produced the 4,996 / 8,908 MiB two-card split measured on the
 * live pod — pinning a model to one card is `disabledGpus`, or
 * `priorityOrder` + `priority`.
 *
 * NOT `LLMSplitStrategy` (`"evenly" | "favorMainGpu"`), the older and narrower
 * sibling type in the same bundle. This is the one in force.
 */
export const AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES = Object.freeze(['custom', 'evenly', 'priorityOrder', 'tensor'] as const);
export type AiModelServingGpuSplitStrategy = (typeof AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES)[number];

/**
 * KV-cache element types, i.e. llama.cpp's `--cache-type-k` / `--cache-type-v`.
 *
 * Deliberately CONSERVATIVE: only the types llama.cpp has accepted for the KV
 * cache across the versions LM Studio ships. Rejecting a type the daemon would
 * have accepted costs a dropped field that degrades to the engine default;
 * accepting one it refuses makes the Phase 1 loader fail to serve, and that
 * loader's declared posture is fail-closed. Re-check this list against
 * `llmLlamaCacheQuantizationTypes` in the image's own
 * `@lmstudio/sdk/dist/index.d.ts` when Phase 1 wires the loader.
 */
export const AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES = Object.freeze(['f32', 'f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'] as const);
export type AiModelServingKvCacheQuantizationType = (typeof AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES)[number];

/**
 * The cache types that are NOT quantized, and therefore carry no flash-attention
 * requirement. Everything else does — see {@link checkAiModelServingProfile}.
 */
export const AI_MODEL_SERVING_UNQUANTIZED_KV_CACHE_TYPES = Object.freeze(['f32', 'f16'] as const);

/**
 * Per-model GPU placement. `@lmstudio/sdk@1.5.0` `gpuSplitConfig`.
 *
 * A `type`, not an `interface`, and deliberately so — see the note on
 * {@link AiModelServingProfile}.
 */
export type AiModelServingGpuSplit = {
  /** Placement strategy. Absent => the platform default, and ultimately the engine's `evenly`. */
  strategy?: AiModelServingGpuSplitStrategy;
  /** Device indices this model may NOT use. `[1]` confines the model to GPU 0. */
  disabledGpus?: number[];
  /** Device indices most-preferred first. Read by `strategy: "priorityOrder"`. */
  priority?: number[];
  /** Per-device share, index-aligned with the visible devices. Read by `strategy: "custom"`. */
  customRatio?: number[];
};

/** K and V cache element types. Either may be set alone. */
export type AiModelServingKvCacheQuant = {
  k?: AiModelServingKvCacheQuantizationType;
  v?: AiModelServingKvCacheQuantizationType;
};

/**
 * `AiModel._metadata.serving` — the load-time serving profile that travels with
 * a locally-served model.
 *
 * Every member is a LOAD-TIME parameter: changing one means unload + reload, so
 * a console that edits this must present an explicit "Apply & reload" rather
 * than saving silently (ticket D-2). None of them can be changed on a live
 * instance.
 *
 * A `type`, not an `interface`: this is the SHAPE OF STORED JSON. TypeScript
 * gives a type alias an implicit index signature but withholds one from an
 * interface, so an interface here is not assignable to Prisma's
 * `InputJsonValue` and every seed row writing the column fails to compile.
 */
export type AiModelServingProfile = {
  /**
   * Context window the ENGINE is loaded with (`--context-length`).
   *
   * Distinct from `_metadata.capabilities.contextLength`, which is what callers
   * are told they may USE. The two are in LOCKSTEP and the invariant is
   * one-directional — see {@link checkAiModelServingProfile}.
   */
  contextLength?: number;
  /**
   * Decode slots (`--parallel`). Residency, not throughput, is what this
   * decides: LM Studio gives every slot the FULL context rather than dividing
   * it (measured), so KV memory scales with `contextLength x parallel`.
   */
  parallel?: number;
  /** `--flash-attn`. Also the precondition for a quantized V-cache. */
  flashAttention?: boolean;
  /** `--cache-type-k` / `--cache-type-v`. */
  kvCacheQuant?: AiModelServingKvCacheQuant;
  /** Which card(s) this model loads onto. The answer to R-6. */
  gpuSplit?: AiModelServingGpuSplit;
};

/** Inclusive `[min, max]` bounds, published so an admin UI and the API validator share ONE table. */
export interface AiModelServingRange {
  readonly min: number;
  readonly max: number;
  /** Whole numbers only — the engine field is an `int`, so `65536.5` is a typo, not a value. */
  readonly integer?: boolean;
}

/**
 * The two scalar knobs' ranges.
 *
 * Both are generous on purpose: the REAL ceiling is VRAM, it is the product
 * `contextLength x parallel` rather than either factor, and it depends on the
 * weights and the card. A range cannot express that, so it bounds only what is
 * obviously a typo and leaves the budget to the Phase 3 load precheck (D-6),
 * which has the live `DCGM_FI_DEV_FB_USED` a static table never will.
 */
export const AI_MODEL_SERVING_RANGES: Readonly<Record<'contextLength' | 'parallel', AiModelServingRange>> = Object.freeze({
  contextLength: Object.freeze({ min: 512, max: 1_048_576, integer: true }),
  parallel: Object.freeze({ min: 1, max: 64, integer: true }),
});

/** Upper bound on any device-index array — a sanity cap, not a statement about the node. */
export const AI_MODEL_SERVING_MAX_GPUS = 16;

export interface ParsedAiModelServingProfile {
  /** Only the members that survived. Never carries `undefined` members or an empty nested block. */
  profile: AiModelServingProfile;
  /**
   * Dotted paths of everything dropped — an unknown key, a wrong type, or a
   * value outside its range. The caller logs this at WARN: a silently ignored
   * profile is how a model ends up served on parameters nobody chose.
   */
  rejected: string[];
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);

function inRange(value: unknown, range: AiModelServingRange): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.integer && !Number.isInteger(value)) return false;
  return value >= range.min && value <= range.max;
}

/** A set of plausible device indices: distinct, whole, non-negative, and not absurdly many. */
function isDeviceIndexList(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_MODEL_SERVING_MAX_GPUS) return false;
  if (!value.every((index) => Number.isInteger(index) && (index as number) >= 0 && (index as number) < AI_MODEL_SERVING_MAX_GPUS)) return false;
  return new Set(value as number[]).size === value.length;
}

/** A per-device share: non-negative, finite, and not all zero — an all-zero ratio allocates the model nowhere. */
function isRatioList(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_MODEL_SERVING_MAX_GPUS) return false;
  if (!value.every((share) => typeof share === 'number' && Number.isFinite(share) && share >= 0)) return false;
  return (value as number[]).some((share) => share > 0);
}

/** One member drawn from a closed vocabulary. Anything else is NAMED, never coerced. */
function takeEnum<T extends string>(raw: Rec, out: Rec, key: string, allowed: readonly T[], prefix: string, rejected: string[]): void {
  const value = raw[key];
  if (value === undefined) return;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) out[key] = value;
  else rejected.push(`${prefix}${key}`);
}

/** Every key of `raw` the caller did not consume, named in the order the row wrote them. */
function nameUnknown(raw: Rec, known: readonly string[], prefix: string, rejected: string[]): void {
  const set = new Set<string>(known);
  for (const key of Object.keys(raw)) if (!set.has(key)) rejected.push(`${prefix}${key}`);
}

/** `kvCacheQuant`, parsed. `undefined` when nothing survived, so the caller omits the key. */
function parseKvCacheQuant(raw: unknown, prefix: string, rejected: string[]): AiModelServingKvCacheQuant | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRec(raw)) {
    rejected.push(prefix.slice(0, -1));
    return undefined;
  }
  const out: Rec = {};
  for (const key of ['k', 'v']) takeEnum(raw, out, key, AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES, prefix, rejected);
  nameUnknown(raw, ['k', 'v'], prefix, rejected);
  return Object.keys(out).length > 0 ? (out as AiModelServingKvCacheQuant) : undefined;
}

/** `gpuSplit`, parsed. `undefined` when nothing survived, so the caller omits the key. */
function parseGpuSplit(raw: unknown, prefix: string, rejected: string[]): AiModelServingGpuSplit | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRec(raw)) {
    rejected.push(prefix.slice(0, -1));
    return undefined;
  }
  const out: AiModelServingGpuSplit = {};
  takeEnum(raw, out as Rec, 'strategy', AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES, prefix, rejected);
  for (const key of ['disabledGpus', 'priority'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (isDeviceIndexList(value)) out[key] = [...value];
    else rejected.push(`${prefix}${key}`);
  }
  if (raw.customRatio !== undefined) {
    if (isRatioList(raw.customRatio)) out.customRatio = [...raw.customRatio];
    else rejected.push(`${prefix}customRatio`);
  }
  nameUnknown(raw, ['strategy', 'disabledGpus', 'priority', 'customRatio'], prefix, rejected);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read `AiModel._metadata.serving` into the profile a loader may act on.
 *
 * Visit order is DECLARED members first (in declaration order), then unknown
 * keys in the order the row wrote them — so `rejected` is stable across two rows
 * that carry the same content in a different JSON key order, and a warn line
 * does not churn.
 */
export function parseAiModelServingProfile(raw: unknown): ParsedAiModelServingProfile {
  const rejected: string[] = [];
  const profile: AiModelServingProfile = {};
  if (!isRec(raw)) return { profile, rejected };

  for (const [key, range] of Object.entries(AI_MODEL_SERVING_RANGES)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (inRange(value, range)) (profile as Rec)[key] = value;
    else rejected.push(key);
  }
  if (raw.flashAttention !== undefined) {
    if (typeof raw.flashAttention === 'boolean') profile.flashAttention = raw.flashAttention;
    else rejected.push('flashAttention');
  }
  const kvCacheQuant = parseKvCacheQuant(raw.kvCacheQuant, 'kvCacheQuant.', rejected);
  if (kvCacheQuant) profile.kvCacheQuant = kvCacheQuant;
  const gpuSplit = parseGpuSplit(raw.gpuSplit, 'gpuSplit.', rejected);
  if (gpuSplit) profile.gpuSplit = gpuSplit;

  nameUnknown(raw, [...Object.keys(AI_MODEL_SERVING_RANGES), 'flashAttention', 'kvCacheQuant', 'gpuSplit'], '', rejected);
  return { profile, rejected };
}

/** What {@link checkAiModelServingProfile} needs that the profile itself cannot carry. */
export interface AiModelServingCheckOptions {
  /**
   * `_metadata.capabilities.contextLength` — the window callers are TOLD they
   * may use. Absent/null => the row declares none, so there is no pair to check.
   */
  declaredContextLength?: number | null;
}

/**
 * Cross-field invariants on a RESOLVED serving profile. Empty => coherent.
 *
 * Runs on the resolved profile rather than at parse time on purpose: a model row
 * may declare `kvCacheQuant.v` and inherit `flashAttention` from the platform
 * default, and judging that pair from the row alone would strip a setting the
 * platform had already made valid.
 *
 * Returns MESSAGES rather than throwing, because the same check serves a save
 * (where it becomes a 400) and a read projection (where a throw would break a
 * list on one bad row).
 */
export function checkAiModelServingProfile(profile: AiModelServingProfile, options?: AiModelServingCheckOptions): string[] {
  const problems: string[] = [];

  // llama.cpp requires flash attention for V-cache quantization, and the LM
  // Studio 0.0.23-1 daemon bundle carries a guard that THROWS on the pair
  // (measured, TASK-946). Absence of `flashAttention` is the engine default,
  // which is OFF — so absence is not consent.
  const vCache = profile.kvCacheQuant?.v;
  if (vCache && !(AI_MODEL_SERVING_UNQUANTIZED_KV_CACHE_TYPES as readonly string[]).includes(vCache) && profile.flashAttention !== true) {
    problems.push(
      `kvCacheQuant.v is "${vCache}", which is quantized, but flashAttention is not enabled. ` +
        'llama.cpp can only quantize the V-cache with flash attention on; set flashAttention to true, or leave kvCacheQuant.v at f16.',
    );
  }

  const split = profile.gpuSplit;
  if (split) {
    if (split.strategy === 'custom' && split.customRatio === undefined) {
      problems.push('gpuSplit.strategy is "custom", which reads gpuSplit.customRatio — declare the per-device share, or choose another strategy.');
    }
    if (split.strategy === 'priorityOrder' && split.priority === undefined) {
      problems.push('gpuSplit.strategy is "priorityOrder", which reads gpuSplit.priority — declare the device order, or choose another strategy.');
    }
    if (split.disabledGpus?.length && split.priority?.length) {
      const disabled = new Set(split.disabledGpus);
      if (split.priority.every((index) => disabled.has(index))) {
        problems.push(
          `gpuSplit.disabledGpus disables every device named in gpuSplit.priority (${split.priority.join(', ')}) — the model would have nowhere to load.`,
        );
      }
    }
  }

  // The TASK-995 lockstep. One-directional: under-claiming only leaves headroom
  // unused, over-claiming re-creates `exceed_context_size_error` at inference
  // time, after a pre-dispatch budget check has already passed.
  const declared = options?.declaredContextLength;
  const served = profile.contextLength;
  if (typeof declared === 'number' && typeof served === 'number' && declared > served) {
    problems.push(
      `The declared context window (${declared}) exceeds the served one (${served}). ` +
        'A caller told it may use the declared budget would be refused by the engine with exceed_context_size_error; ' +
        'raise serving.contextLength, or lower the declared capabilities.contextLength.',
    );
  }

  return problems;
}
