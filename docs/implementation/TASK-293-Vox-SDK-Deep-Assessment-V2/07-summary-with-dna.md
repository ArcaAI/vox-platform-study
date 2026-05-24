# 07 — Summary with DNA Writing Style (backend-handled)

| | |
|---|---|
| Reviewer | A7 |
| Scope | Summarization (sync/async), DNA writing-style learning + apply, async-job streaming |
| Date | 2026-05-24 |
| Predecessor | TASK-262 §01-vox-sdk, §08-api-cross-reference (GAP-01) |
| Status | Findings issued — 2 P0, 4 P1, 6 P2 |

---

## 1. Scope & method

**Surface reviewed**

- SDK
  - `packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts` (+ `__tests__/useArcaSummary.test.ts`)
  - `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts` (+ `useDnaStyle.test.ts`, `useDnaStyle.wsH.test.ts`)
  - `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` (+ `useConsultationJob.test.ts`, `useConsultationJob.autoRefresh.test.ts`)
  - `packages/agentic-sdk-v2/src/hooks/useArca.ts` (summary actions block, L775–L1100)
  - `packages/agentic-sdk-v2/src/core/SSEClient.ts`
  - `packages/agentic-sdk-v2/src/core/constants.ts` — `SUMMARY_ENDPOINTS`, `DNA_STYLE_ENDPOINTS`, `CONSULTATION_JOB_ENDPOINTS`
  - `packages/agentic-sdk-v2/src/types/summary.ts`, `dna.ts`, `consultation-job.ts`
- Backend
  - `apps/api/src/modules/consultation/consultation.controller.ts` (summary endpoints)
  - `apps/api/src/modules/consultation/consultation-job.controller.ts` (job status / cancel / SSE)
  - `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`
  - `apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts`
  - `apps/api/src/modules/dna-writing-style/dna-writing-style-job-stream.ts`
  - `apps/api/src/modules/streaming/smr-proxy.controller.ts`
  - `apps/api/src/modules/auth/auth.controller.ts` (`POST /auth/stream-ticket`)
  - `apps/api/src/guards/jwtauth.guard.ts` (ticket validation path)
  - `apps/api/src/main.ts` (global `ValidationPipe` config)
- Applications / Domain
  - `packages/applications/src/services/consultation/summary/summary.service.ts`
  - `packages/applications/src/services/consultation/summary/chain-summary.service.ts`
  - `packages/applications/src/services/consultation/jobs/consultation-job.service.ts`
  - `packages/applications/src/services/consultation/jobs/dto/job.dto.ts`
  - `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`
  - `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts`
  - `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`
  - `packages/applications/src/services/dna-writing-style/dna-regeneration.scheduler.ts`
  - `packages/applications/src/services/dna-writing-style/dto/generate-dna-report.request.ts`
- Python service (protocol contract only): `apps/smr/src/smr_v2/api/endpoints/{generate,tasks,stream}.py`

**Method**

1. Confirm TASK-262 GAP-01 status by re-reading the new `ConsultationJobController`.
2. Walk the contract end-to-end for the three documented user journeys:
   - sync summary (`POST /consultations/:id/summary`),
   - async summary (`POST /consultations/:id/summary/async` → `GET/PATCH/SSE /consultations/jobs/:jobId`),
   - DNA style generation (`POST /dna-writing-styles/generate` → poll `/jobs/:jobId`).
3. Diff SDK DTO shapes vs backend DTOs (class-validator + `ApiProperty`).
4. Trace the SSE event-name contract on the wire (Nest `MessageEvent.type`/`data` → browser `EventSource` named listeners).
5. Read the global `ValidationPipe` config (only `transform: true`) — silent vs. rejecting unknown fields.
6. Look for ownership/tenant checks on the new job controller and the SMR proxy.
7. Look for idempotency keys, cancellation propagation, audit logging.

All references are `file:line` against the current `main` working tree.

---

## 2. Current architecture

### 2.1 Sync summary (HTTP-only)

```
SDK consumer
  ├─ useArcaSummary.generateSummary(options)            useArcaSummary.ts:62
  ├─ POST /consultations/:id/summary                    constants.ts:74
  │    body: SummaryGenerationOptions { dnaStyleId?, transcript?, promptTemplateId?, ... }
  │
  └─► ConsultationController.generateSummary            consultation.controller.ts:~540
       └─ SummaryService.generateSummary                summary.service.ts:124
            ├─ verify consultation ownership            consultation.controller.ts (verifyConsultationOwnership)
            ├─ assemble prompt (PromptAssemblyService)  summary.service.ts:164
            │    uses request.dnaStyleId, request.template
            ├─ call SMR (HTTP, blocking)                summary.service.ts:175  → SMR /api/v1/generate
            └─ persist RAW_SUMMARY ContextItem + meta   summary.service.ts:189-202
                                                        SysEvent ResourceCreated  summary.service.ts:204
```

### 2.2 Async summary (HTTP init → BullMQ → SSE/poll)

```
SDK
  ├─ useArcaSummary.generateSummaryAsync(options)       useArcaSummary.ts:140
  ├─ POST /consultations/:id/summary/async              constants.ts:88
  │    body: SummaryGenerationOptions
  │    returns 202 { jobId, status:'pending', consultationId, createdAt }
  │
  ├─ useConsultationJob.streamJob(jobId, cb)            useConsultationJob.ts:104
  │    1. POST /auth/stream-ticket { scope:'consultation-jobs' }   SSEClient.ts (TASK-264)
  │    2. EventSource(`/consultations/jobs/:jobId/stream?ticket=…`)
  │    3. SSEClient.onEvent('status'|'progress'|'result', …)
  │
  └─ useConsultationJob.cancelJob(jobId)                 useConsultationJob.ts:86
       PATCH /consultations/jobs/:jobId/cancel

Backend
  ConsultationController.generateSummaryAsync           consultation.controller.ts:590
   └─ ConsultationJobService.createSummaryJob           consultation-job.service.ts (BullMQ enqueue, status in Redis)
       └─ SummaryProcessor.process                      summary.processor.ts
            ├─ updateJobStatus RUNNING                  publishes to redis ch `consultation_job_updates:{jobId}`
            ├─ assemble prompt incl. dnaStyleId
            ├─ POST SMR /api/v1/generate (blocking)     (no streaming token-stream wired back to SDK)
            ├─ persist RAW_SUMMARY ContextItem
            └─ updateJobStatus COMPLETED { result:{contextItemId,…} }

ConsultationJobController.streamJob                     consultation-job.controller.ts:60-71
 └─ ConsultationJobService.subscribeToJobUpdates        consultation-job.service.ts:365-450
      Observable<MessageEvent> {
        subscriber.next({ data: JSON.stringify(status) })   // ← no `type:` field
        …
      }
```

### 2.3 DNA style: learn (async job) + apply (per-request)

