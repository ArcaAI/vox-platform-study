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

/** Code default, mirrored by `DEFAULT_JUDGE_TIMEOUT_S` in the guardrail pull client. */
export const GUARDRAIL_JUDGE_DEFAULTS = {
  [GUARDRAIL_JUDGE_TIMEOUT_KEY]: 60,
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
      'instead. Guardrail retries a judgement twice, so the worst-case wait a caller sees is roughly ' +
      'twice this value plus backoff — `apps/text` maps the resulting outage to a retryable 503, never ' +
      'to a content rejection. Raise it for a slow self-hosted guardian; lowering it below the ' +
      'guardian’s real p99 turns healthy judgements into 503s, which fail CLOSED and block generation.',
    default: GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY],
  },
];
