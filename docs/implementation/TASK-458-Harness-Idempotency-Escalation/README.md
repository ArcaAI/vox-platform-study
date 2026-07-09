# TASK-458 — Harness Idempotency, Escalation & Policy-Degrade (C1-02…C1-06)

- **Status**: Review — implemented, adversarially reviewed (+ I-1 fix), merged to `fix/2605-review` (Wave 2 Batch 1)
- **Type**: bugfix (reliability, cost, observability)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 (P1)
- **Findings**: C1-02 (High) · C1-03 (Med) · C1-04 (Med) · C1-05 (Med) · C1-06 (Med) — all CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-458-harness-idempotency` (from the Wave-1 landing on `fix/2605-review`)
- **Size**: L
- **Suggested agent**: general-purpose (Python / Temporal)

## 🔒 Replay-safety is a hard gate (read first)

Any change to `workflows.py` that alters the **command sequence** requires a `workflow.patched()` marker + a newly captured replay fixture + a new replay test. The scout classified each finding:

| Finding | Fix location | Replay impact |
|---|---|---|
| C1-03 (idempotency key) | `api_client.py` (client) | activity/client only — **replay-safe**, no patch gate |
| C1-04 (SMR idempotent) | `smr_client.py` / `activities.py` body | activity body — **replay-safe** |
| C1-05 (real escalation) | `activities.py` body (+ new `api_client` method + apps/api endpoint) | activity body — **replay-safe** |
| C1-06 (set `reduced_assurance`) | `workflows.py` `except` block | setting the flag in the existing `except` adds NO command → **replay-safe**; adding a WORM-emitting activity there is NOT — gate it |
| C1-02 (terminal abandon + cap edit re-run) | `workflows.py` gate/assurance loops | **changes the command sequence** → REQUIRES `workflow.patched()` + new fixture + replay test |

`test_replay_compat.py` (5 tests, `temporalio.worker.Replayer`) + fixtures in `tests/unit/temporal/fixtures/` MUST pass. Existing markers: `task-345-harness-progress`, `task-348-failure-terminal`, `task-355-optimistic-delivery`, `task-355-assurance-signals`. Capture new fixtures with `_capture_replay_fixture.py`. NEVER regenerate the frozen `pre_task345` fixture.

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/harness/src/harness/temporal/workflows.py` | Terminal abandon timer + cap edit-driven re-run (C1-02); set `reduced_assurance` on policy-fetch failure (C1-06) — each command-sequence change behind a NEW `workflow.patched("task-458-…")` marker |
| `apps/harness/src/harness/temporal/activities.py` | Real `escalate_gate` (C1-05) |
| `apps/harness/src/harness/services/api_client.py` | Idempotency key on WORM callbacks (C1-03); new escalation-record method (C1-05) |
| `apps/harness/src/harness/services/smr_client.py` | Idempotent SMR generate / avoid re-invoke on lost response (C1-04) |
| `apps/harness/src/harness/tests/unit/temporal/**`, `…/services/**` | RED-first tests + replay fixtures + stub updates |

apps/api side (a new endpoint to receive escalation records for C1-05, and callback idempotency dedup for C1-03) is **out of this manifest** — if the fix needs it, STOP and report so the orchestrator opens a coordinated apps/api change. Anything else outside the manifest → STOP.

## Requirement Analysis

### C1-02 (High) — unbounded escalation loop + uncapped edit-driven re-run
Gate loop ([workflows.py:845-868](apps/harness/src/harness/temporal/workflows.py)) exits ONLY when `self._approval` is set; every `gate_escalation_seconds` (default 12h) it re-fires `escalate_gate` and increments `escalations` **forever** — no terminal abandon/expire, no max. The optimistic assurance loop ([:681-770]) re-runs the costly `run_inferential_sensors` on **every** `edit` signal ([:722-725] `continue`) with **no cap** — contrast the Q1 regen path right below which IS capped (`regens_used < gate.max_regen`, :755-760). **`continue_as_new` is NOT the fix** (TASK-448 S3: ~7 years to the event cap) — the real asks are (a) a terminal abandon/expire timer on the gate and (b) a cap (coalesce) on edit-driven re-runs. Both change the workflow command sequence → patch-gated.