```
Learn
  SDK
   └─ useDnaStyle.generate(input)                       useDnaStyle.ts:46
       POST /dna-writing-styles/generate   ─►  { jobId }
   └─ useDnaStyle.pollJobStatus(jobId)                  useDnaStyle.ts:79-110
       polls GET /dna-writing-styles/jobs/:jobId every Xs until completed/failed
       NOTE: SDK never opens SSE on DNA job stream (see §5 D-7).

  Backend
   DnaWritingStyleController.generate                  dna-writing-style.controller.ts
    └─ DnaWritingStyleService.generateDnaReport
         └─ enqueue BullMQ 'generate-dna-report' job (uuid jobId per POST)
              └─ DnaWritingStyleProcessor.process       dna-writing-style.processor.ts
                  ├─ fetch ContextItems for doctor (NO type filter — see §5 D-3)
                  ├─ POST SMR /api/v1/generate  with style-extraction prompt
                  └─ persist DnaWritingStyleReport + version

Apply
  SDK sends `dnaStyleId` in SummaryGenerationOptions
  Backend SummaryService.generateSummary → PromptAssemblyService.assemble({ dnaStyleId })
  PromptAssemblyService loads dna_writing_style_report.styleText and appends it to system prompt.
  ChainSummary persists `dnaStyleId` on the RAW_SUMMARY ContextItem (chain-summary.service.ts:123).
```

### 2.4 SMR proxy (`/text/*`) — not used by the SDK

```
apps/api/src/modules/streaming/smr-proxy.controller.ts
  POST /text/generate            (sync passthrough)
  POST /text/generate/assembled  (loads dna_writing_style by id and injects styleText into system prompt
                                  — no ownership check on dnaStyleId, see §6 S-3)
  GET  /text/tasks/:taskId       (SMR task status)
  POST /text/tasks/:taskId/cancel
  GET  /text/tasks/:taskId/stream (SSE from SMR Redis Streams)
```

The SDK has **no** constants for `/text/*`; the proxy is reachable from any authenticated user but is not part of the SDK summary path.

---

## 3. Public surface map

| SDK hook / method | Verb | Path constant | Backend handler | Stream channel |
|---|---|---|---|---|
| `useArcaSummary.generatePreSummary` | POST | `SUMMARY_ENDPOINTS.PRE_SUMMARY` constants.ts:75 | `ConsultationController.generatePreSummary` | — |
| `useArcaSummary.generateSummary` | POST | `SUMMARY_ENDPOINTS.GENERATE` constants.ts:74 | `ConsultationController.generateSummary` | — |
| `useArcaSummary.generateComprehensiveSummary` | POST | `SUMMARY_ENDPOINTS.COMPREHENSIVE` constants.ts:86 | `ConsultationController.generateComprehensiveSummary` | — |
| `useArcaSummary.generateSummaryAsync` | POST | `SUMMARY_ENDPOINTS.GENERATE_ASYNC` constants.ts:88 | `ConsultationController.generateSummaryAsync` consultation.controller.ts:590 | — (caller must poll/stream `/consultations/jobs/:jobId`) |
| `useArcaSummary.generatePreSummaryAsync` | POST | `SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC` constants.ts:90 | `ConsultationController.generatePreSummaryAsync` consultation.controller.ts:618 | — |
| `useArcaSummary.generateComprehensiveSummaryAsync` | POST | `SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC` constants.ts:92 | `ConsultationController.generateComprehensiveSummaryAsync` | — |
| `useArcaSummary.loadSummaries` | GET | `SUMMARY_ENDPOINTS.LIST` constants.ts:80 | `ConsultationController.listSummaries` | — |
| `useArcaSummary.updateSummary` | PATCH | `SUMMARY_ENDPOINTS.UPDATE` constants.ts:81 | `ConsultationController.updateSummary` | — |
| `useArcaSummary.approveSummary` | POST | `SUMMARY_ENDPOINTS.APPROVE` constants.ts:97 | `ConsultationController.approveSummary` | — |
| `useDnaStyle.generate` | POST | `DNA_STYLE_ENDPOINTS.GENERATE` constants.ts:134 | `DnaWritingStyleController.generate` | — |
| `useDnaStyle.getMyStyle` | GET | `DNA_STYLE_ENDPOINTS.MY_STYLE` constants.ts:138 | `DnaWritingStyleController.getMyStyle` | — |
| `useDnaStyle.getByDoctor` | GET | `DNA_STYLE_ENDPOINTS.BY_DOCTOR` constants.ts:144 | `DnaWritingStyleController.getByDoctor` | — |
| `useDnaStyle.update` | PATCH | `DNA_STYLE_ENDPOINTS.UPDATE` constants.ts:139 | `DnaWritingStyleController.update` | — |
| `useDnaStyle.getVersions` | GET | `DNA_STYLE_ENDPOINTS.VERSIONS` constants.ts:140 | `DnaWritingStyleController.getVersions` | — |
| `useDnaStyle.getJobStatus` / `pollJobStatus` | GET | `DNA_STYLE_ENDPOINTS.JOB_STATUS` constants.ts:136 | `DnaWritingStyleController.getJobStatus` | — |
| _(no SDK caller)_ | GET (SSE) | `DNA_STYLE_ENDPOINTS.JOB_STREAM` constants.ts:137 | `DnaWritingStyleController.streamJobStatus` dna-writing-style.controller.ts:132 | named events `status`/`progress`/`result`/`error` (dna-writing-style-job-stream.ts:57-71) |
| `useConsultationJob.getJob` | GET | `CONSULTATION_JOB_ENDPOINTS.GET` constants.ts:419 | `ConsultationJobController.getJob` consultation-job.controller.ts:39 | — |
| `useConsultationJob.cancelJob` | PATCH | `CONSULTATION_JOB_ENDPOINTS.CANCEL` constants.ts:420 | `ConsultationJobController.cancelJob` consultation-job.controller.ts:52 | — |
| `useConsultationJob.streamJob` | GET (SSE) | `CONSULTATION_JOB_ENDPOINTS.SSE` constants.ts:421 | `ConsultationJobController.streamJob` consultation-job.controller.ts:69 | **unnamed `message` events only** (consultation-job.service.ts:377,394,402) |
| `useConsultationJob.pollJob` | GET | `CONSULTATION_JOB_ENDPOINTS.GET` constants.ts:419 | `ConsultationJobController.getJob` | — |

---

## 4. Strengths

