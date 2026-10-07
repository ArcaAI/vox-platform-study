// TASK-1005 §5.2 — the SYSTEM knobs of the model-residency controller, plus
// the one STT warm-start key the controller supersedes over time.
//
// SCOPE: platform-only (`maxScope: 'system'`, `globalOnly: true`). Residency
// decides how much memory each process holds on two time-sliced cards shared
// by every tenant's workload; there is no tenant opinion to express, so there
// is no tenant tier. This is the documented super-admin-only shape of rule 2
// (`00-project-context.md` §Configuration Principles), not an omission.
//
// FAIL MODE: `open-to-default` throughout. Nothing here SELECTS a provider or
// a model; every key is a tuning knob whose default is the plan's measured
// posture, and `residency.enforce`'s default is OFF — so an unreadable row
// degrades to shadow mode (recommend, never act), which is the safe side.
//
// READERS: `ModelResidencyService` resolves the `residency.*` keys through the
// registry cascade (SYSTEM passed explicitly) once per 10 s decision tick.
// `stt.warmDefaultAsrOnBoot` is read by `apps/stt` off its effective-config
// pull (`stt.main._warm_default_asr_model`) — hence `consumedBy: ['stt']`, the
// ONE wiring step that puts a key on that route.

import { SettingDescriptor } from '../registry.types';

const CATEGORY = 'Service Runtime';

export const MODEL_RESIDENCY_DEFAULTS = {
  'residency.enforce': false,
  'residency.headroomPercent': 15,
  'residency.minResidencySeconds': 300,
  'residency.reloadCooldownSeconds': 120,
  'residency.promotion.rateThreshold': 2,
  'residency.promotion.windows': 6,
  'residency.admission.maxWaitMs': 5000,
  'stt.warmDefaultAsrOnBoot': false,
} as const;

export type ModelResidencySettingKey = keyof typeof MODEL_RESIDENCY_DEFAULTS;

/**
 * TASK-1051 — when an administrator recorded the review of the shadow log (an ISO
 * date). Read by the enforce-readiness checklist only; absent (null) = no review on
 * file. Kept out of `MODEL_RESIDENCY_DEFAULTS` because that map is the controller's
 * numeric/boolean tuning set, and this is a record, not a knob.
 */
export const RESIDENCY_SHADOW_REVIEWED_AT_KEY = 'residency.shadowReviewedAt';

/** An inclusive bound, refused rather than clamped so an admin is told. */
const numberBetween =
  (min: number, max: number, what: string, integer = true) =>
  (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
      return `${what} must be a ${integer ? 'whole ' : ''}number between ${min} and ${max}.`;
    }
  };

/** The fields every descriptor in this family shares. */
const PLATFORM_KNOB = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
} as const;

