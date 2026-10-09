// =============================================================================
// load_spec -> kvConfig, and the applied kvConfig -> load_config. PURE.
// =============================================================================
// The gateway sends the model's RESOLVED serving profile (snake_case, contract
// `lmStudioAgent.loadRequest.load_spec`) — the same resolution the boot plan
// uses. This module turns it into a boot-plan entry and hands it to
// `assemblePlanRequest` (../loader/kvconfig.mjs), so a console load obeys the
// boot loader's rules to the letter: same kvConfig keys, same field order,
// same refusals (KV quantization without flash attention, a priorityOrder with
// no priority, a pin to a card that does not exist). That is AC-2: a reload is
// identical to a boot load.
// =============================================================================
import { KvConfigError, assemblePlanRequest } from '../loader/kvconfig.mjs';

/** A refused load_spec / device. `code` is a contract error code. */
export class LoadSpecError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LoadSpecError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const LOAD_SPEC_KEYS = new Set([
  'identifier',
  'context_length',
  'parallel',
  'flash_attention',
  'kv_cache_quant',
  'gpu_split',
  'ttl_seconds',
]);
const GPU_SPLIT_KEYS = new Set(['strategy', 'priority', 'disabled_gpus', 'custom_ratio']);
const KV_QUANT_KEYS = new Set(['k', 'v']);

/** The boot plan's camelCase field names, as the gateway's snake_case spells them. */
const SNAKE_NAMES = [
  ['.contextLength', '.context_length'],
  ['.flashAttention', '.flash_attention'],
  ['.kvCacheQuant', '.kv_cache_quant'],
  ['.gpuSplit', '.gpu_split'],
  ['.disabledGpus', '.disabled_gpus'],
  ['.customRatio', '.custom_ratio'],
];
const toSnake = (text) => SNAKE_NAMES.reduce((acc, [camel, snake]) => acc.split(camel).join(snake), text);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAbsent = (value) => value === undefined || value === null;

const refuseUnknown = (value, allowed, path) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new LoadSpecError(
      'LOAD_FAILED',
      `invalid load_spec: unknown field(s) ${unknown.map((k) => `${path}.${k}`).join(', ')} — ` +
        `LM Studio would ignore an unknown kvConfig key silently, so it is refused here (allowed: ${[...allowed].join(', ')})`,
      { field: `${path}.${unknown[0]}` },
    );
  }
};

const deviceIndex = (device, gpuCount) => {
  const match = typeof device === 'string' ? /^cuda:(\d+)$/.exec(device) : null;
  if (!match) {
    throw new LoadSpecError(
      'DEVICE_UNAVAILABLE',
      `lm-studio places models on GPUs only (cuda:<n>), got "${device}"`,
      { device },
    );
  }
  const index = Number(match[1]);
  if (!Number.isSafeInteger(gpuCount) || gpuCount < 1) {
    throw new LoadSpecError(
      'DEVICE_UNAVAILABLE',
      `cannot place on ${device}: the GPU count is unknown (nvidia-smi gave nothing usable; set LMS_GPU_COUNT) — ` +
        'refusing to guess which cards to disable',
      { device },
    );
  }
  if (index >= gpuCount) {
    throw new LoadSpecError(
      'DEVICE_UNAVAILABLE',
      `lm-studio sees no device ${device} — ${gpuCount} GPU(s) detected (cuda:0..cuda:${gpuCount - 1})`,
      { device },
    );
  }
  return index;
};

/**
 * Build the daemon load request for one residency load.
 *
 * @param {{ modelRef: string, loadSpec: object, device?: string|null, pin: boolean,
 *           ttlSeconds?: number|null, gpuCount?: number, env: object }} input
 * @returns {{ identifier: string, ttlMs?: number, kvConfig: {fields: Array<{key, value}>},
 *             gpuSplit?: object }}
 * @throws {LoadSpecError}
 */
