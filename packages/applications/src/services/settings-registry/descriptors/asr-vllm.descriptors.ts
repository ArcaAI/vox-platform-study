// TASK-1010 phase B (OD-6 / OD-10) — the PLATFORM knobs of `apps/asr-vllm`, the vLLM Whisper
// decode backend.
//
// SCOPE: platform-only (`maxScope: 'system'`, `globalOnly: true`), an owner-approved exception to
// tenant → platform resolution: these size ONE shared GPU pool that serves every tenant's windows,
// so there is no tenant opinion to express.
//
// FAIL MODE: `open-to-default` throughout. Nothing here SELECTS a model — the model arrives on
// every request as a gateway-resolved spec, chosen by the tenant's ASR AGENT. Every key is a
// tuning knob; an unreadable row degrades to the default below, never to an outage.
//
// WHEN A KEY APPLIES: the four `asrVllm.engine.*` knobs at the NEXT engine build (vLLM fixes them
// at `AsyncLLM` construction; `maxResidentEngines` bounds eviction immediately); the two
// `asrVllm.truncation.*` thresholds per request.
//
// READERS: `apps/asr-vllm` pulls them over `GET /internal/effective-config?service=asr-vllm` —
// `consumedBy: ['asr-vllm']` is the ONE wiring step. The six `ASR_VLLM_*` env vars they replace are
// closed on the service side (a dead alias), so no `envOverride` lane is declared here: a stale
// env value must not be able to win over the registry.

import { SettingDescriptor } from '../registry.types';

const CATEGORY = 'ASR vLLM Runtime';

export const ASR_VLLM_DEFAULTS = {
  // OD-10 — 0.20 while ASR shares a 16 GB card; raise per environment in the SYSTEM row, not in code.
  'asrVllm.engine.gpuMemoryUtilization': 0.2,
  'asrVllm.engine.maxNumSeqs': 64,
  'asrVllm.engine.enforceEager': false,
  'asrVllm.engine.maxResidentEngines': 1,
  // The truncation heuristic's current code defaults (`apps/asr-vllm/src/asr_vllm/core/config.py`),
  // so registering them changes no behaviour. Uncalibrated until the GPU run measures them.
  'asrVllm.truncation.minCharsPerVoicedSecond': 3.0,
  'asrVllm.truncation.voicedDbfs': -40.0,
} as const;

export type AsrVllmSettingKey = keyof typeof ASR_VLLM_DEFAULTS;

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

/** The fields every descriptor in this family shares. */
const PLATFORM_KNOB = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  consumedBy: ['asr-vllm'],
  category: CATEGORY,
} as const;

export const ASR_VLLM_SETTINGS: SettingDescriptor[] = [
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.engine.gpuMemoryUtilization',
    dataType: 'number',
    label: 'ASR vLLM: GPU memory share per engine',
    description:
      'Fraction of the WHOLE GPU`s memory each vLLM engine may claim (weights + encoder/KV cache). A time-sliced GPU gives no memory isolation, so on a shared card this is the service`s budget share, not "how much is free". `maxResidentEngines` × this must fit one card. Applies at the next engine build.',
    default: ASR_VLLM_DEFAULTS['asrVllm.engine.gpuMemoryUtilization'],
    validate: numberBetween(0.05, 0.95, 'GPU memory utilization', false),
  },
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.engine.maxNumSeqs',
    dataType: 'number',
    label: 'ASR vLLM: max concurrent windows per engine',
    description:
      'vLLM`s running-batch cap — the ceiling on decode windows one engine batches together (continuous batching). Applies at the next engine build.',
    default: ASR_VLLM_DEFAULTS['asrVllm.engine.maxNumSeqs'],
    validate: numberBetween(1, 1024, 'Max concurrent sequences'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.engine.enforceEager',
    dataType: 'boolean',
    label: 'ASR vLLM: skip CUDA-graph capture',
    description:
      'ON skips CUDA-graph capture: a faster cold start (engine load) at the cost of slower steady-state decode. Applies at the next engine build.',
    default: ASR_VLLM_DEFAULTS['asrVllm.engine.enforceEager'],
  },
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.engine.maxResidentEngines',
    dataType: 'number',
    label: 'ASR vLLM: resident engines',
    description:
      'How many engines (one per agent runtime key) may be resident at once; the idle least-recently-used one is evicted beyond it. Each claims `gpuMemoryUtilization` of the card. Applies immediately.',
    default: ASR_VLLM_DEFAULTS['asrVllm.engine.maxResidentEngines'],
    validate: numberBetween(1, 4, 'Resident engines'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.truncation.minCharsPerVoicedSecond',
    dataType: 'number',
    label: 'ASR vLLM: truncation heuristic — min characters per voiced second',
    description:
      'The vllm#53144 guard: a window whose transcript has fewer non-space characters than this per second of VOICED audio is flagged `short_output_for_voiced_audio` (a suspected silent drop). Information only — the service never alters a transcript because of it. Uncalibrated until measured on the ml-en fixtures. Applies per request.',
    default: ASR_VLLM_DEFAULTS['asrVllm.truncation.minCharsPerVoicedSecond'],
    validate: nonNegative('Minimum characters per voiced second'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'asrVllm.truncation.voicedDbfs',
    dataType: 'number',
    label: 'ASR vLLM: truncation heuristic — voiced level (dBFS)',
    description:
      'Audio at or above this level counts as VOICED when the truncation heuristic measures how much speech a window held. Applies per request.',
    default: ASR_VLLM_DEFAULTS['asrVllm.truncation.voicedDbfs'],
    validate: numberBetween(-90, 0, 'Voiced level (dBFS)', false),
  },
];
