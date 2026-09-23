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
// per-(provider, model) surface — the Agent's parameters (TASK-863; `AiRuntimeProfile`
// was retired by TASK-862), injected per request by the agent resolver. What is registered
// here is strictly the LAST fallback before the in-code floor, for a caller
// with no resolvable profile at all. Hence `maxScope: 'system'` + `globalOnly`.
//
// Resolution order at the service, most specific first (unchanged by this file):
//   1. the request's own value — a caller that set it always wins,
//   2. the Agent parameter values the gateway pushed onto the body,
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
//
// TASK-1001 OD-10 — `frequencyPenalty` / `presencePenalty` joined the family.
// Decode-time repetition pressure for a small model that repeats sentences at
// temperature 0 (OD-7 kept that model). The per-agent path exists
// (`parameters.generation.*Penalty`), but a PUBLISHED Agent's parameters cannot
// be updated — a DB trigger refuses it — so the value that reaches the existing
// fleet has to be THIS runtime setting, not an agent edit. Their default is `0`,
// the neutral value: no penalty, which is what every engine applies today when
// the field is absent, so registering them is likewise a zero-behaviour change
// until a platform admin writes a row. Their range is the one the Agent contract
// declares for the same knob (`GENERATION_PROPERTY` in
// `@arcaai/workflow-contract`), refused rather than clamped; this file stays
// dependency-free, so the bound is written out here and parity-tested
// (`text-generation-penalties.descriptors.task1001.test.ts`).

import { SettingDescriptor } from '../registry.types';

/**
 * Registry key → the value `apps/text` falls back to when no row is written.
 * Transcribed from `GENERATION_FLOOR` in `apps/text/src/text/core/defaults.py`.
 */
export const TEXT_GENERATION_DEFAULTS = {
  'text.generation.temperature': 0.1,
  'text.generation.maxTokens': 16384,
  'text.generation.topP': 0.95,
  'text.generation.frequencyPenalty': 0,
  'text.generation.presencePenalty': 0,
} as const;

export type TextGenerationKey = keyof typeof TEXT_GENERATION_DEFAULTS;

/**
 * The inclusive bound `GENERATION_PROPERTY` (`@arcaai/workflow-contract`) declares for
 * `frequencyPenalty` / `presencePenalty` on an Agent. Written out rather than imported so this
 * file stays dependency-free; parity with the contract is asserted by the descriptor test.
 */
const PENALTY_RANGE = { min: -2, max: 2 } as const;

/** An inclusive numeric bound, refused rather than clamped so an admin is told. */
const numberBetween = (min: number, max: number, what: string) => (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return `${what} must be a number between ${min} and ${max}.`;
  }
};

const META: Record<TextGenerationKey, { label: string; description: string; validate?: (value: unknown) => string | void }> = {
  'text.generation.temperature': {
    label: 'Default sampling temperature',
    description:
      'Applied only when the request omits `temperature` AND the Agent (TASK-863) supplied none. The floor is ' +
      'near-deterministic on purpose: it is sent to engines nobody profiled, where a high temperature is the ' +
      'difference between a usable clinical note and a plausible-sounding invention.',
  },
  'text.generation.maxTokens': {
    label: 'Default output ceiling (tokens)',
    description:
      'Applied only when the request omits `max_tokens` AND the Agent (TASK-863) supplied none. Bounds the output, ' +
      'and therefore the worst-case bill and latency, for an unprofiled engine — generous enough that a clinical ' +
      'note is not truncated, bounded enough that a runaway generation cannot bill without limit.',
  },
  'text.generation.topP': {
    label: 'Default nucleus sampling (top-p)',
    description:
      'Applied only when the request omits `top_p` AND the Agent (TASK-863) supplied none. Trims the long tail of ' +
      'the token distribution; lowering it narrows what the model may say, raising it toward 1.0 removes the trim.',
  },
  'text.generation.frequencyPenalty': {
    label: 'Default frequency penalty',
    description:
      'Applied only when the request omits `frequency_penalty` AND the Agent (TASK-863) supplied none. Penalises a ' +
      'token in proportion to how often it has already appeared — decode-time pressure against a note that repeats ' +
      'its own sentences. 0 is neutral (no penalty, today`s behaviour); positive values discourage repetition, ' +
      'negative values encourage it. Range -2 to 2. It applies to every generation that states no penalty of its own, ' +
      'so set it with the whole fleet in mind; a published Agent cannot be edited, which is why this default exists.',
    validate: numberBetween(PENALTY_RANGE.min, PENALTY_RANGE.max, 'Default frequency penalty'),
  },
  'text.generation.presencePenalty': {
    label: 'Default presence penalty',
    description:
      'Applied only when the request omits `presence_penalty` AND the Agent (TASK-863) supplied none. Penalises any ' +
      'token that has already appeared at all, however often — pressure towards new content rather than against ' +
      'repeat counts. 0 is neutral (no penalty, today`s behaviour); positive values push away from what was already ' +
      'said, negative values toward it. Range -2 to 2. It applies to every generation that states no penalty of its ' +
      'own, so set it with the whole fleet in mind.',
    validate: numberBetween(PENALTY_RANGE.min, PENALTY_RANGE.max, 'Default presence penalty'),
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
    ...(META[key].validate ? { validate: META[key].validate } : {}),
  }),
);