1. **GAP-01 closed.** `ConsultationJobController` now exists at `apps/api/src/modules/consultation/consultation-job.controller.ts:28` and exposes the exact three paths the SDK has been calling (`/consultations/jobs/:jobId`, `/cancel`, `/stream`). The handler delegates to the pre-existing `IConsultationJobService`, so the wire-up is real, not a stub.
2. **All summarization runs server-side.** Every SDK summary path is an `apiClient.post` to a backend route (e.g., `useArcaSummary.ts:80`, `useArca.ts:841`). No LLM, no `transformers.js`, no Web-LLM is imported anywhere in `packages/agentic-sdk-v2/src/**`. Business requirement #1 is structurally satisfied.
3. **Stream auth migrated off URL JWT.** `useConsultationJob.streamJob` constructs `SSEClient(SSE_SCOPE, apiClient, logger)` (useConsultationJob.ts:110) which fetches a single-use ticket from `POST /auth/stream-ticket` and appends `?ticket=…` rather than embedding the JWT — closes TASK-262 C-4 conceptually. (See §6 S-1 for the scope-string defect that still breaks it.)
4. **Solid SSE event-name contract on DNA stream.** `streamDnaJobStatus` (dna-writing-style-job-stream.ts:57-71) emits properly named events (`type:'status' | 'progress' | 'result' | 'error'`) — this is the correct pattern, and the rest of the codebase should converge on it.
5. **DDD layering preserved.** Controllers do not touch Prisma; they go through `IConsultationJobService` / `SummaryService` / `IDnaWritingStyleService`. `SysEvent ResourceCreated`/`ResourceUpdated` is emitted on summary create/update (summary.service.ts:116, 204, 257, 314, 414) — wires into existing audit-log pipeline.
6. **Cancel-and-cleanup attempted.** `ConsultationJobService.cancelJob` (consultation-job.service.ts:302-352) at least removes `waiting`/`delayed` BullMQ jobs from the queue and updates Redis status. (See §5 D-5 for what it misses.)
7. **Ownership check on async-job *creation*.** `generateSummaryAsync` (consultation.controller.ts:591) and `generatePreSummaryAsync` (consultation.controller.ts:619) call `verifyConsultationOwnership(consultationId)` *before* enqueuing, so a non-owner cannot start a job on someone else's consultation.
8. **DNA write-time ownership.** `DnaWritingStyleService.updateDnaReport` (and the controller route) requires the doctor to own the report; admin overrides go through `DnaWritingStyleAdminController` only. Cross-doctor `getByDoctor` is correctly rejected at the controller for non-admins.
9. **Auto-refresh of context items on completion.** `useConsultationJob.streamJob` and `pollJob` both call `refreshContextItems(consultationId)` when the job reaches a terminal state (useConsultationJob.ts:135, 217) — handy for the consumer.

---

## 5. Defects

### CRITICAL

#### D-1. SSE event-name contract broken — consultation-job stream delivers ZERO events to the SDK
- **Where**: backend emitter `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:377,394,402,409-415`; SDK listeners `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:128,147,160`
- **What**: `subscribeToJobUpdates` emits `MessageEvent` objects with **only a `data:` field, no `type:`**. NestJS `@Sse()` maps `MessageEvent.type` → the SSE `event:` line. With no `type`, the wire produces a default-message event, which only fires `EventSource.onmessage`. The SDK exclusively uses **named** listeners via `sseClient.onEvent('status' | 'progress' | 'result', …)` — those handlers are registered with `addEventListener('status', …)` etc. and never fire for default-message events.
- **Impact**: `useConsultationJob.streamJob` is silently dead. After connecting, status/progress/result callbacks never fire; the consumer never learns the job completed, never refreshes context items, and the SSE socket stays open until the 30 s server `ping` cadence runs out of reconnect attempts. The only signal of completion comes from manual polling. End-to-end async-summary streaming is non-functional.
- **Evidence**: 
  - emitter: `subscriber.next({ data: JSON.stringify(currentStatus) } as MessageEvent);` (consultation-job.service.ts:401-403)
  - SDK listener: `sseClient.onEvent('status', (data) => …)` (useConsultationJob.ts:128)
  - Working pattern in same repo: `subscriber.next({ type: 'status', data: payload })` (dna-writing-style-job-stream.ts:57)
- **Patch (backend)**:
  ```ts
  // consultation-job.service.ts — emit named events
  const emitStatus = (s: JobStatusResponse) =>
    subscriber.next({ type: 'status', data: JSON.stringify(s) } as MessageEvent);
  const emitProgress = (s: JobStatusResponse) =>
    subscriber.next({ type: 'progress',
      data: JSON.stringify({ jobId: s.jobId, progress: s.progress, currentStep: s.currentStep }) } as MessageEvent);
  const emitResult = (s: JobStatusResponse) =>
    subscriber.next({ type: 'result', data: JSON.stringify(s.result ?? null) } as MessageEvent);
  const emitError = (s: JobStatusResponse) =>
    subscriber.next({ type: 'error',
      data: JSON.stringify({ jobId: s.jobId, error: s.error ?? 'Job failed' }) } as MessageEvent);
  // … use these instead of bare `{ data }` at lines 377, 394, 402, 411
  ```

#### D-2. Stream-ticket scope mismatch — every SDK SSE attempt to `/consultations/jobs/:jobId/stream` returns 401
- **Where**: SDK scope literal `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:20`; backend expected scope `apps/api/src/modules/consultation/consultation-job.controller.ts:62`; ticket-check `apps/api/src/guards/jwtauth.guard.ts` (`handleTicketAuth`, scope-equality at ~L99)
- **What**: The SDK passes `SSE_SCOPE = 'consultation-jobs'` (plural, dash) to `new SSEClient(SSE_SCOPE, …)`, which posts `{ scope:'consultation-jobs' }` to `/auth/stream-ticket`. The backend route is decorated with `@StreamScope({ namespace:'consultation_job', param:'jobId' })` (consultation-job.controller.ts:62) and `JwtAuthGuard.handleTicketAuth` reconstructs the **expected** scope as `` `${namespace}:${req.params[param]}` `` → `'consultation_job:<jobId>'`. Stored ticket scope `'consultation-jobs'` ≠ expected `'consultation_job:<jobId>'` → `UnauthorizedException`.
- **Impact**: Even if D-1 were fixed, no SDK-issued ticket can authenticate the SSE route. Streaming is completely unreachable; the SDK falls back to `onerror` and reconnect loops until `maxReconnectAttempts: 15` is exhausted. (Note: the unit test `useConsultationJob.test.ts` mocks `SSEClient` entirely, so this never surfaced.)
- **Patch (SDK)**:
  ```ts
  // useConsultationJob.ts — scope must encode the resource id
  const streamScopeFor = (jobId: string) => `consultation_job:${jobId}`;
  // …
  const sseClient = new SSEClient(streamScopeFor(jobId), apiClient as unknown as SSEApiClient, logger);
  ```
  Or, structurally better: make `SSEClient`'s `scope` a function `(url) => string` or accept a scope-builder.

#### D-3. `ConsultationJobController` has no per-job authorization — any authenticated user can read/cancel/stream any job's PHI
- **Where**: `apps/api/src/modules/consultation/consultation-job.controller.ts:13-15, 28, 39-44, 52-58, 69-71`
- **What**: The controller is decorated with `@Authorize()` at class level (authN only). The header docblock explicitly admits the gap: *"Per-job ownership checks are tracked as a follow-up (TASK-263 §6) once `ConsultationJobStatus` carries `userId`/`tenantId` fields."* The Redis-stored `ConsultationJobStatus` (job.dto.ts:70-83) intentionally **does not** include `userId` or `tenantId` (only `consultationId`, `contextItemId`), and `getJobStatus` returns the raw payload (consultation-job.service.ts:286-297).
- **Impact**: PHI exposure. The `result` field for a completed `SUMMARY` job contains the generated summary text (job.dto.ts:165-180 `SummaryJobResult.content`) — full PHI. Any authenticated user with knowledge of (or able to guess) a `jobId` (UUIDv4, but appears in client logs / SysEvents / Sentry breadcrumbs) can:
  - `GET /consultations/jobs/<other-doctor's-job>` → returns full summary content
  - `GET /consultations/jobs/<jobId>/stream` → streams completion result with the full summary
  - `PATCH /consultations/jobs/<jobId>/cancel` → grief / DoS another doctor's running summary
  Cross-tenant isolation is also absent — no `tenantId` is loaded or compared.
