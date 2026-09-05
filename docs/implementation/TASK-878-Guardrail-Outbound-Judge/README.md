# TASK-878 — Guardrail outbound gaps and judge configuration homes

| | |
|---|---|
| **Status** | In Progress |
| **Type** | feature (safety) + refactor (configuration) |
| **Program** | TASK-870 wave 2, lane C |
| **Branch** | `task-878-guardrail-outbound-judge` (base `030df76b5` off `dev-2.2`) |
| **Owns** | `apps/guardrail/**`; a new `descriptors/guardrail-judge.descriptors.ts` + one `registry.ts` spread + its test; `seed/06-ai-models.ts` and its seed tests; this directory |
| **Merge target** | `dev-2.2` — merged by the orchestrator, not this lane |

## Requirement Analysis

Two unrelated-looking things, one owner directive behind both (TASK-870 §Requirement
Analysis items 5 and 7, and rule 09 §"No hardcoded configuration"):

> Guardrail is built-in and platform-only; it gates every text-generation request before
> send AND every response after receive, for built-in and BYO providers alike. The priority
> is safety against prompt jailbreak and injection. No hardcoded configuration.

**A. The outbound screen's three reported gaps.** TASK-871 landed the post-receive gate in
`apps/text` against guardrail's existing `POST /api/v1/guardrail/screen/outbound` and closed
its own side completely. It then reported three things it could not fix from `apps/text`:

| | Gap |
|---|---|
| G1 | `OUTBOUND_TASKS` has no `jailbreak_detection` — that check is inbound-only, so a jailbroken or injection-echoing RESPONSE is not detected. This is the owner's stated first priority. |
| G2 | `ScreenResponse` carries no `usage_detail`, so nothing the outbound screen spends can ride back to the billing plane. `apps/text` already lifts `raw.usage_detail`. |
| G3 | There is no nonce: text's INPUT gate calls `/api/medical/validate`, not `/screen/inbound` (which issues the containment nonce), so the containment-echo check reports `skipped`. |

**B. Judge configuration with no home.** `JudgePolicy` (`core/config.py:32-34`) hardcodes the
judge's `temperature` (0.05), `max_tokens` (300) and `timeout_s` (60.0). Rule 09 is explicit
that a `pydantic-settings`/`BaseModel` field with a real default is "a hardcoded value wearing
a config costume". TASK-872 removed the former `judgeTemperature` registry key precisely
because it was declared-but-unread (`core/policy.py:65-70`); this ticket gives the three values
their correct homes rather than re-declaring an unread knob.

## Current State Evaluation

Verified against the base commit (`030df76b5`); file:line references are to that tree.

- **The outbound screen makes NO LLM call.** `Screener.screen_outbound`
  (`services/screening.py:282`) sanitizes, then runs ONE delegated `classify` against
  `apps/nlp` for `OUTBOUND_TASKS` (`safety_analyzer.classify_tasks:105` →
  `NlpGuardClient.classify:268` → `POST /api/v1/guard/classify`), then a PII-span call to the
  same peer, then a pure-Python containment-echo check. `build_screener`
  (`core/dependencies.py:411`) constructs a `SafetyAnalyzer` and nothing else — no
  `TextJudgeClient` is built anywhere on the outbound path.
- **`jailbreak_detection` is already a declared task on the guardrail.safety row's
  taxonomy** (it is `INBOUND_TASKS[0]`, `screening.py:65`) and `_DECLARED_FAIL_MODES`
  (`:70-75`) already declares it fail-closed. `_classify` intersects the requested names with
  the taxonomy the registry row declared, so a task the taxonomy omits is recorded
  `skipped/not_in_taxonomy`, never invented and never a block.
- **`/api/medical/validate` reports `stats`, not `usage_detail`** (`api/endpoints/medical.py:69`,
  `_stats_of:81`). The `usage_detail` blob is produced one layer down, by
  `TextJudgeClient.validate_medical_context` (`services/external_text_client.py:261-263`),
  which forwards `text`'s own derived block VERBATIM. `apps/text`'s
  `guardrail_usage_from_verdict` (`models/usage.py:366`) accepts BOTH shapes, preferring
  `raw.usage_detail`. `apps/nlp`'s guard routes return `{results, scores, model_version}`
  (`apps/nlp/src/nlp/api/v1/rest/guard.py:389`) — no usage block today.
- **Judge hyperparameter plumbing.** `build_judge_client` (`core/tenant_config.py:836`) already
  resolves `GuardrailPolicy.from_blob(tenant_cfg.policy)` — the `AiModel._metadata.policy`
  blob — through the same tenant → SYSTEM cascade that chose the model, and already reads
  `medicalValidationCriteria` (fail-closed) and `judgeMinConfidence` from it. `temperature` /
  `max_tokens` / `timeout_s` come from `AiRuntimeProfile` (`tenant_cfg.*`, per-row optional
  tuning) and fall back to the `JudgePolicy` literals inside `TextJudgeClient.__init__`
  (`external_text_client.py:155-157`).
