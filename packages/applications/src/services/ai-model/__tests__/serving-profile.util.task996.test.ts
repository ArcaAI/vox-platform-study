/**
 * TASK-996 Phase 2 — the serving-profile cascade: `AiModel._metadata.serving`
 * (owner decision D-7) resolved against the `lmStudio.serving.*` platform
 * default from the settings registry.
 *
 * This is CONFIGURATION, so it cascades and widens ONLY on absence
 * (`00-project-context.md` §Configuration Principles rule 2). It is NOT content
 * and is never cloned per tenant: every row here is SYSTEM-owned and
 * shared-read (§"Content is cloned; configuration cascades").
 *
 * What this file pins:
 *  1. Resolution order — model profile wins, the platform default fills ONLY
 *     what the model left unsaid, and a field neither tier declares stays
 *     absent rather than being invented.
 *  2. Validation — the stored row goes through the SAME parser
 *     (`parseAiModelServingProfile`) the Phase 1 loader will read with, so a
 *     projection can never show an admin a value the runtime would drop.
 *  3. The TASK-995 LOCKSTEP — a declared context window wider than the served
 *     one is reported at resolve time, not discovered as
 *     `exceed_context_size_error` at inference time.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import type { AiModelServingProfile } from '@arcaai/types';
import { LM_STUDIO_SERVING_DEFAULTS } from '../../settings-registry/descriptors/lmstudio-serving.descriptors';
import { declaredContextLengthOf, platformServingProfileFrom, resolveServingProfile, servingProfileOf } from '../serving-profile.util';

const entity = (metaData: unknown) => ({ metaData }) as any;

/** The platform default as it ships with no `GlobalSetting` row written anywhere. */
const shippedPlatformProfile = () => platformServingProfileFrom(LM_STUDIO_SERVING_DEFAULTS);

// ---------------------------------------------------------------------------
// 1. Reading the row.
// ---------------------------------------------------------------------------

describe('servingProfileOf — `AiModel._metadata.serving`', () => {
  it('parses a declared profile off the row', () => {
    expect(servingProfileOf(entity({ serving: { contextLength: 65536, parallel: 4 } }))).toEqual({
      contextLength: 65536,
      parallel: 4,
    });
  });

  it('is null for a row that carries no serving block — absent is not an empty profile', () => {
    expect(servingProfileOf(entity({ capabilities: { contextLength: 65536 } }))).toBeNull();
    expect(servingProfileOf(entity({ serving: {} }))).toBeNull();
    expect(servingProfileOf(entity(null))).toBeNull();
    expect(servingProfileOf(entity('serving'))).toBeNull();
  });

  it('drops a member the runtime would drop, so a projection never over-promises', () => {
    expect(servingProfileOf(entity({ serving: { contextLength: 65536, parallel: 0, draftModel: 'x' } }))).toEqual({
      contextLength: 65536,
    });
  });
});

