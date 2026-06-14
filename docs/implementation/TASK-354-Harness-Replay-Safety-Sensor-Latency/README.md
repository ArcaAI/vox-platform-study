# TASK-354 — Harness Workflow Replay Safety + Inferential Sensor Latency Hardening

| | |
|---|---|
| **Ticket** | TASK-354 |
| **Created** | 2026-06-12 |
| **Updated** | 2026-06-13 |
| **Status** | Completed |
| **Type** | bugfix (2 defects) + ops hardening |
| **Affected** | `apps/harness` (Temporal workflow + activities), runbook docs |

## 1. Requirement Analysis

### Background — incident of 2026-06-11/12 ("SOAP notes not generated, many Running workflows")

Diagnosis evidence (Temporal CLI + `core` schema queries, 2026-06-12):

1. **No worker was polling `harness-task-queue`** (the whole dev stack was down); workflow-task backlog grew to 10 (age 13 h 38 m). Restarting the stack restored processing.
2. **3 of 9 "Running" workflows were permanently wedged zombies** failing every workflow task with `[TMPRL1100] Nondeterminism error`:
   - `harness-doc-019e9d51-…`, `harness-doc-019e9d34-…` (Jun 5): histories predate the Phase-6 `fetch_policy` activity, which was added **without a `workflow.patched()` gate** (`workflows.py` ~line 222). Replay mismatch: history `extract_entities` vs command `fetch_policy`. A cancel requested Jun 7 could never be delivered (processing the cancel itself needs a workflow task → fails).
   - `harness-doc-019eafd5-…` (Jun 10): history written by the **ungated TASK-345 cohort** — `report_progress` emitted unconditionally, **no patch marker recorded** (empty `searchAttributes`). The TASK-348 worker replays `workflow.patched("task-345-harness-progress")` → no marker → `False` → skips progress → mismatch (`report_progress` vs `fetch_policy`). The TASK-348 gate protects *pre-TASK-345* histories but cannot protect marker-less *TASK-345-era* histories.
   - All 3 terminated with operator approval on 2026-06-12. Root enabler: **multiple worker processes with different code vintages ran concurrently on the same task queue.**
3. **The latest consultation (`019eb6dc…`, Jun 11 13:30 UTC) actually produced its SOAP note, but 17 minutes late.** `run_inferential_sensors` attempt 1 consumed the **full 900 s `start_to_close_timeout`** before Temporal retried; attempt 2 finished in 77 s. The activity has **no heartbeat and no per-call timeout**, so one slow/hung LM Studio pass stalls the pipeline for the entire budget. Draft `RAW_SUMMARY` ContextItem `019eb6f0-…` + `SummaryMeta` persisted 13:47:42.
4. **Baseline measurement (2026-06-12 post-restart verification, workflow `019eb9ee…`)**: a *healthy* single-attempt run takes **344 s in `run_inferential_sensors`** (everything else < 25 s; `generate` 21 s; note visible at ~6 min; full loop incl. clinician sign-off Completed at 9 min). Under `asyncio.gather` + the serializing concurrency governor (`HARNESS_LLM_MAX_CONCURRENCY=1`), **each sensor's wall-clock ≈ the whole pass** — so any per-sensor budget below ~400–500 s would cut off healthy runs. The budget must live at the **per-judge-call** level, not per-sensor.
4. The remaining 6 `Running` workflows are **by-design gate-waiters** (PENDING_REVIEW drafts awaiting the clinician `approval` signal, 24 h SLA + 12 h re-escalation).

### Defects to fix

| # | Defect | Impact |
|---|---|---|
| A | `run_inferential_sensors` has no `activity.heartbeat()` and no per-judge-call timeout; a hung LLM call burns the full 900 s before retry | SOAP note latency balloons from ~6 min (healthy baseline) to 15–17 min; users perceive "not generated" |
| B | No *current-era* replay fixture exists; future workflow-sequence changes without a patch gate will silently re-create unkillable zombie workflows (proven 3×) | In-flight consultations wedge permanently; Running list pollution; cancel impossible |

### Acceptance Criteria

