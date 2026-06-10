# TASK-345 — Harness Live Progress Feed

| | |
|---|---|
| **Ticket** | TASK-345 |
| **Type** | feature |
| **Created** | 2026-06-10 |
| **Updated** | 2026-06-10 |
| **Status** | Completed |

## 1. Requirement Analysis

### Description

After a consultation recording stops, the documentation harness (`apps/harness`, a Python Temporal workflow) drafts the SOAP note asynchronously. Today the clinical workspace UI shows only a **static** placeholder ("Generating the SOAP draft…") for the whole run (typically 30s–several minutes). The clinician has no visibility into what the harness is doing or whether it is making progress.

Build a **live activity/progress feed**: the harness emits a progress event at each workflow stage ("extracting key information", "assembling context", "drafting the note", "running safety sensors", "finalizing the draft"), the API relays those events to the browser over the existing Redis → SSE realtime infrastructure, and the review panel renders a live stage checklist (✓ for completed stages, spinner for the current one) — falling back to the existing static text when no events arrive (pipeline down).

### Business Context

Clinicians wait on the review screen right after a visit ends. A visible, truthful progress feed reduces perceived latency, communicates that the safety pipeline (sensors/guardrails) is actually running, and distinguishes "still working" from "stuck" — directly improving trust in the auto-drafting harness.

### Acceptance Criteria

1. The harness workflow reports progress at each stage; progress reporting failures NEVER fail or delay the document workflow (fire-and-forget, short timeout, errors swallowed + logged).
2. A new internal API endpoint (service-token guarded, same pattern as the existing `/internal/harness/*` routes) accepts progress events and publishes them on the realtime channel infrastructure.
3. A new SSE endpoint streams progress to the browser, keyed by `consultationId`, guarded identically to the existing live-summary stream (`@TenantOwnedResource` pre-stream guard + `@StreamScope` one-shot ticket).
4. The review panel's "generating" state shows the live stage checklist while events arrive and keeps "Generating the SOAP draft…" as the graceful fallback when none do.
5. Late joiners (SSE connects after stages already ran) immediately see the accumulated stage state (Redis snapshot replay).
6. No DB/Prisma/domain changes — progress is ephemeral realtime data (Redis pub/sub + short-TTL snapshot only).
7. All units TDD'd (pytest / vitest), builds stay green.

## 2. Current State Evaluation

### Verified findings (all pointers re-checked against the code)

- **`apps/harness/src/harness/temporal/workflows.py`** — `HarnessDocWorkflow.run` chains: `fetch_policy` → `extract_entities` (+ `persist_entities`) → `retrieve_context` → bounded regen loop (`assemble_prompt` → `generate` → note-NER → `run_sensors` → `run_inferential_sensors`) → `persist_draft` → gate wait → `record_gate_decision`. It tracks an internal `_phase` (queryable) but **emits no progress anywhere**. Workflow body is deterministic; all I/O lives in activities (`activities.py`).
- **`apps/harness/src/harness/services/api_client.py`** — typed httpx client for the apps/api `/internal/harness/*` callbacks (`get_policy`, `persist_entities`, `assemble`, `persist_draft`, `record_gate_decision`). **No progress method.** Auth via `X-Service-Token`.
- **Harness jobId never reaches the UI** — `ConsultationEventHandler.handleTranscriptionCreated` (packages/applications/…/events/consultation-event.handler.ts, line ~124) mints `harness-doc-${randomUUID()}` and passes it to `harnessGatewayService.start(...)`; it is never returned to any UI-facing response. The workflow only threads it into `persist_draft` (best-effort `notifyProgress(jobId, 100, …)` on a channel no client is subscribed to).
- **Legacy job-update SSE pattern** — `ConsultationJobService` publishes `consultation_job_updates:{jobId}` via `IRedisCacheService.publish`, relayed by `GET /consultations/jobs/:jobId/stream` (`@Sse()`). Requires the client to know the jobId — which the clinical workspace never has for harness runs.
- **Live-summary SSE pattern (the one to mirror — consultationId-keyed)** — `LiveDocumentationService` publishes `consultation:live-summary:{consultationId}` + a `:last` snapshot key (1h TTL, late-join replay), relayed by `GET /consultations/:id/live-summary/stream` (`@Sse()` + `@TenantOwnedResource` + `@StreamScope({ namespace: 'consultation_live_summary', param: 'id' })`), heartbeat every 15s, terminal event carries `closed: true` (ends the stream via `takeWhile`). UI mirrors it in `use-live-summary-stream.ts` (stream ticket → `EventSource`) with the pure reducer `reduceLiveSummaryMessage` in `lib/live-summary.ts`.
- **Internal inbound surface** — `HarnessInternalController` (`apps/api/src/modules/consultation/harness-internal.controller.ts`, `@Controller('internal/harness')`, class-guarded by `HarnessServiceTokenGuard`, `@Public()` to skip the user-JWT chain). This — not the stt-internal ApiKey controller — is the controller the harness already calls; the progress endpoint belongs here.
- **Stream tickets** — `StreamTicketService.issueTicket` accepts any scope string; scope enforcement happens per-route via `@StreamScope`. A new namespace needs no registration.
- **UI** — `clinical-workspace-page.tsx` polls draft readiness (`useDraftReadiness`, `lib/draft-polling.ts`: 150s timeout / 3.5–8s tick) and passes `draftStatus` to `ReviewPanel`; `components/review-panel.tsx` (line ~56) renders the static "Generating the SOAP draft…" block when `draftStatus === 'generating'`. On stop, the page switches to the Review tab immediately, so the panel (and a hook inside it) mounts at generation start.
- **Tests/infra** — harness tests live in `apps/harness/src/harness/tests/` (`pnpm py:harness:test`, conda `arcaenv`); workflow tests use Temporal's time-skipping env with name-matched stub activities (`_harness_stubs.py`) — any new activity invoked by the workflow must get a stub there. TS unit tests run via root vitest (`dotenv -e .env.test -- vitest run …`); ui-playground has its own `test` + `type-check` scripts.

