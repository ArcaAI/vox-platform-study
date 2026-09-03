// The platform GENERATION profile for `apps/text`.
//
// `temperature` / `maxTokens` / `topP` had NO config surface at all: they were
// literals in `apps/text/src/text/core/defaults.py` (`GENERATION_FLOOR`),
// applied by `openai_compat.py`, `ollama.py` and `bedrock.py`, and the only way
// to change them was a redeploy. They are also among the most obviously
// per-deployment values in the service — a summarisation profile and a
// clinical-extraction profile want different ones.
//
// WHY THIS IS A PLATFORM (PULL) FAMILY, not a tenant one. Cardinality decides
// the channel (owner decision D-1): the pull route is one cached snapshot per
// service process, forever, so only a knob with no tenant opinion belongs on
// it. A tenant that wants its own hyperparameters already has a deeper,
// per-(provider, model) surface — `AiRuntimeProfile`, injected per request by
// `TextRequestEnrichmentService.applyTextRuntimeProfile`. What is registered
// here is strictly the LAST fallback before the in-code floor, for a caller
// with no resolvable profile at all. Hence `maxScope: 'system'` + `globalOnly`.
//
// Resolution order at the service, most specific first (unchanged by this file):
//   1. the request's own value — a caller that set it always wins,
//   2. the `AiRuntimeProfile` values the gateway pushed onto the body,
//   3. THIS platform profile, arriving on the PULL channel,
//   4. the in-code floor.
//
// D-2: `global-kv`, not `db-config`. Three scalars do not earn a table of their
// own, and `global-kv` is the tier with a complete read + write + cascade +
// invalidate loop already built.
//
// Defaults are transcribed VERBATIM from `GENERATION_FLOOR` so registering
// these keys changes ZERO behaviour: with no row written the cascade bottoms
// out at exactly the number the service runs on today. Parity is asserted
// mechanically, cross-language, by
// `apps/text/src/text/tests/unit/test_task799_descriptor_parity.py`.

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the value `apps/text` falls back to when no row is written.
 * Transcribed from `GENERATION_FLOOR` in `apps/text/src/text/core/defaults.py`.
 */
export const TEXT_GENERATION_DEFAULTS = {
  'text.generation.temperature': 0.1,
  'text.generation.maxTokens': 16384,
  'text.generation.topP': 0.95,
} as const;

export type TextGenerationKey = keyof typeof TEXT_GENERATION_DEFAULTS;

const META: Record<TextGenerationKey, { label: string; description: string }> = {
  'text.generation.temperature': {
    label: 'Default sampling temperature',
    description:
      'Applied only when the request omits `temperature` AND no `AiRuntimeProfile` supplied one. The floor is ' +
      'near-deterministic on purpose: it is sent to engines nobody profiled, where a high temperature is the ' +
      'difference between a usable clinical note and a plausible-sounding invention.',
  },
  'text.generation.maxTokens': {
    label: 'Default output ceiling (tokens)',
    description:
      'Applied only when the request omits `max_tokens` AND no `AiRuntimeProfile` supplied one. Bounds the output, ' +
      'and therefore the worst-case bill and latency, for an unprofiled engine — generous enough that a clinical ' +
      'note is not truncated, bounded enough that a runaway generation cannot bill without limit.',
  },
  'text.generation.topP': {
    label: 'Default nucleus sampling (top-p)',
    description:
      'Applied only when the request omits `top_p` AND no `AiRuntimeProfile` supplied one. Trims the long tail of ' +
      'the token distribution; lowering it narrows what the model may say, raising it toward 1.0 removes the trim.',
  },
};

export const TEXT_GENERATION_SETTINGS: SettingDescriptor[] = (Object.keys(TEXT_GENERATION_DEFAULTS) as TextGenerationKey[]).map<SettingDescriptor>(
  (key) => ({
    key,
    tier: 'global-kv',
    // What puts the key on `GET /internal/effective-config?service=text`. Safe
    // because every key here is PLATFORM-scope: one cached snapshot per process.
    consumedBy: ['text'],
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Tuning, not selection: an unwritten row must degrade to today's number,
    // not turn every unprofiled generation into an outage. `apps/text` mirrors
    // this — an absent group keeps the in-code floor.
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: META[key].label,
    description: META[key].description,
    default: TEXT_GENERATION_DEFAULTS[key],
  }),
);
