// =============================================================================
// env -> LM Studio kvConfig. PURE. No I/O, no SDK import, no daemon.
// =============================================================================
// WHY THIS MODULE EXISTS AT ALL
//
// `lms load` and `POST /api/v1/models/load` between them cannot set three
// things HOPE needs (ticket §2.3, all measured):
//
//   llm.load.llama.flashAttention        - the single biggest latency lever
//   llm.load.llama.{k,v}CacheQuantizationType - ~10.5 GiB of f16 KV today
//   load.gpuSplitConfig                  - which card a model lands on (R-6)
//
// The daemon supports all three. Only the transport was missing: they are
// reachable exclusively as kvConfig fields over the websocket the
// `@lmstudio/sdk` speaks. So this file decides WHAT to send and load.mjs sends
// it — split that way because "which key, which value" is the half that can be
// silently wrong, and it must be testable in milliseconds with no daemon.
//
// -----------------------------------------------------------------------------
// PROVENANCE OF THE KEY NAMES — these are measured, not guessed
// -----------------------------------------------------------------------------
// A kvConfig is an untyped `{fields: [{key, value}]}` bag. An unknown key is
// therefore not an error: it is IGNORED. That is the opposite of the REST API,
// which at least answered `unrecognized_keys`, and it is exactly the silent
// divergence this whole loader exists to prevent. So every key below was
// obtained by RUNNING the SDK's own converter, never by reading docs:
//
//   node -e 'new LMStudioClient({...}).llm.loadConfigToKVConfig({ contextLength,
//            flashAttention, llamaKCacheQuantizationType, evalBatchSize, gpu })'
//   -> llm.load.contextLength
//      llm.load.llama.acceleration.offloadRatio
//      llm.load.llama.flashAttention
//      llm.load.llama.{k,v}CacheQuantizationType   {checked, value}
//      load.gpuSplitConfig                          <- NOT llm.load.*
//
// `load.gpuSplitConfig` really does sit in the shared `load` scope, not under
// `llm.load`. Verified twice: the SDK emits that literal string, and the `lms`
// binary builds its schematics as
//   globalConfigSchematics.scoped("llm.load")
//     .union(globalConfigSchematics.sliced("envVars"))
//     .union(globalConfigSchematics.scoped("load"))
// so the two namespaces are unioned and `gpuSplitConfig` is declared in `load`.
// Putting it under `llm.load.` would be silently dropped.
//
// `llm.load.numParallelSessions` is the odd one out: SDK 1.5.0 on npm has no
// `parallel` anywhere, so it cannot be reached through the typed config at all
// — which is the reason this module hand-assembles the field list instead of
// filling in `LLMLoadModelConfig` and letting the SDK convert. The name and
// scope come from the shipping `lms` binary, which maps its own CLI-side
// `maxParallelPredictions` onto `numParallelSessions` inside the `llm.load`
// scope:
//   const top = llmLoadSchematics.buildPartialConfig({
//     gpuSplitConfig: ..., numParallelSessions: config2.maxParallelPredictions,
//     contextLength: ..., "llama.flashAttention": ..., ... })
// That is the same knob `lms load --parallel` set, so replacing the CLI does
// not lose it.
//
// -----------------------------------------------------------------------------
// WHAT THESE ENV VARS ARE
// -----------------------------------------------------------------------------
// The BOOTSTRAP FLOOR, and nothing more: the values the pod loads with before
// the database is reachable. Steady-state serving configuration is governed
// (TASK-996 Phase 2+); env governs cold start only. That is why an UNSET
// variable emits no field rather than a default — a field we do not send is a
// decision we have not taken, and the daemon's own default applies. Only
// LMS_GPU has a default here, because `lms load` had one (`--gpu max`) and
// changing how much of a model is offloaded is not a side effect this ticket
// gets to have.
// =============================================================================

/**
 * A configuration fault, always attributable to one environment variable.
 * Never a crash: the caller turns this into the same EX_CONFIG exit the rest
 * of entrypoint.sh uses, so `kubectl describe` distinguishes "misconfigured"
 * from "died".
 */
export class KvConfigError extends Error {
  constructor(envVar, message) {
    super(`${envVar}: ${message}`);
    this.name = 'KvConfigError';
    this.envVar = envVar;
  }
}

/**
 * `LLMLlamaCacheQuantizationType`, @lmstudio/sdk 1.5.0 index.d.ts:4797.
 * Exported so the test asserts against the SDK's list rather than a copy of it
 * that could drift.
 */
export const CACHE_QUANTIZATION_TYPES = Object.freeze([
  'f32',
  'f16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
]);

/**
 * `gpuSplitConfig.strategy`.
 *
 * The two copies of "@lmstudio/sdk@1.5.0" DISAGREE about this union, and the
 * disagreement is real, not a misreading: the npm tarball declares
 * `"custom" | "evenly" | "priorityOrder"`, while the copy vendored inside the
 * llmster image (same version string, different build, CRLF line endings)
 * declares those three plus `"tensor"`. The daemon is the only authority on
 * which it accepts, and it rejects what it does not know. Refusing "tensor"
 * here would invent a restriction the running daemon may not have and would
 * make R-6 undeliverable for no reason; accepting it costs nothing, because a
 * daemon that does not know it fails the load and load.mjs refuses to serve.
 * The value of validating at all is catching a TYPO ("even", "evenly " ) before
 * it reaches a bag that silently ignores unknown values.
 */
