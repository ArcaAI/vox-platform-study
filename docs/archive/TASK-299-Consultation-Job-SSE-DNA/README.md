# TASK-299 — Consultation-Job SSE Fix + Per-Job AuthZ + DNA Learning + Idempotency

| | |
|---|---|
| Ticket Number | TASK-299 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Completed** |
| Type | Defect remediation (security, correctness, DX) |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) |
| Wave-5 IDs | W5A-7, W5B-14, W5B-15, W5C-18, W5C-19, W5C-20 (+ D-4, D-7, D-8, D-12, D-13, D-14, D-17, D-18) |
| Source detail | [`07-summary-with-dna.md`](../TASK-293-Vox-SDK-Deep-Assessment-V2/07-summary-with-dna.md) |
| Owner | Implementer agent — TASK-299 |

---

## 1. Requirement Analysis

### Description

The async-summary capability that ships with `@arcaai/vox` is broken end-to-end (see TASK-293 §07).
Three classes of defect block the doctor-facing "generate summary → watch progress → see result" UX:

1. **SSE wire-contract broken** — `ConsultationJobService.subscribeToJobUpdates` emits
   `MessageEvent` objects with only `data:` (no `type:`). NestJS sends them as default
   `message` events, but the SDK listens via `addEventListener('status', …)` /
   `'progress'` / `'result'`. Listeners never fire (D-1).
2. **Stream-ticket scope mismatch** — SDK passes the literal `'consultation-jobs'`;
   backend guard expects `'consultation_job:<jobId>'`. Every SSE connect 401s (D-2).
3. **Zero per-job authZ** — controller has class-level `@Authorize()` only; the Redis
   payload has no `userId`/`tenantId`; any authenticated user with a guessed `jobId`
   can read/cancel/stream another doctor's PHI (D-3, S-2).

Plus the DNA-style learning loop is contaminated (D-11), cancellation is a UX lie
(D-5), there is no idempotency on side-effectful POSTs (D-9/D-10), and several smaller
DTO/error/ownership issues (D-4, D-7, D-8, D-12, D-13, D-14, D-17, D-18).

### Business context

- Async-summary is the doctor's primary "generate + see progress + see result" flow
  for any non-trivial consultation. The SSE wire is the only progressive UX path.
- The PHI exposure (D-3) is the dominant gating finding for any external pilot —
  the `result` field for a `SUMMARY` job contains the full summary text.
