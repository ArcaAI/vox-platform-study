// TASK-1021 (C-4) — the PLATFORM knobs of `apps/vllm`, the OpenAI-compatible vLLM inference
// service. Replaces TASK-1010's `asrVllm.*` family (`apps/asr-vllm`).
//
// WHAT MOVED OUT: the four `asrVllm.engine.*` knobs sized ONE engine for every model. Engine sizing
// is a fact about the WEIGHTS, so it now rides the model row — `AiModel._metadata.serving`
// (`vramGiB`, `maxNumSeqs`, `enforceEager`), served per slug on the internal serving-spec route
// (D-11). What stays platform-wide is how the GPU is carved into POOLS, and the truncation heuristic.
//
// SCOPE: platform-only (`maxScope: 'system'`, `globalOnly: true`), the owner-approved exception to
// tenant → platform resolution TASK-1010 took: a pool is ONE shared slice of a GPU that serves every
// tenant, so there is no tenant opinion to express.
//
// FAIL MODE: `open-to-default` throughout. Nothing here SELECTS a model — the model arrives per
// request, chosen by the tenant's agent. An unreadable row degrades to the default, never an outage.
//
// POOL IDENTITY: each `apps/vllm` replica reads its own pool by name from `VLLM_POOL` (env, default
// `default`) — a process identity, so it stays on the bootstrap floor.
//
// READERS: `apps/vllm` pulls them over `GET /internal/effective-config?service=vllm` —
// `consumedBy: ['vllm']` is the ONE wiring step. No `envOverride` lane: a stale env value must not
// be able to win over the registry.

import { SERVING_KINDS } from '@arcaai/types';
import { SettingDescriptor } from '../registry.types';

const CATEGORY = 'vLLM Runtime';

export const VLLM_POOLS_KEY = 'vllm.pools';

export const VLLM_DEFAULTS = {
  // OD-4 — the dev `asr` pool takes ONE of the two free time-sliced units: a 6 GiB budget on a
  // 16 GB card, one resident engine (the Whisper row declares `vramGiB: 5`).
  [VLLM_POOLS_KEY]: {
    default: { acceptedKinds: ['asr'], pins: [], vramBudgetGiB: 6, maxResidentEngines: 1, inflightFactor: 2 },
  },
  // Unchanged from the `asrVllm.truncation.*` keys they replace. Uncalibrated until the GPU run
  // measures them.
  'vllm.truncation.minCharsPerVoicedSecond': 3.0,
  'vllm.truncation.voicedDbfs': -40.0,
} as const;

export type VllmSettingKey = keyof typeof VLLM_DEFAULTS;

/** An inclusive bound, refused rather than clamped so an admin is told. */
const numberBetween =
  (min: number, max: number, what: string, integer = true) =>
  (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
      return `${what} must be a ${integer ? 'whole ' : ''}number between ${min} and ${max}.`;
    }
  };

/** A finite, non-negative number with no ceiling. */
const nonNegative = (what: string) => (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `${what} must be a finite number of at least 0.`;
};

const POOL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const POOL_FIELDS = ['acceptedKinds', 'pins', 'vramBudgetGiB', 'maxResidentEngines', 'inflightFactor'];