### Key design decisions (and why)

1. **Channel keyed by `consultationId`, not jobId.** The UI always knows the consultationId; the harness jobId is minted server-side in the event handler and never surfaces to any client API. Keying by jobId would require threading it through `recording/stop` → polling → UI for no benefit. The consultationId-keyed live-summary relay already exists as a hardened, tenant-guarded pattern — we mirror it exactly. The jobId is still carried *inside* the payload for ops/log correlation.
2. **Progress emitted from the workflow via a tiny dedicated `report_progress` activity between stages** (not from inside the existing activities). The workflow body knows consultationId/tenantId/jobId + stage; the existing activity inputs (e.g. `ExtractEntitiesInput` = text+language only) would all need consultation/tenant fields added to self-report. A dedicated activity keeps I/O out of the deterministic body, is the smallest diff, and is trivially stub-bable in workflow tests.
3. **Never fail the workflow:** the `report_progress` activity swallows ALL exceptions internally (returns `reported=False`), uses a short HTTP timeout (5s), and the workflow additionally wraps each call in `try/except ActivityError` with `RetryPolicy(maximum_attempts=1)` + 10s start-to-close — belt and braces.
4. **Server-side fold to full-state events.** The API service folds each stage event into an accumulated `stages[]` snapshot in Redis (the workflow is sequential, so no concurrent-fold races) and publishes the **full state** on every event. The UI is stateless (each SSE message = complete checklist) and late-join replay is the same object. Regens re-activate `drafting_note` (attempt counter increments; later stages reset to `pending`) so the loop is honestly communicated.
5. **Terminal event** `stage: "completed"` (sent after `persist_draft` succeeds) marks all stages completed and sets `closed: true` → the SSE relay ends the stream (same `takeWhile` contract as live-summary). The gate/sign-off wait that follows is intentionally NOT part of this feed (the UI leaves the "generating" state as soon as the draft appears via the existing poll).
6. **No PHI in the feed.** Events carry stage keys, generic labels, ordinals, timestamps — never transcript or note content.
7. **Stage catalog** (workflow-truthful; "highlighting key findings" from the original wish-list is not a real workflow stage — highlights are folded during assemble — so it is not shown):