export const GPU_SPLIT_STRATEGIES = Object.freeze(['custom', 'evenly', 'priorityOrder', 'tensor']);

const TRUE_WORDS = new Set(['true', '1', 'on', 'yes']);
const FALSE_WORDS = new Set(['false', '0', 'off', 'no']);

/** Treat unset and empty alike: `${VAR:+...}` in the shell did, and manifests set empty strings. */
const read = (env, name) => {
  const raw = env[name];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
};

const parseBoolean = (env, name) => {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  const word = raw.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new KvConfigError(
    name,
    `expected a boolean (${[...TRUE_WORDS].join('/')} or ${[...FALSE_WORDS].join('/')}), got "${raw}"`,
  );
};

const parsePositiveInt = (env, name) => {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  // Number() rather than parseInt(): parseInt("64k") is 64, which is exactly
  // the kind of quiet mis-load this loader exists to make impossible.
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new KvConfigError(name, `expected a positive integer, got "${raw}"`);
  }
  return value;
};

/**
 * `LLMLlamaAccelerationOffloadRatio`: a 0..1 ratio, or the words "off"/"max".
 *
 * CANONICALISED TO THE NUMBER on the way out, because the daemon stores it as
 * one. Measured on the live pod: a model loaded with `--gpu max` reads back
 * `llm.load.llama.acceleration.offloadRatio = 1`, not `"max"`. Both forms are
 * accepted on the wire (the SDK's own schema is `number | "off" | "max"`), so
 * sending the canonical form costs nothing and keeps load.mjs's read-back an
 * exact comparison instead of one carrying a special case. The env surface
 * still takes the words, because `lms load --gpu max` did.
 */
const parseOffloadRatio = (env, name, fallback) => {
  const raw = read(env, name) ?? fallback;
  if (raw === undefined) return undefined;
  if (raw === 'max') return 1;
  if (raw === 'off') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new KvConfigError(name, `expected "max", "off", or a ratio between 0 and 1, got "${raw}"`);
  }
  return value;
};

/** A comma-separated list of GPU indices. Order is meaningful for `priority`. */
const parseGpuIndexList = (env, name) => {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((p) => p.trim());
  const indices = parts.map((part) => {
    const value = Number(part);
    if (part === '' || !Number.isSafeInteger(value) || value < 0) {
      throw new KvConfigError(name, `expected comma-separated GPU indices (0-based), got "${raw}"`);
    }
    return value;
  });
  // A duplicate is never a preference — "priority: [0,0]" and "disabled: [1,1]"
  // are both a hand slipping on a manifest, and both are cheaper to catch here
  // than to diagnose from an unexpected VRAM split hours later.
  if (new Set(indices).size !== indices.length) {
    throw new KvConfigError(name, `repeats a GPU index: "${raw}"`);
  }
  return indices;
};

/** A comma-separated list of non-negative split weights for `strategy: "custom"`. */
const parseRatioList = (env, name) => {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  return raw.split(',').map((p) => p.trim()).map((part) => {
    const value = Number(part);
    if (part === '' || !Number.isFinite(value) || value < 0) {
      throw new KvConfigError(name, `expected comma-separated non-negative numbers, got "${raw}"`);
    }
    return value;
  });
};

/**
 * `{checked, value}` — the checkbox shape the daemon stores these in, mirroring
 * the SDK's own `cacheQuantizationTypeToCheckbox({value, falseDefault: "f16"})`.
 * A bare string here is silently ignored by the daemon, so the shape matters as
 * much as the key.
 */
const parseCacheQuantization = (env, name) => {
  const raw = read(env, name);
  if (raw === undefined) return undefined;
  if (FALSE_WORDS.has(raw.toLowerCase())) return { checked: false, value: 'f16' };
  if (!CACHE_QUANTIZATION_TYPES.includes(raw)) {
    throw new KvConfigError(
      name,
      `expected one of ${CACHE_QUANTIZATION_TYPES.join(', ')} (or "off" to disable), got "${raw}"`,
    );
  }
  return { checked: true, value: raw };
};

/**
 * All four sub-fields are REQUIRED by the daemon's type, so the moment any one
 * gpu-split variable is set we must supply a complete object. The defaults
 * restated here ("evenly", empty lists) are the daemon's own — which is also
 * why nothing is emitted at all when no variable is set: sending the default
 * explicitly and sending nothing are the same to the daemon today, but only the
 * latter stays correct if the default changes.
 */