- **`JudgePolicy.timeout_s` has TWO readers**, not one: the judge client above, and
  `_nlp_client`'s fallback at `core/dependencies.py:337`
  (`timeout_s=float(cfg.timeout_s or settings.judge.timeout_s)`). Both are peer-call budgets.
  `GET /medical/config` (`medical.py:216-224`) reports all three values.
- **`core/effective_config.py`** already has the generic `setting(key)` accessor for keys a
  descriptor names `consumedBy: ['guardrail']` (the declared extension point), plus a
  `groundedness()` group accessor; TASK-872 deleted the dead `retention()` and emptied
  `_sources()`.
- **The registry reserves this ticket's homes explicitly** — `registry.ts:74-75`: *"The two
  judge hyper-parameters and the judge timeout get their homes in wave 2."*

## Design Decisions

### G1 — the outbound jailbreak check delegates to `apps/nlp`, and cannot reach the judge

`jailbreak_detection` is appended to `OUTBOUND_TASKS`. It is therefore part of the SAME single
`classify` call the outbound screen already makes to `apps/nlp` — zero additional peer calls,
zero additional latency budget, and no new failure mode (an outage already marks every task in
the batch `undetermined`, which blocks).

It is appended LAST so the existing `reasons[0]` ordering (`response_safety` first) is
unchanged for every consumer that reads the first reason as the rejection label.

**Cycle safety.** The `text → guardrail → text` loop TASK-871 guarded against requires the
outbound screen to reach `apps/text`. It cannot:

1. The check is a classification task, executed by `SafetyAnalyzer` against `NlpGuardClient`.
   `Screener` holds exactly one collaborator (`self._analyzer`), and `build_screener` builds
   that analyzer from two `NlpGuardClient`s. No code path from `screen_outbound` constructs,
   imports or reaches a `TextJudgeClient`.
2. `apps/text`'s own tripwire is the second layer and is unchanged: `gate_completion` calls
   `assert_not_in_judge_scope` before any guardrail call, so even if guardrail's outbound
   screen ever DID delegate to the judge lane, the completion produced by that judge call
   would raise `GuardrailRecursionError` rather than re-enter the gate.

Both layers are pinned by new tests (§Implementation Plan, tests 2 and 3).

### G2 — `usage_detail` rides back when a delegated call reports one, and is `null` otherwise

`ScreenResponse` gains `usage_detail`, fed from `GuardrailDecision.usage_detail`, which the
`Screener` reads off its analyzer after the checks run. The producer side is the ONE forwarding
contract guardrail already uses for the judge (`external_text_client.py:261-263`): a delegated
peer's `usage_detail` block is forwarded VERBATIM, never re-derived and never fabricated —
`text` derives the funding tier from the credential that served the call, and re-deriving it
downstream is how a call site starts mis-billing.

**Stated plainly: the outbound screen spends no metered tokens today.** Its delegated executor
is `apps/nlp`, whose guard routes run local GLiNER2/NLI weights and return no usage block. So
the field is `null` on today's outbound path — deliberately `null` and never `{}` or zeros,
which is the same rule `_stats_of` (`medical.py:81-90`) already states: *"reporting zeros there
would tell the billing plane the call was free rather than that it never happened."*

This is a wire CHANNEL with no current producer, not a control an admin can set with no effect
(the defect `core/policy.py:65-70` and TASK-872 removed). It is proven end to end by tests at
both ends: guardrail populates it from a peer payload that carries one, and `apps/text` lifts
it off a `ScreenResponse`-shaped verdict into a `UsageDetail`. Any delegated executor that
starts metering — `apps/nlp` gaining token accounting, or a future judge-backed check — rides
back with no further change on either side.

### G3 — DECISION: option (b). The input gate stays on `/api/medical/validate`

Containment-echo stays `skipped`. Reasoning, in the order it decided the question:

1. **A nonce without an envelope makes the check structurally always-pass.** The nonce is only
   meaningful if the text the MODEL sees is guardrail's `envelope` — the nonce-fenced,
   sanitized wrapper (`screen.py:114-123`, `injection_defense.wrap_untrusted`). `apps/text`
   sends the caller's own `prompt` to the provider. Passing a nonce that never appears in the
   prompt turns `containment_echo` from an honest `skipped` into a `pass` that cannot fail —
   a green dashboard for a check that is not running. This codebase already ranks that as
   worse than no check at all (`_check_pii_leak`, `screening.py:301-305`). So option (a) is
   not "swap one URL": it requires `apps/text` to send `envelope` in place of `prompt`, and to
   carry the nonce from the input gate through to the output gate.
