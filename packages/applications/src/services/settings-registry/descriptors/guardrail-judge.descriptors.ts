// The delegated judgement's per-call budget (TASK-878).
//
// Guardrail hosts no engine: `POST /api/medical/validate` is a DELEGATION to
// `apps/text`'s isolated judge lane, and the same number bounds guardrail's calls
// to `apps/nlp`. That budget was `JudgePolicy.timeout_s = 60.0` in
// `apps/guardrail/src/guardrail/core/config.py` — a `BaseModel` field with a real
// default, which rule 09 §"No hardcoded configuration" names as a hardcoded value
// wearing a config costume, and which an operator could not move without a
// redeploy.
//
// WHY THIS TIER, when the judge's temperature and max-tokens went to the model
// row instead. A timeout is not a property of the model: it is a property of the
// DEPLOYMENT's latency envelope — how long this cluster's guardrail is willing to
// wait on a peer before it fails closed. Two environments running the identical
// guardian checkpoint legitimately disagree about it, and no environment wants a
// per-model answer. It is platform-scope by construction for a second reason as
// well: guardrail is built-in and platform-only (TASK-870 owner decision item 5),
// so there is no tenant who may set it and `maxScope: 'system'` + `globalOnly` say
// so declaratively rather than through an imperative check.
//
// `open-to-default`, and the default is the literal it replaced, so registering it
// changed no behaviour. Fail-closed would be actively wrong here: a control-plane
// outage would turn every clinical judgement into a failure, when the correct
// degradation is to keep waiting exactly as long as the service always has.
//
// The Python side mirrors this default ONCE, at
// `apps/guardrail/src/guardrail/core/effective_config.DEFAULT_JUDGE_TIMEOUT_S`,
// and reads the served value through `EffectiveConfigSnapshot.judge_timeout_s()`.

import { SettingDescriptor } from '../registry.types';

/** The key `apps/guardrail` reads off the effective-config `settings` map. */
export const GUARDRAIL_JUDGE_TIMEOUT_KEY = 'guardrail.judge.timeoutSeconds';

/**
 * TASK-1050 (README §9.8.1) — how long a workflow node held on a guardrail `block` waits durably for a resolution
 * before the run ends `run.failed GUARDRAIL_BLOCKED` (the consultation stays held; a later resume supersedes).
 * Read by the GATEWAY and injected on every harness run start (`resolveRunStartLimits`), never read by the harness
 * from env.
 */
export const GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY = 'guardrail.hold.timeoutSeconds';

/**
 * TASK-1050 (README §9.8.2) — the evaluation-gap reconciler: an evaluation id a run reported is "missing" once it is
 * older than the grace and still has no `GuardrailEvaluation` row; ids older than the lookback are not scanned.
 */
export const GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY = 'guardrail.evaluations.reconcileGraceMinutes';
export const GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY = 'guardrail.evaluations.reconcileLookbackHours';

/** Code defaults. The timeout is mirrored by `DEFAULT_JUDGE_TIMEOUT_S` in the guardrail pull client. */
/** TASK-1050 — the admin "Test my rules" screen call (`POST admin/guardrail/screen`). */
export const GUARDRAIL_PLAYGROUND_SCREEN_TIMEOUT_MS_KEY = 'guardrail.playground.screenTimeoutMs';

export const GUARDRAIL_JUDGE_DEFAULTS = {
  [GUARDRAIL_JUDGE_TIMEOUT_KEY]: 90, // TASK-1059 OD-6 (was 60): the text judge lane now queues up to 30 s
  [GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY]: 86_400,
  [GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY]: 10,
  [GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY]: 24,
  [GUARDRAIL_PLAYGROUND_SCREEN_TIMEOUT_MS_KEY]: 60_000,
} as const;

function wholeNumberBetween(min: number, max: number): (value: unknown) => string | undefined {
  return (value: unknown): string | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return `Must be a whole number of at least ${min}.`;
    if (value > max) return `Must not exceed ${max}.`;
    return undefined;
  };
}