- **Patch**:
  1. Add `userId: string; tenantId: string;` to `ConsultationJobStatus` (job.dto.ts:70) and write them in `consultation-job.service.ts createJob*` (alongside `consultationId`).
  2. In `ConsultationJobController.getJob` / `streamJob` / `cancelJob`, resolve the job, then enforce `status.userId === cls.get('userId') && status.tenantId === cls.get('tenantId')` (or admin) — throw `ForbiddenException` otherwise.
  3. In `JwtAuthGuard.handleTicketAuth`, after the scope match, also verify the ticket's bound `userId` against the loaded job's `userId`.

### HIGH

#### D-4. SDK ↔ backend DTO field-name drift — `transcript` / `promptTemplateId` / `departmentId` silently dropped
- **Where**: 
  - SDK type `packages/agentic-sdk-v2/src/types/summary.ts` `SummaryGenerationOptions` (fields `transcript`, `promptTemplateId`, `departmentId`)
  - Backend DTO `packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts` (fields `transcription`, `template`; no `departmentId`, no `promptTemplateId`)
  - Service consumer `packages/applications/src/services/consultation/summary/summary.service.ts:144` reads `request.transcription`
  - Pipe config `apps/api/src/main.ts:221` — `new ValidationPipe({ transform: true })` (no `whitelist`, no `forbidNonWhitelisted`)
- **What**: SDK ships `{ transcript, promptTemplateId, departmentId, dnaStyleId, includeNER, options }`. Backend service reads `request.transcription` (not `transcript`) and `request.template` (not `promptTemplateId`); `departmentId` has no consumer at all. Because the pipe runs `transform:true` only, the mismatched fields are not rejected — they are silently ignored, and the service falls back to context-item-loaded transcripts (summary.service.ts:155-157) and to PromptAssembly defaults.
- **Impact**: Silent feature-not-existent. A doctor who selects "use this transcript" or "use template T-42" in the UI sees a summary generated from **default** transcripts and the **default** template — with no error feedback. The bug is invisible during demos because the result still looks plausible.
- **Patch**: Pick a side.
  - **Preferred**: rename SDK fields to match backend (`transcript→transcription`, `promptTemplateId→template`); drop `departmentId` from `SummaryGenerationOptions` (department comes from the consultation server-side).
  - Or: tighten the backend by adding `@Expose() transcription` aliases for `transcript` etc., and enable `whitelist:true` + `forbidNonWhitelisted:true` so the contract is enforced.
  - Tests: add a backend-contract test (vitest + supertest) that posts `{ transcript:'x' }` and asserts the result reflects `'x'`; today no such test exists.

#### D-5. Cancellation does not stop a running job — SMR keeps generating, summary is still persisted, billing/PHI not rolled back
- **Where**: `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:302-352`; `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` (no abort-signal handling)
- **What**: `cancelJob` only removes BullMQ jobs in `waiting` / `delayed` state (consultation-job.service.ts:334-336). If the job is `active` (worker is already calling SMR — the 15-60s critical window), the code unconditionally writes `status:'CANCELLED'` to Redis (consultation-job.service.ts:340) but the worker is **not** signalled and the SMR HTTP call is **not** aborted. When SMR returns, the processor still persists a `RAW_SUMMARY` `ContextItem` and emits `SysEventType.ResourceCreated`. The doctor sees status="cancelled" while the summary appears in the consultation a few seconds later.
- **Impact**: 
  - Misleading UX (cancel does nothing once SMR is active).
  - PHI is generated and stored after the doctor explicitly asked to stop.
  - LLM cost is incurred for a cancelled request.
  - Audit log records a `ResourceCreated` from a cancelled flow.
- **Patch**: Pass an `AbortSignal` from the worker into `summaryService.callSmrService`, and refuse to persist if the job status in Redis is `CANCELLED` at the end of the SMR call. Backbone:
  ```ts
  // summary.processor.ts (sketch)
  const ac = new AbortController();
  cancelWatcher.on(jobId, () => ac.abort());
  const smr = await this.summaryService.callSmrService({ … }, { signal: ac.signal });
  const fresh = await this.jobService.getJobStatus(jobId);
  if (fresh?.status === 'CANCELLED') return;       // do not persist
  ```
  And on the wire: forward cancellation to SMR by calling `POST /text/tasks/:taskId/cancel` (already exists, smr-proxy/`apps/smr/.../tasks.py`).

#### D-6. Async-summary controller drops typed contracts via `(request as any)?.field` — type/runtime safety lost
- **Where**: `apps/api/src/modules/consultation/consultation.controller.ts:594-601, 622-627`
- **What**: The handler accepts `@Body() request: GenerateSummaryRequest` but immediately reads `(request as any)?.dnaStyleId`, etc., bypassing the DTO contract. Combined with the pipe configuration (D-4), any client-supplied JSON shape is forwarded into the job payload.
- **Impact**: A malicious client could inject extra fields into `options` or smuggle properties that survive into the BullMQ payload and downstream prompt assembly. Loss of contract erodes the audit trail (Swagger schema does not match runtime behavior).
- **Patch**: Remove the `as any` casts; rely on the DTO's typed fields. If the DTO truly needs `contextItemIds` and `includeNER`, add them with `@ApiPropertyOptional` + class-validator decorators to `GenerateSummaryRequest`.

#### D-7. DNA SSE endpoint exists but cannot be reached from a browser SDK — missing `@StreamScope` *and* no SDK caller
- **Where**: 
  - backend endpoint `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:132-136` (`@Sse()`, but **no** `@StreamScope`)
  - SDK has the constant `DNA_STYLE_ENDPOINTS.JOB_STREAM` (constants.ts:137) but no hook references it (grep of `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts` shows only `JOB_STATUS` usage — useDnaStyle.ts:73, 89, 92)
- **What**: Two coupled problems.
  1. The DNA stream route is protected only by `JwtAuthGuard` (Bearer header). Browser `EventSource` cannot send custom headers, so this endpoint can be reached only by a Node EventSource shim — i.e., not from the playground / not from the SDK in a browser.
  2. The SDK only polls (`useDnaStyle.pollJobStatus`) — meaning the working SSE pattern is unused. UX must endure 2 s polling latency on DNA-style generation (which can take 30-90 s).
- **Impact**: 
  - Wasted server work building/maintaining a stream the SDK never uses.
  - Inconsistent transport pattern (poll for DNA, "stream" for consultation jobs, neither actually working).
  - Future browser consumers will be confused.