describe('declaredContextLengthOf — the other half of the lockstep pair', () => {
  it('reads `_metadata.capabilities.contextLength`, and the un-nested legacy spelling', () => {
    expect(declaredContextLengthOf(entity({ capabilities: { contextLength: 65536 } }))).toBe(65536);
    expect(declaredContextLengthOf(entity({ contextLength: 16384 }))).toBe(16384);
  });

  it('is null when the row declares none, or declares something that is not a positive integer', () => {
    expect(declaredContextLengthOf(entity({}))).toBeNull();
    expect(declaredContextLengthOf(entity({ capabilities: { contextLength: 0 } }))).toBeNull();
    expect(declaredContextLengthOf(entity({ capabilities: { contextLength: '65536' } }))).toBeNull();
    expect(declaredContextLengthOf(entity(null))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The platform default.
// ---------------------------------------------------------------------------

describe('platformServingProfileFrom — the registry values as a profile', () => {
  it('folds the six `lmStudio.serving.*` keys into one profile', () => {
    expect(shippedPlatformProfile()).toEqual({
      contextLength: 65536,
      parallel: 4,
      flashAttention: false,
      kvCacheQuant: { k: 'f16', v: 'f16' },
      gpuSplit: { strategy: 'evenly' },
    });
  });

  it('the SHIPPED default is coherent — registering these descriptors changes no serving behaviour', () => {
    expect(resolveServingProfile(null, shippedPlatformProfile()).problems).toEqual([]);
  });

  it('ignores a value the parser would reject rather than passing it to the loader', () => {
    expect(platformServingProfileFrom({ ...LM_STUDIO_SERVING_DEFAULTS, 'lmStudio.serving.parallel': 0 })).not.toHaveProperty('parallel');
    expect(platformServingProfileFrom({ 'lmStudio.serving.gpuSplitStrategy': 'favorMainGpu' })).toEqual({});
  });

  it('an empty cascade yields an empty profile — no tier is invented', () => {
    expect(platformServingProfileFrom({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. Resolution order: model -> platform default, widening ONLY on absence.
// ---------------------------------------------------------------------------

describe('resolveServingProfile — model wins, platform fills the gaps', () => {
  const platform: AiModelServingProfile = {
    contextLength: 65536,
    parallel: 4,
    flashAttention: false,
    kvCacheQuant: { k: 'f16', v: 'f16' },
    gpuSplit: { strategy: 'evenly' },
  };

  it('a row with NO profile takes the platform default whole', () => {
    const resolved = resolveServingProfile(null, platform);
    expect(resolved.profile).toEqual(platform);
    expect(resolved.sources).toEqual({
      contextLength: 'platform',
      parallel: 'platform',
      flashAttention: 'platform',
      'kvCacheQuant.k': 'platform',
      'kvCacheQuant.v': 'platform',
      gpuSplit: 'platform',
    });
  });

  it("a declared field WINS; the platform's value for it is not consulted", () => {
    const resolved = resolveServingProfile({ contextLength: 16384, flashAttention: true }, platform);
    expect(resolved.profile.contextLength).toBe(16384);
    expect(resolved.profile.flashAttention).toBe(true);
    expect(resolved.sources.contextLength).toBe('model');
    expect(resolved.sources.flashAttention).toBe('model');
  });

  it('widens ONLY on absence — an undeclared field still inherits', () => {
    const resolved = resolveServingProfile({ contextLength: 16384 }, platform);
    expect(resolved.profile.parallel).toBe(4);
    expect(resolved.sources.parallel).toBe('platform');
  });

  it('merges kvCacheQuant per member — k and v are two engine flags, not one', () => {
    const resolved = resolveServingProfile({ flashAttention: true, kvCacheQuant: { v: 'q8_0' } }, platform);
    expect(resolved.profile.kvCacheQuant).toEqual({ k: 'f16', v: 'q8_0' });
    expect(resolved.sources['kvCacheQuant.k']).toBe('platform');
    expect(resolved.sources['kvCacheQuant.v']).toBe('model');
  });

  it('takes gpuSplit ATOMICALLY — half a placement is not a placement', () => {
    const resolved = resolveServingProfile({ gpuSplit: { disabledGpus: [1] } }, platform);
    expect(resolved.profile.gpuSplit).toEqual({ disabledGpus: [1] });
    expect(resolved.sources.gpuSplit).toBe('model');
  });

  it('leaves a field absent when NEITHER tier declares it', () => {
    const resolved = resolveServingProfile({ contextLength: 16384 }, {});
    expect(resolved.profile).toEqual({ contextLength: 16384 });
    expect(resolved.sources).toEqual({ contextLength: 'model' });
  });

  it('never mutates either input', () => {
    const modelProfile: AiModelServingProfile = { kvCacheQuant: { v: 'q8_0' }, flashAttention: true };
    const platformCopy = structuredClone(platform);
    resolveServingProfile(modelProfile, platformCopy);
    expect(modelProfile).toEqual({ kvCacheQuant: { v: 'q8_0' }, flashAttention: true });
    expect(platformCopy).toEqual(platform);
  });
});

// ---------------------------------------------------------------------------
// 4. Coherence, on the RESOLVED profile.
// ---------------------------------------------------------------------------

describe('resolveServingProfile — problems are reported against what the loader will use', () => {
  it('a model V-quant is legal once the PLATFORM supplies flash attention', () => {
    const resolved = resolveServingProfile({ kvCacheQuant: { v: 'q8_0' } }, { flashAttention: true });
    expect(resolved.problems).toEqual([]);
  });

  it('the same model profile is refused when no tier enables flash attention', () => {
    const resolved = resolveServingProfile({ kvCacheQuant: { v: 'q8_0' } }, { flashAttention: false });
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toMatch(/flash/i);
  });

  it('LOCKSTEP: a declared window wider than the resolved served one is a problem', () => {
    const resolved = resolveServingProfile(null, { contextLength: 65536 }, { declaredContextLength: 131072 });
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]).toContain('131072');
  });

  it('LOCKSTEP: the check follows the CASCADE — a model that raises the served window clears it', () => {
    const resolved = resolveServingProfile({ contextLength: 131072 }, { contextLength: 65536 }, { declaredContextLength: 131072 });
    expect(resolved.problems).toEqual([]);
  });

  it('LOCKSTEP: an under-claim is safe, and equality is the intended state', () => {
    expect(resolveServingProfile(null, { contextLength: 65536 }, { declaredContextLength: 16384 }).problems).toEqual([]);
    expect(resolveServingProfile(null, { contextLength: 65536 }, { declaredContextLength: 65536 }).problems).toEqual([]);
  });
});