const buildGpuSplitConfig = (env) => {
  const rawStrategy = read(env, 'LMS_GPU_SPLIT_STRATEGY');
  const disabledGpus = parseGpuIndexList(env, 'LMS_GPU_DISABLED');
  const priority = parseGpuIndexList(env, 'LMS_GPU_PRIORITY');
  const customRatio = parseRatioList(env, 'LMS_GPU_CUSTOM_RATIO');

  if (rawStrategy === undefined && disabledGpus === undefined && priority === undefined && customRatio === undefined) {
    return undefined;
  }

  if (rawStrategy !== undefined && !GPU_SPLIT_STRATEGIES.includes(rawStrategy)) {
    throw new KvConfigError(
      'LMS_GPU_SPLIT_STRATEGY',
      `unknown strategy "${rawStrategy}" — expected one of ${GPU_SPLIT_STRATEGIES.join(', ')}`,
    );
  }
  const strategy = rawStrategy ?? 'evenly';

  // A strategy that reads a list it was not given does not fail — it falls back
  // to splitting evenly, which is precisely the 4,996/8,908 MiB split R-6 is
  // meant to end. Silence here would look like the feature simply not working.
  if (strategy === 'priorityOrder' && (priority === undefined || priority.length === 0)) {
    throw new KvConfigError(
      'LMS_GPU_SPLIT_STRATEGY',
      'strategy "priorityOrder" needs LMS_GPU_PRIORITY — without it the daemon splits evenly and the pin is lost',
    );
  }
  if (strategy === 'custom' && (customRatio === undefined || customRatio.length === 0)) {
    throw new KvConfigError(
      'LMS_GPU_SPLIT_STRATEGY',
      'strategy "custom" needs LMS_GPU_CUSTOM_RATIO — without it there is no split to apply',
    );
  }

  const resolvedDisabled = disabledGpus ?? [];
  const resolvedPriority = priority ?? [];
  const contradictions = resolvedPriority.filter((gpu) => resolvedDisabled.includes(gpu));
  if (contradictions.length > 0) {
    throw new KvConfigError(
      'LMS_GPU_PRIORITY',
      `GPU ${contradictions.join(', ')} is both prioritised and disabled by LMS_GPU_DISABLED`,
    );
  }

  // Deliberately NOT validated: whether these indices exist. The loader cannot
  // see the devices, the daemon can, and inventing a device count here would be
  // a second source of truth about the hardware.
  return { strategy, disabledGpus: resolvedDisabled, priority: resolvedPriority, customRatio: customRatio ?? [] };
};

/**
 * Assemble the whole load request from the environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ modelKey: string, identifier?: string, ttlMs?: number,
 *             kvConfig: { fields: Array<{ key: string, value: unknown }> } }}
 * @throws {KvConfigError} naming the offending variable.
 */
export function assembleLoadRequest(env) {
  const modelKey = read(env, 'LMS_LOAD');
  if (modelKey === undefined) {
    throw new KvConfigError('LMS_LOAD', 'no model key — there is nothing to preload');
  }

  const flashAttention = parseBoolean(env, 'LMS_FLASH_ATTENTION');
  const kCache = parseCacheQuantization(env, 'LMS_KV_CACHE_K');
  const vCache = parseCacheQuantization(env, 'LMS_KV_CACHE_V');

  // llama.cpp cannot quantize the V cache without flash attention — the SDK
  // says so on `llamaVCacheQuantizationType` and llama.cpp refuses at load.
  // The K cache is held to the same rule on purpose: a request that quantizes
  // half the cache while attention runs naively is a manifest someone got
  // wrong, and this is a fail-closed boot path. Refusing costs one clear
  // message; accepting it means serving on parameters nobody asked for.
  for (const [name, quant] of [['LMS_KV_CACHE_K', kCache], ['LMS_KV_CACHE_V', vCache]]) {
    if (quant?.checked && flashAttention !== true) {
      throw new KvConfigError(
        name,
        `KV cache quantization ("${quant.value}") requires flash attention — set LMS_FLASH_ATTENTION=true, ` +
          'or drop the quantization. llama.cpp cannot serve this combination',
      );
    }
  }

  const gpuSplitConfig = buildGpuSplitConfig(env);
  const ttlSeconds = parsePositiveInt(env, 'LMS_TTL');

  // Insertion order IS the wire order, so a failed load logs a stable,
  // diffable request rather than a reshuffled one.
  const candidates = [
    ['llm.load.contextLength', parsePositiveInt(env, 'LMS_CONTEXT')],
    ['llm.load.numParallelSessions', parsePositiveInt(env, 'LMS_PARALLEL')],
    ['llm.load.llama.acceleration.offloadRatio', parseOffloadRatio(env, 'LMS_GPU', 'max')],
    ['llm.load.llama.flashAttention', flashAttention],
    ['llm.load.llama.kCacheQuantizationType', kCache],
    ['llm.load.llama.vCacheQuantizationType', vCache],
    ['load.gpuSplitConfig', gpuSplitConfig],
  ];

  return {
    modelKey,
    identifier: read(env, 'LMS_IDENTIFIER'),
    // The CLI took seconds; the channel takes milliseconds.
    ttlMs: ttlSeconds === undefined ? undefined : ttlSeconds * 1000,
    kvConfig: {
      fields: candidates
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ key, value })),
    },
  };
}