/** Every problem in ONE pool, named by its field, so a hand-edited map is fixed in one pass. */
function poolProblems(name: string, pool: unknown): string[] {
  if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) return [`pool "${name}" must be an object`];
  const p = pool as Record<string, unknown>;
  const problems: string[] = [];
  const kinds = p.acceptedKinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => (SERVING_KINDS as readonly unknown[]).includes(k))) {
    problems.push(`pool "${name}".acceptedKinds must be a non-empty array of: ${SERVING_KINDS.join(', ')}`);
  }
  if (!Array.isArray(p.pins) || !p.pins.every((slug) => typeof slug === 'string' && slug.trim().length > 0)) {
    problems.push(`pool "${name}".pins must be an array of model slugs`);
  }
  if (typeof p.vramBudgetGiB !== 'number' || !Number.isFinite(p.vramBudgetGiB) || p.vramBudgetGiB <= 0) {
    problems.push(`pool "${name}".vramBudgetGiB must be a number of GiB greater than 0`);
  }
  if (typeof p.maxResidentEngines !== 'number' || !Number.isInteger(p.maxResidentEngines) || p.maxResidentEngines < 1) {
    problems.push(`pool "${name}".maxResidentEngines must be a whole number of at least 1`);
  }
  if (p.inflightFactor !== undefined && (typeof p.inflightFactor !== 'number' || !Number.isFinite(p.inflightFactor) || p.inflightFactor < 1)) {
    problems.push(`pool "${name}".inflightFactor must be a number of at least 1 (or omitted for 2)`);
  }
  for (const key of Object.keys(p)) {
    if (!POOL_FIELDS.includes(key)) problems.push(`pool "${name}".${key} is not a pool field (${POOL_FIELDS.join(', ')})`);
  }
  return problems;
}

/** `vllm.pools`: a non-empty map of pool name → pool. Reports every bad entry, not the first. */
function validatePools(value: unknown): string | void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${VLLM_POOLS_KEY} must be a JSON object mapping a pool name to its pool.`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${VLLM_POOLS_KEY} must declare at least one pool.`;
  const problems: string[] = [];
  for (const [name, pool] of entries) {
    if (!POOL_NAME.test(name)) problems.push(`pool name "${name}" must be lowercase letters, digits and hyphens`);
    problems.push(...poolProblems(name, pool));
  }
  if (problems.length > 0) return `${VLLM_POOLS_KEY} is invalid — ${problems.join(' | ')}.`;
}

/** The fields every descriptor in this family shares. */
const PLATFORM_KNOB = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  consumedBy: ['vllm'],
  category: CATEGORY,
} as const;

export const VLLM_SETTINGS: SettingDescriptor[] = [
  {
    ...PLATFORM_KNOB,
    key: VLLM_POOLS_KEY,
    dataType: 'json',
    label: 'vLLM: GPU pools',
    description:
      'How `apps/vllm` carves its GPU into pools, by pool name (each replica serves the pool its `VLLM_POOL` names). Per pool: `acceptedKinds` (asr | llm | tts), `pins` (model slugs kept resident), `vramBudgetGiB` (GiB of GPU memory the pool may fill with engines — each engine claims its model row`s `vramGiB`), `maxResidentEngines` (the idle least-recently-used engine is evicted beyond it) and `inflightFactor` (queued requests admitted per engine slot; default 2). A time-sliced GPU gives no memory isolation, so the budget is the pool`s share of a card, not "how much is free".',
    default: VLLM_DEFAULTS[VLLM_POOLS_KEY],
    validate: validatePools,
  },
  {
    ...PLATFORM_KNOB,
    key: 'vllm.truncation.minCharsPerVoicedSecond',
    dataType: 'number',
    label: 'vLLM: truncation heuristic — min characters per voiced second',
    description:
      'The vllm#53144 guard: a transcription whose text has fewer non-space characters than this per second of VOICED audio is flagged `short_output_for_voiced_audio` (a suspected silent drop). Information only — the service never alters a transcript because of it. Uncalibrated until measured on the ml-en fixtures. Applies per request.',
    default: VLLM_DEFAULTS['vllm.truncation.minCharsPerVoicedSecond'],
    validate: nonNegative('Minimum characters per voiced second'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'vllm.truncation.voicedDbfs',
    dataType: 'number',
    label: 'vLLM: truncation heuristic — voiced level (dBFS)',
    description:
      'Audio at or above this level counts as VOICED when the truncation heuristic measures how much speech a request held. Applies per request.',
    default: VLLM_DEFAULTS['vllm.truncation.voicedDbfs'],
    validate: numberBetween(-90, 0, 'Voiced level (dBFS)', false),
  },
];