| # | stage key | label | emitted before |
|---|---|---|---|
| 1 | `extracting_information` | Extracting key information | policy fetch + transcript NER |
| 2 | `assembling_context` | Assembling context | institutional retrieval + prompt assembly |
| 3 | `drafting_note` | Drafting the note | each generate iteration (re-emitted on regen) |
| 4 | `running_safety_sensors` | Running safety sensors | computational + inferential sensor pass |
| 5 | `finalizing_draft` | Finalizing the draft | persist_draft |
| — | `completed` | Draft ready for review | terminal (after persist_draft) — folds to all-completed + `closed: true` |

### Payload schemas

Harness → API (`POST /api/v1/internal/harness/consultations/:id/progress`, camelCase, `X-Service-Token`):

```json
{ "tenantId": "…", "jobId": "harness-doc-…", "stage": "drafting_note", "label": "Drafting the note", "ordinal": 3, "total": 5 }
```

API → browser (published on `consultation:harness-progress:{consultationId}`, snapshot at `…:last` TTL 1h, full-state every event):

```json
{
  "consultationId": "…",
  "jobId": "harness-doc-…",
  "stages": [
    { "stage": "extracting_information", "label": "Extracting key information", "ordinal": 1, "total": 5, "status": "completed", "attempt": 1, "at": "…" },
    { "stage": "drafting_note", "label": "Drafting the note", "ordinal": 3, "total": 5, "status": "active", "attempt": 2, "at": "…" }
  ],
  "updatedAt": "…",
  "closed": false
}
```

### Impact areas

- `apps/harness` (models, activities, workflows, api_client, worker via existing `DOCUMENT_ACTIVITIES`, test stubs)
- `packages/applications` (`services/consultation/harness/`: new progress service + module + DTOs, barrels)
- `apps/api` (`harness-internal.controller.ts` POST route; `consultation.controller.ts` SSE route; `consultation.module.ts` import)
- `apps/ui-playground` (`clinical-workspace`: types, constants, api, new lib reducer, new hook, review-panel rendering)

## 3. Implementation Plan

No DB/domain changes. Layer order: applications service → api controller → harness (Python) → UI. TDD red-green-refactor per unit.

### TDD test list

**A. `packages/applications` — `HarnessProgressService` (vitest, new `__tests__/harness-progress.service.test.ts`)**
1. first stage event → publishes full-state payload (1 active stage, attempt 1) on `consultation:harness-progress:{id}` and stores the same JSON snapshot (`setex`, 1h TTL)
2. subsequent stage event → earlier stage folds to `completed`, new stage `active` (reads prior snapshot)
3. re-emitted stage (regen) → attempt increments, later stages reset to `pending`
4. terminal `completed` event → all stages `completed`, payload `closed: true`
5. corrupt snapshot in Redis → starts fresh (never throws)
6. Redis publish failure → resolves `{ ok: false }`, never throws
7. `subscribeToProgress` → emits stored snapshot first, then relayed channel messages
8. `subscribeToProgress` → completes after a `closed: true` event and unsubscribes from the channel

**B. `apps/api` — controllers (vitest)**
9. `harness-internal.controller.test.ts`: `POST consultations/:id/progress` delegates to `HarnessProgressService.reportProgress(id, dto)`
10. new `consultation.controller.harness-progress.test.ts`: `GET :id/harness-progress/stream` is `@Sse()`, path/method metadata correct, `@TenantOwnedResource` + `@StreamScope({ namespace: 'consultation_harness_progress' })` metadata present, delegates to `subscribeToProgress`

**C. `apps/harness` (pytest)**
11. `test_api_client.py`: `report_progress` POSTs camelCase body to `/consultations/{id}/progress` with the service token; returns ok; raises `ApiServiceError` on HTTP failure
12. `test_activities.py`: `report_progress` activity returns `reported=True` on success and `reported=False` (no raise) when the API client errors
13. `test_doc_workflow.py`: happy path emits the ordered stage sequence (`extracting_information`, `assembling_context`, `drafting_note`, `running_safety_sensors`, `finalizing_draft`, `completed`) with consultation/tenant/job threading
14. `test_doc_workflow.py`: regen path re-emits `drafting_note`/`running_safety_sensors` per iteration
15. `test_doc_workflow.py`: a failing `report_progress` activity does NOT fail the workflow (draft still persists, result PASS)

**D. `apps/ui-playground` (vitest)**
16. new `lib/__tests__/harness-progress.test.ts`: reducer classifies progress events / heartbeats / closed / invalid payloads; normalizes stages defensively
17. `components/__tests__/review-panel.test.tsx`: generating + live stages → stage checklist rendered (completed/active markers); generating + no events → static fallback text remains