- **Patch**: 
  1. Add `@StreamScope({ namespace:'dna_job', param:'jobId' })` to `streamJobStatus` so a ticket-bearing `EventSource` can authenticate.
  2. Either implement `useDnaStyle.streamJobStatus(jobId, callbacks)` using `SSEClient` (mirroring `useConsultationJob.streamJob`) and remove `pollJobStatus`; or remove the unused SSE endpoint to reduce surface.

### MEDIUM

#### D-8. `JobStatus` case mismatch — SDK terminal-detection is permanently false on real backend values
- **Where**: SDK `packages/agentic-sdk-v2/src/types/consultation-job.ts:7,34-38`; backend types `packages/applications/src/services/consultation/jobs/dto/job.dto.ts:7,95,118`
- **What**: Backend emits uppercase statuses `'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'` (job.dto.ts:7, ApiProperty enum at job.dto.ts:95,118). SDK `JobStatus` type is lowercase, and the terminal-check `isTerminalStatus` (consultation-job.ts:34-37) tests against `new Set(['completed','failed','cancelled'])`. The processor never lowercases.
- **Impact**: 
  - `useConsultationJob.pollJob` (useConsultationJob.ts:214) never sees a terminal status from real responses → polls until `maxAttempts` (default 60 × 2 s = 120 s) then rejects with `'Polling exceeded max attempts'`, even though the job completed in 30 s.
  - `useConsultationJob.streamJob` cleanup branch (useConsultationJob.ts:133-137) never triggers, leaving the SSE socket open until the component unmounts (which is correct for streams but in conjunction with D-1 means it never closes at all).
  - The mocks in `useConsultationJob.test.ts` use lowercase statuses (`'completed'`) so unit tests pass while integration is broken.
- **Patch**: 
  ```ts
  // consultation-job.ts
  const TERMINAL = new Set(['completed','failed','cancelled','COMPLETED','FAILED','CANCELLED']);
  export const isTerminalStatus = (s: string) => TERMINAL.has(s);
  ```
  And/or normalize on receive (`setStatus(data.status.toLowerCase() as JobStatus)`). Add a unit test that uses uppercase fixtures.

#### D-9. Retry-with-exponential-backoff on `useDnaStyle.generate` re-enqueues duplicate DNA jobs
- **Where**: `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts:46`; `packages/agentic-sdk-v2/src/hooks/useApiOperation.ts:48-73` (`withRetry`, default `{ maxRetries: 2 }`)
- **What**: `useDnaStyle.generate` is wrapped in `execute(...)` which applies the default retry policy. A transient 5xx on the **first** POST → SDK retries → backend enqueues a **second** BullMQ job with a **new uuid**. Server has no idempotency key, so duplicate work runs and a duplicate report version is created.
- **Impact**: Wasted SMR cost, possible "two versions appeared after I clicked once" UX.
- **Patch**: Either pass `execute('generate', fn, false /* no retry */)` on side-effectful POSTs, or implement client/server idempotency keys (`Idempotency-Key` header). Backend currently has zero idempotency support across summarize/DNA paths (`rg -i idempotenc` in `apps/api/src` and `packages/agentic-sdk-v2/src` returns no matches).

#### D-10. No idempotency on async-summary POST either
- **Where**: `apps/api/src/modules/consultation/consultation.controller.ts:590` and `:618`; SDK `useArca.ts:977, 1019`
- **What**: Same as D-9. The async-summary handler accepts every POST and enqueues a fresh job. A double-click or a transient retry produces N duplicate jobs all consuming SMR tokens.
- **Impact**: Cost amplification + possible "two summaries appeared" UX.
- **Patch**: Accept an optional `Idempotency-Key` header (UUIDv4 from the SDK), store it on the job in Redis with a 24h TTL, and short-circuit if a prior job exists with the same key. The SDK should generate a key per user-initiated action.

#### D-11. DNA-style learning corpus is unfiltered — pulls all `ContextItems`, not just approved/edited summaries
- **Where**: `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` (the `gather samples` step pulls all `ContextItem`s for a doctor with no type filter); `packages/applications/src/services/dna-writing-style/dna-regeneration.scheduler.ts`
- **What**: The business requirement is *"DNA writing style is learned from the doctor's prior approved/edited summaries"*. The processor instead fetches all context items for the doctor — including raw transcripts, case notes, AI-generated draft summaries that were **never** approved, and unedited content. There is no filter on `ContextItemType === RAW_SUMMARY && approvedAt != null` (or equivalent on `SummaryMeta.status === 'APPROVED'`).
- **Impact**: The learned style is contaminated by AI-prior output (model self-eating its own raw output is a known style-collapse risk) and by transcript fragments that aren't the doctor's prose at all. The promised feedback loop ("learns from doctor's approved edits") does not exist; it learns from whatever happens to be present.
- **Patch**: Restrict the sample query to approved/edited summaries:
  ```ts
  // pseudo
  const samples = await this.contextItemRepository.findApprovedSummariesByDoctor(doctorId, { limit: 50 });
  // and/or join SummaryMeta where status === 'APPROVED' && updatedBy === doctorId
  ```
  Also: add an audit trail — when DNA regen runs, persist the list of source `contextItemId`s it learned from so the result is explainable.

#### D-12. SMR proxy applies `dnaStyleId` with no doctor-ownership check — style theft
- **Where**: `apps/api/src/modules/streaming/smr-proxy.controller.ts` (`/text/generate/assembled` handler loads `dnaWritingStyleRepository.findById(body.dna_writing_style_id)` and injects `styleText` into the system prompt without verifying the caller owns the report)
- **What**: While `DnaWritingStyleController.getByDoctor` correctly 403s cross-doctor reads, the SMR proxy bypasses that check — any authenticated user can pass another doctor's `dna_writing_style_id` and the proxy will load it and apply it. The styleText itself isn't returned, but it is "applied" to the caller's prompt, which is still a leak vector if the caller can echo the system prompt.
- **Impact**: Style cross-pollination / impersonation. Limited blast radius today because the SDK doesn't call `/text/*`, but anyone holding a valid JWT can.
- **Patch**: In the proxy, after `findById`, verify `dnaStyle.doctorId === currentUser.id` (or admin).

### LOW

#### D-13. `useArcaSummary` is not exported from `core.ts`
- **Where**: `packages/agentic-sdk-v2/src/hooks/index.ts:14` (exports it); `packages/agentic-sdk-v2/src/core.ts:36-58` (does **not** re-export it)
- **Impact**: Consumers cannot `import { useArcaSummary } from '@arcaai/vox'`. They must use the god `useArca()` hook or reach into a non-public path. Inconsistent with `useDnaStyle` / `useConsultationJob`.
- **Patch**: Add `useArcaSummary` to the export list at `core.ts:43` (alphabetical).

#### D-14. Memoization risk in `useConsultationJob.streamJob`
- **Where**: `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:104-195`
- **What**: `streamJob` is `useCallback`-wrapped with `[apiClient, logger, store.consultation, refreshContextItems]` deps. When `store.consultation` changes (any field), the callback identity changes, and any `useEffect(() => streamJob(jobId, cb), [streamJob, jobId])` in a consumer will re-open a new SSE. Combined with `autoReconnect:true` (line 181) and a 15-attempt backoff, this can fan out to many concurrent SSE connections.
- **Patch**: Read `store.consultation?.id` once at top of `streamJob` via a ref, or remove `store.consultation` from deps (the only use is `parsed.consultationId || store.consultation?.id`, which can be a closure-over-ref).