1. A single hung/stuck judge HTTP call is cut off at a configurable **per-call timeout** and that sensor **degrades** (existing `degraded_result` path → reduced assurance) instead of stalling the whole 900 s activity. Healthy runs (≈344 s pass, measured) are NOT affected — no per-sensor cap below the measured healthy wall-clock.
2. `run_inferential_sensors` heartbeats so Temporal detects a dead worker/hung attempt within `heartbeat_timeout` (60 s) instead of `start_to_close` (900 s).
3. A replay-compat test replays a **post-TASK-348 current-era history** (contains `fetch_policy`, both patch markers, progress events) against the current definition — CI fails on any future ungated command-sequence change.
4. Runbook documents: identifying/terminating nondeterministic zombies, one-worker-version-per-queue policy, zero-poller monitoring.
5. All existing harness unit + replay tests still pass.

### Explicit non-goals

- **No retroactive patch-gating of `fetch_policy`.** `workflow.patched()` cannot repair already-recorded marker-less histories; adding a gate now would only invert the mismatch for current in-flight executions. Pre-Phase-6 histories are already terminated (operational fix).
- No Temporal Worker Versioning (Build IDs) rollout — recorded as a future option in the runbook.

## 2. Current State Evaluation

- `apps/harness/src/harness/temporal/workflows.py` — `HarnessDocWorkflow._run`: `_INFERENTIAL_TIMEOUT = 900s`, `_INFERENTIAL_RETRY = 2 attempts`, no `heartbeat_timeout` on any activity. `fetch_policy` executed unconditionally; `report_progress` gated by `workflow.patched("task-345-harness-progress")`; failure-terminal gated by `"task-348-failure-terminal"`.
- `apps/harness/src/harness/temporal/activities.py` — `run_inferential_sensors` (line ~374): builds judge, fans out `GroundednessSensor` + `CitationVerifySensor` (+ `SafetySensor` when enabled) via `asyncio.gather`; each sensor makes many serialized LLM calls under the concurrency governor (`HARNESS_LLM_MAX_CONCURRENCY=1`). Backend failures degrade per sensor; **wall-clock overruns do not**.
- `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` — fixtures: `doc_workflow_pre_task345_history`, `doc_workflow_task345_history`. **No post-TASK-348 fixture.** Capture procedure in `_capture_replay_fixture.py`.
- Timeout/retry-option changes (adding `heartbeat_timeout`) do **not** alter the recorded command sequence → replay-safe; confirmed by running the replay suite after the change.

## 3. Implementation Plan (TDD)

> Gate: user approves this plan before any code is written.

### Step 1 — Defect A: per-judge-call timeout + heartbeat (RED → GREEN → REFACTOR)

> Design note (from the 2026-06-12 baseline): a healthy pass is ≈344 s wall-clock and each sensor's
> wall-clock ≈ the whole pass (shared serializing governor). A per-*sensor* `asyncio.wait_for` budget
> would therefore cut off healthy runs — the timeout belongs on each **individual LLM request**
> (where a hang actually manifests: one stuck HTTP call with the connection held open).

1. **RED** — `apps/harness/src/harness/tests/unit/temporal/test_activities_inferential.py` (extend existing activity tests):
   - a judge/guardian HTTP call that never responds is aborted at the per-call timeout (`HARNESS_LLM_REQUEST_TIMEOUT_S`, default 120 s); the owning sensor returns its `degraded_result` (reason mentions the timeout), other sensors still return real results;
   - the activity issues heartbeats during the pass (assert via `temporalio.testing.ActivityEnvironment` heartbeat capture);
   - config override respected.
   Run: `pnpm py:harness:test:unit` → confirm the new tests FAIL.
2. **GREEN**:
   - thread a request timeout through the shared LLM client/governor used by the judge, citation-verify, and Granite Guardian calls (`HARNESS_LLM_REQUEST_TIMEOUT_S` on `HarnessSettings`; applied as the HTTP client timeout). A timed-out call exhausts its existing `HARNESS_LLM_MAX_ATTEMPTS` retries/backoff, then the sensor self-degrades via the existing path — never raises into the activity;
   - in `activities.py` `run_inferential_sensors`: background heartbeat task (every 15 s) for the duration of the pass;
   - in `workflows.py`: add `heartbeat_timeout=timedelta(seconds=60)` to the `run_inferential_sensors` activity options. Keep `start_to_close = 900 s` (healthy pass needs ~344 s + headroom).
3. **REFACTOR** — keep `_assemble_inferential_output` unchanged; verify full unit suite.

### Observation (out of scope, recorded for follow-up)