### File creation/modification order

1. `packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts` — add `HarnessProgressRequest` + event/ack types (+ dto barrel already wildcard)
2. `packages/applications/src/services/consultation/harness/harness-progress.service.ts` + `harness-progress.service.module.ts` (+ barrel `index.ts`)
3. `apps/api/src/modules/consultation/harness-internal.controller.ts` — POST progress route
4. `apps/api/src/modules/consultation/consultation.controller.ts` — SSE relay route; `consultation.module.ts` — module import
5. `apps/harness/src/harness/services/api_client.py` — `report_progress`
6. `apps/harness/src/harness/temporal/models.py` — `ReportProgressInput`/`ReportProgressResult` + stage catalog
7. `apps/harness/src/harness/temporal/activities.py` — `report_progress` activity (+ `DOCUMENT_ACTIVITIES`)
8. `apps/harness/src/harness/temporal/workflows.py` — `_report_progress` helper + 6 emission points
9. `apps/harness/src/harness/tests/unit/temporal/_harness_stubs.py` — progress stub + recorder
10. `apps/ui-playground/src/features/clinical-workspace/` — `types.ts`, `constants.ts`, `api/clinical-workspace.api.ts`, `lib/harness-progress.ts`, `hooks/use-harness-progress.ts`, `components/review-panel.tsx`

### Verification criteria

- `pnpm py:harness:test` (scoped: temporal + services tests) green
- Root vitest scoped runs for `packages/applications` harness tests + `apps/api` consultation controller tests green
- `pnpm --filter @arcaai/ui-playground test` (scoped) + `pnpm --filter @arcaai/ui-playground type-check` green
- `pnpm build --filter @arcaai/applications` and `pnpm build:api` green
- `ReadLints` clean on modified files
- NOT in scope: live end-to-end verification (requires the concurrently-repaired dev environment + a real mic consult); the manual procedure is documented in §5

## 4. Implementation Summary

Implemented exactly per the plan (no deviations from §2/§3; one small refinement noted below). All 17 planned tests written RED-first and turned GREEN; full suites + builds green.

### What was built