/** Platform-only, open-to-default, read by the gateway (no pull-route consumer). */
const GATEWAY_GUARDRAIL_KNOB = {
  tier: 'global-kv',
  dataType: 'number',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Guardrail Policy',
} as const;

export const GUARDRAIL_JUDGE_SETTINGS: SettingDescriptor[] = [
  {
    key: GUARDRAIL_JUDGE_TIMEOUT_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    consumedBy: ['guardrail'],
    category: 'Guardrail Policy',
    label: 'Guardrail judge peer timeout (s)',
    description:
      'How long guardrail waits on ONE delegated peer call before failing closed — a judgement on ' +
      "`apps/text`'s isolated judge lane, or a classification/PII/entailment call on `apps/nlp`. It is " +
      'the deployment’s latency envelope, not a property of any model: the judge’s temperature and ' +
      'output-token budget are model-coupled and live on the selected `AiModel._metadata.policy` ' +
      'instead. Guardrail makes ONE judge attempt (a timed-out judgement is still running, so it is not ' +
      'retried); `apps/text` maps the resulting outage to a retryable 503, never to a content rejection. ' +
      'The timeouts NEST: `text.externalGuardrail.timeoutS` must stay above this value plus guardrail’s ' +
      'admission wait, so raising this means raising that first. Lowering it below the guardian’s real ' +
      'p99 (measured 50.6 s) turns healthy judgements into 503s, which fail CLOSED and block generation.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY],
  },
  {
    ...GATEWAY_GUARDRAIL_KNOB,
    key: GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY,
    label: 'Guardrail hold timeout (s)',
    description:
      'How long a workflow node held on a guardrail BLOCK waits for the clinician`s resolution (exclude, edit, or acknowledge) ' +
      'before the run ends `GUARDRAIL_BLOCKED`. The consultation stays held either way and a later resume re-runs by ' +
      'supersede, so the hold is never a dead end. Injected on every harness run start; a running hold keeps the value ' +
      'it started with. 60 s to 7 days.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_HOLD_TIMEOUT_SECONDS_KEY],
    validate: wholeNumberBetween(60, 7 * 86_400),
  },
  {
    ...GATEWAY_GUARDRAIL_KNOB,
    key: GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY,
    label: 'Guardrail evaluation reconcile grace (min)',
    description:
      'An evaluation id a run reported (TEXT `guardrailEvaluationIds`, stored on the trajectory step / activity run) counts ' +
      'as MISSING once it is older than this and still has no GuardrailEvaluation row. Guardrail`s outbox drains ' +
      'at-least-once, so the grace absorbs normal redrive delay. Exported as `guardrail_evaluation_missing_total`.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_EVALUATION_RECONCILE_GRACE_MINUTES_KEY],
    validate: wholeNumberBetween(1, 1440),
  },
  {
    ...GATEWAY_GUARDRAIL_KNOB,
    key: GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY,
    label: 'Guardrail evaluation reconcile lookback (h)',
    description: 'How far back the evaluation-gap reconciler scans reported evaluation ids. Older ids are not counted.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_EVALUATION_RECONCILE_LOOKBACK_HOURS_KEY],
    validate: wholeNumberBetween(1, 168),
  },
  {
    ...GATEWAY_GUARDRAIL_KNOB,
    key: GUARDRAIL_PLAYGROUND_SCREEN_TIMEOUT_MS_KEY,
    label: 'Guardrail "Test my rules" timeout (ms)',
    description:
      'How long the admin console`s "Test my rules" call (`POST admin/guardrail/screen`) waits for guardrail before ' +
      'answering 503. A playground knob only: production screening timeouts live in `apps/text`. 5–120 s.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_PLAYGROUND_SCREEN_TIMEOUT_MS_KEY],
    validate: wholeNumberBetween(5_000, 120_000),
  },
];