#### D-15. DNA SSE is poll-internally — 1 s setInterval against BullMQ even with no clients
- **Where**: `apps/api/src/modules/dna-writing-style/dna-writing-style-job-stream.ts:80` (`setInterval(() => void emit(), 1000)`)
- **What**: The "stream" is in fact a 1-Hz BullMQ poll inside the controller. No Pub/Sub. With many concurrent DNA generations this scales poorly. The consultation-job stream got it right with Redis Pub/Sub (`consultation-job.service.ts:406`); DNA didn't.
- **Patch**: Have `DnaWritingStyleProcessor` publish to `dna_job_updates:{jobId}` on progress/complete/fail, and subscribe in the stream — same shape as consultation-job.

#### D-16. SDK `SummaryGenerationOptions` carries `transcript` (PHI) in URL-adjacent context; backend never reads it (see D-4)
- **Where**: `packages/agentic-sdk-v2/src/types/summary.ts` `SummaryGenerationOptions.transcript`
- **What**: This field is documented as "alternative to backend gathering" but since D-4 silently drops it, every SDK call still ships transcript text in the request body. With HTTPS, fine on the wire; in HTTP application logs or browser DevTools network panel, PHI is visible. The right fix is either to remove the field from the SDK (decision: backend always gathers) or wire it through end-to-end.

#### D-17. `generateComprehensiveSummary` SDK signature truncated
- **Where**: `packages/agentic-sdk-v2/src/hooks/useArca.ts:178` and `useArcaSummary.ts`
- **What**: SDK signature is `{ dnaStyleId?, includeNER? }`. Backend `ComprehensiveSummaryRequest` also accepts `template`, `includeLabResults`, `options`. SDK consumers cannot pass them.
- **Patch**: Widen the SDK signature to match the backend DTO.

#### D-18. Error mapping not normalized — model-timeout / content-filter / context-overflow all surface as raw `ApiError`
- **Where**: SDK `packages/agentic-sdk-v2/src/utils/errorUtils.ts` (general); `AgenticErrorCode` enum (somewhere in SDK)
- **What**: No grep finds a mapping from SMR's specific error shapes (e.g., 408 timeout, 413 prompt-too-long, content-filter `error.code = 'CONTENT_FILTER'`) into `AgenticErrorCode`. Consumers see `Error('Request failed: 500')` rather than `AgenticErrorCode.ModelTimeout`.
- **Patch**: Define and populate `AgenticErrorCode.{ModelTimeout, PromptTooLong, ContentFilter, RateLimited}` and translate at `AgenticClient`'s response handler.

#### D-19. No first-token latency budget / streaming-tokens contract
- **Where**: `apps/smr/src/smr_v2/api/endpoints/generate.py`, `apps/smr/src/smr_v2/api/endpoints/stream.py`
- **What**: SMR can stream tokens via SSE (`stream=True` returns 202 + task_id; `/tasks/:taskId/stream` emits chunks). The api-gateway summary path **does not propagate this token stream** to the SDK — the summary processor calls SMR with `stream=false` and waits for the full text. So even with D-1/D-2 fixed, the only events the SDK would receive are coarse status transitions (PENDING → RUNNING → COMPLETED), not live tokens. The product copy "streaming summary generation" is half-true.
- **Patch**: Decide: do we want true token-stream UX? If yes, switch the summary processor to `stream=true`, forward chunks to `redis pub/sub consultation_job_updates:{jobId}` as `{type:'progress', data:{deltaText}}`, and add a `chunk` event to the SDK SSE listeners.

---

## 6. Security findings

| ID | Severity | Title | Where |
|---|---|---|---|
| S-1 | Critical | Stream-ticket scope mismatch → SSE 401 (see D-2) | useConsultationJob.ts:20, consultation-job.controller.ts:62 |
| S-2 | Critical | No per-job ownership/tenant check on `ConsultationJobController` → cross-user PHI access (see D-3) | consultation-job.controller.ts:13-15 |
| S-3 | Medium | SMR proxy applies `dnaStyleId` without ownership verification (see D-12) | smr-proxy.controller.ts |
| S-4 | Medium | Async-summary handler casts `request as any` (see D-6) | consultation.controller.ts:594-601 |
| S-5 | Medium | DNA stream endpoint cannot be browser-authenticated (no `@StreamScope`, EventSource cannot send Bearer) (see D-7) | dna-writing-style.controller.ts:132 |
| S-6 | Low | Transcript in request body when backend ignores it (see D-16) | summary.ts (types) |
| S-7 | Info | Audit-log integration via `SysEventType.ResourceCreated/Updated` only on summary CRUD — no explicit audit row for **view/read** of a summary | summary.service.ts:116, 204, 257, 314, 414 |
| S-8 | Info | SSE ticket plumbing — confirmed migration off URL JWT (TASK-274), good (SSEClient.ts) | — |
| S-9 | Info | Transport is HTTPS in production; no HTTP fallback in SDK constants | constants.ts |

**PHI handling summary**

- ✅ Transport: HTTPS-only in production; CORS callback in `main.ts:71-90` blocks non-HTTPS in prod.
- ✅ At-rest: `RAW_SUMMARY` `ContextItem.content` is stored in Postgres via Prisma — encryption is a deployment concern (column-level encryption is **not** configured in `packages/database/prisma/schema.prisma`; this is out of scope for this review but worth flagging to TASK-294 cross-cutting).
- ❌ Authorization: D-3 / S-2 is the dominant PHI risk — *the* finding to fix before any external pilot.
- ⚠️ Audit: `SysEvent` covers create/update; no explicit "summary viewed/streamed by user X" entry. Compliance-grade audit would log SSE connect / `getJob` reads too.

---

## 7. Performance findings

| ID | Title | Detail |
|---|---|---|
| P-1 | SDK polling fallback at 120 s timeout due to D-8 | `useConsultationJob.pollJob` defaults `maxAttempts=60` × `intervalMs=2000`. Real jobs return uppercase statuses → SDK polls to exhaustion before erroring. (useConsultationJob.ts:200-238) |
| P-2 | DNA "stream" is 1-Hz BullMQ poll (see D-15) | `dna-writing-style-job-stream.ts:80` |
| P-3 | Async summary worker calls SMR with `stream=false` (see D-19) | First-token latency = full summary latency; user has no progressive UX. |
| P-4 | DNA learning samples unbounded | DNA processor pulls all `ContextItem`s for a doctor; no `LIMIT`. For long-tenured doctors this is a slow query and a long prompt. Add `LIMIT 50` + recency ordering. |
| P-5 | `useDnaStyle.pollJobStatus` polls every `intervalMs` regardless of job state | Could use exponential backoff (1s → 2s → 4s, cap 10s). useDnaStyle.ts:79-110 |
| P-6 | No max-input-length guard on SDK before POST | A 200k-token transcript will hit SMR and return `413 prompt too long` (or worse, silently truncate). Add SDK-side length pre-check + chunking strategy doc. |
| P-7 | `useConsultationJob.streamJob` opens a new `SSEClient` per call but does not de-duplicate by `jobId` | If a consumer re-mounts, two sockets to the same job open. (useConsultationJob.ts:104-195) |

