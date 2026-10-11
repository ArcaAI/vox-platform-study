# BUG-041: Consultation stays RECORDING after its workflow run fails with OUTPUT_INVALID

| Field | Value |
|---|---|
| Status | Pending |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/41 (karanarca, 2026-10-06, label `bug`) |
| Severity | Medium. 232 sessions show the wrong state; downstream lists and filters are misled |
| Related | TASK-1045 (seven-status lifecycle + timeout sweep), TASK-1003, BUG-036, BUG-042 |

## Requirement Analysis
Workflow `arcaai-bren-consultation` run status is Failed with reason `OUTPUT_INVALID`, while the consultation still shows "Recording" (232 sessions). The reporter expects the consultation to leave RECORDING and reflect a failure state.

## Current State Evaluation
- Lifecycle doctrine (TASK-1045, rule 08 §Consultation Lifecycle): background work never changes `status`. A failed run sets the orthogonal `processing = FAILED` + `processingReason` (`consultation-lifecycle.gate.ts:66-71`). So by design a run failure does **not** move a consultation out of RECORDING. The capture state only changes on `stop`/`pause` or the sweep.
- Only `stop` (from the client) or the timeout sweep leaves RECORDING. `ConsultationTimeoutSweepService.sweepStaleRecordings` (`timeout-sweep/consultation-timeout-sweep.service.ts:183-215`) auto-**pauses** RECORDING rows idle for `consultation.state.recordingStaleMinutes` (default 30, `consultation-gates.constants.ts:219`). The query is `ConsultationRepository.findStaleRecording` (`packages/domains/.../ConsultationRepository.ts:508`). The sweep then auto-closes per tenant policy.
- That sweep landed with TASK-1045 on dev-2.2 (e.g. `e1b5e6158`, `d3c141c16`, 2026-10-05). The reporting environment (cluster) may predate it. Check the deployed digest.
- The 232 RECORDING rows are most plausibly consultations whose client never called `stop`. Candidates: the ALaaS stop flow broke (BUG-036: DELETE 404 → UI hang, user abandons), or ALaaS never sends stop. A live-summary run failing with OUTPUT_INVALID mid-recording is independent of that.
- `OUTPUT_INVALID` comes from the harness classifier (`apps/harness/src/harness/temporal/interpreter/activities.py:762-763`): any error text containing "schema" or "SchemaViolation". This is broad; the real failing node needs the run's events.
- The console "Recording" label: a client without `X-Hope-Lifecycle: 2` gets the legacy projection (`legacy-status-projection.ts:40`), but RECORDING maps to itself, so the label is genuine.

## Root Cause
Two things combine (confidence: medium):
1. Expected behaviour mismatch. Per TASK-1045, a run failure is recorded on `processing`, not `status`, so "workflow failed ⇒ leave RECORDING" is not implemented by design.
2. Abandoned captures are never stopped. Either the deployed build lacks the TASK-1045 stale-recording sweep, or the clients (ALaaS) never send `stop`.

Separately, the high OUTPUT_INVALID rate for `arcaai-bren-consultation` is its own defect: a model output vs. outputSchema mismatch. Needs run-event evidence.

## Implementation Plan
Investigate first (read-only):
1. Query 3 sample consultations: `status`, `processing`, `processingReason`, `lastActivityAt`, and whether `stop` was ever received (lifecycle events).
2. Pull the failing run's node events to find the schema mismatch.
3. Confirm the cluster digest includes TASK-1045.

TDD tests (depending on the OD-1 decision):
1. Sweep test: a RECORDING consultation with `processing = FAILED` and idle past the window is auto-paused (already covered? add the case if missing).
2. If the owner chooses "terminal run failure stops capture": a lifecycle-gate test that a governing-run terminal failure **after** the capture socket is gone transitions RECORDING → STOPPED with `processing FAILED`.
3. Harness test: `_classify` maps a real schema violation to OUTPUT_INVALID and nothing broader. Tighten the bare `"schema" in text` match.

File order: `consultation-lifecycle.gate.ts` (if OD-1 = yes) → `activities.py` classifier → console list shows the `processing` FAILED badge next to the status (`apps/admin-console` consultations feature).

Verification: `pnpm --filter @arcaai/applications test -- consultation`, `pnpm harness:test` (or arcaenv pytest per the sandbox memory), `pnpm --filter @arcaai/admin-console build lint test`.

## Risks / Open Questions (owner)
- OD-1 (key): should a failed governing run ever change capture `status`? The current doctrine says no. Alternatives: (a) keep the doctrine and rely on the sweep plus a visible `processing FAILED` badge; (b) auto-stop when the run fails **and** no live STT session is bound.
- OD-2: the cleanup of the existing 232 rows: run the sweep with `recordingStaleMinutes` override via the dev cleanup script, or wait for the deployed sweep.
- OD-3: fix the `arcaai-bren-consultation` output schema or prompt. This is tenant content, so the change belongs to the tenant admin, not the platform.

## Implementation Summary
Not started.

## Change History
- 2026-10-06: created from GitHub issue #41 (read-only investigation).