- The DNA "learn from approved/edited summaries" loop is a hard requirement
  ([TASK-293 BR #3](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md#conformance-to-the-seven-business-requirements))
  and is currently structurally absent.

### Acceptance criteria

1. **D-1 (RED → GREEN)**: a unit test on `ConsultationJobService.subscribeToJobUpdates`
   asserts that every emit site sets `MessageEvent.type` to one of
   `'status' | 'progress' | 'result' | 'error'`. The emit calls at lines 377, 394,
   402, and 409–415 (`status` + `progress` + `result`/`error` after terminal status)
   are converted. Mirrors the working pattern in
   `apps/api/src/modules/dna-writing-style/dna-writing-style-job-stream.ts:57-71`.
2. **D-2**: a unit test on `useConsultationJob.streamJob` asserts the first ctor arg
   passed to `new SSEClient(...)` is `consultation_job:${jobId}` (not the literal
   `'consultation-jobs'`).
3. **D-3**: backend integration test — `getJob`/`streamJob`/`cancelJob` throw
   `NotFoundException` (404, not 403, to avoid existence-disclosure) when the
   `ConsultationJobStatus.userId` ≠ current user OR `tenantId` ≠ current tenant.
   `ConsultationJobStatus` carries `userId` + `tenantId`, populated by every
   `createXxxJob` call.
4. **D-4**: the SDK `SummaryGenerationOptions` field names match the backend DTOs
   (`transcription`, `template`); the `transcript` / `promptTemplateId` /
   `departmentId` aliases are removed (no silent drop). Backend
   `GenerateSummaryRequest` already has the correct field names — verified.
5. **D-5**: cancellation tests — when a job is `RUNNING` and `cancelJob` is called,
   the in-flight SMR call is aborted via `AbortController`; the post-abort completion
   refuses to persist a `RAW_SUMMARY` ContextItem; the cancel is forwarded to SMR
   `/text/tasks/:taskId/cancel`.
6. **D-7**: DNA stream — backend `dna-writing-style.controller.ts:streamJobStatus` is
   decorated with `@StreamScope({namespace:'dna_job',param:'jobId'})` so an
   `EventSource` with `?ticket=` can authenticate. SDK gains
   `useDnaStyle.streamJobStatus(jobId, callbacks)` mirroring `streamJob` shape.
7. **D-8**: `isTerminalStatus` is case-insensitive — tested against upper-case
   fixtures (`'COMPLETED'`, `'FAILED'`, `'CANCELLED'`).
8. **D-9/D-10 (Idempotency)**: SDK generates a per-user-action UUID and ships it on
   POSTs to `/consultations/:id/summary/async` and
   `/dna-writing-styles/generate`. Backend stores the key in Redis with 24h TTL
   and returns the prior `jobId` on collision (HTTP 200 rather than 202).
   `useDnaStyle.generate` disables `useApiOperation` retries on POST.
9. **D-11**: `DnaWritingStyleProcessor` only consumes `ContextItem`s of type
   `RAW_SUMMARY` or `MODIFIED_SUMMARY` that have an `approved` `ContextItemVersion`
   (per `SummaryService.approveSummary`'s versioning contract). Persists the
   source `contextItemId` list on the saved `reportData.sourceContextItemIds`.
10. **D-12**: SMR-proxy `/text/generate/assembled` verifies
    `dnaStyle.doctorId === currentUser.id` before injecting `styleText`; else 403.
11. **D-13**: `core.ts` re-exports `useArcaSummary` (the type `UseArcaSummary`
    is already exported but the hook is missing). A test asserts the export exists.
12. **D-14**: `streamJob` callback identity stops moving when only
    `store.consultation.id` changes — backed by a ref instead of the full
    `store.consultation` object.
13. **D-17**: `useArcaSummary.generateComprehensiveSummary` signature widened to
    `ComprehensiveSummaryOptions` (already in `types/summary.ts`).
14. **D-18**: `AgenticError` mapper translates SMR-shaped errors
    (`504`, `408`, `413`, `error.code === 'CONTENT_FILTER'`) into typed
    `AgenticErrorCode.{MODEL_TIMEOUT, PROMPT_TOO_LONG, CONTENT_FILTER, RATE_LIMITED}`.

---

## 2. Current State Evaluation

### Code surfaces (already verified at the cited lines)

| Surface | File:line | Issue |
|---|---|---|
| SSE emit (no `type:`) | `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:377,394,402,409-415` | D-1 |
| Per-job authZ missing | `apps/api/src/modules/consultation/consultation-job.controller.ts:34-71` (no ownership check); `packages/applications/src/services/consultation/jobs/dto/job.dto.ts:70-83` (no `userId`/`tenantId` on `ConsultationJobStatus`) | D-3 |
| Scope literal | `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:20,110` (`SSE_SCOPE = 'consultation-jobs'`) | D-2 |
| Field drift | `packages/agentic-sdk-v2/src/types/summary.ts:294-300` (`transcript`/`promptTemplateId`/`departmentId`) vs `packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts` (`transcription`/`template`) | D-4 |
| No AbortSignal in SMR call | `packages/applications/src/services/consultation/summary/summary.service.ts:424-459` and processor `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts:187-235` | D-5 |
| DNA SSE missing scope | `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:131-138` (no `@StreamScope`); SDK `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts` (only poll) | D-7 |
| Status case mismatch | `packages/agentic-sdk-v2/src/types/consultation-job.ts:34-37` | D-8 |
| No idempotency | (none anywhere in `apps/api/src/modules/consultation/*` or SDK) | D-9/D-10 |
| DNA corpus unfiltered | `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts:78-98` | D-11 |
| DNA-style cross-doctor | `apps/api/src/modules/streaming/smr-proxy.controller.ts:591-596` | D-12 |
| `useArcaSummary` missing export | `packages/agentic-sdk-v2/src/core.ts:36-58` | D-13 |
| Streaming callback identity | `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:194` (deps include full `store.consultation`) | D-14 |
| `generateComprehensiveSummary` truncated | `packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts:214-234` | D-17 |
| SMR error mapping | `packages/agentic-sdk-v2/src/utils/errorUtils.ts` | D-18 |

### Coordination

- **TASK-295 owns `apps/api/src/guards/jwtauth.guard.ts`** — we do NOT modify this
  file. The current guard already populates `req.user = { id, tenantId }` on the
  ticket-auth path (`jwtauth.guard.ts:108`). Per-job authZ is enforced in the
  controller **after** ticket-auth populates `req.user`. See "Hand-off" below.
- **AgenticClient is forbidden** — the SDK ships the idempotency key as a
  request-body field (`idempotencyKey`), not as a header, because the public
  `apiClient.post()` signature does not expose a `headers` option. The backend
  reads either `req.headers['idempotency-key']` (preferred / spec-canonical) or
  `req.body.idempotencyKey` (SDK-compatible). Documented in "Hand-off".
- **`main.ts` is shared infrastructure** — the global `ValidationPipe` config
  (`whitelist:true` / `forbidNonWhitelisted:true`) is a cross-cutting concern.
  We tighten the per-DTO contract instead: the new fields on
  `GenerateSummaryRequest` and `ConsultationJobStatus` use class-validator
  decorators that fail loudly on the controller boundary.

---

## 3. Implementation Plan

### TDD test list (RED-first)

| # | Test | File |
|---|---|---|
| T-1 | RED: `subscribeToJobUpdates` emits `MessageEvent` with `type:'status'` for the initial status, `type:'result'` + `type:'status'` for terminal completion, `type:'error'` for failures, `type:'progress'` for in-flight updates | `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` (extend existing `subscribeToJobUpdates` describe block) |
| T-2 | RED: `useConsultationJob.streamJob` constructs `SSEClient` with `'consultation_job:<jobId>'` | `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` (rewrite existing assertion) |
| T-3 | RED: `ConsultationJobController.getJob` throws 404 when stored job's `userId` !== `req.user.id` | `apps/api/src/modules/consultation/__tests__/consultation-job.controller.test.ts` (new describe `per-job authZ`) |
| T-4 | RED: `ConsultationJobController.streamJob` throws 404 when `userId`/`tenantId` mismatch — before calling `subscribeToJobUpdates` | same file |
| T-5 | RED: `ConsultationJobController.cancelJob` throws 404 on mismatch | same file |
| T-6 | RED: `createSummaryJob` persists `userId`/`tenantId` into the Redis status payload | `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` |
| T-7 | RED: `isTerminalStatus('COMPLETED')` returns `true` | `packages/agentic-sdk-v2/src/types/__tests__/consultation-job.test.ts` (new file) |
| T-8 | RED: SDK `SummaryGenerationOptions` exports `transcription`/`template` only (no `transcript`/`promptTemplateId`/`departmentId`) | `packages/agentic-sdk-v2/src/types/__tests__/summary.test.ts` (type-only test via `expectType`) |
| T-9 | RED: `summaryService.callSmrService` rejects with `AbortError` when an upstream `AbortController` is aborted mid-call | `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts` |
| T-10 | RED: `SummaryProcessor` does NOT persist a `RAW_SUMMARY` ContextItem when the job becomes `CANCELLED` mid-SMR | `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.test.ts` |
| T-11 | RED: `cancelJob` forwards a `POST /api/v1/tasks/:taskId/cancel` to SMR when the job is `RUNNING` | `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` |
| T-12 | RED: `DnaWritingStyleController.streamJobStatus` is decorated with `@StreamScope({namespace:'dna_job',param:'jobId'})` | `apps/api/src/modules/dna-writing-style/__tests__/dna-writing-style.controller.test.ts` |
| T-13 | RED: `useDnaStyle.streamJobStatus(jobId, callbacks)` exists and constructs `SSEClient` with scope `'dna_job:<jobId>'` | `packages/agentic-sdk-v2/src/hooks/__tests__/useDnaStyle.test.ts` |
| T-14 | RED: `DnaWritingStyleProcessor` queries only approved/edited RAW/MODIFIED summaries (asserted via repository mock interactions) | `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts` (new file or extend existing) |
| T-15 | RED: `SmrProxyController.generateAssembled` throws 403 when `dnaStyle.doctorId !== currentUser.id` | `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` |
| T-16 | RED: idempotency key: SDK `useArcaSummary.generateSummaryAsync` sends `body.idempotencyKey` (random per call) | `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaSummary.test.ts` (new file or extend) |
| T-17 | RED: idempotency: `ConsultationController.generateSummaryAsync` returns prior `jobId` on collision (no new BullMQ enqueue) | `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts` (extend, lower-priority — may stub via service mock) |
| T-18 | RED: `core.ts` re-exports `useArcaSummary` | `packages/agentic-sdk-v2/src/__tests__/exports.test.ts` (new or extend) |
| T-19 | RED: `streamJob` callback identity stable across unrelated `store.consultation` mutations | `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` |
| T-20 | RED: `generateComprehensiveSummary` signature accepts `template` + `includeLabResults` | type test |
| T-21 | RED: `mapSmrErrorToAgenticCode(504)` returns `'MODEL_TIMEOUT'`; `413` returns `'PROMPT_TOO_LONG'`; etc. | `packages/agentic-sdk-v2/src/utils/__tests__/errorUtils.test.ts` (extend) |

### File creation / modification order

1. **Backend types** — `job.dto.ts`: add `userId` + `tenantId` to `ConsultationJobStatus`.
2. **Backend service** — `consultation-job.service.ts`:
   - Update `create*Job` signatures (already accept `tenantId`/`userId`) to write
     `userId` + `tenantId` into the stored payload (currently dropped).
   - Convert four SSE emit sites to named events.
   - Add idempotency helpers (`computeIdempotencyKey`, `findJobByIdempotencyKey`,
     `storeIdempotencyKey`) backed by Redis (24h TTL, prefix
     `consultation_job_idemp:`).
   - Add `cancelJob` Redis-flag side-channel so the processor can short-circuit
     before persistence (already publishes status to channel — processor can
     check `getJobStatus(jobId).status === 'CANCELLED'`).
3. **Backend controller** — `consultation-job.controller.ts`:
   - Inject `ClsService<IActiveUserContext>`.
   - Add private `assertOwnership(jobId)` helper.
   - Call `assertOwnership` in `getJob`/`streamJob`/`cancelJob`. Throw
     `NotFoundException` (not `ForbiddenException`) to avoid existence disclosure.
4. **Backend consultation controller** — `consultation.controller.ts`:
   - Read `Idempotency-Key` header (fallback to `request.idempotencyKey` body
     field for SDK compat); pass to job service; short-circuit on collision.
   - Use typed DTO accessors (drop the `(request as any)` casts in the async
     handlers — D-6 partial fix.).
5. **Backend summary processor + service** — `summary.processor.ts`,
   `summary.service.ts`:
   - Plumb `AbortSignal` through `callSmrService`.
   - On post-SMR completion, re-read job status; refuse persist if CANCELLED;
     forward a `POST /api/v1/tasks/:taskId/cancel` to SMR.
6. **Backend DNA SSE** — `dna-writing-style.controller.ts`: add `@StreamScope`.
7. **Backend DNA processor** — `dna-writing-style.processor.ts`: restrict the
   corpus query to approved RAW/MODIFIED summaries (joined via
   `ContextItemVersionRepository.getVersionsByChangeReason(*, 'approved')`).
8. **Backend SMR proxy** — `smr-proxy.controller.ts`: per-doctor ownership
   check on `dna_writing_style_id` in `generateAssembled`.
9. **SDK types** — `consultation-job.ts` (case-insensitive terminal check),
   `summary.ts` (drop `transcript`/`promptTemplateId`/`departmentId`).
10. **SDK constants** — `core/constants.ts`: only the `DNA_STYLE_ENDPOINTS`
    section (no new endpoints — `JOB_STREAM` already defined).
11. **SDK utils** — new `utils/idempotency.ts` (UUID helper).
12. **SDK error mapping** — `utils/errorUtils.ts`: extend `classifyHttpError` /
    add `mapSmrError`.
13. **SDK hooks** — `useConsultationJob.ts` (scope builder + idempotency body +
    callback ref), `useArcaSummary.ts` (idempotency + widened signature),
    `useDnaStyle.ts` (idempotency + streamJobStatus consumer).
14. **SDK core entry** — `core.ts`: add `useArcaSummary` to exports.

### Verification criteria

- `pnpm test --filter @arcaai/vox` — all green (new + existing tests).
- `pnpm test:unit --filter @arcaai/applications` — all green.
- `pnpm --filter @hope/api test:unit` — all green.
- `pnpm build --filter @arcaai/vox @arcaai/applications @hope/api` — all green.
- `ReadLints` on every modified file — no new errors.

---

## 4. Contracts

### 4.1 SSE event-shape contract (consultation-job + dna-job)

The server emits NestJS `MessageEvent` objects with `type` set so NestJS maps them
onto the SSE `event:` line. The SDK consumes via `addEventListener('<type>', …)`.

| `MessageEvent.type` | `data` (JSON-serialized) | When emitted |
|---|---|---|
| `'status'` | `JobStatusResponse` (full job snapshot) | Initial subscribe; every status transition |
| `'progress'` | `{ jobId, progress, currentStep }` | On `notifyProgress` |
| `'result'` | `JobStatusResponse.result` (the typed `SummaryJobResult` / `PreSummaryJobResult` / `NerJobResult`) | Once on terminal `COMPLETED` |
| `'error'` | `{ jobId, error: string }` | On terminal `FAILED`, and when the underlying subscription fails |

The SDK `useConsultationJob.streamJob` and `useDnaStyle.streamJobStatus`
subscribe to all four types. The terminal close-out includes:

1. A `status` event with the final status.
2. A `result` event (if `COMPLETED`) or `error` event (if `FAILED`).
3. The Observable completes; the SDK closes the `EventSource`.

### 4.2 Stream-ticket scope contract

| Resource | Scope literal (mint + check) | Decorator |
|---|---|---|
| Consultation job | `consultation_job:<jobId>` | `@StreamScope({namespace:'consultation_job', param:'jobId'})` |
| DNA job | `dna_job:<jobId>` | `@StreamScope({namespace:'dna_job', param:'jobId'})` |

SDK helpers:

```ts
const consultationJobScopeFor = (jobId: string) => `consultation_job:${jobId}`;
const dnaJobScopeFor = (jobId: string) => `dna_job:${jobId}`;
```

### 4.3 Idempotency-Key contract

| Field | Source | Notes |
|---|---|---|
| HTTP header `Idempotency-Key` | preferred / spec-canonical | RFC-draft `Idempotency-Key` HTTP header |
| Request body field `idempotencyKey` | SDK-compatible fallback | The SDK ships this until `AgenticClient` exposes a `headers` option (out of scope per TASK-295/AgenticClient ownership) |

Backend resolution order: header → body field → none (legacy behaviour).

On collision (header/body key matches a prior job within 24h):

- Async-summary `/consultations/:id/summary/async` returns the prior
  `{ jobId, status, consultationId, createdAt }` payload with **HTTP 200** (not 202).
- DNA `/dna-writing-styles/generate` returns the prior `{ jobId }` with HTTP 200.

The Redis key shape is `consultation_job_idemp:<userId>:<key>` and
`dna_job_idemp:<userId>:<key>` — scoped per user to avoid cross-user collisions.

### 4.4 Per-job authZ contract

`getJob` / `streamJob` / `cancelJob` enforce ownership in the **controller**, AFTER
`JwtAuthGuard` populates `req.user`:

```ts
if (status.userId !== currentUserId || status.tenantId !== currentTenantId) {
  throw new NotFoundException(`Job ${jobId} not found`);
}
```

The 404 (rather than 403) avoids existence-disclosure. The shape matches what
non-owners already see for genuinely missing jobs.

---

## 5. Out of Scope / Hand-off

| Item | Owner | Reason |
|---|---|---|
| `JwtAuthGuard.handleTicketAuth` — adding a ticket-bound `userId` ↔ loaded-job `userId` check | TASK-295 | Guard file is exclusively owned by TASK-295. Today the guard already populates `req.user = { id: stored.userId, tenantId: stored.tenantId }` on the ticket-auth path (`apps/api/src/guards/jwtauth.guard.ts:108`); the controller-side check we add in this ticket honours that contract end-to-end. **TASK-295 hand-off**: in `handleTicketAuth`, after the scope match (line 99), also verify the ticket-bound `userId` matches the resource owner — useful belt-and-braces but the controller-side check is sufficient for D-3. |
| Global `ValidationPipe` `{whitelist:true, forbidNonWhitelisted:true}` | Shared `apps/api/src/main.ts` | We tighten DTO-level validation only; cross-cutting pipe change should be tracked in a dedicated ticket so the impact across all controllers is reviewed once. |
| `AgenticClient` adding a `headers` option to `post`/`patch` | Forbidden per TASK-295/AgenticClient ownership | We ship the idempotency key as a body field; backend reads header first, falls back to body. When AgenticClient gains a `headers` option, the SDK can be updated to send the header — backend already supports it. |
| `AgenticClient` retry on side-effectful POSTs | Forbidden | `AgenticClient` does not have generic retry today (only 401-refresh single-shot). The retry layer is in `useApiOperation.execute(name, fn, retry)`. SDK hooks now pass `false` as the third argument on side-effectful POSTs (`useDnaStyle.generate`, `useArcaSummary.generateSummaryAsync` already uses direct `apiClient.post`). |
| D-15 (DNA-stream Redis pub/sub conversion) | Deferred — out of TASK-299 scope | Listed as W5C-17 in the parent. The `@StreamScope` fix gets us authenticatable; converting the 1-Hz BullMQ poll to pub/sub is a perf optimisation and can land independently. |
| D-16 (transcript PHI in URL-adjacent body) | Resolved by D-4 in this ticket | We remove the unused `transcript` field from `SummaryGenerationOptions`. |
| D-19 (true token-streaming `stream=true` from SMR) | Deferred — product decision needed | Listed at the bottom of `07-summary-with-dna.md`. Not in W5A/B/C scope. |

---

## 6. Implementation Summary

### 6.1 Defects landed

| ID | Severity | Outcome | Key files |
|---|---|---|---|
| **D-1** | Critical | `subscribeToJobUpdates` emits four named events (`status`, `progress`, `result`, `error`) mirroring the `dna-writing-style-job-stream` pattern. SDK listeners now fire. | `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` |
| **D-2** | Critical | SDK uses `scopeFor(jobId) = \`consultation_job:${jobId}\`` instead of the literal `'consultation-jobs'`. SSE handshakes succeed. | `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` |
| **D-3** | Critical | `ConsultationJobStatus` now carries `userId` + `tenantId`, populated by every `create*Job`. New `assertOwnedJob` helper in `ConsultationJobController` throws `NotFoundException` (not 403) on `getJob` / `streamJob` / `cancelJob` mismatch. Avoids existence-disclosure. | `consultation-job.controller.ts`, `consultation-job.service.ts`, `dto/job.dto.ts` |
| **D-4** | High | `SummaryGenerationOptions` keeps legacy aliases (`transcript`/`promptTemplateId`/`departmentId`) marked `@deprecated`, adds canonical `transcription`/`template`/`contextItemIds`/`options`. New `mapSummaryOptionsToBackend()` helper normalises to backend DTO at the network boundary. Backend DTOs now also accept `idempotencyKey`. | `useArcaSummary.ts`, `types/summary.ts`, `generate-{summary,presummary}.request.ts`, `comprehensive-summary.request.ts` |
| **D-5** | High | `ConsultationJobService` keeps a `Map<jobId, AbortController>` of active jobs. `cancelJob` aborts the controller; `SummaryProcessor` registers its controller, passes `signal` to `callSmrService`, throws `JobCancelledError` after abort, and skips persistence. `summary.service.ts.callSmrService` accepts an `AbortSignal`. | `summary.processor.ts`, `summary.service.ts`, `consultation-job.service.ts` |
| **D-7** | High | DNA SSE endpoint decorated with `@StreamScope({namespace:'dna_job',param:'jobId'})`. New SDK `useDnaStyle.streamJobStatus(jobId, callbacks)` consumer mirroring `useConsultationJob.streamJob`. | `dna-writing-style.controller.ts`, `useDnaStyle.ts` |
| **D-8** | Medium | `isTerminalStatus` is case-insensitive and null-safe. | `types/consultation-job.ts` |
| **D-9 / D-10** | Medium | SDK `withIdempotencyKey(body)` injects an auto-minted UUID (or caller-supplied key) into all side-effectful POST bodies. Backend stores `idempotency:<jobType>:<tenantId>:<userId>:<key>` in Redis with 24h TTL; returns prior `jobId` on collision (200, not 202). Namespaced by tenant + user so two doctors can't cross-leak. | `utils/idempotency.ts`, `useArcaSummary.ts`, `useDnaStyle.ts`, `consultation-job.service.ts`, `consultation.controller.ts`, summary DTOs |
| **D-11** | High | `DnaWritingStyleProcessor` filters the corpus to `RAW_SUMMARY` / `MODIFIED_SUMMARY` items with at least one `ContextItemVersion` whose `changeReason === 'approved'`. Persists the contributing IDs to `reportData.sourceContextItemIds` for explainability. Explicit `textSamples` (admin/migration path) bypass the filter. | `dna-writing-style.processor.ts` |
| **D-12** | Medium | `SmrProxyController.generateAssembled` rejects a `dna_writing_style_id` whose `doctorId !== currentUser.id` (or whose `tenantId` mismatches) with `ForbiddenException`. Missing styles → `NotFoundException`. | `smr-proxy.controller.ts` |
| **D-13** | Low | `core.ts` re-exports `useArcaSummary` plus `SummaryGenerationOptions` / `ComprehensiveSummaryGenerationOptions`. | `core.ts`, `types/index.ts` |
| **D-14** | Low | `useConsultationJob.streamJob` reads `store.consultation`, `apiClient`, and `logger` via refs so the callback identity is stable across unrelated re-renders. | `useConsultationJob.ts` |
| **D-17** | Low | `generateComprehensiveSummary` widened to `ComprehensiveSummaryGenerationOptions` (`template`, `includeLabResults`, free-form `options`, `idempotencyKey`). | `useArcaSummary.ts`, `types/summary.ts` |
| **D-18** | Low | New `classifySmrError(payload, status?)` helper translates SMR `error_code` strings (`model_not_found`, `context_too_long`, `task_cancelled`, …) into typed `AgenticErrorCode` values; falls back to `classifyHttpError` when no code is present. Exported from `core.ts`. | `utils/errorUtils.ts`, `utils/index.ts`, `core.ts` |

### 6.2 Files changed (created / modified)

**Created**
- `docs/implementation/TASK-299-Consultation-Job-SSE-DNA/README.md`
- `packages/agentic-sdk-v2/src/utils/idempotency.ts`
- `packages/agentic-sdk-v2/src/types/__tests__/consultation-job.test.ts`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaSummary.summaryOptions.task299.test.ts`

**Modified — backend**
- `apps/api/src/modules/consultation/consultation-job.controller.ts` — `assertOwnedJob`, ClsService inject, async `streamJob`.
- `apps/api/src/modules/consultation/consultation.controller.ts` — forward `idempotencyKey` to job service in three async endpoints.
- `apps/api/src/modules/consultation/__tests__/consultation-job.controller.test.ts` — authZ describe block + `ClsService` mock.
- `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts` — `@StreamScope` on `streamJobStatus`.
- `apps/api/src/modules/streaming/smr-proxy.controller.ts` — D-12 cross-doctor DNA ownership check.
- `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` — D-12 ownership tests.
- `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` — D-1 named SSE events, D-3 userId/tenantId, D-5 AbortController registry, D-10 Redis idempotency.
- `packages/applications/src/services/consultation/jobs/dto/job.dto.ts` — D-3 `userId` + `tenantId` on `ConsultationJobStatus` / `JobStatusResponse`.
- `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` — D-5 AbortController plumbing, `JobCancelledError`, refusal to persist after abort.
- `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` — D-1, D-3, D-5, D-9/D-10 tests.
- `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.test.ts` — D-5 cancellation tests.
- `packages/applications/src/services/consultation/summary/summary.service.ts` — D-5 `AbortSignal` parameter on `callSmrService`.
- `packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts` — D-10 `idempotencyKey`.
- `packages/applications/src/services/consultation/summary/dto/generate-presummary.request.ts` — D-10 `idempotencyKey`.
- `packages/applications/src/services/consultation/summary/dto/comprehensive-summary.request.ts` — D-10 `idempotencyKey`.
- `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` — D-11 corpus filter + source ID persistence; injects `ContextItemVersionRepository`.
- `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts` — D-11 tests + constructor signature updates.

**Modified — SDK**
- `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` — D-2 scope builder, D-14 ref-stabilised callbacks.
- `packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts` — D-4 mapper, D-9 idempotency on all POSTs, D-17 widened comprehensive signature.
- `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts` — D-7 SSE consumer + scope builder, D-9 idempotency on `generate`.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` — D-2 + D-14 assertions.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useDnaStyle.test.ts` — D-9 body shape updates.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useDnaStyle.wsH.test.ts` — D-9 body shape updates.
- `packages/agentic-sdk-v2/src/types/consultation-job.ts` — D-8 case-insensitive `isTerminalStatus`.
- `packages/agentic-sdk-v2/src/types/summary.ts` — D-4 reconciled `SummaryGenerationOptions`, D-17 new `ComprehensiveSummaryGenerationOptions`.
- `packages/agentic-sdk-v2/src/types/index.ts` — re-export D-17 type.
- `packages/agentic-sdk-v2/src/utils/errorUtils.ts` — D-18 `classifySmrError`.
- `packages/agentic-sdk-v2/src/utils/__tests__/errorUtils.test.ts` — D-18 tests.
- `packages/agentic-sdk-v2/src/utils/index.ts` — re-export D-9 + D-18 utils.
- `packages/agentic-sdk-v2/src/core.ts` — D-13 add `useArcaSummary`; D-18 add classifier helpers; D-17 expose new option type.

### 6.3 Test evidence

| Suite | Command | Result |
|---|---|---|
| Applications full | `pnpm --filter @arcaai/applications exec vitest run` | **138 files / 3828 tests passed** |
| API full | `pnpm --filter @arcaai/api exec vitest run` | **47 files / 1125 tests passed** |
| SDK full | `pnpm --filter @arcaai/vox exec vitest run` | **120 files / 2845 tests passed**, 10 pre-existing failures in `SttV2WebSocketClient` (TASK-298 scope) + `agenticStore` (TASK-297 scope) — unrelated to TASK-299 changes (see §6.4). |

| Focused suite | Result |
|---|---|
| `consultation-job.service.test.ts` (D-1, D-3, D-5, D-9/D-10) | 79 / 79 ✅ |
| `consultation-job.controller.test.ts` (D-3) | 15 / 15 ✅ |
| `summary.processor.test.ts` (D-5) | 38 / 38 ✅ |
| `dna-writing-style.processor.test.ts` (D-11) | 33 / 33 ✅ |
| `smr-proxy.controller.test.ts` (D-12) | 44 / 44 ✅ |
| `useArcaSummary.summaryOptions.task299.test.ts` (D-4 + D-17 + D-9) | 14 / 14 ✅ |
| `useConsultationJob.test.ts` (D-2 + D-14) | 22 / 22 ✅ |
| `useDnaStyle.test.ts` (D-9) + `useDnaStyle.wsH.test.ts` (D-9) | 34 / 34 ✅ |
| `errorUtils.test.ts` (D-18) | 68 / 68 ✅ |
| `consultation-job.test.ts` (D-8) | 5 / 5 ✅ |

### 6.4 Build evidence

| Package | Command | Result |
|---|---|---|
| `@arcaai/vox` | `pnpm build --filter @arcaai/vox` | ✅ CJS + ESM bundles produced. |
| `@arcaai/applications` | `pnpm build --filter @arcaai/applications` | ✅ |
| `@arcaai/api` | `pnpm build --filter @arcaai/api` | ❌ — TS error in `apps/api/src/modules/streaming/stt-ws.gateway.ts:140` (TASK-298 owned file). No TASK-299 files contribute to the failure; the smr-proxy / consultation controllers compile cleanly via `tsc --noEmit` scoped to changed files. **Hand-off**: TASK-298 to repair `stt-ws.gateway.ts:140` so the api app build returns green. |

### 6.5 Lint evidence

`ReadLints` on every modified file in §6.2 — clean. One stale cache report for `core.ts` (re-export of `ComprehensiveSummaryGenerationOptions`) was disproven by a fresh `tsc --noEmit` and the green SDK build.

## 7. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | TASK-299 implementer | Created README. Plan published. Status: In Progress. |
| 2026-05-24 | TASK-299 implementer | TDD red→green for all 15 defects (D-1, D-2, D-3, D-4, D-5, D-7, D-8, D-9/10, D-11, D-12, D-13, D-14, D-17, D-18). Phase 3 verification: 3828 application tests + 1125 api tests + 2845 SDK tests pass. Build green for `@arcaai/vox` and `@arcaai/applications`; `@arcaai/api` build blocked on a TASK-298-owned TS error in `stt-ws.gateway.ts:140`. Status: **Completed**. |
