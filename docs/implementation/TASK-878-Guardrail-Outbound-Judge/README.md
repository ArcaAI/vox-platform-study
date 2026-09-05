# TASK-878 — Guardrail outbound gaps and judge configuration homes

| | |
|---|---|
| **Status** | Completed (lane; the merge into `dev-2.2` is the orchestrator's) |
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

Three commits on top of `030df76b5`.

| Commit | What |
|---|---|
| `12179b3f3` | Ticket opened: current-state evaluation, the G3 decision, the two-tier home for the judge values |
| `4ca9bcd63` | The guardrail service: G1, G2, and both configuration moves |
| `46cdd658f` | The descriptor + registry spread + its test, the seed row, and the two cross-service pins in `apps/text` |

### G1 — `jailbreak_detection` on the outbound direction

`services/screening.py:66-77` appends it to `OUTBOUND_TASKS`. Nothing else was
needed: `_DECLARED_FAIL_MODES` (`:81-86`) already merges both task tuples, so the
check inherits the fail-CLOSED posture, and `_classify` (`:199`) already sends the
whole tuple in ONE delegated `classify`. Appended rather than prepended so
`reasons[0]` — the label `apps/text` reports on a rejection — keeps naming
`response_safety` for every rejection that already had it.

A taxonomy that does not declare the task yields `skipped/not_in_taxonomy`, not a
block (`screening.py:222-235`, pinned by
`test_a_taxonomy_without_the_task_reports_skipped_rather_than_blocking`). So the
change is inert until a tenant's `guardrail.safety` row declares the task — which
the SYSTEM row already does, since the same name is `INBOUND_TASKS[0]`.

### Cycle-safety evidence (the `text -> guardrail -> text` tripwire)

Two independent layers, each with a test:

1. **Guardrail's composition, statically and at runtime.** The check is a
   classification dispatched through `Screener._classify` → `SafetyAnalyzer` →
   `NlpGuardClient`. `test_the_outbound_jailbreak_check_is_a_classification_not_a_judgement`
   asserts `services/screening.py` names none of `TextJudgeClient`,
   `external_text_client`, `generate/internal/judge`, and that `_classify`'s only
   executor is `self._analyzer.classify_tasks`;
   `test_build_screener_binds_no_judge_client_for_the_jailbreak_check` builds a
   real screener from a taxonomy that DOES declare `jailbreak_detection` and
   asserts both bound clients are `NlpGuardClient` and neither is a
   `TextJudgeClient`. (The pre-existing `test_task799_outbound_screen_boundary.py`
   asserts the same boundary for the PHI-egress reason; these say it for the
   cycle reason, on the task this ticket added.)
2. **`apps/text`'s tripwire, unchanged and still first.**
   `test_task878_guardrail_outbound.py::test_the_gate_raises_inside_a_judge_scope_before_calling_guardrail`
   drives `gate_completion` inside `judge_scope()` with a client whose verdict
   BLOCKS on `jailbreak_detection`, and asserts `GuardrailRecursionError` is
   raised and `screen_output` was never awaited. The companion test proves the
   tripwire is scoped, not a blanket disable.

So the loop is broken twice: guardrail cannot reach `apps/text` from the outbound
screen, and if a future change made it able to, the judge completion it produced
would raise on the first request rather than close the cycle.

### G2 — `usage_detail` on `ScreenResponse`

| File | Change |
|---|---|
| `services/external_nlp_client.py:175-181,187-197,226-229` | `last_usage_detail` + `record_usage_detail`, and `_post` lifts `usage_detail` off any successful peer payload. VERBATIM, never re-derived; anything that is not a non-empty dict is ignored |
| `services/safety_analyzer.py:145-159` | `usage_detail()` — the seam the screener reads, first non-empty of the two bound clients |
| `services/screening.py:140-146,201-216,289` | `GuardrailDecision.usage_detail` (+ `to_dict()["usageDetail"]`), collected in `_finish`. Guarded: an analyzer without the seam, or one that raises, costs the caller its billing row and never its decision |
| `api/endpoints/screen.py:74-83,98` | `ScreenResponse.usage_detail`, mapped in `_to_response` — so BOTH screen routes carry it |

`apps/text` needed no change: `guardrail_usage_from_verdict` (`models/usage.py:366`)
already prefers `raw.usage_detail`, and TASK-871's `gate_completion` already lifts
it before the allow/deny branch. `test_task878_guardrail_outbound.py` pins the
meeting point in both directions — an allowed screen returns the `UsageDetail` to
the call site, a rejected one carries it on `OutputRejectedError.guardrail_usage`.

**Stated plainly, and it is in the code comments too: the outbound screen meters
nothing today.** Its executor is `apps/nlp`, which runs local weights and returns
`{results, scores, model_version}`. The field is therefore `null` on today's
outbound path — deliberately `null` and never `{}` or zeros. This is a wire
channel with no current producer, not the declared-but-unread ADMIN CONTROL that
`core/policy.py:86-95` and TASK-872 removed; the producer side is real and tested
(`test_the_nlp_client_forwards_a_peer_usage_block_verbatim`), so any delegated
executor that starts metering rides back with no further change on either side.

### G3 — decision (b): the input gate stays on `/api/medical/validate`

Recorded in full under §Design Decisions. In one line: **a nonce without an
envelope makes `containment_echo` structurally always-pass**, which is a false
green rather than an honest `skipped`, so option (a) is not a URL swap — it
requires `apps/text` to send guardrail's `envelope` in place of its own prompt,
and would additionally delete the medical-context gate and silence the input-side
`guardrail_usage`. No code changed for G3; the prerequisite for revisiting it is
"`apps/text` sends the envelope", not "`apps/text` sends a nonce".

### B — the judge's three values

| File | Change |
|---|---|
| `core/config.py:10-45` | `JudgePolicy.temperature` / `.max_tokens` / `.timeout_s` DELETED; the docstring records where each went and why `min_confidence`, `max_attempts`, `retry_backoff_s` and `max_input_chars` stay |
| `core/policy.py:59-79,186-217,240-247` | `judgeTemperature` / `judgeMaxTokens` as fail-CLOSED `_SPECS` entries with bounds; `require_number` (the numeric twin of `require_criteria` — absence, wrong type and out-of-range all raise, because a fail-closed key has nothing to clamp toward); `judge_temperature` / `judge_max_tokens` accessors |
| `services/external_text_client.py:117-127,155-157` | `temperature`, `max_tokens`, `timeout_s` are now REQUIRED keyword args, exactly like `criteria` and `tenant_id` and for the same reason: a client that cannot be built cannot render an unattributable verdict |
| `core/tenant_config.py:843,856-869,896-906` | `build_judge_client` resolves both hyperparameters off the row's `_metadata.policy` and takes the platform `judge_timeout_s`. Precedence UNCHANGED — the winning `AiRoutingPolicy.configJson` tuning still wins where it carries one; what moved is what it falls back TO |
| `core/effective_config.py:48-53,109-122` | `DEFAULT_JUDGE_TIMEOUT_S = 60.0` (one definition site, mirroring the descriptor's `default`) and `EffectiveConfigSnapshot.judge_timeout_s()` — a value that is not a positive number is treated as no opinion rather than obeyed |
| `core/dependencies.py:169,195-223,345-353,375,430-450,652-656` | `resolve_judge_timeout_s` (never raises; a config-plane outage keeps the declared default, the posture `_groundedness_gate` already states) and its three call sites. `JudgePolicy.timeout_s` had TWO readers — the judge client AND `_nlp_client`'s fallback — and both now read this one key, because both are the same question |
| `api/endpoints/medical.py:206-233` | `GET /medical/config` no longer reports the three moved values as process-wide facts; it reports WHERE each resolves, which is what an operator asking a process-wide route actually needs |
| `descriptors/guardrail-judge.descriptors.ts` (new) + `registry.ts:19,80` | `guardrail.judge.timeoutSeconds` — `global-kv`, `system`, `globalOnly`, `open-to-default` at 60, `consumedBy: ['guardrail']`, category `Guardrail Policy`. Exactly ONE spread line added to `registry.ts` (plus its import), replacing the comment that reserved the slot |
| `seed/ai-models/llm.ts:100-123` | The SYSTEM `granite-guardian-4.1-8b` row's `metaData.policy` gains `judgeTemperature: 0.05` and `judgeMaxTokens: 300` — the deleted literals transcribed verbatim, so the move changed no behaviour. Propagated by `seedAiModels`' full-column `update`, so an existing dev DB converges on `db:seed` |

**Behaviour change, deliberate and fail-closed:** a `guardrail.validate` selection
whose model row carries no `judgeTemperature` / `judgeMaxTokens` now makes
`POST /api/medical/validate` answer **503** instead of judging at a hardcoded
temperature. That is the declared posture for a `failMode: closed` key, it is the
same 503 an unseeded `medicalValidationCriteria` already produced, and `db:seed`
supplies both values for the platform default row.

### Files changed

`apps/guardrail`: `services/{screening,external_nlp_client,safety_analyzer,external_text_client}.py`,
`api/endpoints/{screen,medical}.py`, `core/{config,policy,tenant_config,dependencies,effective_config}.py`;
tests `test_task878_outbound_judge.py` (NEW, 32) plus fixture updates in
`test_{fail_closed_safety_posture,medical_db_config,metrics_task386,task777_policy_plane,task799_lane_d_guardrail,tenant_config,tenant_config_runtime_profile,text_judge_delegation,usage_metering_task615}.py`.
`apps/text`: `tests/unit/test_task878_guardrail_outbound.py` (NEW, 6) — **no production file changed**.
`packages/applications`: `descriptors/guardrail-judge.descriptors.ts` (NEW),
`__tests__/guardrail-judge.descriptors.test.ts` (NEW), `registry.ts` (one import + one spread).
`packages/database`: `seed/ai-models/llm.ts`, `seed/__tests__/task-777-guardrail-policy-seed.test.ts`.

### Disclosures

- **`seed/ai-models/llm.ts`, not `seed/06-ai-models.ts` itself.** The lane owns
  "`06-ai-models.ts` and its seed tests"; the guardian row lives in the
  `ai-models/` split that file re-exports. No other wave-2 lane touches any seed.
- **`apps/text` gained a test file and no production code.** The brief scoped the
  three `apps/text` files "only as far as the nonce handshake requires", and G3
  chose (b), so it required nothing. The new file exists because the two contracts
  it pins — the judge tripwire and the usage ride-back — are only assertable from
  this side.
- **One pre-existing ruff finding fixed in passing**: a trailing space at
  `core/policy.py` (`# groundedness `), present at base `030df76b5` and the ONLY
  ruff error in `apps/guardrail` there. One character, no behaviour; fixed so this
  lane's `guardrail:lint` gate is reportable rather than red-at-baseline.
- **`injectionScreeningCriteria` is still declared with no reader** in
  `core/policy.py:58`, exactly as before. It is out of this lane's scope and is
  reported for the program rather than fixed: it is the same
  declared-but-unread shape TASK-872 removed elsewhere, and the choice is either
  to wire an inbound LLM second opinion or to drop the key.
- Black: the two files this lane made newly unformatted were formatted. Three
  files it edits (`core/tenant_config.py`, `services/safety_analyzer.py`,
  `tests/test_tenant_config.py`) were ALREADY unformatted at base and were left as
  found, along with the other seven pre-existing findings in `apps/guardrail`.

### Verification evidence

Worktree `hope-v2-task-878`, HEAD `46cdd658f`, base `030df76b5`.

**Step 0 — the worktree source guard resolves IN THIS TREE** (rule 14 §4). Both
Python suites carry `assert_source_tree` in their `conftest.py` and would abort
with zero tests collected otherwise; the resolved paths, printed through
`apps/guardrail/pyproject.toml`'s own `pythonpath`:

```
guardrail            -> /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-878/apps/guardrail/src/guardrail/__init__.py
hope_env             -> /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-878/packages/py-env/src/hope_env/__init__.py
hope_runtime_models  -> /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-878/packages/py-runtime-models/src/hope_runtime_models/__init__.py
```

**TDD — RED before GREEN.** `test_task878_outbound_judge.py` written first, against
the base implementation:

```
27 failed, 5 passed in 0.50s
```

The 5 that passed are behaviour-preservation pins (the leading task order, both
cycle-safety assertions, and the not-in-taxonomy skip), which is what they are for.
After the implementation: `32 passed in 0.31s`.

The six `apps/text` tests were GREEN on arrival and are declared as such: G3 chose
option (b), so no `apps/text` production code changed. They are contract pins
across the service boundary — they fail if either side drifts (guardrail dropping
`usage_detail`, or `apps/text` losing the judge tripwire), which is the only place
that contract can be asserted.

**`pnpm guardrail:test`** — 426 baseline + 32 new:

```
============================= 458 passed in 10.39s =============================
```

**`pnpm guardrail:lint`** (ruff):

```
All checks passed!
```

**`pnpm guardrail:typecheck`** (mypy):

```
Success: no issues found in 44 source files
```

**`pnpm text:test`** — 1614 baseline + 6 new, exit 0:

```
=== 1620 passed, 4 skipped, 16 deselected, 12 warnings in 181.60s (0:03:01) ====
```

**`pnpm text:lint`** — the two KNOWN pre-existing findings, in files this lane did
not touch, unchanged:

```
  --> apps/text/src/text/models/provider.py:47:71
   --> apps/text/src/text/tests/unit/test_judge_route.py:469:26
Found 2 errors.
```

**`pnpm text:typecheck`** (mypy):

```
Success: no issues found in 81 source files
```

**`pnpm --filter @arcaai/applications test`** — 659 files / 11519 baseline, +1 file
and +6 tests (the descriptor test), exit 0:

```
 Test Files  660 passed | 1 skipped (661)
      Tests  11525 passed | 4 skipped (11529)
```

**`pnpm --filter @arcaai/database test`** — 9 failures, ALL pre-existing at the
base commit and none in this lane's files. Measured both ways rather than argued:

```
this branch (46cdd658f):   Test Files  3 failed | 76 passed (79)
                                Tests  9 failed | 1761 passed (1770)

base 030df76b5 (the two changed files checked out from base, then restored):
                           Test Files  3 failed | 76 passed (79)
                                Tests  9 failed | 1759 passed (1768)
```

Identical 3 files and 9 failures either way; the delta is exactly the +2 assertions
this lane added. The failures are in `ai-model-registry-seed.test.ts`,
`config-plane-seed.test.ts` and `task-863-agents.test.ts`, and concern a 36th
catalogue row (`whisper-large-v3-turbo-q8_0`) against tests that assert "exactly
35", an LM Studio `AiProviderConnection` pointing at `http://localhost:1234/v1`,
and the TASK-863 agent specs — all present at base (`git show
030df76b5:.../ai-models/audio.ts` contains that slug) and none of them touched
here: this lane's `packages/database` diff adds two keys to ONE existing row's
`metaData.policy` and adds no row.

**`pnpm lint`** — RED, entirely on `@arcaai/api`, in three e2e spec files this lane
does not touch (its diff contains zero `apps/api` paths):

```
@arcaai/api:lint: ✖ 70 problems (5 errors, 65 warnings)
Failed:    @arcaai/api#lint
```

The five errors are prettier formatting in
`tests/e2e/auth-throttle-per-endpoint.spec.ts` and
`tests/e2e/shared-component-contracts.spec.ts`, plus an unused `loginDoctor` import
in `tests/e2e/harness-gate.spec.ts`. Every other workspace passed, including
`@arcaai/applications` (213 problems, **0 errors** — `eslint-plugin-only-warn`) and
`@arcaai/domains`; the three files this lane adds or edits under
`packages/applications` produce no finding at all.

The workspaces this lane actually owns are green on their own gates
(`guardrail:lint` clean, `applications` 0 errors), and `apps/api` is another
lane's surface.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened: current-state evaluation, the G3 decision (option b) and the two-tier home for the judge values recorded. |
| 2026-09-05 | G1 + G2 + both configuration moves landed (`4ca9bcd63`), 32 guardrail tests RED→GREEN. |
| 2026-09-05 | Descriptor + one registry spread + its test, the seeded judge policy, and the two cross-service pins in `apps/text` (`46cdd658f`). All gates run and pasted; status → Completed. |