---

## 8. Test coverage gaps

| Gap | Where | Why it matters |
|---|---|---|
| T-1 | No integration test exercises the **real** SSE wire for `/consultations/jobs/:jobId/stream` | `useConsultationJob.test.ts` mocks `SSEClient` entirely. D-1 (no `type:` on events) and D-2 (ticket scope) would have been caught by a single supertest+EventSource round-trip. |
| T-2 | No test fixture uses uppercase backend statuses (`'COMPLETED'`) | `useConsultationJob.test.ts` uses `'completed'`. D-8 would have failed loudly. |
| T-3 | No backend e2e test for cancel-during-active (D-5) | Need a test that starts a job, awaits `status==='RUNNING'`, calls cancel, then asserts no `ContextItem` is persisted. |
| T-4 | No test for the **DNA-DTO drift** | No supertest call that posts `{ transcript:'X' }` and asserts the returned summary uses `X`. D-4 silent-drop is invisible. |
| T-5 | No test that two concurrent retries (`maxRetries:2`) of `useDnaStyle.generate` produce a single backend job | D-9 idempotency hole untested. |
| T-6 | No reconnect-during-stream test | `useConsultationJob` claims `autoReconnect:true` with 15 attempts and 30 s max delay (useConsultationJob.ts:181-185), but no test asserts an EventSource `onerror` followed by a successful reconnect resumes status callbacks. |
| T-7 | No cross-user 403 test on `ConsultationJobController` | Once D-3 is fixed, an integration test should assert `GET /consultations/jobs/<user-A-job>` from user B returns 403. |
| T-8 | No DNA-corpus filter test | After D-11 fix, a test should seed RAW transcripts + 1 approved summary and assert only the approved summary's text reaches the SMR prompt. |
| T-9 | No SMR-failure mapping test | After D-18 fix, simulate SMR 408 / 413 / content-filter and assert SDK surfaces `AgenticErrorCode.*`. |
| T-10 | No test asserts streaming is *gated* by stream ticket | After D-2 fix, an integration test should drop the ticket and confirm 401. |

---

## 9. Conformance to the business requirement

### 9.1 Summarization always backend — **VERDICT: PASS**

