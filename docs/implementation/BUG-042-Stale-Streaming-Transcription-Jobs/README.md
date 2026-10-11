# BUG-042: STREAMING transcription jobs stuck in PROCESSING ("Running") for days

| Field | Value |
|---|---|
| Status | Completed |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/42 (karanarca, 2026-10-06, label `bug`) |
| Severity | Medium. Ops dashboard counts are wrong; no clinical data is lost |
| Related | TASK-999 (STREAMING rows), TASK-992 (batch reaper), TASK-985, BUG-036 |

## Requirement Analysis
Admin console → Audio → Transcription Jobs shows 27 jobs at "Running" with 0% progress for ~116 h (507 total, 475 completed, 1 queued, 0 failed). Expected: a job either completes, or a stuck job times out to FAILED/terminal. Actual: the jobs never leave Running. The report has a screenshot (see the issue) but no environment field; the numbers point to the shared cluster tenant.

## Current State Evaluation
- Since TASK-999 a realtime STT session is a `TranscriptionJob` row with `jobType = STREAMING`. It is written at open and is only closed when teardown returns a summary. See `packages/applications/src/services/stt/streaming/streamingSession.service.ts:110-117` (design) and `:600-605` (`closeStreamJob(summary)` runs only `if (summary)`).
- `removeSession` (`streamingSession.service.ts:552-596`) returns early on an STT **404** ("Session already removed"). It also does not close the row on a **204**. In both cases the row stays PROCESSING and only a metric/warn is emitted (`:607-619`).
- The batch reaper deliberately skips STREAMING rows: `packages/applications/src/services/stt/job/reaper/stt-job-reaper.service.ts:171-189`. Its comment says "closing THOSE ... needs a reaper that knows about Redis session state, which is not this one". No such reaper exists.
- The row is stranded whenever the gateway never reaches a 200 teardown. Known paths:
  1. The apps/stt inactivity reaper or the Redis TTL tears the session down first. The later gateway DELETE then gets a 404.
  2. The gateway pod restarts or is killed before finalize. `stt-ws.gateway.ts:739` handles SIGTERM, but a crash skips it.
  3. Removal fails, then exhausts `session-removal-retry.service.ts`.
  4. The control-path FINALIZE already popped the stashed summary. The TASK-985 stash mitigates this, but it is time-bounded.
- `ConsultationLifecycleService.liveBoundSessions` (`consultation-lifecycle.service.ts:560-575`) reads `completedAt: null` STREAMING rows. Stranded rows inflate that read too, although a liveness check against STT filters them out.

## Root Cause
The STREAMING job row has exactly one close path: a 200 teardown summary from STT. Every other ending (404, 204, crash, exhausted retry) leaves the row in PROCESSING, and no sweeper covers STREAMING rows. Confidence: high (both gaps are documented in the code comments).

## Implementation Plan
TDD tests first (all in `packages/applications`):
1. `streamingSession.service` test: when STT DELETE returns 404, the STREAMING row for the session is closed, as COMPLETED with `interrupted`, or FAILED with code `STT_SESSION_GONE`. The terminal status needs an owner decision (OD-1).
2. Same test for a 204 with no summary: the row is closed and no usage row is emitted (the metric still increments).
3. New `StreamingJobSweeper` test: a PROCESSING STREAMING row older than N minutes (setting) whose session STT reports not-live (`getSessionStatus` 404) is closed. A row whose session is live is left alone. "Unknown" (STT unreachable) is left alone, so the sweep fails safe.
4. Sweeper test: the sweep is paged and per-row failures are isolated, mirroring `stt-job-reaper.service.test.ts`.

File order:
1. `transcriptionJob.service.ts`: add `closeStreamJobWithoutSummary(sessionId, reason)`.
2. `streamingSession.service.ts`: call it on the 404 and 204 branches, wrapped best-effort like the existing calls.
3. New `stt/job/reaper/stt-streaming-job-sweeper.service.ts` (+ module registration): cron-driven, governed setting `stt.streamingJob.staleMinutes`. Register the descriptor and do not use an env var (rule 09).
4. One-off: the 27 existing rows are cleared by the new sweeper on its first run. No migration needed.

Verification: `pnpm --filter @arcaai/applications test -- stt`, `pnpm --filter @arcaai/applications build`, `pnpm lint`, then a live check on the console Transcription Jobs page.

## Risks / Open Questions (owner)
- OD-1: what terminal status should a stranded STREAMING row get: COMPLETED (the session did run, so the transcript exists elsewhere) or FAILED/new code? Note the report expects "Failed/Timed Out".
- OD-2: a stranded row was never billed (no summary means no `transcribe.stream` usage). Should the sweeper attempt usage recovery? There is an existing internal usage POST path (`apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts:112`).
- The console's "Live" stream badge on such rows should follow automatically once the status is terminal; verify.

## Implementation Summary
Not started.

## Final Verification (2026-10-11, cluster api `0.0.0-dev-2-2.b4c248f9`)

Zero QUEUED or PROCESSING TranscriptionJob rows on the cluster. The sweep closed the stranded rows as FAILED/`STT_SESSION_GONE` at 09:00 and 09:45; the 204-teardown path closed one at 09:12.

## Change History

- 2026-10-11 — Final verification against the deployed cluster passed; status Completed.
- 2026-10-06: created from GitHub issue #42 (read-only investigation).
