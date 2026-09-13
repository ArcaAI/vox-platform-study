// The harness JUDGE's reasoning posture — the PLATFORM values, on the pull route.
//
// TASK-968 (owner directive 2026-09-13: reasoning OFF for text generation; configuration
// belongs to the platform admin, not to an environment variable).
//
// ## What was wrong
//
// The judge's two reasoning levers were `pydantic-settings` fields on
// `apps/harness/src/harness/eval/config.py#JudgeConfig`, reachable only as
// `HARNESS_JUDGE_REASONING_MODE`, `HARNESS_JUDGE_SUPPRESS_REASONING` and
// `HARNESS_JUDGE_EXTRA_BODY`. Three consequences, all of them the reason this file exists:
//
//  1. Both defaults left reasoning ON — `reasoning_mode: "auto"` lets the model decide, and
//     an absent `extra_body` is the engine's own default. That is the state TASK-891
//     measured at 5168 ms / 184 reasoning tokens against 1237 ms / 30 with `minimal`.
//  2. `extra_body` is NOT eval-only. It is baked into `JudgeClient.complete()` at the
//     transport layer, so it rides EVERY judge call — including the groundedness and
//     citation-verify sensors that `run_inferential_sensors` runs on every real
//     consultation. An env var was therefore deciding a live clinical pass's token budget.
//  3. Env vars are immutable for the process lifetime (`09-infrastructure-devops.md`
//     §Configuration Tiers L1), so the only way to retune the judge was a redeploy.
//
// ## Why `global-kv`, platform scope, and this shape
//
// Same reasoning as `HARNESS_SENSOR_SETTINGS` (D-1/D-2): `global-kv` is the one tier with a
// complete read + write + cascade + invalidate loop, and the judge is a PLATFORM component
// — its model election (`AiRoutingPolicy` `harness.judge`) is already a SYSTEM-only row that
// only a platform admin may write (`16-ai-routing-policy.ts`). Governing its posture at a
// deeper scope than its own model selection would be incoherent, so `maxScope: 'system'` +
// `globalOnly: true`, exactly like the claim-check threshold beside it.
//
// TWO keys rather than one, because there are genuinely two levers and they act in different
// places — the existing code says so ("Distinct from `suppress_reasoning` so prompt phrasing
// and the hard `/no_think` suffix can be tuned independently"):
//
//   reasoningMode    PROMPT lever  — appends `/no_think` or a think-first directive to the
//                                    judge SYSTEM MESSAGE. Reaches the PDSQI-9 rubric judge
//                                    (`resolve_prompt`) only: CI, the promotion gate and the
//                                    admin run-now endpoint.
//   reasoningEffort  WIRE lever    — rides `extra_body.reasoning_effort` into the
//                                    OpenAI-compatible / Azure `create(...)` call. Reaches
//                                    EVERY judge call, the live inferential pass included.
//
// The retired `suppress_reasoning` boolean collapses into `reasoningMode: 'none'` — the
// consuming code already read it that way (`if suppress_reasoning or reasoning_mode == "none"`),
// so it was a second name for one state, which is exactly the ungoverned-surface shape the
// configuration rules exist to remove.
//
// DEFAULTS ARE THE DIRECTIVE, not a transcription. Unlike the sensor thresholds — which were
// copied verbatim so that registering them changed nothing — these two deliberately CHANGE the
// value in force, from "let the engine decide" to off. The deployed judge is
// `lms-gemma-4-e2b-it-qat` on LM Studio, which is precisely the small local judge
// `NO_THINK_SUFFIX` was written for: it otherwise emits a long `<think>` block and can end the
// turn before the JSON. A platform admin who wants the old behaviour writes `auto` here, with
// no redeploy.

import { SettingDescriptor } from '../registry.types';

/** The prompt lever's vocabulary, as `resolve_prompt` branches on it. */
export const HARNESS_JUDGE_REASONING_MODES = ['auto', 'think', 'none'] as const;

/** The wire lever's vocabulary — the SAME four efforts an agent may author (`agent-reasoning.ts`). */
export const HARNESS_JUDGE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

const oneOf = (allowed: readonly string[], what: string) => (value: unknown) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${what} must be one of ${allowed.join(', ')}.`;
  }
};

export const HARNESS_JUDGE_REASONING_MODE: SettingDescriptor = {
  key: 'harness.judge.reasoningMode',
  tier: 'global-kv',
  // The ONLY wiring step: this is what puts the key on
  // `GET /internal/effective-config?service=harness`.
  consumedBy: ['harness'],
  dataType: 'enum',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  // TUNING, so `open-to-default`: an unwritten row leaves the judge on its in-code floor
  // (`none`), which is already the directive's posture. Fail-closed would turn "nobody has
  // configured this yet" into an endpoint failure, the opposite of the degradation contract
  // every consumer of this route is built around.
  failMode: 'open-to-default',
  category: 'Clinical Assurance',
  label: 'Judge reasoning mode (prompt)',
  description:
    "How the PDSQI-9 rubric judge's system prompt asks the model to reason. 'none' (default) appends a /no_think directive and forbids a <think> block, which is what a small local judge needs to avoid exhausting its completion budget before the JSON appears; 'think' asks for an explicit reasoning pass first; 'auto' says nothing and leaves the model to decide. Prompt text only — nothing server-side is toggled, and it does not reach the groundedness or citation-verify sensors, which build their own messages. Changing it changes judge scores, so treat it as a calibration decision, not a cost knob.",
  default: 'none',
  validate: oneOf(HARNESS_JUDGE_REASONING_MODES, 'Judge reasoning mode'),
};

export const HARNESS_JUDGE_REASONING_EFFORT: SettingDescriptor = {
  key: 'harness.judge.reasoningEffort',
  tier: 'global-kv',
  consumedBy: ['harness'],
  dataType: 'enum',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Clinical Assurance',
  label: 'Judge reasoning effort (engine)',
  description:
    "How hard the judge's engine is told to think, sent as extra_body.reasoning_effort on every OpenAI-compatible or Azure judge call — the rubric judge AND the live groundedness / citation-verify sensors that run on every consultation. 'minimal' (default) is the engine's own off switch. Raising it buys deliberation on a graded entailment verdict and spends wall-clock inside the assurance pass; measured on gemma-4-e2b-it-qat, leaving the engine on its own default cost 5168 ms against 1237 ms at minimal. Bedrock's converse API has no such passthrough and ignores this.",
  default: 'minimal',
  validate: oneOf(HARNESS_JUDGE_REASONING_EFFORTS, 'Judge reasoning effort'),
};

export const HARNESS_JUDGE_SETTINGS: SettingDescriptor[] = [HARNESS_JUDGE_REASONING_MODE, HARNESS_JUDGE_REASONING_EFFORT];