Evidence:
- All SDK summary methods use `apiClient.post` to a backend route (useArcaSummary.ts:80, useArca.ts:841,795, etc.).
- No LLM library is imported anywhere in `packages/agentic-sdk-v2/src/**` (verified by reading `useArcaSummary.ts`, `useArca.ts`, and the package's `package.json`).
- The summary path terminates at `summaryService.callSmrService` (summary.service.ts:175) → SMR HTTP service. No fallback to local inference.

### 9.2 DNA style available with/without — **VERDICT: PARTIAL PASS, with HIGH defects**

Evidence (PASS aspects):
- `dnaStyleId` is optional on every summary path (`SummaryGenerationOptions.dnaStyleId?: string`, summary.ts).
- Backend `PromptAssemblyService.assemble({ dnaStyleId })` resolves the style report and injects `styleText` (summary.service.ts:164-172). If absent, the default system prompt is used.
- `chain-summary.service.ts:123` records `dnaStyleId` on the persisted `RAW_SUMMARY` so applied style is auditable.

Evidence (FAIL aspects):
- D-11: the "learn from approved/edited summaries" half of the loop is **not** implemented — corpus is unfiltered. So the *apply* side works, but the *learn* side does not match the requirement.
- D-12: cross-doctor `dnaStyleId` can be applied via `/text/generate/assembled`.

### 9.3 Job tracking (HTTP) + stream (SSE/WS) — **VERDICT: FAIL**

Evidence:
- ✅ HTTP init: `POST /consultations/:id/summary/async` returns 202 + `{ jobId, status:'pending' }` (consultation.controller.ts:603-608). Job appears in Redis.
- ✅ HTTP status: `GET /consultations/jobs/:jobId` returns `JobStatusResponse` (consultation-job.controller.ts:39).
- ✅ HTTP cancel: `PATCH /consultations/jobs/:jobId/cancel` (consultation-job.controller.ts:52). But see D-5 — does not stop active workers.
- ❌ SSE stream: broken end-to-end. D-1 (no `type:` events) means the SDK receives no callbacks. D-2 (ticket scope) means it can't even connect. D-3 means any connection would be a cross-user PHI hole.
- ⚠️ Polling works around the SSE break — but D-8 (case mismatch) means it times out at 120 s instead of completing.

Conclusion: the *machinery* is present but the *wire contract* is not. Streaming is non-functional today.

### 9.4 GAP-01 (consultation-job HTTP controller) closed — **VERDICT: CLOSED, with caveats**

Evidence:
- File `apps/api/src/modules/consultation/consultation-job.controller.ts` (73 lines) exists; provides the three SDK-expected endpoints (`GET`, `PATCH /cancel`, `GET /stream`) (consultation-job.controller.ts:34-71).
- File header docblock at consultation-job.controller.ts:1-16 explicitly attributes the work to "TASK-263 / W0-6 (GAP-01)" — i.e., this is the deliberate closure.

Caveats:
- The controller fulfills the *route* contract but **not** the *event-stream* contract (D-1) nor the *authZ* contract (D-3). GAP-01 is closed in form; the substance still needs D-1 + D-3 + D-2 to land before the SDK story works.

### Overall verdict

| Requirement | Verdict |
|---|---|
| 1. All summarization backend-handled | PASS |
| 2. DNA optional on summary | PASS |
| 3. DNA learns from approved/edited summaries | **FAIL** (D-11) |
| 4. HTTP init + SSE/WS stream | **FAIL** (D-1, D-2) |
| 5. Multiple jobs trackable / cancelable / idempotent | **FAIL** (D-5 cancellation; D-9/D-10 idempotency) |

---

## 10. Recommended fixes

### P0 — must fix before any external pilot

1. **D-3 / S-2** — Add `userId`+`tenantId` to `ConsultationJobStatus`, populate at job creation, enforce ownership in `getJob` / `streamJob` / `cancelJob`. Verify ticket-bound user matches loaded job user in `JwtAuthGuard.handleTicketAuth`. *(File: `consultation-job.controller.ts`, `consultation-job.service.ts`, `jwtauth.guard.ts`, `job.dto.ts`.)*
2. **D-1** — Emit named SSE events (`type:'status'|'progress'|'result'|'error'`) from `ConsultationJobService.subscribeToJobUpdates`. *(File: `consultation-job.service.ts:377,394,402,409-415`.)*
3. **D-2** — Build SDK ticket scope as `` `consultation_job:${jobId}` ``, not the literal `'consultation-jobs'`. *(File: `useConsultationJob.ts:20,110`.)*

### P1 — fix in the same wave

4. **D-4** — Reconcile DTO field names (`transcript→transcription`, `promptTemplateId→template`); drop unused `departmentId` from SDK options; tighten backend with `whitelist:true, forbidNonWhitelisted:true` in `main.ts:221` and the SDK-side too. *(Files: `types/summary.ts`, `generate-summary.request.ts`, `main.ts`.)*
5. **D-5** — Wire `AbortController` through `summaryService.callSmrService`; refuse persistence on post-cancel completion; forward cancel to SMR `/text/tasks/:taskId/cancel`. *(Files: `summary.processor.ts`, `summary.service.ts`.)*
6. **D-8** — Make `isTerminalStatus` case-insensitive; normalize statuses to one canonical case on SDK boundary. Add upper-case test fixtures. *(File: `consultation-job.ts:34-37`, tests.)*
7. **D-11** — Restrict DNA learning corpus to approved/edited summaries (join on `SummaryMeta.status === 'APPROVED'`); persist the source-`contextItemId` list for explainability. *(File: `dna-writing-style.processor.ts`.)*

### P2 — quality / hygiene

8. **D-6** — Drop `(request as any)?` in the async controllers; extend the DTOs with the missing typed fields. *(File: `consultation.controller.ts:594-627`.)*
9. **D-7** — Decide DNA SSE: either add `@StreamScope({namespace:'dna_job',param:'jobId'})` and an SDK `useDnaStyle.streamJobStatus`, or remove the unused endpoint.
10. **D-9 / D-10** — Implement `Idempotency-Key` header (SDK generates per user-action UUID; backend stores in Redis with 24 h TTL and returns prior `jobId` on collision). Disable retries on side-effectful POSTs.
11. **D-12 / S-3** — Add ownership check on `dnaStyleId` in `smr-proxy.controller.ts`'s `/text/generate/assembled`.
12. **D-13** — Add `useArcaSummary` to `core.ts` exports.
13. **D-14** — Stabilize `streamJob` callback identity (use refs for store-derived ids).
14. **D-15** — Convert DNA "stream" to Redis Pub/Sub.
15. **D-17** — Widen `generateComprehensiveSummary` SDK signature to match backend DTO.
16. **D-18** — Map SMR errors → `AgenticErrorCode`.
17. **D-19** — Decide on true token-streaming; if yes, propagate SMR `stream=true` chunks through Redis Pub/Sub.

---

## 11. Scorecard

| Dimension | Score (1-5) | Comment |
|---|---|---|
| Endpoint alignment (SDK ↔ backend routes) | 4 / 5 | All routes exist; GAP-01 closed; method/path/verb agree. Field-name drift inside bodies (D-4) is the gap. |
| HTTP init → SSE/WS stream pattern | 1 / 5 | Init works; stream is fully broken end-to-end (D-1, D-2). Polling kind-of works modulo D-8. |
| DNA learning loop | 1 / 5 | Approved-summary filter missing (D-11). Loop is not what the requirement asks for. |
| DNA application | 4 / 5 | StyleId is plumbed through and persisted; minor cross-user-apply risk in SMR proxy (D-12). |
| Job lifecycle | 2 / 5 | Create/status OK; cancel partially works (D-5); stream broken (D-1/D-2); retry/history not implemented. |
| Idempotency | 1 / 5 | No idempotency key anywhere (D-9, D-10). |
| Authorization | 1 / 5 | Class-level `@Authorize()` only; per-job authZ admitted-missing (D-3). |
| PHI handling | 2 / 5 | TLS OK; PHI leak through D-3; column-level encryption out of scope; audit lacks reads. |
| Stream auth | 2 / 5 | Ticket plumbing exists and is the right pattern; scope wiring breaks it (D-2). |
| Error mapping | 2 / 5 | Generic ApiError pass-through; no model-error normalization (D-18). |
| Cancellation | 2 / 5 | Cancel API exists but doesn't actually stop active SMR work or roll back PHI (D-5). |
| Performance | 3 / 5 | Mostly OK; D-15, D-3 (P3), P-4, P-5 limit; first-token latency = full latency. |
| Test coverage | 2 / 5 | Unit tests pass while integration is broken; no real-wire SSE test; no cross-user 403 test. |
| **Aggregate** | **2.1 / 5** | Architecture is right; wire-contract and authZ details aren't. |

---

## Reviewer summary (return payload)

**File written:** `docs/implementation/TASK-293-Vox-SDK-Deep-Assessment-V2/07-summary-with-dna.md`

**Defects by severity**
- Critical: 3 (D-1 SSE no `type:` events, D-2 ticket scope mismatch, D-3 no per-job authZ → PHI leak)
- High: 4 (D-4 DTO field drift, D-5 cancel doesn't abort active jobs, D-6 `(request as any)` casts, D-7 DNA SSE unreachable from browser)
- Medium: 5 (D-8 status case mismatch, D-9/D-10 no idempotency, D-11 DNA corpus unfiltered, D-12 SMR-proxy cross-doctor `dnaStyleId`)
- Low: 7 (D-13..D-19)

**Top-3 must-fix (P0)**
1. **D-3 — Per-job authZ on `ConsultationJobController`.** Right now any authenticated user can `GET /consultations/jobs/<any-jobId>`, `…/stream`, or `PATCH …/cancel`, and the `result` of a `SUMMARY` job is full PHI summary text. The controller header docblock literally documents the omission. Fix: add `userId`/`tenantId` to `ConsultationJobStatus`, populate on enqueue, enforce ownership in the controller and in `JwtAuthGuard.handleTicketAuth`.
2. **D-1 — Named SSE events.** `ConsultationJobService.subscribeToJobUpdates` emits `{ data }` only; the SDK listens with `addEventListener('status', …)` etc., which never fire. Convert the four emit sites (consultation-job.service.ts:377, 394, 402, 409-415) to set `type:'status'|'progress'|'result'|'error'` — matching the working `streamDnaJobStatus` pattern (dna-writing-style-job-stream.ts:57-71).
3. **D-2 — Stream-ticket scope.** SDK uses scope `'consultation-jobs'`; backend expects `'consultation_job:<jobId>'`. Change `useConsultationJob.ts:20` to a `scopeFor(jobId)` builder and pass it to `new SSEClient(scopeFor(jobId), …)`. Without this fix, no SDK consumer can ever authenticate the stream — even if D-1 is fixed.

**Blockers**

- D-1 + D-2 + D-3 collectively block the "async summary with live progress" UX. Until all three land, the SDK has only **polling**, and even polling is degraded by D-8.
- D-11 blocks the *DNA-learning* business requirement (#3). Until the corpus is restricted to approved/edited summaries, the feature does not match the spec.
- D-5 blocks any cost-or-PHI-bounded cancellation contract. Until `AbortSignal` is wired through to SMR, "cancel" is a UX lie.

**TASK-262 GAP-01 status:** **CLOSED** in form (controller exists at consultation-job.controller.ts:28) but **not** in substance — D-1, D-2, and D-3 must land for the controller to be useful and safe.