Healthy-pass latency (~5.7 min of judge calls) dominates note delivery (~6 min total). Tuning options if product wants faster notes: raise `HARNESS_LLM_MAX_CONCURRENCY` (if the LM Studio box tolerates it), a smaller/faster judge model, or capping verified claims per draft. Separate ticket if pursued.

### Step 2 — Defect B: current-era replay fixture (RED → GREEN)

1. Capture a post-TASK-348 history with `_capture_replay_fixture.py` (worker on current code, full doc loop incl. `fetch_policy`, progress markers, failure-terminal patch marker) → `fixtures/doc_workflow_post_task348_history.json`.
2. **RED/GREEN** — add `test_post_task348_history_replays_on_current_definition` to `test_replay_compat.py`. It must pass on the current definition **including the Step-1 `heartbeat_timeout` change** (proves option-only changes are replay-safe) and fail if any future ungated sequence change lands.
3. Re-run the two existing replay tests — still green.

### Step 3 — Runbook (docs only)

`knowledge/harness/README.md` (ops section) + this ticket: detect zombies (`temporal workflow list` + `WorkflowTaskFailed` / TMPRL1100), terminate procedure, **one worker version per task queue** policy, zero-poller/backlog-age monitoring command, patch-gate checklist for every workflow change (gate + captured fixture + replay test).

### Verification criteria

- `pnpm py:harness:test:unit` — all pass (new + existing, incl. 3 replay tests). Output captured in ticket.
- Manual E2E on dev stack: consultation → draft within the healthy baseline (~6 min with the current serialized judge pass); with one judge call forcibly hung → draft still arrives with `reduced_assurance` after ~per-call timeout × retries, not 15 min.
- `ReadLints` clean on modified files.

## 4. Implementation Summary

Implemented per the plan with strict TDD (RED → GREEN → REFACTOR). All three steps complete; all acceptance criteria met.

### Step 1 — Defect A: per-call timeout + heartbeat

A per-**call** wall-clock timeout (`HARNESS_LLM_REQUEST_TIMEOUT_S`, default 120 s) now bounds every individual model call on **both** LLM paths. A timed-out call surfaces as a transient `TimeoutError`, is retried within `HARNESS_LLM_MAX_ATTEMPTS`, and once the budget is spent the owning sensor self-degrades via its existing `degraded_result` path — it never raises into the activity and never auto-PASSes. `run_inferential_sensors` heartbeats every 15 s; the workflow sets `heartbeat_timeout=60s` (option-only, `start_to_close` kept at 900 s).

### Step 2 — Defect B: current-era replay fixture

Captured a post-TASK-348 **failure-terminal** history (`persist_draft` fails *after* the inferential pass) so the fixture carries **both** patch markers (`task-345-harness-progress` + `task-348-failure-terminal`) and the `run_inferential_sensors` command whose options Step 1 changed. The new replay test proves the option change is replay-safe and forward-guards against any future ungated sequence change. Live capture used Temporal's in-process time-skipping environment — **no live stack required** (the `019eb9f4…_events.json` export was therefore not needed as a fallback).

### Step 3 — Runbook

`knowledge/harness/README.md` gained an **Operations (runbook)** section: inferential-pass latency/timeout layers, zombie (TMPRL1100) detection + termination, one-worker-version-per-queue policy, zero-poller/backlog-age monitoring, and the patch-gate checklist. `apps/harness/.env.example` documents the new knob.

### Files changed