2. **The two endpoints are not semantically equivalent.** `/api/medical/validate` answers *is
   this medical* (an LLM judgement, gated by the posture's `require_medical`);
   `/guardrail/screen/inbound` answers *is this safe*. Switching would silently DELETE the
   medical-context gate and make `GuardrailPosture.require_medical` inert.
3. **It would silence input-side billing.** `/api/medical/validate` is the only path guardrail's
   judge spend has to the billing plane (`guardrail_usage_from_verdict` on the input verdict).
   `/screen/inbound` makes no judge call, so the input-side `guardrail_usage` on
   `GenerateResponse` would go to `null`.

Options: (a) is a redesign of the input gate across two services with a billing regression and
a semantics deletion; (b) is honest and costs nothing. Per the owner's "fast win — guardrail
need not be perfect", **(b)**. The prerequisite for revisiting it is stated above: it is
"`apps/text` sends the envelope", not "`apps/text` sends a nonce".

### B — the three judge values, and why they land in two different tiers

| Value | Home | Why |
|---|---|---|
| `judgeTemperature`, `judgeMaxTokens` | `AiModel._metadata.policy`, fail-CLOSED | They are MODEL-COUPLED. A decoding temperature and an output-token budget calibrated for granite-guardian's JSON verdict are meaningless against a different checkpoint — the same argument `core/policy.py:75-86` already records for `groundednessEntailmentThreshold`. Resolving them through the cascade that chose the model keeps the two in step by construction. Fail-closed with no code default: a judge running at an unknown temperature is not a judge with a sensible default, it is an unattributable verdict. |
| `guardrail.judge.timeoutSeconds` | `global-kv` descriptor, `globalOnly`, `open-to-default` | It is a PEER-CALL BUDGET (guardrail → text, and the same fallback for guardrail → nlp), a property of the deployment's latency envelope rather than of any model row, and platform-scope by construction — guardrail is platform-only, so no tenant may set it. `open-to-default` because a control-plane outage must never turn every judgement into a failure. |

`AiRuntimeProfile` (`tenant_cfg.temperature` / `max_tokens` / `timeout_s`) keeps precedence
where a row carries one — that is the existing per-selection tuning override and this ticket
does not change it. The model-row policy is what the fallback becomes.

## Implementation Plan

TDD, RED before GREEN, hermetic throughout (no live peers, no DB).

| # | Test | Proves |
|---|---|---|
| 1 | `jailbreak_detection` is in `OUTBOUND_TASKS`; a response whose classification flags it is BLOCKED with that reason; it rides the SAME single `classify` call; a taxonomy that omits it yields `skipped`, not a block | G1 |
| 2 | `screen_outbound` reaches `apps/nlp` only: the analyzer's client is an `NlpGuardClient`, `build_screener` builds no judge client, and the `screening` module names neither `TextJudgeClient` nor the judge path | G1 cycle safety, layer 1 |
| 3 | (`apps/text`) `gate_completion` inside `judge_scope()` raises `GuardrailRecursionError` before any `screen_output`, for the jailbreak-blocking verdict shape | G1 cycle safety, layer 2 |
| 4 | `ScreenResponse.usage_detail` is populated when a delegated call reports one, is `None` when none does, and is never `{}`/zeros | G2 |
| 5 | (`apps/text`) `guardrail_usage_from_verdict` lifts a `UsageDetail` off a `ScreenResponse`-shaped outbound verdict carrying `usage_detail` | G2, end to end |
| 6 | `GuardrailPolicy.judge_temperature` / `judge_max_tokens` resolve from the blob; ABSENT ⇒ `GuardrailUndeterminedError` (fail-closed, no code default); out-of-range ⇒ raises too | B |
| 7 | `JudgePolicy` no longer declares `temperature` / `max_tokens` / `timeout_s`; `build_judge_client` passes the resolved values; `AiRuntimeProfile` still wins where present; an unseeded row makes the guardian dependency 503 | B |
| 8 | (seed) the SYSTEM granite-guardian row carries `judgeTemperature` and `judgeMaxTokens`, propagated by `seedAiModels`' update path, idempotently | B |
| 9 | `EffectiveConfigSnapshot.judge_timeout_s()` returns the served value, the bootstrap default on absence/outage, and rejects non-positive/non-numeric values | Deliverable 5 |
| 10 | (TS) `guardrail.judge.timeoutSeconds` is registered `global-kv` / `system` / `globalOnly` / `open-to-default` / `consumedBy: ['guardrail']`, category `Guardrail Policy`, default 60 | Deliverable 5 |

File order: `screening.py` → `external_nlp_client.py` + `safety_analyzer.py` → `screen.py` →
`policy.py` → `config.py` + `external_text_client.py` + `tenant_config.py` +
`dependencies.py` + `medical.py` → `effective_config.py` → the TS descriptor + `registry.ts`
→ the seed row.

## Implementation Summary

_(filled on completion)_

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened: current-state evaluation, the G3 decision (option b) and the two-tier home for the judge values recorded. |