**`packages/applications` (service layer — Redis only, no Prisma):**
- `HarnessProgressService` — `reportProgress(consultationId, dto)` folds each stage event into the accumulated full-state event (prior snapshot read from Redis; earlier stages → `completed`, re-emitted stage → `active` + `attempt`+1 with later stages reset to `pending`; terminal `completed` stage → all completed + `closed: true`), stores the snapshot (`consultation:harness-progress:{id}:last`, `setex` 3600s) and publishes the identical JSON on `consultation:harness-progress:{id}`. Best-effort: any Redis failure resolves `{ ok: false }` (warn-logged), never throws. `subscribeToProgress(consultationId)` returns the SSE `Observable`: snapshot replay → channel relay → 15s heartbeats, completing on the terminal `closed` event (the `takeWhile` sits on the **merged** stream so the infinite heartbeat can't keep the stream open) and unsubscribing from the channel on teardown.
- `HarnessProgressServiceModule` (RedisCacheModule + RedisSubscriberService wiring), exported via the harness barrel.
- DTOs in `dto/harness-internal.dto.ts`: `HarnessProgressRequest` (validated: `tenantId`/`stage` required; `jobId`/`label`/`ordinal`/`total` optional), `HarnessProgressAck`, `HarnessProgressEventDto`/`HarnessProgressStageDto`, `HARNESS_PROGRESS_TERMINAL_STAGE`.

**`apps/api` (thin controllers):**
- `HarnessInternalController` — new `POST internal/harness/consultations/:id/progress` (effective `/api/v1/internal/harness/...`), behind the existing class-level `HarnessServiceTokenGuard` + `@Public()`; one-line delegation to `HarnessProgressService.reportProgress`.
- `ConsultationController` — new `GET consultations/:id/harness-progress/stream` `@Sse()` route mirroring the live-summary stream's auth exactly: `@TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })` + `@StreamScope({ namespace: 'consultation_harness_progress', param: 'id' })`; delegates to `subscribeToProgress`.
- `ConsultationModule` imports `HarnessProgressServiceModule`.

**`apps/harness` (Python — Temporal):**
- `models.py` — `HARNESS_PROGRESS_STAGES` catalog (5 stages, §2 table), `HARNESS_PROGRESS_TERMINAL_STAGE/_LABEL`, `ReportProgressInput`, `ReportProgressResult`.
- `api_client.py` — `report_progress(...)` POSTs the camelCase stage event (None fields pruned) with `X-Service-Token`; raises `ApiServiceError` like its siblings (the *activity* is the swallowing layer).
- `activities.py` — `report_progress` activity: forwards via a dedicated `_progress_api_client` (5s HTTP timeout) and swallows **all** exceptions (`reported=False`, warn-logged). Registered in `DOCUMENT_ACTIVITIES` (worker picks it up automatically).
- `workflows.py` — `_report_progress` helper (`start_to_close_timeout=10s`, `maximum_attempts=1`, `try/except ActivityError: pass`) + six emission points: before policy/NER (`extracting_information`), before retrieval (`assembling_context`), top of each regen-loop iteration (`drafting_note`), before each sensor pass (`running_safety_sensors`), before `persist_draft` (`finalizing_draft`), and after the draft persists (terminal `completed`). The gate/sign-off wait is intentionally outside the feed.

**`apps/ui-playground` (clinical workspace):**
- `lib/harness-progress.ts` — pure `reduceHarnessProgressMessage` (event / closed / heartbeat / invalid) + defensive `normalizeHarnessProgressEvent` (drops malformed stage entries, defaults label/ordinal/attempt, coerces unknown statuses to `pending`, sorts by ordinal).
- `hooks/use-harness-progress.ts` — mirrors `useLiveSummaryStream`: one-shot stream ticket (`consultation_harness_progress:<id>`) → `EventSource`; full-state events replace local state; terminal event closes; any failure degrades silently to "no stages" (the panel keeps its fallback).
- `constants.ts` / `api/clinical-workspace.api.ts` — `harnessProgressScope`, `harnessProgressStream` endpoint, `buildHarnessProgressStreamUrl`.
- `components/review-panel.tsx` — subscribes only while `!noteContextItemId && draftStatus === 'generating'`; renders the live checklist (✓ emerald check = completed, spinner = active with "pass N" on regen attempts, dim circle = pending) inside the same `review-generating` card, and keeps the exact static "Generating the SOAP draft…" block when no events have arrived.

Refinement vs. the live-summary original: the relay's `takeWhile(closed)` is applied to the merged (relay + heartbeat) stream so the SSE observable actually **completes** on the terminal event instead of idling on heartbeats until client disconnect.

### Files created/modified

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts` | + progress DTOs/ack/event types + terminal-stage constant |
| `packages/applications/src/services/consultation/harness/harness-progress.service.ts` | **new** — fold/snapshot/publish + SSE relay |
| `packages/applications/src/services/consultation/harness/harness-progress.service.module.ts` | **new** — DI module |
| `packages/applications/src/services/consultation/harness/index.ts` | + barrel exports |
| `packages/applications/src/services/consultation/harness/__tests__/harness-progress.service.test.ts` | **new** — 9 tests (A1–A8 + init-failure) |
| `apps/api/src/modules/consultation/harness-internal.controller.ts` | + `POST consultations/:id/progress` |
| `apps/api/src/modules/consultation/consultation.controller.ts` | + `GET :id/harness-progress/stream` SSE route + DI |
| `apps/api/src/modules/consultation/consultation.module.ts` | + `HarnessProgressServiceModule` import |
| `apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` | + 2 progress-route tests |
| `apps/api/src/modules/consultation/__tests__/consultation.controller.harness-progress.test.ts` | **new** — 4 SSE route/metadata tests |
| `apps/harness/src/harness/temporal/models.py` | + stage catalog + `ReportProgressInput`/`Result` |
| `apps/harness/src/harness/services/api_client.py` | + `report_progress` + `ReportProgressResponse` |
| `apps/harness/src/harness/temporal/activities.py` | + `report_progress` activity + `_progress_api_client` + registration |
| `apps/harness/src/harness/temporal/workflows.py` | + `_report_progress` helper + 6 emission points |
| `apps/harness/src/harness/tests/unit/services/test_api_client.py` | + 3 `report_progress` tests |
| `apps/harness/src/harness/tests/unit/temporal/test_activities.py` | + 2 activity tests |
| `apps/harness/src/harness/tests/unit/temporal/test_doc_workflow.py` | + 3 workflow progress tests |
| `apps/harness/src/harness/tests/unit/temporal/_harness_stubs.py` | + `report_progress` stub + `progress_fails`/`progress_inputs` |
| `apps/ui-playground/src/features/clinical-workspace/lib/harness-progress.ts` | **new** — reducer/normalizer |
| `apps/ui-playground/src/features/clinical-workspace/lib/__tests__/harness-progress.test.ts` | **new** — 6 reducer tests |
| `apps/ui-playground/src/features/clinical-workspace/hooks/use-harness-progress.ts` | **new** — SSE hook |
| `apps/ui-playground/src/features/clinical-workspace/constants.ts` | + scope + endpoint |
| `apps/ui-playground/src/features/clinical-workspace/api/clinical-workspace.api.ts` | + stream-URL builder |
| `apps/ui-playground/src/features/clinical-workspace/components/review-panel.tsx` | + live checklist in the generating state (static fallback kept) |
| `apps/ui-playground/src/features/clinical-workspace/components/__tests__/review-panel.test.tsx` | + hook mock + 3 checklist/fallback tests |

(`types.ts` ended up untouched — the progress types live in `lib/harness-progress.ts`, self-contained like the other lib modules.)

### Test & build evidence (actual outputs, 2026-06-10)

- applications (scoped): `Test Files 3 passed (3) / Tests 35 passed (35)`; full package: `Test Files 211 passed | 1 skipped / Tests 4955 passed | 4 skipped`
- api (full): `Test Files 1 failed | 97 passed | 2 skipped / Tests 1 failed | 1716 passed | 4 skipped` — the 1 failure is **pre-existing** in `src/modules/streaming/__tests__/transcription-job.controller.test.ts` (pipelineId validation; file untouched by this task, fails identically before the change)
- harness (full unit suite): `476 passed in 18.14s`; `ruff check`: `All checks passed!`; `mypy`: `Success: no issues found in 75 source files`
- ui-playground: feature scope `Test Files 20 passed (20) / Tests 156 passed (156)`; `type-check`: only 3 **pre-existing** errors in `src/features/admin/{jobs,queues}` (files untouched by this task); clinical-workspace files clean
- builds: `pnpm build --filter @arcaai/applications` → `7 successful`; `pnpm build:api` → `8 successful`
- ReadLints on all modified TS/Python paths: no linter errors

## 5. Live verification procedure (manual, post-merge)

Prereqs: dev stack up (API :8868, harness :8866 + its Temporal worker, SMR/NLP, Redis), working auth, UI :5175.

1. Open the clinical workspace, start a consultation with the harness pipeline metadata, record a short consult (mic), then **stop recording**. The page switches to the Review tab in the `generating` state.
2. **Expected UI:** within ~1–2s the static "Generating the SOAP draft…" placeholder is replaced by the live checklist. Stages tick through: *Extracting key information → Assembling context → Drafting the note → Running safety sensors → Finalizing the draft* — completed ones get a green ✓, the current one a spinner. If the gate demands a regen, "Drafting the note" re-activates and shows "pass 2". When the draft persists, the existing readiness poll flips the panel to the review screen.
3. **Expected SSE (observable directly):** mint a ticket `POST /api/v1/auth/stream-ticket {"scope":"consultation_harness_progress:<consultationId>"}` then `curl -N "http://localhost:8868/api/v1/consultations/<consultationId>/harness-progress/stream?ticket=<ticket>"` → full-state JSON events (schema in §2), interleaved `{"type":"heartbeat",…}` every 15s, final event has every stage `completed` and `"closed": true`, after which the stream ends.
4. **Late join:** open the stream after stages have run → the first message is the accumulated snapshot.
5. **Fallback:** stop the API→Redis path (or run with the progress route 500ing) → the workflow still completes and the UI shows the static placeholder the whole time (harness worker logs `harness.report_progress.failed` warnings).
6. Confirm in harness worker logs that a progress failure never appears as a workflow failure (no retry storms: 1 attempt, 10s cap per stage event).

## 6. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Initial implementation (all four layers + tests), status → Completed | see Implementation Summary |