export function buildLoadRequest({ modelRef, loadSpec, device, pin, ttlSeconds, gpuCount, env }) {
  const spec = isAbsent(loadSpec) ? {} : loadSpec;
  if (!isObject(spec)) throw new LoadSpecError('LOAD_FAILED', 'invalid load_spec: expected an object', { field: 'load_spec' });
  refuseUnknown(spec, LOAD_SPEC_KEYS, 'load_spec');

  const identifier =
    typeof spec.identifier === 'string' && spec.identifier.trim() !== '' ? spec.identifier.trim() : modelRef;

  const entry = {
    slug: identifier,
    contextLength: spec.context_length,
    parallel: spec.parallel,
    flashAttention: spec.flash_attention,
  };

  if (!isAbsent(spec.kv_cache_quant)) {
    if (!isObject(spec.kv_cache_quant)) {
      throw new LoadSpecError('LOAD_FAILED', 'invalid load_spec: load_spec.kv_cache_quant must be {k, v} or null', {
        field: 'load_spec.kv_cache_quant',
      });
    }
    refuseUnknown(spec.kv_cache_quant, KV_QUANT_KEYS, 'load_spec.kv_cache_quant');
    entry.kvCacheQuant = { k: spec.kv_cache_quant.k, v: spec.kv_cache_quant.v };
  }

  if (!isAbsent(device)) {
    // `device` OVERRIDES the profile's split: this card and nothing else.
    entry.gpu = deviceIndex(device, gpuCount);
  } else if (!isAbsent(spec.gpu_split)) {
    if (!isObject(spec.gpu_split)) {
      throw new LoadSpecError('LOAD_FAILED', 'invalid load_spec: load_spec.gpu_split must be an object or null', {
        field: 'load_spec.gpu_split',
      });
    }
    refuseUnknown(spec.gpu_split, GPU_SPLIT_KEYS, 'load_spec.gpu_split');
    entry.gpuSplit = {
      strategy: spec.gpu_split.strategy,
      priority: spec.gpu_split.priority,
      disabledGpus: spec.gpu_split.disabled_gpus,
      customRatio: spec.gpu_split.custom_ratio,
    };
  }

  const ttl = isAbsent(spec.ttl_seconds) ? ttlSeconds : spec.ttl_seconds;
  if (!isAbsent(ttl) && (!Number.isSafeInteger(ttl) || ttl < 1)) {
    throw new LoadSpecError('LOAD_FAILED', `invalid load_spec: ttl_seconds must be a positive integer, got ${JSON.stringify(ttl)}`, {
      field: 'load_spec.ttl_seconds',
    });
  }

  let request;
  try {
    request = assemblePlanRequest(entry, 'load_spec', { env, gpuCount });
  } catch (error) {
    if (!(error instanceof KvConfigError)) throw error;
    throw new LoadSpecError('LOAD_FAILED', `invalid load_spec: ${toSnake(error.message)}`, {
      field: toSnake(error.envVar),
    });
  }

  const split = request.kvConfig.fields.find((field) => field.key === 'load.gpuSplitConfig')?.value;
  return {
    identifier,
    // A pinned model must never be idle-unloaded by the daemon.
    ttlMs: pin || isAbsent(ttl) ? undefined : ttl * 1000,
    kvConfig: request.kvConfig,
    gpuSplit: split,
  };
}

const quantSide = (value) => (isObject(value) && value.checked === true ? value.value : null);

/**
 * The applied kvConfig of a loaded instance -> the contract's snake_case
 * `load_config`. An absent field is `null` (the daemon's default applies).
 */
export function loadConfigFromFields(fields) {
  const byKey = new Map((fields ?? []).map((field) => [field.key, field.value]));
  const get = (key) => (byKey.has(key) ? byKey.get(key) : null);
  const k = byKey.get('llm.load.llama.kCacheQuantizationType');
  const v = byKey.get('llm.load.llama.vCacheQuantizationType');
  const split = byKey.get('load.gpuSplitConfig');
  return {
    context_length: get('llm.load.contextLength'),
    parallel: get('llm.load.numParallelSessions'),
    flash_attention: get('llm.load.llama.flashAttention'),
    kv_cache_quant: k === undefined && v === undefined ? null : { k: quantSide(k), v: quantSide(v) },
    gpu_split: isObject(split)
      ? {
          strategy: split.strategy ?? null,
          priority: Array.isArray(split.priority) ? split.priority : [],
          disabled_gpus: Array.isArray(split.disabledGpus) ? split.disabledGpus : [],
          custom_ratio: Array.isArray(split.customRatio) ? split.customRatio : [],
        }
      : null,
  };
}

const enabledCards = (split, gpuCount) => {
  const disabled = new Set(Array.isArray(split?.disabledGpus) ? split.disabledGpus : []);
  return [...Array(gpuCount).keys()].filter((index) => !disabled.has(index));
};

/**
 * Which device an instance sits on, from its gpuSplit (daemon shape): exactly
 * one enabled card -> `cuda:<n>`; anything wider (or unknowable) -> `multi`.
 */
export function deviceOfSplit(split, gpuCount) {
  if (!Number.isSafeInteger(gpuCount) || gpuCount < 1) return 'multi';
  if (gpuCount === 1) return 'cuda:0';
  const enabled = enabledCards(split, gpuCount);
  return enabled.length === 1 ? `cuda:${enabled[0]}` : 'multi';
}

/**
 * An ESTIMATE of per-card bytes for an instance this agent did not load (the
 * boot plan, a JIT load): the GGUF file size, split by the configured gpuSplit.
 * priorityOrder fills its first enabled card first, so the file is booked
 * there; `custom` uses the ratios; anything else splits evenly.
 */
export function estimateDeviceBytes(sizeBytes, split, gpuCount) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isSafeInteger(gpuCount) || gpuCount < 1) return {};
  const enabled = enabledCards(split, gpuCount);
  if (enabled.length === 0) return {};

  if (split?.strategy === 'priorityOrder') {
    const first = (split.priority ?? []).find((index) => enabled.includes(index)) ?? enabled[0];
    return { [`cuda:${first}`]: sizeBytes };
  }

  const weights = enabled.map((index) =>
    split?.strategy === 'custom' ? Math.max(0, Number(split.customRatio?.[index] ?? 0)) : 1,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return {};
  const out = {};
  let assigned = 0;
  enabled.forEach((index, i) => {
    const share = i === enabled.length - 1 ? sizeBytes - assigned : Math.floor((sizeBytes * weights[i]) / total);
    assigned += share;
    if (share > 0) out[`cuda:${index}`] = share;
  });
  return out;
}
