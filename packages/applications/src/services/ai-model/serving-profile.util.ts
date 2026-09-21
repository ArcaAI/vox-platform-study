import type { AiModelEntity } from '@arcaai/domains';
import { type AiModelServingProfile, checkAiModelServingProfile, parseAiModelServingProfile } from '@arcaai/types';
import { LM_STUDIO_SERVING_DEFAULTS, type LmStudioServingKey } from '../settings-registry/descriptors/lmstudio-serving.descriptors';

/**
 * TASK-996 Phase 2 — the serving-profile CASCADE: the per-model
 * `AiModel._metadata.serving` block (owner decision D-7) resolved against the
 * `lmStudio.serving.*` platform default from the settings registry.
 *
 * This is CONFIGURATION, so it cascades and widens ONLY on absence
 * (`00-project-context.md` §Configuration Principles rule 2). It is NOT content
 * and is never cloned per tenant: an LM Studio `AiModel` row is a SYSTEM row,
 * platform-owned and shared-read, and a per-tenant COPY of a configuration row
 * is a bug under §"Content is cloned; configuration cascades".
 *
 * The two tiers are MODEL and PLATFORM, not tenant and platform, because the
 * value decides how much VRAM one process takes on shared, time-sliced cards.
 * There is no tenant opinion to express, and that is stated once here rather
 * than re-derived at each call site.
 *
 * Shared by the admin projection, the Phase 3 load route and the Phase 1 loader
 * so none of them can read the stored JSON a different way — the same reason
 * `asr-profile.util.ts` exists beside it.
 */

/** Which tier supplied one resolved field. */
export type AiModelServingProfileSource = 'model' | 'platform';

export interface ResolvedAiModelServingProfile {
  /** What the loader will actually use. A field NEITHER tier declared stays absent. */
  profile: AiModelServingProfile;
  /**
   * Dotted path -> the tier that supplied it. An admin surface renders this as
   * "inherited" vs "set on this model"; an absent key means no tier had an
   * opinion and the engine's own default applies.
   */
  sources: Record<string, AiModelServingProfileSource>;
  /**
   * Cross-field and LOCKSTEP violations on the RESOLVED profile, empty when
   * coherent. Reported rather than thrown because the same call serves a save
   * (where it becomes a 400) and a list projection (where a throw would break
   * every other row).
   */
  problems: string[];
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The READ side: `AiModel._metadata.serving`, parsed through the SAME validator
 * the Phase 1 loader reads with, so a projection never shows an admin a value
 * the runtime would silently drop.
 *
 * `null` means the row expressed NO opinion — which is not the same as an empty
 * profile, and is what makes the platform default apply. A block whose every
 * member was rejected therefore reads as `null` too: nothing survived, so
 * nothing was said.
 */
export function servingProfileOf(entity: Pick<AiModelEntity, 'metaData'>): AiModelServingProfile | null {
  const meta = asPlainObject(entity.metaData);
  const { profile } = parseAiModelServingProfile(meta?.serving);
  return Object.keys(profile).length > 0 ? profile : null;
}

/**
 * The other half of the lockstep pair: the context window this row DECLARES to
 * callers.
 *
 * Read the way `capabilitiesOf` already reads it — `_metadata.capabilities.contextLength`
 * falling back to `_metadata.contextLength` for rows seeded before the
 * `capabilities` nesting — and held to the same rule: a positive integer or
 * nothing. A 0/negative/NaN value is a mis-seeded row, and treating it as a
 * budget would hand a caller a window that can only produce an empty prompt.
 */
export function declaredContextLengthOf(entity: Pick<AiModelEntity, 'metaData'>): number | null {
  const meta = asPlainObject(entity.metaData) ?? {};
  const caps = asPlainObject(meta.capabilities) ?? meta;
  const raw = caps.contextLength;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Fold the flat `lmStudio.serving.*` registry values into one profile.
 *
 * Built through `parseAiModelServingProfile` on purpose: the platform tier and
 * the model tier then pass through ONE validator, so a `GlobalSetting` row an
 * older gateway wrote — or a key whose descriptor `validate` was added after the
 * row — cannot reach the loader by the back door. A rejected value is simply
 * absent, which is the `open-to-default` posture this family declares.
 *
 * Takes a partial map so a caller may hand it the resolved cascade directly; a
 * key the cascade did not answer is a field nobody set, not a zero.
 */
export function platformServingProfileFrom(values: Partial<Record<LmStudioServingKey, unknown>>): AiModelServingProfile {
  const { profile } = parseAiModelServingProfile({
    contextLength: values['lmStudio.serving.contextLength'],
    parallel: values['lmStudio.serving.parallel'],
    flashAttention: values['lmStudio.serving.flashAttention'],
    kvCacheQuant: {
      k: values['lmStudio.serving.kvCacheQuantK'],
      v: values['lmStudio.serving.kvCacheQuantV'],
    },
    gpuSplit: { strategy: values['lmStudio.serving.gpuSplitStrategy'] },
  });
  return profile;
}

/** The platform default as it ships, with no `GlobalSetting` row written anywhere. */
export function shippedPlatformServingProfile(): AiModelServingProfile {
  return platformServingProfileFrom(LM_STUDIO_SERVING_DEFAULTS);
}

/**
 * Resolve the profile the engine will be loaded with: model -> platform default,
 * widening ONLY on absence.
 *
 * Granularity is per FIELD for the scalars and per MEMBER for `kvCacheQuant`
 * (`k` and `v` are two independent engine flags), so a model that states one
 * thing does not silently discard the platform's answer for everything else.
 *
 * `gpuSplit` is the deliberate exception and merges ATOMICALLY: `strategy`,
 * `priority` and `customRatio` are one placement decision, and half of one
 * model's placement combined with half of the platform's is a configuration
 * nobody wrote. A model that declares any part of `gpuSplit` owns all of it.
 */
export function resolveServingProfile(
  modelProfile: AiModelServingProfile | null | undefined,
  platformDefault: AiModelServingProfile,
  options?: { declaredContextLength?: number | null },
): ResolvedAiModelServingProfile {
  const model = modelProfile ?? {};
  const profile: AiModelServingProfile = {};
  const sources: Record<string, AiModelServingProfileSource> = {};

  for (const key of ['contextLength', 'parallel', 'flashAttention'] as const) {
    if (model[key] !== undefined) {
      (profile as Record<string, unknown>)[key] = model[key];
      sources[key] = 'model';
    } else if (platformDefault[key] !== undefined) {
      (profile as Record<string, unknown>)[key] = platformDefault[key];
      sources[key] = 'platform';
    }
  }

  const kvCacheQuant: Record<string, unknown> = {};
  for (const member of ['k', 'v'] as const) {
    if (model.kvCacheQuant?.[member] !== undefined) {
      kvCacheQuant[member] = model.kvCacheQuant[member];
      sources[`kvCacheQuant.${member}`] = 'model';
    } else if (platformDefault.kvCacheQuant?.[member] !== undefined) {
      kvCacheQuant[member] = platformDefault.kvCacheQuant[member];
      sources[`kvCacheQuant.${member}`] = 'platform';
    }
  }
  if (Object.keys(kvCacheQuant).length > 0) profile.kvCacheQuant = kvCacheQuant;

  const gpuSplit = model.gpuSplit ?? platformDefault.gpuSplit;
  if (gpuSplit) {
    profile.gpuSplit = structuredClone(gpuSplit);
    sources.gpuSplit = model.gpuSplit ? 'model' : 'platform';
  }

  return { profile, sources, problems: checkAiModelServingProfile(profile, { declaredContextLength: options?.declaredContextLength }) };
}
