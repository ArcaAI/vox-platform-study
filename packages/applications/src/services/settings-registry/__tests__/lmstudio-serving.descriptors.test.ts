/**
 * TASK-996 Phase 2b — the LM Studio serving catalog.
 *
 * Registering a descriptor is the ONLY step that makes a key governed and
 * writable, so these assertions are the difference between "a platform admin
 * can set the served context window without a redeploy" and "it stays a
 * manifest edit". Four invariants beyond mere presence:
 *
 *  1. PLATFORM-ONLY. These decide how much VRAM one process takes on shared,
 *     time-sliced cards that also host `hope-stt` and the guardrail model; a
 *     tenant raising a context window would evict another tenant's workload.
 *  2. `open-to-default`, every one. Nothing here SELECTS a provider or a model,
 *     so nothing here is fail-closed; an unreadable row must degrade to today's
 *     behaviour rather than refuse to serve the AI plane.
 *  3. Every default IS today's measured behaviour — registering this family
 *     changes ZERO serving behaviour, and the shipped set is self-consistent.
 *  4. The two closed vocabularies agree, member for member, with the tables the
 *     row parser reads with (`@arcaai/types`). They are written out twice on
 *     purpose (the descriptor file stays dependency-free); this is what stops
 *     the two copies drifting.
 */
import { describe, expect, it } from 'vitest';
import { AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES, AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES } from '@arcaai/types';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { LM_STUDIO_SERVING_DEFAULTS, LM_STUDIO_SERVING_SETTINGS, type LmStudioServingKey } from '../descriptors/lmstudio-serving.descriptors';
import { resolveServingProfile, shippedPlatformServingProfile } from '../../ai-model/serving-profile.util';

const ALL_KEYS = Object.keys(LM_STUDIO_SERVING_DEFAULTS) as LmStudioServingKey[];

describe('LM Studio serving descriptors', () => {
  it('registers all eight keys — the six-field platform profile plus the two JIT defaults', () => {
    expect(ALL_KEYS).toEqual([
      'lmStudio.serving.contextLength',
      'lmStudio.serving.parallel',
      'lmStudio.serving.flashAttention',
      'lmStudio.serving.kvCacheQuantK',
      'lmStudio.serving.kvCacheQuantV',
      'lmStudio.serving.gpuSplitStrategy',
      'lmStudio.jit.defaultContextLength',
      'lmStudio.jit.modelTtlSeconds',
    ]);
    for (const key of ALL_KEYS) expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
    expect(LM_STUDIO_SERVING_SETTINGS.map((d) => d.key)).toEqual(ALL_KEYS);
  });

  it('scopes them to the platform: SYSTEM-only, super-admin-editable, global-kv', () => {
    for (const key of ALL_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.tier, key).toBe('global-kv');
      expect(d.maxScope, key).toBe('system');
      expect(d.globalOnly, key).toBe(true);
      expect(d.sensitivity, key).toBe('internal');
    }
  });

  it('declares every key as a tuning knob that degrades to its default — none is a SELECTION', () => {
    for (const key of ALL_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(d.failMode, key).toBe('open-to-default');
      expect(d.killSwitch, key).toBeUndefined();
    }
  });

  it('declares the engine defaults it ships with, so registering them changed no behaviour', () => {
    for (const key of ALL_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).default, key).toBe(LM_STUDIO_SERVING_DEFAULTS[key]);
    }
    // Flash attention off + an unquantized KV cache is exactly what the live
    // `llama-server` cmdline shows. Turning them on is a MEASURED change an
    // admin makes, not a default that arrives with a descriptor file.
    expect(LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.flashAttention']).toBe(false);
    expect(LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.kvCacheQuantK']).toBe('f16');
    expect(LM_STUDIO_SERVING_DEFAULTS['lmStudio.serving.kvCacheQuantV']).toBe('f16');
  });

  it('the shipped defaults resolve to a COHERENT profile — no self-contradiction out of the box', () => {
    expect(resolveServingProfile(null, shippedPlatformServingProfile()).problems).toEqual([]);
  });
});

describe('LM Studio serving descriptors — write-lane validation', () => {
  const validate = (key: LmStudioServingKey, value: unknown) => HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate?.(value);

  it('accepts every declared default', () => {
    for (const key of ALL_KEYS) expect(validate(key, LM_STUDIO_SERVING_DEFAULTS[key]), key).toBeUndefined();
  });

  it('refuses a context window or slot count that is not a whole number in range', () => {
    expect(validate('lmStudio.serving.contextLength', 0)).toMatch(/whole number/);
    expect(validate('lmStudio.serving.contextLength', 65_536.5)).toMatch(/whole number/);
    expect(validate('lmStudio.serving.parallel', 0)).toMatch(/whole number/);
    expect(validate('lmStudio.serving.parallel', 1024)).toMatch(/whole number/);
    expect(validate('lmStudio.jit.defaultContextLength', -1)).toMatch(/whole number/);
    expect(validate('lmStudio.jit.modelTtlSeconds', 86_401)).toMatch(/whole number/);
  });

  it('refuses a value outside the closed vocabulary, and names the vocabulary', () => {
    expect(validate('lmStudio.serving.kvCacheQuantV', 'q3_k_m')).toMatch(/must be one of/);
    expect(validate('lmStudio.serving.gpuSplitStrategy', 'favorMainGpu')).toMatch(/must be one of/);
  });

  it('accepts every member of the vocabularies the ROW PARSER reads with — the two copies agree', () => {
    for (const type of AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES) {
      expect(validate('lmStudio.serving.kvCacheQuantK', type), type).toBeUndefined();
      expect(validate('lmStudio.serving.kvCacheQuantV', type), type).toBeUndefined();
    }
    for (const strategy of AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES) {
      expect(validate('lmStudio.serving.gpuSplitStrategy', strategy), strategy).toBeUndefined();
    }
  });

  it('accepts NOTHING the row parser would reject — the descriptor is not the wider of the two', () => {
    const kvTypes = new Set<string>(AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES);
    const strategies = new Set<string>(AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES);
    for (const bogus of ['bf16', 'q3_k_m', 'Q8_0', '']) expect(kvTypes.has(bogus) || validate('lmStudio.serving.kvCacheQuantK', bogus)).toBeTruthy();
    for (const bogus of ['favorMainGpu', 'EVENLY', ''])
      expect(strategies.has(bogus) || validate('lmStudio.serving.gpuSplitStrategy', bogus)).toBeTruthy();
  });
});

describe('LM Studio serving descriptors — what is deliberately NOT registered', () => {
  it('has no per-device array key: placement is a per-MODEL decision, not a platform-wide one', () => {
    for (const key of ['lmStudio.serving.gpuSplitDisabledGpus', 'lmStudio.serving.gpuSplitPriority', 'lmStudio.serving.gpuSplitCustomRatio']) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(false);
    }
  });

  it('has no tenant tier: there is no tenant opinion about another tenant`s VRAM', () => {
    for (const key of ALL_KEYS) expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).platformTierKey, key).toBeUndefined();
  });

  it('is not pushed onto the internal effective-config pull route — no Python service loads models', () => {
    for (const key of ALL_KEYS) expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).consumedBy, key).toBeUndefined();
  });
});