export const MODEL_RESIDENCY_SETTINGS: SettingDescriptor[] = [
  {
    ...PLATFORM_KNOB,
    key: 'residency.enforce',
    dataType: 'boolean',
    category: CATEGORY,
    label: 'Model residency: enforce decisions',
    description:
      'OFF (the default) is SHADOW mode: the residency controller computes every load / unload / pin it would make, records it as a recommendation and meters it (`residency_decisions_total{mode="shadow"}`), and sends NOTHING to any service. ON sends the commands. Owner decision OD-1: run shadow for 7 days and review the recommendation log before turning this on. Operator actions from the console (load, unload, pin) are never gated by this switch.',
    default: MODEL_RESIDENCY_DEFAULTS['residency.enforce'],
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.headroomPercent',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: memory headroom (%)',
    description:
      'Share of each device`s TOTAL memory the controller never hands out, on top of what DCGM reports as used. GPU time-slicing gives no memory isolation, so an over-committed load can OOM every pod on the card; this is the margin that absorbs a KV cache growing or a co-tenant`s lazy load between two 10 s observations. Applies to automatic placement AND to the console`s over-budget check (409 `OVER_BUDGET`).',
    default: MODEL_RESIDENCY_DEFAULTS['residency.headroomPercent'],
    validate: numberBetween(0, 90, 'Headroom percent'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.minResidencySeconds',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: minimum residency (s)',
    description:
      'A model resident for less than this is never an eviction candidate, however idle — the anti-thrash floor that stops the controller evicting a model it (or a request) has only just paid to load.',
    default: MODEL_RESIDENCY_DEFAULTS['residency.minResidencySeconds'],
    validate: numberBetween(0, 86_400, 'Minimum residency'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.reloadCooldownSeconds',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: reload cool-down (s)',
    description:
      'After an unload (automatic or from the console) the controller will not reload the same model on the same service for this long — the second anti-thrash guard. A request can still lazy-load it; this only restrains the controller.',
    default: MODEL_RESIDENCY_DEFAULTS['residency.reloadCooldownSeconds'],
    validate: numberBetween(0, 86_400, 'Reload cool-down'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.promotion.rateThreshold',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: WARM promotion rate (requests/min)',
    description:
      'The EWMA request rate (from `model_inference_latency_seconds`) a WARM-class model must sustain for `residency.promotion.windows` consecutive 10 s windows before the controller keeps it resident. It is demoted once the EWMA falls below HALF this value — a band rather than a line, so a model hovering at the threshold is not loaded and unloaded every tick.',
    default: MODEL_RESIDENCY_DEFAULTS['residency.promotion.rateThreshold'],
    validate: numberBetween(0, 100_000, 'Promotion rate threshold', false),
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.promotion.windows',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: WARM promotion windows',
    description:
      'Consecutive 10 s decision windows at or above the promotion rate before a WARM model is promoted (6 ⇒ one minute of sustained demand). One window below the rate restarts the count.',
    default: MODEL_RESIDENCY_DEFAULTS['residency.promotion.windows'],
    validate: numberBetween(1, 360, 'Promotion windows'),
  },
  {
    ...PLATFORM_KNOB,
    key: 'residency.admission.maxWaitMs',
    dataType: 'number',
    category: CATEGORY,
    label: 'Model residency: admission wait (ms)',
    description:
      'How long an automatic (enforce-mode) load waits for the one-load-per-GPU gate before deferring to the next tick. Owner decision OD-2: wait at most 5 s for room, then give up (a live request gets 503 + `Retry-After` from the serving agent).',
    default: MODEL_RESIDENCY_DEFAULTS['residency.admission.maxWaitMs'],
    validate: numberBetween(0, 60_000, 'Admission wait'),
  },
  {
    ...PLATFORM_KNOB,
    key: RESIDENCY_SHADOW_REVIEWED_AT_KEY,
    dataType: 'string',
    category: CATEGORY,
    label: 'Model residency: shadow review recorded on',
    description:
      'The date (ISO 8601) an administrator reviewed the shadow-mode recommendation log (owner decision OD-1 of TASK-1005: review the log before turning `residency.enforce` on). Read ONLY by the enforce-readiness checklist (`GET admin/model-residency/readiness`); it enables nothing by itself. Empty = no review on file.',
    default: null,
    validate: (value: unknown) => {
      if (value === null) return undefined;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
        return 'Shadow review date must be an ISO 8601 date (e.g. 2026-10-14 or 2026-10-14T09:00:00Z).';
      }
    },
  },
  {
    ...PLATFORM_KNOB,
    key: 'stt.warmDefaultAsrOnBoot',
    dataType: 'boolean',
    category: 'STT Runtime',
    consumedBy: ['stt'],
    label: 'Warm the default ASR model at STT boot',
    description:
      'When ON, each `hope-stt` pod loads the platform`s default ASR model once, detached from startup and readiness, so the first session after a pod roll does not pay the cold load (TASK-985 QW-4). Read by STT since TASK-985 but unregistered until TASK-1005, so no admin could set it. Superseded over time by the residency controller, which implicitly PINS every assigned speech-to-text agent`s primary model (plan D-4).',
    default: MODEL_RESIDENCY_DEFAULTS['stt.warmDefaultAsrOnBoot'],
  },
];