### C1-03 (Med) — WORM callbacks carry no idempotency key
`_headers` ([api_client.py:133-134]) sends only `Content-Type` + `X-Service-Token`; `_prune` never adds an idempotency field. Five WORM/draft callbacks (`persist_draft`, `finalize_assurance`, `record_gate_decision`, `report_progress`, `report_assurance_event`) are wrapped in Temporal `_API_RETRY`=3 at their call sites, so a lost ack re-POSTs and can double-write the WORM audit / draft.

### C1-04 (Med) — non-idempotent SMR generate under two retry layers
`smr_client` POSTs `/api/v1/generate` ([smr_client.py:63]) via `governed_request` which retries up to `HARNESS_LLM_MAX_ATTEMPTS`=5 on transient failures **including a lost response after the model ran** (timeout / dropped read → classified transient → re-sent). Layered on top, the `generate` activity is wrapped in `_GENERATE_RETRY`=2, so a worker crash after the SMR call but before recording the result re-runs the activity → another generation. Double LLM spend + divergent drafts.

### C1-05 (Med) — `escalate_gate` is a no-op
`escalate_gate` ([activities.py:731-743]) only logs `harness.gate.sla_breached` and returns `escalated=True` — no apps/api call, no notification, no persistence. An SLA breach notifies no one and records nothing. (No escalation endpoint exists in `api_client` today — the fix adds one.)

### C1-06 (Med) — policy-fetch failure silently relaxes assurance
A failed `fetch_policy` ([workflows.py:264-273]) falls back to code defaults but **never sets `reduced_assurance`** (that flag is only flipped on retrieval/inferential degrade). So an unreachable policy endpoint silently relaxes a stricter tenant policy with no reduced-assurance signal and no WORM event. Setting `reduced_assurance=True` in the existing `except` adds no command (replay-safe); emitting a WORM `REDUCED_ASSURANCE` event would add a command (patch-gate it).

### Acceptance criteria

- [ ] **C1-02 (red first)**: tests assert (a) the gate abandons/expires after a terminal bound (not infinite escalation) and (b) N rapid edits do NOT trigger N inferential passes (coalesced/capped). Both changes behind a new `workflow.patched("task-458-…")` marker; a new replay fixture proves pre-458 histories replay AND the new sequence replays. `escalations` still surfaced.
- [ ] **C1-03**: WORM callbacks carry a deterministic idempotency key (derived from workflow/run + logical step) so a retry dedups. Header-assertion tests updated. (apps/api dedup consumption — coordinate if needed.)
- [ ] **C1-04**: a lost-response-after-model-ran scenario does NOT re-invoke the LLM (idempotency key to SMR, or narrow `governed_request`/activity retry to pre-send failures for `generate`). Test double-invocation is prevented.
- [ ] **C1-05**: `escalate_gate` records the breach to apps/api (new `api_client` method + endpoint) and/or notifies; the no-op test (`test_activities.py:378-385`) is updated to assert the real effect.
- [ ] **C1-06**: policy-fetch failure sets `reduced_assurance=True`; the test asserting `reduced_assurance is False` (`test_doc_workflow.py:609-638`) is inverted.
- [ ] **AC-gate**: `pnpm py:harness:test` (INCLUDING `test_replay_compat`) + `pnpm py:harness:lint` + `pnpm py:harness:typecheck` green; output pasted.

### Non-goals

- `continue_as_new` (explicitly not needed). The claim-check / payload-size work (S3 strategic). Sensor placement (correct). The C1-01 sign-off window (TASK-453, accepted-as-is).

## Current State Evaluation (code-verified 2026-07-09 against `fix/2605-review`)

Temporal structure: `HarnessDocWorkflow._run` [workflows.py:256]; 13 activities in `DOCUMENT_ACTIVITIES` [activities.py:747-761]; RetryPolicies [workflows.py:101-112] (`_API_RETRY`=3, `_GENERATE_RETRY`=2); workflow start sets no `execution_timeout`/`run_timeout` [internal.py:176-188] (no workflow-level backstop). SLA defaults now `86_400s`/escalation `43_200s` [models.py:42-43].

