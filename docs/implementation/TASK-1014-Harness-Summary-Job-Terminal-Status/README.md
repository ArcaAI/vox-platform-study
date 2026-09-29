# TASK-1014 — A harness-run SUMMARY job reaches a terminal status

**Status:** Review (merged into `dev-2.2`; awaiting owner sign-off)
**Type:** bugfix
**Branch:** worktree off `dev-2.2` @ `d74d2f0b5`
**Related:** TASK-1012 (browser SDK 4.0.1 `progress >= 100` workaround), TASK-1006

## Requirement Analysis

`POST consultations/:id/summary/async` routes to the harness. The controller registers a
ConsultationJob for the harness correlation id (`registerHarnessNoteJob`). After that, the harness
callbacks only ever called `notifyProgress(jobId, 100, …)` and never `notifyComplete`. The BullMQ
pre-summary path does call it (`pre-summary.processor.ts`). Result: `GET consultations/jobs/:jobId`
stayed `RUNNING` forever, so `@arcaai/vox-node` `summaries.generateAsync()` + `jobs.waitFor()` polled
until it timed out. The harness failure path had the same gap: the job never became `FAILED`.

Required:
1. The job becomes `COMPLETED` at the harness's true terminal point, with the BullMQ result shape
   (`SummaryJobResult`: `contextItemId`, `content`, `summaryMeta.aiModelId`).
2. The job becomes `FAILED` when the harness run fails.
3. Both are idempotent against duplicate harness callbacks.

## Current State Evaluation

The terminal point depends on the workflow shape (`apps/harness/src/harness/temporal/workflows.py`,
`HarnessDocWorkflow`):

| Shape | Callbacks, in order | Terminal point |
|---|---|---|
| Single-shot (optimistic delivery off, the default) | `persistDraft` (no `phase`) | `persistDraft` (progress 100) |
| Optimistic, verdict not FLAG | `persistDraft` (`phase: EARLY`, progress 90) → `finalizeAssurance` | `finalizeAssurance` (progress 100) |
| Optimistic, verdict FLAG | `persistDraft` EARLY → `retract_draft` | none on the gateway yet: `POST …/retraction` has not landed (see `apps/harness/src/harness/services/api_client.py` `retract_draft`), so that activity fails and the run fails (row below) |
| Run raises | `report_progress(stage="failed", job_id)` (`run()`'s `except`) | the `failed` progress callback |

Assurance is optional per run (the optimistic kill-switch). An EARLY `persistDraft` is therefore
never terminal. The legacy path keeps running after the draft, into the clinician gate. A failure
there reports `failed` after the job already completed, and that report must not undo it.

`HarnessDocWorkflow` can run a second execution for the same consultation (see the adoption comment in
`persistDraft`), so duplicate or late callbacks happen in normal operation.

## Implementation Plan

- `HarnessInternalService.advanceHarnessJob(jobId, progress, step, terminal | null)`: reads the job
  first. If the job is already COMPLETED, FAILED or CANCELLED, it does nothing (duplicate or late
  callback). Otherwise it sends the existing `notifyProgress` frame, and on a terminal call also
  `notifyComplete` with a `SummaryJobResult`. `content` is read back from the persisted row, which is
  what the clinician sees, including a case where the draft path skipped adoption.
- Both terminal points (`persistDraft` without `phase`, `finalizeAssurance`) call it with a result.
  The EARLY `persistDraft` calls it without one, so the job stays RUNNING at 90. The settled check also
  stops a late EARLY callback from moving a finished job back to RUNNING.
- New `HarnessInternalService.reportProgress`: passes the event to `HarnessProgressService`
  (unchanged live feed). On stage `failed` with a `jobId`, it calls `notifyFailed` with the same
  settled check. The `POST internal/harness/consultations/:id/progress` route now calls this method.
  The controller's `HarnessProgressService` injection became unused and was removed.
- Everything stays best-effort (try/catch, warn). A Redis failure never undoes a persisted note.

TDD list: see `harness-internal.service.test.ts` › `TASK-1014 — harness summary job terminal status`.
It drives the REAL `ConsultationJobService` over an in-memory Redis and asserts what a poller reads:
single-shot completes with the BullMQ shape · EARLY stays RUNNING/90 · finalize completes · a duplicate
finalize completes once (`notifyComplete` ×1, `completedAt` unchanged) · a late EARLY does not regress
COMPLETED · a CANCELLED job is not brought back · `failed` → FAILED with the label, and the live feed is
still fed · `failed` after COMPLETED stays COMPLETED · a non-terminal stage leaves the job alone.

## Implementation Summary

Files changed:
- `packages/applications/src/services/consultation/harness/harness-internal.service.ts`: `reportProgress`,
  `advanceHarnessJob`, `buildSummaryJobResult`, `failHarnessJob`, `isHarnessJobSettled`, plus the two
  terminal call sites.
- `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts`:
  9 new tests. The shared job-service mock gained `getJobStatus`/`notifyFailed`, and the context-item
  mock gained `findById`.
- `apps/api/src/modules/consultation/harness-internal.controller.ts`: the progress route delegates to
  `HarnessInternalService`, and the unused `HarnessProgressService` param and import are removed.
- `apps/api/src/modules/consultation/__tests__/harness-internal*.test.ts` (6 files): the positional
  4th constructor arg is removed, and the progress-route test now expects delegation to the internal
  service.

No schema, route, DTO or OpenAPI change. The route's path, body and response are unchanged.

Evidence (2026-09-29, worktree):
- RED: 8 failed / 1 passed. The single-shot, finalize and duplicate tests failed with `expected 'RUNNING' to be 'COMPLETED'`. The `reportProgress` tests failed with `service.reportProgress is not a function`. The controller tests failed with `Cannot read properties of undefined (reading 'reportProgress')`.
- GREEN: `harness-internal.service.test.ts` has 161 passed, and the 6 touched apps/api test files have 79 passed.
- `npx eslint` on the touched files: 0 errors, and the source files have no warnings. The test files are lint-ignored by config.
- `pnpm --filter @arcaai/applications build` is clean. `apps/api` `tsc --noEmit` is clean apart from `@arcaai/async-contract` not being built in the worktree, which is unrelated.

## Follow-ups

- **SDK workaround removal (next SDK release):** `packages/agentic-sdk-v2/src/core/summaryJob.ts`
  treats `progress >= 100` as done because the harness job never reached COMPLETED (TASK-1012, SDK
  4.0.1). Once this is deployed it can go back to waiting for `COMPLETED` only. Keep it until every
  gateway the SDK targets carries this fix.
- **Retraction endpoint:** when `POST internal/harness/consultations/:id/retraction` lands, it must
  settle the job too. Most likely `advanceHarnessJob` with a terminal result, or FAILED if the owner
  decides a retracted note is a failed job. Today the missing endpoint makes that run fail, and the
  `failed` progress stage marks the job FAILED.
- The settled check is a read then a write, not an atomic compare-and-set. Temporal retries are
  sequential, so this covers re-delivery. Two truly concurrent executions could both complete the job,
  with the same result.

## Change History

- 2026-09-29: ticket opened, implemented TDD (RED → GREEN), status Review. Uncommitted in the worktree,
  waiting for the owner to name the merge target.
- 2026-09-29: renumbered TASK-1013 → TASK-1014 before merging; a parallel session had already
  merged TASK-1013 (STT streaming-session terminal status) into `dev-2.2`.
