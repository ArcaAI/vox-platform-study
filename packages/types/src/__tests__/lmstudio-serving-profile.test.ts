/**
 * TASK-996 Phase 2a — `AiModelServingProfile`: the typed shape of
 * `AiModel._metadata.serving` and its parser + coherence check.
 *
 * Two layers, deliberately separate:
 *  - `parseAiModelServingProfile` is SHAPE ONLY — per-field type/range/enum. It
 *    can never see the whole picture, because a model row may legitimately
 *    declare one field and inherit the rest from the platform default.
 *  - `checkAiModelServingProfile` is CROSS-FIELD, and runs on a RESOLVED
 *    profile: the flash-attention/V-cache interlock, the gpuSplit strategy's
 *    own required array, and the TASK-995 context LOCKSTEP.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES,
  AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES,
  checkAiModelServingProfile,
  parseAiModelServingProfile,
} from '../lmstudio-serving-profile.js';

describe('parseAiModelServingProfile — the happy path', () => {
  it('reads every declared member of a full profile', () => {
    const { profile, rejected } = parseAiModelServingProfile({
      contextLength: 65536,
      parallel: 4,
      flashAttention: true,
      kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
      gpuSplit: { strategy: 'custom', disabledGpus: [1], priority: [0, 1], customRatio: [1, 0] },
    });
    expect(rejected).toEqual([]);
    expect(profile).toEqual({
      contextLength: 65536,
      parallel: 4,
      flashAttention: true,
      kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
      gpuSplit: { strategy: 'custom', disabledGpus: [1], priority: [0, 1], customRatio: [1, 0] },
    });
  });

  it('a partial profile keeps only what it declared — absence is not a value', () => {
    const { profile, rejected } = parseAiModelServingProfile({ gpuSplit: { disabledGpus: [1] } });
    expect(rejected).toEqual([]);
    expect(profile).toEqual({ gpuSplit: { disabledGpus: [1] } });
    expect(profile).not.toHaveProperty('contextLength');
  });

  it('a non-object, null or undefined row yields an empty profile, not a throw', () => {
    for (const raw of [undefined, null, 42, 'serving', []]) {
      expect(parseAiModelServingProfile(raw)).toEqual({ profile: {}, rejected: [] });
    }
  });

  it('accepts every published gpu-split strategy and kv-cache quantization type', () => {
    for (const strategy of AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES) {
      expect(parseAiModelServingProfile({ gpuSplit: { strategy } }).rejected).toEqual([]);
    }
    for (const type of AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES) {
      expect(parseAiModelServingProfile({ kvCacheQuant: { k: type, v: type } }).rejected).toEqual([]);
    }
  });
});

describe('parseAiModelServingProfile — validation rejections (drop and NAME, never coerce)', () => {
  it('drops an out-of-range or non-integer contextLength / parallel', () => {
    expect(parseAiModelServingProfile({ contextLength: 0 })).toEqual({ profile: {}, rejected: ['contextLength'] });
    expect(parseAiModelServingProfile({ contextLength: 65536.5 })).toEqual({ profile: {}, rejected: ['contextLength'] });
    expect(parseAiModelServingProfile({ parallel: 0 })).toEqual({ profile: {}, rejected: ['parallel'] });
    expect(parseAiModelServingProfile({ parallel: 1024 })).toEqual({ profile: {}, rejected: ['parallel'] });
  });

  it('drops a non-boolean flashAttention rather than coercing a truthy string', () => {
    const { profile, rejected } = parseAiModelServingProfile({ flashAttention: 'true' });
    expect(profile).toEqual({});
    expect(rejected).toEqual(['flashAttention']);
  });

  it('drops an unknown kv-cache quantization type and names the exact member', () => {
    const { profile, rejected } = parseAiModelServingProfile({ kvCacheQuant: { k: 'q8_0', v: 'q3_k_m' } });
    expect(profile).toEqual({ kvCacheQuant: { k: 'q8_0' } });
    expect(rejected).toEqual(['kvCacheQuant.v']);
  });

  it('drops an unknown gpuSplit strategy and names it', () => {
    const { profile, rejected } = parseAiModelServingProfile({ gpuSplit: { strategy: 'favorMainGpu' } });
    expect(profile).toEqual({});
    expect(rejected).toEqual(['gpuSplit.strategy']);
  });

  it('drops a gpu index array that is not a set of plausible device indices', () => {
    expect(parseAiModelServingProfile({ gpuSplit: { disabledGpus: [-1] } }).rejected).toEqual(['gpuSplit.disabledGpus']);
    expect(parseAiModelServingProfile({ gpuSplit: { priority: [0, 0] } }).rejected).toEqual(['gpuSplit.priority']);
    expect(parseAiModelServingProfile({ gpuSplit: { disabledGpus: [1.5] } }).rejected).toEqual(['gpuSplit.disabledGpus']);
    expect(parseAiModelServingProfile({ gpuSplit: { priority: 'gpu0' } }).rejected).toEqual(['gpuSplit.priority']);
  });

  it('drops a customRatio that is all zero — it would allocate the model nowhere', () => {
    expect(parseAiModelServingProfile({ gpuSplit: { customRatio: [0, 0] } }).rejected).toEqual(['gpuSplit.customRatio']);
    expect(parseAiModelServingProfile({ gpuSplit: { customRatio: [0.75, 0.25] } }).rejected).toEqual([]);
  });

  it('names an unknown key at every level instead of storing it', () => {
    const { profile, rejected } = parseAiModelServingProfile({
      contextLength: 65536,
      draftModel: 'gemma-4-e2b',
      kvCacheQuant: { k: 'q8_0', mode: 'auto' },
      gpuSplit: { strategy: 'evenly', mainGpu: 0 },
    });
    expect(profile).toEqual({ contextLength: 65536, kvCacheQuant: { k: 'q8_0' }, gpuSplit: { strategy: 'evenly' } });
    expect(rejected).toEqual(['kvCacheQuant.mode', 'gpuSplit.mainGpu', 'draftModel']);
  });

  it('names a nested block that is not an object, and stores nothing from it', () => {
    expect(parseAiModelServingProfile({ kvCacheQuant: 'q8_0' })).toEqual({ profile: {}, rejected: ['kvCacheQuant'] });
    expect(parseAiModelServingProfile({ gpuSplit: [0, 1] })).toEqual({ profile: {}, rejected: ['gpuSplit'] });
  });

  it('omits an empty nested block entirely — an empty block and an absent one are one state', () => {
    expect(parseAiModelServingProfile({ kvCacheQuant: {}, gpuSplit: {} })).toEqual({ profile: {}, rejected: [] });
  });
});

describe('checkAiModelServingProfile — cross-field coherence', () => {
  it('a coherent profile has nothing to say', () => {
    expect(
      checkAiModelServingProfile({
        contextLength: 65536,
        parallel: 4,
        flashAttention: true,
        kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
        gpuSplit: { strategy: 'evenly' },
      }),
    ).toEqual([]);
  });

  it('refuses a QUANTIZED V-cache while flash attention is off — llama.cpp cannot serve it', () => {
    const problems = checkAiModelServingProfile({ flashAttention: false, kvCacheQuant: { v: 'q8_0' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/flash/i);
    expect(problems[0]).toContain('kvCacheQuant.v');
  });

  it('treats an ABSENT flashAttention as off — the engine default is off, and absence is not consent', () => {
    expect(checkAiModelServingProfile({ kvCacheQuant: { v: 'q8_0' } })).toHaveLength(1);
  });

  it('allows an unquantized V-cache with flash attention off, and a quantized K-cache without it', () => {
    expect(checkAiModelServingProfile({ flashAttention: false, kvCacheQuant: { k: 'q8_0', v: 'f16' } })).toEqual([]);
    expect(checkAiModelServingProfile({ flashAttention: false, kvCacheQuant: { k: 'q8_0' } })).toEqual([]);
  });

  it('refuses a gpuSplit strategy whose own array is missing', () => {
    expect(checkAiModelServingProfile({ gpuSplit: { strategy: 'custom' } })[0]).toContain('customRatio');
    expect(checkAiModelServingProfile({ gpuSplit: { strategy: 'priorityOrder' } })[0]).toContain('priority');
    expect(checkAiModelServingProfile({ gpuSplit: { strategy: 'custom', customRatio: [1, 0] } })).toEqual([]);
    expect(checkAiModelServingProfile({ gpuSplit: { strategy: 'priorityOrder', priority: [1, 0] } })).toEqual([]);
  });

  it('refuses a split that disables every GPU it was also told to prefer', () => {
    const problems = checkAiModelServingProfile({
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [1] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('disabledGpus');
  });
});

describe('checkAiModelServingProfile — the TASK-995 context LOCKSTEP', () => {
  it('refuses a DECLARED window wider than the SERVED one — that is exceed_context_size_error', () => {
    const problems = checkAiModelServingProfile({ contextLength: 65536 }, { declaredContextLength: 131072 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('131072');
    expect(problems[0]).toContain('65536');
  });

  it('accepts equality — the two halves agreeing exactly is the intended state', () => {
    expect(checkAiModelServingProfile({ contextLength: 65536 }, { declaredContextLength: 65536 })).toEqual([]);
  });

  it('accepts an UNDER-claim: unused headroom is safe, the invariant is one-directional', () => {
    expect(checkAiModelServingProfile({ contextLength: 65536 }, { declaredContextLength: 16384 })).toEqual([]);
  });

  it('says nothing when either half is undeclared — there is no pair to compare', () => {
    expect(checkAiModelServingProfile({ contextLength: 65536 })).toEqual([]);
    expect(checkAiModelServingProfile({}, { declaredContextLength: 131072 })).toEqual([]);
    expect(checkAiModelServingProfile({}, { declaredContextLength: null })).toEqual([]);
  });
});