Sites: gate loop [workflows.py:845-868]; edit re-run [:681-770, :722-725]; `_headers` [api_client.py:133-134] + 5 callbacks; SMR generate [smr_client.py:49-96] + `governed_request` [core/llm_concurrency.py:276-307] (5 attempts); `escalate_gate` [activities.py:731-743]; policy fallback [workflows.py:264-273, :300-309] + `reduced_assurance` init [:348].

Tests encoding current behavior (to invert/extend): escalation `test_doc_workflow.py:240`; edit-rerun `:1048`; regen-cap `:975`; policy-fallback `:609-638`; escalate no-op `test_activities.py:378-385`; client headers `test_api_client.py`; SMR `test_smr_client.py`. Replay: `test_replay_compat.py` + `_capture_replay_fixture.py`.

## Implementation Plan (TDD — strict order)

> Context pack: this README (esp. the replay table) · TASK-449 §Architecture preamble (the **durable harness** — determinism/replay rules are strict) · `.claude/rules/06-python-services.md` (Temporal determinism, replay-compat, `X-Service-Token`).

1. Do the **replay-safe** findings first (C1-03, C1-04, C1-05, C1-06-flag) — activity/client bodies, no command change.
2. Then C1-02 (command-sequence change) behind a NEW patch marker; capture the replay fixture; prove forward+backward replay.
3. Run `test_replay_compat` after every workflows.py change.

### Verification gate

```bash
pnpm py:harness:test           # MUST include test_replay_compat
pnpm py:harness:lint && pnpm py:harness:typecheck
```

Adversarial review focus: (a) C1-02 — does the abandon timer have a real terminal state, and is the edit cap correct under bursts? do pre-458 histories still replay? (b) C1-03/04 — is the idempotency key stable across retries and unique per logical write, so it dedups without suppressing legitimate distinct writes? can a post-model-run SMR response ever re-invoke? (c) C1-05 — does the escalation record actually reach apps/api (or is it still a local log)? (d) C1-06 — is `reduced_assurance` set on ALL policy-degrade paths? (e) every workflows.py command-sequence change carries a patch marker + fixture; zero diff outside the manifest.

## Implementation Summary

**Branch**: `fix/task-458-harness-idempotency` (2 commits) — merged to `fix/2605-review` (Wave 2 Batch 1).

**What shipped**: C1-02 gate terminal-abandon (after `gate_max_escalations`=3) + edit-rerun cap (`max_edit_reruns`=5), both behind NEW `workflow.patched()` markers with 2 new captured replay fixtures. C1-03 `Idempotency-Key = {workflow_run_id}:{activity_id}` on the 5 WORM callbacks. C1-04 SMR post-send non-retryable (read-loss AND the governor per-call timeout — via a `retry_on_timeout=False` flag in `llm_concurrency.py`). C1-05 real `record_escalation` (harness→api POST). C1-06 policy-fetch failure sets `reduced_assurance`.

**Adversarial review**: no Critical — replay safety verified (both markers gate correctly; pre-458 histories replay; the frozen fixture untouched; fixtures base64-decoded to confirm command shapes) and the abandon terminal state confirmed. Important **I-1** found: the governor's `asyncio.timeout` still re-invoked the model post-send → fixed (generate timeout is now terminal; idempotent callers unchanged). Docstrings corrected.

**Gates**: `pnpm py:harness:test` **662 passed** (incl. `test_replay_compat` 7 passed); ruff + mypy clean.

**Discovered → [TASK-466](../TASK-466-Harness-Callback-Consumption/README.md)**: the harness now SENDS the escalation record, the idempotency keys, and the SMR key — but apps/api must add the escalation endpoint + consume the keys (dedup), and apps/smr must honor its idempotency key (the worker-crash re-invoke residual). Sender half done here; receiver half tracked separately.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C1-02…06; all re-verified against the post-Wave-1 tree by read-only scout, with per-finding replay-safety classification (only C1-02 needs a patch marker/fixture; C1-06 flag-set is replay-safe). No implementation. |