| File | Purpose |
|---|---|
| `apps/harness/src/harness/core/config.py` | Add `Settings.llm_request_timeout_s` (default 120 s) — the documented `HARNESS_LLM_REQUEST_TIMEOUT_S` knob. |
| `apps/harness/src/harness/core/llm_concurrency.py` | Add `request_timeout_s` to `LlmGovernorConfig` (+ env read); `call_with_timeout` helper; classify `TimeoutError` transient in `is_retryable`; wrap `governed_request`'s per-attempt call in the timeout (Granite path). |
| `apps/harness/src/harness/eval/judge/providers.py` | Thread the per-call timeout through `_create_with_retry` (judge / groundedness / citation_verify path); treat `TimeoutError` as transient in `_is_transient`. |
| `apps/harness/src/harness/sensors/inferential/granite_client.py` | Catch `TimeoutError` alongside `httpx.HTTPError` → `GraniteServiceError` so a per-call timeout degrades the safety screen. |
| `apps/harness/src/harness/temporal/activities.py` | Background `_heartbeat_periodically()` task (15 s) wrapping `run_inferential_sensors`, cancelled in `finally`. |
| `apps/harness/src/harness/temporal/workflows.py` | Add `_INFERENTIAL_HEARTBEAT_TIMEOUT=60s` and `heartbeat_timeout=` on the `run_inferential_sensors` options (option-only, replay-safe; `start_to_close` unchanged). |
| `apps/harness/src/harness/tests/unit/core/test_llm_concurrency.py` | RED→GREEN governor tests: default, env read, `TimeoutError` transient, hung-op abort+retry+raise, `<=0` disables. |
| `apps/harness/src/harness/tests/unit/temporal/test_activities_inferential.py` | **New** — per-call-timeout + heartbeat tests against the real activity in `ActivityEnvironment` (hung judge → judge sensors degrade only; hung Granite → safety degrades only; override lets a finite call complete; heartbeats emitted). |
| `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` | **New** `test_post_task348_history_replays_on_current_definition`. |
| `apps/harness/src/harness/tests/unit/temporal/_harness_stubs.py` | Add `StubConfig.persist_draft_fails` to drive the post-inferential failure-terminal capture. |
| `apps/harness/src/harness/tests/unit/temporal/_capture_replay_fixture.py` | Add a `--failure` scenario (catches `WorkflowFailureError`, still fetches history). |
| `apps/harness/src/harness/tests/unit/temporal/fixtures/doc_workflow_post_task348_history.json` | **New** captured fixture (both patch markers + `run_inferential_sensors` + failed terminal). |
| `apps/harness/.env.example` | Document `HARNESS_LLM_REQUEST_TIMEOUT_S`. |
| `knowledge/harness/README.md` | Operations (runbook) section + config rows. |

### Test evidence

- New tests RED first, then GREEN. Governor + activity tests: **28 passed** (`test_llm_concurrency.py` + `test_activities_inferential.py`).
- Full harness unit suite: **489 passed** (`apps/harness/src/harness/tests/unit`).
- Replay suite: **3 passed** — `pre_task345`, `task345`, and the new `post_task348`.
- `ruff check apps/harness/src` clean; `ReadLints` clean on all changed files.

### Replay-safety confirmation

- The Step-1 `heartbeat_timeout` edit is option-only — the replay suite (incl. the new post-TASK-348 fixture that contains `run_inferential_sensors`) passes unchanged → no patch gate required.
- Forward-guard demonstrated: temporarily inserting an **ungated** extra `execute_activity` made the new fixture's replay fail with `[TMPRL1100] Nondeterminism error` ("scheduled event 'extract_entities' does not match command 'fetch_policy'"); reverted, suite green again.

### Deviations from plan

- **Fixture is the failure path, not the happy path.** The plan named a post-TASK-348 fixture with "both patch markers". On the happy path the `task-348-failure-terminal` gate is never reached, so a failure-terminal capture (`persist_draft` fails *after* the inferential pass) was used — it records both markers **and** still includes `run_inferential_sensors`, giving a strictly stronger guard. Required a small test-only stub flag (`persist_draft_fails`) + a `--failure` capture mode.
- **Live capture was possible** via the in-process time-skipping environment, so the `019eb9f4…_events.json` export fallback was not needed. Nothing blocked on the (down) live stack.

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-12 | Incident remediated operationally: 3 nondeterministic zombie workflows terminated (`019eafd5`, `019e9d51`, `019e9d34`); dev stack + single worker restarted; pollers verified; backlog drained. Ticket created with plan. | — (ops) |
| 2026-06-12 | E2E verification run (`harness-doc-019eb9ee…`): full loop Completed incl. clinician sign-off. Measured healthy baseline — `run_inferential_sensors` 344 s single attempt, note at ~6 min, total 9 min. Plan revised: per-**judge-call** timeout (`HARNESS_LLM_REQUEST_TIMEOUT_S`) instead of per-sensor budget, which would have cut off healthy runs. | README.md (plan revision) |
| 2026-06-13 | Implemented Steps 1–3 (TDD). Per-call timeout + heartbeat on the inferential pass; post-TASK-348 failure-terminal replay fixture + test; runbook. 489 unit + 3 replay tests pass; ruff/lints clean. Status → Completed. | `apps/harness/**` (config, llm_concurrency, judge providers, granite_client, activities, workflows, tests + fixture), `apps/harness/.env.example`, `knowledge/harness/README.md` |
