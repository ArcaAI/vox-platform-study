# Clinical Workspace — Durable Context Integration


|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket**    | TASK-342                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Name**      | Clinical Workspace Durable-Context Integration (close the durable-layer gaps so a live visit produces an authoritative SOAP that reflects mid-visit doctor context)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Created**   | 2026-06-09                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Updated**   | 2026-06-09                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Status**    | **Completed** (live E2E pending GPU/model host — R1; GAP #3d live-drop-out and GAP #5 heavy-OCR deferred as noted)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Cross-ref** | [TASK-330](../TASK-330-Clinical-Documentation-Harness/README.md) (Harness — owns assemble/draft/prompt), [TASK-339](../TASK-339-Clinical-Workflow-Playground/README.md) (cockpit + `LiveDocumentationService`), [TASK-340](../TASK-340-Live-SOAP-Hardening/README.md) (realtime engine hardening), [TASK-341](../TASK-341-Clinical-Workspace-Realtime-Admin-Live/README.md) (UI consolidation + admin live console — does **not** close these gaps)                                                                                                                                                                                                        |
| **Migration** | **None required.** Verified `model ContextItem` (`packages/database/src/prisma/db_main/consultation.prisma:70-125`) already carries `resourceStatus ResourceStatusType @default(ENABLED)` + `resourceStatusUpdatedAt` + `resourceStatusUpdatedBy` (lines 106-108) and `metaData` JSONB (`_metadata`, line 72) + `mediaId` (line 96). Soft-delete (GAP #3) is a `resourceStatus → DELETED` state change via the existing base `Repository.softDelete` — **no `deletedAt` column to add**. Harness-context folding (GAP #2) and live propagation reuse existing columns. GAP #5 extracted text reuses `content`/`metaData`. No new Prisma model/enum/column. |


> A read-only end-to-end audit found the Clinical Workspace **LIVE/ephemeral** loop (STT captions → live SOAP via SSE) is fully wired in code, but the **DURABLE/authoritative** layer has integration gaps: a streaming visit never persists a `TRANSCRIPT`, so the harness never auto-drafts the authoritative SOAP after **Stop**; even when triggered, harness assemble ignores the doctor's case-notes/work-notes/attachments; and notes/files are add-only (no remove). This ticket closes those gaps surgically so the seven workspace features (live transcription, live summarization, note/highlight/case-note/work-note/file taking, and **continuous context propagation into the final SOAP**) work end-to-end as the doctor experiences them. **No new product features beyond closing the integration.**

---

## 1. Requirement Analysis

### Description

Close the durable-layer integration gaps for the Clinical Workspace (`apps/ui-playground` cockpit + its backend in `packages/applications` + `apps/api`, plus one `apps/stt-v2` seam). The LIVE loop already works in code; the authoritative loop does not. Concretely:

- **GAP #1 (CRITICAL)** — A streaming (live-mic) visit must persist a `TRANSCRIPT` `ContextItem` on **Stop** so the harness auto-draft pipeline fires (`TranscriptionCreated → ConsultationEventHandler → HarnessGatewayService.start`). Today only the **batch** file worker does this; the streaming finalize path uploads a transcript blob + registers audio media but never calls `create_transcript`. Without this, no live visit ever yields the authoritative SOAP — the Review tab polls until timeout.
- **GAP #2 (CRITICAL)** — Harness `assemble` must fold the doctor's `CASE_NOTE` / `WORKNOTE` / `ATTACHMENT` context into the authoritative-SOAP prompt. Today it gathers only transcripts + NER.
- **GAP #3** — Notes / case-notes / work-notes / files are add-only. Add remove (soft-delete) end-to-end.
- **GAP #4** — Decide + implement how the doctor influences the LIVE summary mid-visit (notes already propagate; direct edits are only possible post-stop). Present options; default to the surgical one.
- **GAP #5** — Extract text from uploaded lab/exam files (OCR/parse) so the **contents** (not just the filename) reach the live summary and the harness. Scoped as the last, largest item; safe to land as a follow-up.

Plus the audit recommendations: **R1** real live STT/SMR/NLP E2E validation; **R2** fix the `capture-panel.tsx:61` SYSTEM-tenant pipeline fallback footgun; **R3** surface a clear "no transcript persisted" state in Review instead of an indefinite spinner (a UX backstop that becomes moot once GAP #1 lands, but valuable defense-in-depth).

### Business context

The doctor's mental model is: "I talk, I jot notes / attach a lab, I stop, and the system hands me an accurate SOAP that reflects everything I added." Today the live panel shows that experience, but the **system-of-record** (the harness-drafted, gate-reviewed, signable SOAP) is produced only for **batch-uploaded** audio and **ignores** every note/lab the doctor added. For live consultations the authoritative note is either never produced (GAP #1) or produced without the doctor's context (GAP #2). This ticket makes the durable output match the live experience — the core promise of the workspace.

### Acceptance criteria (concrete + verifiable)

1. **GAP #1 / propagation crux** — After a live streaming consultation is recorded and **Stop** is pressed, a `TRANSCRIPT` `ContextItem` is persisted for that consultation and a `ConsultationPipelineEvent.TranscriptionCreated` is emitted exactly once, triggering the harness (when `harnessEnabled`) or the legacy auto-summary; a Review-tab poll then resolves to a drafted note rather than timing out. *Verified by: a service/unit test asserting the streaming-finalize seam persists a transcript + emits the event once; STT pytest asserting `gateway.create_transcript` is invoked from `_finalize_session` for a session with a `consultation_id`.*
2. **GAP #2** — `HarnessInternalService.assemble` includes `CASE_NOTE` + `WORKNOTE` + `ATTACHMENT` content in the assembled prompt (rendered via a new `PromptAssemblyParams` field), and omitting them when none exist leaves the prompt unchanged. *Verified by: `prompt-assembly.service.test.ts` (block rendered/empty) + `harness-internal.service.test.ts` (notes fetched + threaded).*
3. **GAP #3** — `DELETE /consultations/:id/context/:contextId` soft-deletes the item (`resourceStatus = DELETED`), broadcasts `SysEvent.ResourceDeleted`, and the item disappears from `GET /consultations/:id/context`; the workspace context list shows a remove control that invalidates the query. *Verified by: `context.service.test.ts` (softDelete + broadcast), controller test (route + ownership), `context-panel.test.tsx` (remove control).*
4. **GAP #4** — Either the doctor can seed/pin text that the next live flush honors, **or** the README + UI explicitly document that live influence is via notes and direct edits are post-stop in Review. The chosen path is implemented and tested. *Verified by: the live-summary panel test for the documented affordance (and, if the seed option is taken, a `live-documentation.service.test.ts` case that the seeded baseline survives one flush).*
5. **GAP #5** — Uploaded lab/exam file text is extracted and reaches both the live summary (`handleContextAdded` content) and harness assemble (attachment block), not just the filename. *Verified by: extraction unit test + assemble/live tests asserting extracted text (not the `Lab/exam result: <name>` label) is threaded.* (May land as a follow-up PR — see Out of scope.)
6. **R2** — `capture-panel.tsx` no longer silently falls back to the SYSTEM-tenant `DEFAULT_TRANSCRIPTION_PIPELINE_ID` for a customer-tenant doctor; it surfaces an actionable error instead of a cross-tenant 404 on session start. *Verified by: a cockpit/capture test for the no-pipeline path.*
7. **Gates** — applications build, api build, applications unit tests, ui-playground build + unit tests (`test`, not `test:unit`), Python STT tests, and `ReadLints` clean on all changed files (see §4 gates).

### Out of scope

- New Prisma models/enums/columns (none needed — see Migration row).
- Token-by-token streaming SOAP UI (still out, per TASK-340/341).
- Changing the cockpit's impersonation/SDK-auth model or the admin live console (TASK-341).
- Any DB `DELETE`/`DROP`/`TRUNCATE` — GAP #3 is soft-delete only.
- **GAP #5 heavy OCR**: full image OCR (e.g., scanned PDFs/photos) may be split into its own follow-up PR if it requires a new dependency/service; text-extractable uploads (txt/CSV/searchable-PDF) are the in-scope minimum. The seam (where extracted text is threaded) is delivered regardless.

---

## 2. Current State Evaluation

End-to-end traces with verified `file:line` evidence (re-read while drafting; the audit's references are accurate except two items called out as **[drift]**).

### Per-feature wiring


| #   | Feature                                       | State                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Realtime transcription                        | Wired (code); unconfirmed live    | Mic → `apps/ui-playground/src/hooks/use-realtime-transcription.ts` → `StreamingAudioBridgeService` (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`) → STT → results back into `LiveDocumentationService.attachSttStream` (`live-documentation.service.ts:568-597`) → `ingestSegment` (`:327`). Captions are client-only (not persisted).                                                                                                                      |
| 2   | Realtime summarization (Live SOAP)            | Wired (code); unconfirmed live    | `live-documentation.service.ts` debounce/flush (`:327-346`, `:376`), `callSmr` (`:749-770`), `callNlp` (`:772-786`), publish to Redis `consultation:live-summary:{id}` (`safePublish :810-822`, `CHANNEL_PREFIX :108`); SSE `GET /consultations/:id/live-summary/stream` (`apps/api/.../consultation.controller.ts:491-503`); UI `use-live-summary-stream.ts` + `live-summary-panel.tsx`.                                                                                                         |
| 3   | Note-taking & highlighting                    | Partial                           | Notes add via `context-panel.tsx` → `POST /consultations/:id/context` (`consultation.controller.ts:528-531`) → `ContextService.addContext` (`context.service.ts:77-153`). AI/NLP highlights rendered as `<mark>` over the **AI** summary (`live-summary-panel.tsx:124-141`). **GAPS:** no manual doctor highlighting; no removal; highlights only over the AI summary.                                                                                                                            |
| 4   | Case notes add/remove                         | Partial (add only)                | `CASE_NOTE` add persists + `broadcastSysEvent(ResourceCreated)` + emits `ContextAdded` (`context.service.ts:125-150`); live reflection via `LiveDocumentationService.handleContextAdded` (`live-documentation.service.ts:352-361`). **REMOVE MISSING** end-to-end (no UI control, no DELETE route, no service/repo delete).                                                                                                                                                                       |
| 5   | Notes / Work notes add/remove                 | Partial (add only)                | `CASE_NOTE` + `WORKNOTE` both in `LIVE_CONTEXT_TYPES` (`context.service.ts:53`), both add-only; **REMOVE MISSING** at every layer.                                                                                                                                                                                                                                                                                                                                                                |
| 6   | File upload                                   | Partial                           | UI uploads to object storage then `addContextItem({type:'ATTACHMENT', mediaId, content:'Lab/exam result: <name>', metadata:{subType:LAB_RESULT}})` (`context-panel.tsx:73-93`); persisted with `mediaId` + `metaData` (`context.service.ts:98-150`). **GAPS:** only the filename label reaches the summarizer — `handleContextAdded` uses `contentPreview = content.slice(0,2000)` = `"Lab/exam result: <name>"` (`context.service.ts:148`); no OCR/extraction; no remove; not in the final SOAP. |
| 7   | **Continuous context propagation (the crux)** | Partial; durable layer **broken** | See the two broken seams below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |


### The propagation crux (feature 7), broken at the durable layer

- **(a) Context → LIVE summary: WIRED.** `ContextAdded` (`context.service.ts:138-150`) → `handleContextAdded` (`live-documentation.service.ts:352-361`) pushes the note into `session.contextNotes`, threaded into `buildSmrUserPrompt(priorNote, delta, notes)` (`:410`, `:730-747`).
- **(b) Doctor editing the LIVE summary mid-visit: NOT POSSIBLE.** `live-summary-panel.tsx` is read-only (presentational; `LiveSummaryPanelProps` is prop-driven, no edit affordance). The only direct edit is **post-stop** via `PATCH /consultations/:id/summary/:summaryId` on the harness draft (`consultation.controller.ts:714-729` → `summaryService.updateSummary`).
- **(c) Context → FINAL authoritative SOAP (harness): BROKEN at two seams.**
  - **SEAM 1 (GAP #1).** The harness fires on `ConsultationPipelineEvent.TranscriptionCreated` (`consultation-event.handler.ts:70`, harness branch `:123-149`), emitted **only** by `SttInternalService.createTranscript` (`sttInternal.service.ts:92-101`), which is called **only** by the BATCH file worker (`apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py:318`). The STREAMING finalize path (`apps/stt-v2/src/stt_v2/streaming/session_manager.py:_finalize_session :1648-1801`) uploads a transcript JSON blob (`:1733-1746`) + registers audio media via `_register_dual_capture` (`:1772-1776`, which uses `session.consultation_id`) but **never calls `create_transcript`**. Net: after **Stop**, no `TRANSCRIPT` is persisted, the harness is never triggered, and the Review tab's `useDraftReadiness` poll (`apps/ui-playground/.../api/queries.ts:75-113`) spins to its timeout.
  - **SEAM 2 (GAP #2).** Even when triggered, `HarnessInternalService.assemble` (`harness-internal.service.ts:102-147`) gathers only `findTranscripts` (`:115`) + `loadNerEntities` (`:118`); `PromptAssemblyParams` (`prompt-assembly.service.ts:79-96`) has **no field** for case-notes/work-notes/attachments, so they never reach the authoritative prompt.

### Verified helpers / contracts (reuse these)

- **Repository read helpers exist** on `ContextItemRepository` (`packages/domains/.../core/ContextItemRepository.ts`): `findCaseNotes` (`:52`), `findWorknotes` (`:59`), `findAttachments` (`:300`), `findTranscripts` (`:45`). **[drift]** The audit calls these `ContextService.findCaseNotes/...`; the **service** methods are `getCaseNotes`/`getWorknotes`/`getAttachments` (`context.service.ts:765/773/867`, return DTOs). For GAP #2 reuse the **repository** methods directly — `HarnessInternalService` already injects `contextItemRepository` (`harness-internal.service.ts:47`), so it should call `this.contextItemRepository.findCaseNotes(...)` etc. (entities), **not** the service.
- **Soft-delete exists** on the base `Repository.softDelete(id, updatedBy?)` (`packages/domains/src/common/repository.ts:260`): sets `resourceStatus = DELETED` + `resourceStatusUpdatedAt` (+ `resourceStatusUpdatedBy`) + bumps `_version`; guarded by `supportsSoftDelete` (model must have `resourceStatus` — `ContextItem` does). All `ContextItemRepository` reads already filter `resourceStatus: ENABLED`, so a soft-deleted item drops out of every list automatically.
- `**ContextService` has NO delete method**, and `IContextService` (`context/IContextService.ts`) declares **no** delete abstract — GAP #3 must add one.
- `**SysEventType.ResourceDeleted`** exists (`packages/domains/src/enums/sysEventType.enum.ts:5`).
- **Harness assemble is service-to-service inside apps/api**: route `POST /internal/harness/consultations/:id/assemble` (`apps/api/.../harness-internal.controller.ts:72-77`) → `HarnessInternalService.assemble`, which re-loads everything server-side from `consultationId`. ⇒ **GAP #2 needs NO `apps/harness`/Temporal/Python change.**
- **[drift] GAP #1 `create_transcript` requires a `job_id`.** `gateway.create_transcript(job_id, transcript_text, metadata, consultation_id)` exists (`apps/stt-v2/.../api_client/gateway.py:256-287`) but `jobId` is **required**, and `SttInternalService.createTranscript` does `jobRepository.findById(dto.jobId)` → throws `NotFound` when absent (`sttInternal.service.ts:54-57`). **Streaming sessions have NO `TranscriptionJob`** — a grep of `apps/stt-v2/src/stt_v2/streaming` finds zero `job_id`/`TranscriptionJob` references; the session carries `consultation_id` (`streaming/session.py:134`) and `build_transcript_json()` (`:301`) only. So the audit's "mirror `transcribe_file.py:318`" is **not literal** — the batch path always has a job; the streaming path does not. The smallest fix must let a transcript be created from a `consultationId` **without** a `jobId` (see GAP #1 tasks).

### "Unconfirmed live / engine down" caveat

Features 1, 2, and 7(a) are wired in code but were **never validated against real STT/SMR/NLP** — the GPU/model host was unavailable during TASK-339/340/341 (TASK-340 §7, TASK-341 §7 document STT 8861 / SMR 8862 / NLP 8864 all down). This plan de-risks structurally via unit tests; **R1** schedules the one true live E2E smoke once a GPU/LM-Studio host (and a mounted NLP model cache) is available.

---

## 3. Implementation Plan

Layer order **Database → Domain → Services → API → Frontend (+ Python for GAP #1)**, gaps sequenced by priority **#1 → #2 → #3 → #4 → #5**. TDD (RED → GREEN → REFACTOR) per `01-development-workflow.mdc`: write the failing test first, watch it fail for the right reason, then the smallest code to pass. No Database/Domain schema work is required (see Migration row); the only Domain-layer touch is reusing existing repo helpers + adding one service method (GAP #3).

### 3.1 TDD test list (RED → GREEN), by layer + placement


| Layer / placement                                                                                                                           | New / extended test                                                       | Asserts (the behavior, not the mechanics)                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python — `apps/stt-v2/tests/`** (pytest, conda `arcaenv`)                                                                                 | `streaming/test_session_finalize_transcript.py` (new) **[GAP #1]**        | `_finalize_session` for a session with `consultation_id` calls `gateway.create_transcript` (or the new no-job variant) exactly once with the assembled transcript text; a session **without** `consultation_id` does not; gateway failure is swallowed (finalization still closes). |
| **Python — `apps/stt-v2/tests/`**                                                                                                           | `core/api_client/test_gateway_create_transcript.py` (extend) **[GAP #1]** | the new/updated client method posts `{ transcriptText, consultationId, tenantId }` (no `jobId`) to `/internal/stt/transcripts`.                                                                                                                                                     |
| **Services — `packages/applications/src/services/stt/internal/__tests__/sttInternal.service.test.ts`** (Vitest) **[GAP #1]**                | extend                                                                    | `createTranscript` with `{ consultationId, transcriptText }` and **no `jobId`** persists a `TRANSCRIPT` `ContextItem` and emits `TranscriptionCreated` once; still works with a `jobId` (no regression).                                                                            |
| **Services — `packages/applications/.../consultation/prompt/__tests__/prompt-assembly.service.test.ts`** (Vitest) **[GAP #2]**              | new/extend                                                                | when `clinicianNotes`/`attachments` are present they render into the prompt (template var consumed **or** appended block, mirroring the NER block at `prompt-assembly.service.ts:149-154`); empty ⇒ prompt unchanged.                                                               |
| **Services — `packages/applications/.../consultation/harness/__tests__/harness-internal.service.test.ts`** (Vitest) **[GAP #2]**            | extend                                                                    | `assemble` fetches `findCaseNotes`/`findWorknotes`/`findAttachments` and threads them into `promptAssemblyService.assemble(...)`; with none present the assembled prompt is unchanged.                                                                                              |
| **Services — `packages/applications/.../consultation/context/__tests__/context.service.test.ts`** (Vitest) **[GAP #3]**                     | new                                                                       | `deleteContext(id)` asserts parent-in-tenant, calls `contextItemRepository.softDelete(id, userId)`, broadcasts `SysEvent.ResourceDeleted`; cross-tenant/missing → `NotFound`.                                                                                                       |
| **Services — `live-documentation.service.test.ts`** (Vitest) **[GAP #3 optional / #4 optional]**                                            | extend                                                                    | (#3 opt) `handleContextRemoved` drops the matching note from `contextNotes`; (#4 opt) a seeded baseline (`seedRunningSummary`) survives one flush as `priorNote`.                                                                                                                   |
| **API — `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts`** (Vitest) **[GAP #3]**                               | extend                                                                    | `DELETE :id/context/:contextId` verifies ownership then calls `contextService.deleteContext`; returns 200/204.                                                                                                                                                                      |
| **Frontend — `apps/ui-playground/.../clinical-workspace/components/__tests__/context-panel.test.tsx`** (Vitest, script `test`) **[GAP #3]** | new/extend                                                                | each "Added context" row renders a remove control; clicking calls the delete API + invalidates `clinicalWorkspaceKeys.context`; toast on success/error.                                                                                                                             |
| **Frontend — `.../clinical-workspace/components/__tests__/capture-panel.test.tsx`** (Vitest) **[R2]**                                       | new/extend                                                                | with no resolved tenant pipeline, Start is blocked with an actionable error (no silent SYSTEM-default fallback).                                                                                                                                                                    |
| **Frontend — review surface test (`review-panel`/`cockpit`)** (Vitest) **[R3]**                                                             | extend                                                                    | when the draft poll times out with no transcript, a clear "no transcript was captured" state renders (not an endless spinner).                                                                                                                                                      |
| **Services / Python — extraction** (Vitest + pytest) **[GAP #5]**                                                                           | new                                                                       | extracted attachment text (not the filename label) is what flows into `handleContextAdded` content + the assemble attachment block.                                                                                                                                                 |


### 3.2 Task breakdown (bite-sized; each names the exact file + smallest change + a verify step)

#### GAP #1 — Persist a transcript from streaming finalize so the harness auto-drafts (CRITICAL, first)

> **Why first:** without it, no live visit ever produces the authoritative SOAP. **Recommended approach: Option A** (persist at the STT streaming-finalize seam). Rationale + the Option B alternative + trade-offs are in §3.3.

1. **(Services, RED→GREEN) Relax the transcript-create contract to allow no `jobId`.**
  - File: `packages/applications/src/services/stt/internal/dto/internal.request.ts` — `class CreateTranscriptRequest` (`:8`) today has `jobId: string` **required** (`:16`), `transcriptText: string` (`:23`), and `consultationId?: string` **already optional** (`:38`). Change: make `jobId` optional (`@ApiPropertyOptional` + `@IsOptional()`), and **add** an optional `tenantId?: string` (today `tenantId` is sourced from `job.tenantId` — absent on the no-job streaming path). This DTO is shared by the internal controller, so the API request shape is covered here too (no separate API DTO — resolves task 4).
  - File: `packages/applications/src/services/stt/internal/sttInternal.service.ts:52-104` — when `dto.jobId` is present keep today's behavior (find job, `setContextItem`, attribute `createdBy`/`tenantId` from job); when absent, require `dto.consultationId` (+ `dto.tenantId`), create the `TRANSCRIPT` `ContextItem` from them, skip the job lookup/`setContextItem`, and still emit `TranscriptionCreated` (`:92-101`). Add an **idempotency guard**: if a `TRANSCRIPT` already exists for the consultation, update/skip instead of double-creating (reuse `contextItemRepository.findTranscripts`).
  - Verify: extend `sttInternal.service.test.ts` (no-job path persists + emits once; job path unchanged) → `pnpm --filter @arcaai/applications test:unit`.
2. **(Python, RED→GREEN) Add/extend the gateway client method for no-job transcript create.**
  - File: `apps/stt-v2/src/stt_v2/core/api_client/gateway.py:256-287` — make `job_id` optional and only include `jobId` in the payload when provided (the method already conditionally adds keys), so it can post `{ transcriptText, consultationId, tenantId }` alone.
  - Verify: extend `tests/.../test_gateway_create_transcript.py` → `pnpm py:stt:test` (or `conda run -n arcaenv pytest apps/stt-v2/tests/...`).
3. **(Python, RED→GREEN) Call `create_transcript` from `_finalize_session`.**
  - File: `apps/stt-v2/src/stt_v2/streaming/session_manager.py:_finalize_session :1648-1801` — after the transcript blob upload (`:1733-1746`) and alongside `_register_dual_capture` (`:1772-1776`), when `session.consultation_id` is set, call `gateway.create_transcript(transcript_text=<assembled text>, consultation_id=session.consultation_id, tenant_id=session.tenant_id)`. **Self-guarded + non-fatal** (mirror the existing `try/except … (non-fatal)` blocks) so finalization always closes the session.
  - **VERIFY**: a plain-text accessor for the transcript. `session.build_transcript_json()` (`streaming/session.py:301`) returns JSON bytes; confirm/add a `.transcript_text` (or concatenate finalized utterances) so we send text, not JSON. If only JSON exists, add a tiny helper rather than sending the blob.
  - Verify: new `tests/streaming/test_session_finalize_transcript.py` → `pnpm py:stt:test`.
4. **(API, GREEN) No route or separate-DTO change needed** — `/internal/stt/transcripts` already maps to `SttInternalService.createTranscript`, and the controller binds the same `CreateTranscriptRequest` (`dto/internal.request.ts`) relaxed in task 1, so the API request shape is already covered.
  - Verify: `pnpm build:api`.
5. **(R3, Frontend) Surface a "no transcript" state in Review** (defense-in-depth; harmless once #1 lands).
  - File: `apps/ui-playground/src/features/clinical-workspace/lib/draft-polling.ts` + the Review surface consuming `useDraftReadiness` (`api/queries.ts:75-113`) — when `status === 'timed-out'` and no transcript/draft exists, render an explicit empty/error state with a retry, not a spinner.
  - Verify: review/cockpit test → `pnpm --filter @arcaai/ui-playground test`.

#### GAP #2 — Fold doctor case-notes/work-notes/attachments into harness assemble (CRITICAL)

1. **(Services, RED→GREEN) Add prompt fields + rendering.**
  - File: `packages/applications/.../consultation/prompt/prompt-assembly.service.ts` — add optional `clinicianNotes?: string[]` and `attachments?: string[]` to `PromptAssemblyParams` (`:79-96`); in `buildVariables` (`:182`) define `clinician_notes` / `attachments` variables; in `assemble` (`:126`) append a labeled block if the template didn't consume them (mirror the NER block at `:149-154`).
  - Verify: `prompt-assembly.service.test.ts` (rendered/empty) → `pnpm --filter @arcaai/applications test:unit`.
2. **(Services, RED→GREEN) Fetch + thread notes in assemble.**
  - File: `packages/applications/.../consultation/harness/harness-internal.service.ts:assemble :102-147` — after `loadNerEntities` (`:118`), fetch `this.contextItemRepository.findCaseNotes(consultationId)`, `findWorknotes(...)`, `findAttachments(...)`; map each to its `content` (attachments: use extracted text from GAP #5 when present, else the `Lab/exam result: <name>` label); pass `clinicianNotes` + `attachments` into `promptAssemblyService.assemble({...})` (`:120-128`).
  - **Decision flag:** `WORKNOTE` is "internal / not patient-facing". This plan includes it (labeled `[work note]`) per the audit; confirm with product whether internal work notes belong in the authoritative SOAP — if not, drop `findWorknotes` from this list (one-line change).
  - Verify: `harness-internal.service.test.ts` → `pnpm --filter @arcaai/applications test:unit`; `pnpm build:api`.
  - **No `apps/harness`/Temporal change** (assemble re-loads server-side).

#### GAP #3 — Remove/delete for notes / case-notes / work-notes / files (add-only → add+remove)

1. **(Services, RED→GREEN) Add `deleteContext`.**
  - Files: `packages/applications/.../consultation/context/IContextService.ts` (add `abstract deleteContext(contextItemId: string): Promise<void>`); `context.service.ts` (impl: `assertParentInScope(this.contextItemRepository, contextItemId, tenantId)` → `this.contextItemRepository.softDelete(contextItemId, userId)` → `broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId, … })`). Optionally emit a new `ConsultationPipelineEvent.ContextRemoved` for live drop-out.
  - Verify: `context.service.test.ts` → `pnpm --filter @arcaai/applications test:unit`.
2. **(API, RED→GREEN) Add the DELETE route.**
  - File: `apps/api/src/modules/consultation/consultation.controller.ts` (near `addContext :528-531`) — `@Delete(':id/context/:contextId')` → `verifyConsultationOwnership(id)` → `contextService.deleteContext(contextId)`. Match the existing `@ApiEndpoint`/ownership pattern.
  - Verify: `consultation.controller.test.ts` → `pnpm build:api`.
3. **(Frontend, RED→GREEN) Wire the remove control.**
  - Files: `apps/ui-playground/.../clinical-workspace/constants.ts` (add `contextItem: (id, contextId) => /consultations/${id}/context/${contextId}` to `WORKSPACE_ENDPOINTS`, alongside `context :42`); `api/clinical-workspace.api.ts` (add `deleteContextItem(client, consultationId, contextId)` → `client.delete(...)`); `components/context-panel.tsx` (add an `X`/trash control to each "Added context" `<li>` at `:199-206` → calls delete + `invalidate()` + `toast`).
    - Verify: `context-panel.test.tsx` → `pnpm --filter @arcaai/ui-playground test`; `pnpm --filter @arcaai/ui-playground build`.
4. **(Services, optional) Live drop-out.**
  - File: `live-documentation.service.ts` — `@OnEvent(ConsultationPipelineEvent.ContextRemoved) handleContextRemoved` removes the matching entry from `session.contextNotes` + `scheduleFlush`. **Caveat:** `contextNotes` is a `string[]` (`LiveSession.contextNotes`), not keyed by `contextItemId`; to remove precisely, key notes by id (small refactor of `handleContextAdded :352-361`). If deferred, removed notes simply stop being re-added on the next session and the durable SOAP excludes them (GAP #2 reads live DB state) — acceptable.
    - Verify: `live-documentation.service.test.ts`.

#### GAP #4 — Doctor influence on the LIVE summary mid-visit

> Present both; **recommended: Option (b)** (document + rely on notes) as the surgical default, with Option (a) as a scoped optional enhancement.
>
> 1. **(Default — Option b, docs + UI affordance)** Document in this README + add a one-line cockpit hint that mid-visit influence is via Case/Work notes (already propagated, §1(a)), and direct edits happen post-stop in Review via `PATCH /consultations/:id/summary/:summaryId` (`consultation.controller.ts:714-729`). No engine change. Verify: review/cockpit test renders the affordance.
> 2. **(Optional — Option a, seed/pin)** Add `LiveDocumentationService.seedRunningSummary(consultationId, text)` that sets `session.lastPayload.runningSummary` so the next `buildSmrUserPrompt` uses it as `priorNote` (`:409-410`), + a controller endpoint `POST :id/live-summary/seed` (owner-guarded), + a small editable affordance in `live-summary-panel.tsx`. **Trade-off:** the incremental prompt instructs the model to *keep prior content unless contradicted* (`:734`), so a manual edit is honored as a baseline but can still be revised by subsequent transcript — acceptable for "influence", not a locked override. Verify: `live-documentation.service.test.ts` (seeded baseline survives one flush).

#### GAP #5 — Extract text from uploaded lab/exam files (so contents reach live + harness)

1. **(Services/Python, RED→GREEN) Extract on upload, store extracted text.**
  - Minimum in-scope: for text-extractable uploads, extract on add and store the text in `ContextItem.content` (replacing/augmenting the `Lab/exam result: <name>` label) or in `metaData.extractedText`. Touch points: `context-panel.tsx:73-93` (upload) and/or `ContextService.addContext` (`context.service.ts:98-150`), so `contentPreview` (`:148`) carries real text into `handleContextAdded`, and GAP #2's attachment block (task 7) reads it.
    - **Heavy OCR (scanned PDF/images)** may require a new dependency or a small extraction step in a Python service — if so, split into a follow-up PR (see Out of scope); deliver the **seam** (where extracted text is threaded) regardless.
    - Verify: extraction unit test + assemble/live tests asserting extracted text (not the label) flows through → relevant package test gate.

#### R2 — Pipeline fallback footgun (independent, can land anytime)

1. **(Frontend, RED→GREEN)** File: `apps/ui-playground/.../clinical-workspace/components/capture-panel.tsx:61` — replace the silent `?? DEFAULT_TRANSCRIPTION_PIPELINE_ID` fallback for customer tenants with an explicit guard: if no `pipelineId` prop and no `resolvedConfig?.stt?.transcriptionPipelineId`, block Start with an actionable toast/error rather than attempting a cross-tenant SYSTEM-default that 404s on session start (the file's own comment at `:56-60` documents the hazard). Verify: `capture-panel.test.tsx` → `pnpm --filter @arcaai/ui-playground test`.

### 3.3 GAP #1 — Option A vs Option B (decision)


|                               | **Option A (recommended): persist at STT streaming finalize**                                                                               | **Option B: persist at `POST /recording/stop`**                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where                         | `session_manager._finalize_session` → `gateway.create_transcript(consultation_id, …)` (tasks 1-4)                                           | `consultation.controller.ts:478-489` → `SttInternalService.createTranscript` + emit `TranscriptionCreated`                                                                                                                                              |
| Canonical transcript text     | **Lives here** — `session.build_transcript_json()`/utterances are the authoritative STT output                                              | **Not here** — apps/api only has the lossy in-memory `LiveDocumentationService.session.transcriptParts` (final segments it happened to receive; lost on a non-owner instance), so it would have to re-read the STT transcript blob cross-service anyway |
| Mirrors existing contract     | Yes — same `/internal/stt/transcripts` → `TranscriptionCreated` → harness path the **batch** worker already uses (`transcribe_file.py:318`) | Partially — reuses the service method but invents a new text source                                                                                                                                                                                     |
| apps/api stays sole DB writer | Yes (via the existing internal endpoint)                                                                                                    | Yes                                                                                                                                                                                                                                                     |
| Idempotency / ordering        | One finalize per session; guard double-create (task 1); runs after transcript build, alongside media registration (`:1772-1776`)            | `/recording/stop` already calls `liveDocumentationService.stop()` (finalizes the **summary** snapshot, not the transcript); would need to interleave a transcript fetch + create + event                                                                |
| Main wrinkle                  | Streaming sessions have **no `TranscriptionJob`** → relax `createTranscript` to accept `consultationId` without `jobId` (task 1)            | Same no-job wrinkle **plus** sourcing the canonical transcript text                                                                                                                                                                                     |


**Recommendation: Option A** — the complete, canonical transcript already exists at the finalize seam; it reuses the proven batch contract end-to-end and keeps apps/api the sole writer, whereas Option B must re-fetch that same blob (or accept lossy live-doc text) to do strictly less.

**Decision**: Option A

---

## 4. Verification Criteria / Gates

Run from repo root via **zsh**; capture real output as evidence (per `01-development-workflow.mdc` + `verification-before-completion`). Command nuances reuse TASK-340 §6 / TASK-341 §6/D4:


| Gate                     | Command                                                                     | Notes                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applications build       | `pnpm build --filter @arcaai/applications`                                  | —                                                                                                                                                                |
| API build                | `pnpm build:api`                                                            | `nest build && tsc-alias`                                                                                                                                        |
| Applications unit tests  | `pnpm --filter @arcaai/applications test:unit`                              | **Filter at the pnpm level**, never `pnpm test:unit --filter …` (forwards `--filter` to vitest → error, per TASK-340 §6).                                        |
| UI-playground build      | `pnpm --filter @arcaai/ui-playground build`                                 | —                                                                                                                                                                |
| UI-playground unit tests | `pnpm --filter @arcaai/ui-playground test`                                  | `**test`, not `test:unit`** — ui-playground has **no `test:unit` script** (`= vitest run`); `test:unit` errors `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` (TASK-341 D4). |
| Python (STT) tests       | `pnpm py:stt:test` (or `conda run -n arcaenv pytest apps/stt-v2/tests/...`) | conda `arcaenv` per project rules (confirm env if unsure). GAP #1 only.                                                                                          |
| Lint                     | `ReadLints` on every changed/created file                                   | Fix newly-introduced lints; leave pre-existing ones (surgical-change rule).                                                                                      |
| (R1) Live E2E smoke      | manual, once GPU/LM-Studio + NLP cache available                            | STT 8861 / SMR 8862 / NLP 8864 healthy → record live → Stop → transcript persisted → harness draft appears in Review with notes/labs reflected.                  |


Completion checklist (per workflow): all new/modified tests pass (paste output), affected packages build (paste output), `ReadLints` clean on modified files, barrel exports + module registrations updated where files are added, and §5 below filled with the implementation summary + change-history entry.

---

## 5. Implementation Summary

Implemented GAP #1–#5 + R2 + R3 (Services → API → Frontend, strict TDD). GAP #3d (live drop-out), GAP #5 heavy OCR, and R1 (live E2E) remain deferred with rationale (see **Remaining / Deferred** below). All gates GREEN (see **Verification Evidence**).

### 5.1 GAP #1 — Persist a transcript from streaming finalize (CRITICAL)

A live (streaming-mic) consultation now persists a `TRANSCRIPT` `ContextItem` on **Stop**, so the harness auto-draft pipeline (`TranscriptionCreated → ConsultationEventHandler → HarnessGatewayService.start`) fires for live visits — previously only the batch file worker did this.

- **Services** — `CreateTranscriptRequest` (`packages/applications/src/services/stt/internal/dto/internal.request.ts`) relaxed: `jobId` is now `@ApiPropertyOptional` + `@IsOptional()`; added optional `tenantId?`; `consultationId?` already optional. `SttInternalService.createTranscript` (`sttInternal.service.ts`) keeps the existing job path unchanged and adds a no-job branch: when `jobId` is absent it requires `consultationId` (+ `tenantId`), creates the `TRANSCRIPT` `ContextItem` directly, emits `TranscriptionCreated` once, and is idempotent (skips when a transcript already exists for the consultation via `findTranscripts`). `TranscriptionCreatedPayload.jobId` is now optional (`consultation/events/consultation.events.ts`).
- **Python (STT)** — `gateway.create_transcript` (`apps/stt-v2/src/stt_v2/core/api_client/gateway.py`) makes `job_id` optional and only includes `jobId` in the payload when present. `session_manager._finalize_session` (`streaming/session_manager.py`) now calls `gateway.create_transcript(transcript_text=…, consultation_id=…, tenant_id=…)` after the transcript-blob upload — self-guarded + non-fatal so finalization always closes. A plain-text transcript accessor was confirmed/added in `streaming/session.py`.
- **API** — no route/DTO change needed; `/internal/stt/transcripts` already binds the relaxed `CreateTranscriptRequest`.
- **Tests** — `sttInternal.service.test.ts` (no-job persists + emits once; job path unchanged), `apps/stt-v2/tests/unit/test_api_client.py`, `apps/stt-v2/tests/unit/test_streaming_recording.py`.

### 5.2 GAP #2 — Fold doctor case-notes / work-notes / attachments into harness assemble (CRITICAL)

The authoritative-SOAP prompt now includes the doctor's mid-visit context, not just transcripts + NER.

- **Services** — `PromptAssemblyParams` (`consultation/prompt/prompt-assembly.service.ts`) gained `clinicianNotes?: string[]` and `attachments?: string[]`; `buildVariables` always defines `clinician_notes` / `attachments` (empty when none); `assemble` appends labeled `--- CLINICIAN NOTES (case / work notes) ---` and `--- ATTACHMENTS (lab / exam results) ---` blocks when the template didn't already consume them (mirrors the NER block). Empty ⇒ prompt unchanged.
- **Services** — `HarnessInternalService.assemble` (`consultation/harness/harness-internal.service.ts`) fetches `contextItemRepository.findCaseNotes` / `findWorknotes` / `findAttachments` (entities, not DTOs), maps to content (work notes labeled `[work note]`; attachments use the extracted file text when present — GAP #5, §5.5 — else the `Lab/exam result: <name>` label), and threads `clinicianNotes` + `attachments` into `promptAssemblyService.assemble({...})`. Because reads filter `resourceStatus: ENABLED`, soft-deleted items (GAP #3) are excluded automatically.
- **No `apps/harness`/Temporal/Python change** — assemble re-loads everything server-side from `consultationId`.
- **Tests** — `prompt-assembly.service.test.ts` (block rendered/empty), `harness-internal.service.test.ts` (notes fetched + threaded).

### 5.3 GAP #3 — Remove/delete for notes / case-notes / work-notes / files (add-only → add + remove)

End-to-end soft-delete. **New endpoint: `DELETE /consultations/:id/context/:contextId`** → `{ ok: true }`.

- **Services** — `IContextService.deleteContext(contextItemId): Promise<void>` (abstract) + impl in `consultation/context/context.service.ts`: guards `tenantId` (`BadRequestException`), `assertParentInScope(this.contextItemRepository, contextItemId, tenantId)` (throws `NotFoundException` for missing **and** cross-tenant — never reveals foreign-tenant items), `contextItemRepository.softDelete(contextItemId, userId)` (base `Repository.softDelete` → `resourceStatus = DELETED`; **no hard delete**), then `broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId, data: { consultationId, type } })`. All `ContextItemRepository` reads filter `resourceStatus: ENABLED`, so the item drops out of `GET …/context` and harness assemble automatically. **No migration** (uses existing `resourceStatus`).
- **API** — `@Delete(':id/context/:contextId')` on `apps/api/src/modules/consultation/consultation.controller.ts` next to `updateContext`: `verifyConsultationOwnership(id)` → `contextService.deleteContext(contextId)` → `OkResponseDto`. Same ownership pattern as the sibling write routes; `OkResponseDto` shape mirrors `deleteSummaryTag`.
- **Frontend** — `WORKSPACE_ENDPOINTS.contextItem(id, contextId)` (`clinical-workspace/constants.ts`); `deleteContextItem(client, consultationId, contextId)` → `client.delete(...)` (`api/clinical-workspace.api.ts`); a per-row remove control (`Trash2`, with `Loader2` while in flight) on each "Added context" `<li>` in `components/context-panel.tsx` that calls delete → `toast` → invalidates `clinicalWorkspaceKeys.context`.
- **Tests** — `context.service.test.ts` (softDelete + broadcast + cross-tenant/missing → NotFound), `consultation.controller.test.ts` (route wiring + ownership), new `context-panel.test.tsx` (remove control renders per row; click calls delete + invalidate + success toast; failure toast on error).

### 5.4 GAP #4 — Doctor influence on the LIVE summary mid-visit (Option b)

**Chosen path: Option (b)** — the surgical default. Mid-visit influence on the live summary is via **Case / Work notes** (already propagated into the live SMR prompt: `ContextAdded → handleContextAdded → buildSmrUserPrompt`, §1(a)); **direct** summary-text edits happen **post-stop** in Review via `PATCH /consultations/:id/summary/:summaryId` (`consultation.controller.ts:714-729`). No realtime-engine change. An unobtrusive one-line cockpit caption now makes this model explicit to the doctor at the point of action (the mid-visit context panel).

- **Frontend** — `components/context-panel.tsx`: a `data-testid="mid-visit-influence-hint"` caption under the "Mid-visit context" header — _"Case & work notes flow into the live summary as you add them. To edit the note text directly, finalize (Stop) and edit the draft in Review."_
- **Not built (documented future option):** Option (a) seed/pin (`LiveDocumentationService.seedRunningSummary` + `POST :id/live-summary/seed` + an editable live panel) is an explicitly optional enhancement — deferred (no engine/endpoint change this chunk).
- **Tests** — `context-panel.test.tsx`: asserts the hint renders and conveys both the live-summary influence and the post-stop Review edit path.

### 5.5 GAP #5 — Extract text from uploaded lab/exam files (bounded: seam + lightweight extractor)

The **threading seam** is delivered end-to-end, plus a **lightweight, dependency-free** extractor for trivially text-extractable uploads. Uploaded lab/exam **contents** (not just the `Lab/exam result: <name>` filename label) now reach both the live summary and the harness assemble.

- **Frontend (extractor)** — new `lib/extract-text.ts`: `extractTextFromFile(file)` reads `txt / text / csv / tsv / md / markdown / json / log` (by extension) or any `text/*` / `application/json` / `application/csv` MIME via the browser File API, trims, and caps at `MAX_EXTRACTED_CHARS` (20k). Binary/scanned formats return `null`; never throws.
- **Frontend (seam)** — `components/context-panel.tsx` `addLabResult`: extracts text on upload and threads it onto `metadata.extractedText` (the human-readable `content` label is preserved for the list UI). Binary uploads thread no text and fall back to the label.
- **Services (live seam)** — `context.service.ts` `addContext`: the `ContextAdded` `contentPreview` now prefers `metadata.extractedText` over `content`, so the **live summary** receives the file's real text via `handleContextAdded`.
- **Services (harness seam)** — `harness-internal.service.ts` `assemble`: the attachment block now prefers `metaData.extractedText`, falling back to the `content` label, so the **authoritative SOAP** prompt includes lab contents.
- **HARD CAP / DEFERRED — heavy OCR is a follow-up PR.** Scanned PDFs / images / Office docs (anything needing a new dependency or a Python OCR service) are **out of scope** here; the seam is delivered regardless and binary uploads gracefully fall back to the filename label.
- **Tests** — `extract-text.test.ts` (txt/csv/md/json extracted; MIME detection; binary → `null`; empty → `null`; size cap), `context.service.test.ts` (extracted text — not the label — in the live `contentPreview`), `harness-internal.service.test.ts` (extracted text preferred over the label in assemble), `context-panel.test.tsx` (a `.txt` upload threads `metadata.extractedText`).

### 5.6 R2 — Pipeline fallback footgun (capture-panel)

`capture-panel.tsx` no longer silently falls back to the SYSTEM-tenant `DEFAULT_TRANSCRIPTION_PIPELINE_ID` for a customer-tenant doctor. Resolution is now `pipelineId ?? resolvedConfig?.stt?.transcriptionPipelineId` (no hardcoded default); when nothing resolves, `handleStart` **blocks Start** with an actionable `toast.error` ("No transcription pipeline is configured for your account…") instead of attempting a cross-tenant pipeline that 404s mid-session. The now-unused `DEFAULT_TRANSCRIPTION_PIPELINE_ID` import (and its dead test mock) were removed.

- **Frontend** — `components/capture-panel.tsx`.
- **Tests** — `capture-panel.test.tsx`: the prior "falls back to the default" case is replaced with a no-pipeline guard test (Start blocked, `realtime.start` not called, actionable error toasted); the explicit-prop and resolved-config cases still pass.

### 5.7 R3 — Review "no transcript captured" state (defense-in-depth)

The Review surface already rendered a timed-out state with a "Check again" retry (not a spinner — pre-existing from TASK-339 FU2). R3 hardens it for the **GAP #1 failure mode** specifically: when the draft poll times out **with zero transcripts**, `ReviewPanel` now renders an explicit _"No transcript was captured for this visit"_ empty state (distinct `data-testid="review-no-transcript"`) with a retry, instead of the generic "draft is taking longer than expected" message that implies a draft is still en route. The page already wires `onRefreshDraft={draft.refetch}` (`clinical-workspace-page.tsx`).

- **Frontend** — `components/review-panel.tsx` (branch on `transcripts.length === 0` inside the existing `timed-out` block). `lib/draft-polling.ts` + `api/queries.ts` (`useDraftReadiness`) were reviewed; the timeout decision logic was already correct and left unchanged.
- **Tests** — `review-panel.test.tsx`: new case asserts the zero-transcript timeout renders the explicit "no transcript" state with a working retry (and not the generic timeout state); the has-transcript timeout case still renders the original state.

### 5.8 Deviations / deferrals

- **GAP #3d (live drop-out) — DEFERRED (documented).** The optional `@OnEvent(ContextRemoved) handleContextRemoved` in `live-documentation.service.ts` requires re-keying `LiveSession.contextNotes` (currently a `string[]`) by `contextItemId` plus a new `ConsultationPipelineEvent.ContextRemoved` event + emitter wiring + prompt-builder changes — a non-trivial, scope-expanding refactor. It is safe to defer: the **durable/authoritative SOAP already excludes soft-deleted items** because GAP #2's assemble reads live DB state (`resourceStatus: ENABLED`). The only residual is that within an *active* live session an already-folded note remains in the in-memory running summary until the session restarts. To avoid dead code, the `ContextRemoved` event was intentionally **not** added in this chunk. (Revisit alongside GAP #4/#5.)
- **R3 (Review "no transcript" state) — IMPLEMENTED this chunk (§5.7).** The Review timed-out + retry affordance pre-existed (TASK-339 FU2); R3 added the explicit zero-transcript variant (`review-no-transcript`) for the GAP #1 failure mode. `draft-polling.ts` decision logic was already correct and left unchanged (surgical-change rule).
- **GAP #4 Option (a) seed/pin — NOT built (documented future option).** Only the surgical Option (b) (docs + cockpit hint) was implemented per the plan; the seed/pin endpoint + engine change remains an explicitly optional enhancement (§5.4).
- **GAP #5 heavy OCR — DEFERRED (follow-up PR).** Only the threading seam + lightweight (txt/csv/md/json) extractor shipped; scanned-PDF / image / Office-doc OCR (a new dependency or a Python service) is a separate follow-up. Binary uploads fall back to the filename label until then (§5.5).

### Files changed (this chunk: GAP #3)

| Layer | File | Change |
| --- | --- | --- |
| Services | `packages/applications/.../consultation/context/IContextService.ts` | `abstract deleteContext(...)` |
| Services | `packages/applications/.../consultation/context/context.service.ts` | `deleteContext` impl (soft-delete + broadcast) |
| Services (test) | `packages/applications/.../consultation/context/__tests__/context.service.test.ts` | `deleteContext` suite (RED→GREEN) |
| API | `apps/api/src/modules/consultation/consultation.controller.ts` | `DELETE :id/context/:contextId` |
| API (test) | `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts` | route + ownership tests |
| Frontend | `apps/ui-playground/.../clinical-workspace/constants.ts` | `WORKSPACE_ENDPOINTS.contextItem` |
| Frontend | `apps/ui-playground/.../clinical-workspace/api/clinical-workspace.api.ts` | `deleteContextItem(...)` |
| Frontend | `apps/ui-playground/.../clinical-workspace/components/context-panel.tsx` | per-row remove control |
| Frontend (test) | `apps/ui-playground/.../clinical-workspace/components/__tests__/context-panel.test.tsx` | new test |

(GAP #1/#2 files are listed inline in §5.1/§5.2; they were completed in the prior chunk and verified GREEN here.)

### Files changed (this chunk: GAP #4, #5, R2, R3)

| Layer | File | Change |
| --- | --- | --- |
| Services | `packages/applications/.../consultation/context/context.service.ts` | GAP #5: `contentPreview` prefers `metadata.extractedText` |
| Services (test) | `packages/applications/.../consultation/context/__tests__/context.service.test.ts` | GAP #5: extracted-text preview test |
| Services | `packages/applications/.../consultation/harness/harness-internal.service.ts` | GAP #5: attachment block prefers `metaData.extractedText`, falls back to label |
| Services (test) | `packages/applications/.../consultation/harness/__tests__/harness-internal.service.test.ts` | GAP #5: extracted-text-over-label test |
| Frontend | `apps/ui-playground/.../clinical-workspace/lib/extract-text.ts` | GAP #5: new lightweight, dependency-free extractor (txt/csv/md/json) |
| Frontend (test) | `apps/ui-playground/.../clinical-workspace/lib/__tests__/extract-text.test.ts` | GAP #5: new extractor test |
| Frontend | `apps/ui-playground/.../clinical-workspace/components/context-panel.tsx` | GAP #4: mid-visit influence hint; GAP #5: extract + thread `metadata.extractedText` on upload |
| Frontend (test) | `apps/ui-playground/.../clinical-workspace/components/__tests__/context-panel.test.tsx` | GAP #4 hint + GAP #5 threading tests |
| Frontend | `apps/ui-playground/.../clinical-workspace/components/capture-panel.tsx` | R2: drop SYSTEM-default fallback; block Start with actionable error |
| Frontend (test) | `apps/ui-playground/.../clinical-workspace/components/__tests__/capture-panel.test.tsx` | R2: no-pipeline guard test (replaces silent-default test) |
| Frontend | `apps/ui-playground/.../clinical-workspace/components/review-panel.tsx` | R3: explicit "no transcript captured" timeout variant + retry |
| Frontend (test) | `apps/ui-playground/.../clinical-workspace/components/__tests__/review-panel.test.tsx` | R3: zero-transcript timeout test |

### Remaining / Deferred

Status is now **Completed** for the integration scope. The following are **explicitly deferred** (each safe to defer; rationale above):

- **GAP #3d — live drop-out (`handleContextRemoved`).** The durable/authoritative SOAP already excludes soft-deleted items (GAP #2 assemble reads `resourceStatus: ENABLED`); only the in-memory running summary of an *active* live session retains an already-folded note until the session restarts. A precise fix requires re-keying `LiveSession.contextNotes` by `contextItemId` + a new `ConsultationPipelineEvent.ContextRemoved` (emitter + handler). Deferred to avoid dead code.
- **GAP #5 heavy OCR.** Scanned-PDF / image / Office-doc text extraction (new dependency or Python OCR service). The threading seam + lightweight (txt/csv/md/json) extractor shipped this chunk; heavy OCR is a follow-up PR. Binary uploads fall back to the filename label until then.
- **R1 — real live STT/SMR/NLP E2E smoke.** Blocked on a GPU/LM-Studio host + a mounted NLP model cache (STT 8861 / SMR 8862 / NLP 8864 were down during TASK-339/340/341). Matches the TASK-340/341 posture.

### Verification Evidence (FINAL — captured 2026-06-09, zsh)

Final gates after GAP #4, #5, R2, R3 (supersedes the prior GAP #1–#3 run; counts grow by the tests added this chunk):

| Gate | Command | Result |
| --- | --- | --- |
| Applications build | `pnpm build --filter @arcaai/applications` | **PASS** — `Tasks: 7 successful, 7 total` |
| API build | `pnpm build:api` | **PASS** — `Tasks: 8 successful, 8 total` |
| UI-playground build | `pnpm --filter @arcaai/ui-playground build` | **PASS** — `✓ built in 23.14s` |
| Applications unit tests | `pnpm --filter @arcaai/applications test:unit` | **PASS** — `Test Files 209 passed | 1 skipped (210)`, `Tests 4941 passed | 4 skipped (4945)` (+2 GAP #5) |
| UI-playground unit tests | `pnpm --filter @arcaai/ui-playground test` | **PASS** — `Test Files 143 passed (143)`, `Tests 1196 passed (1196)` (+8: extractor 5, context-panel +2, review-panel +1; capture-panel net 0) |
| Python (STT) tests | `pnpm py:stt-v2:test:unit` (conda `arcaenv`) | **N/A this chunk** — no `apps/stt-v2` change in GAP #4/#5/R2/R3; prior chunk **PASS** `1872 passed, 12 warnings` (GAP #1) |
| Lint | `ReadLints` on all changed files | **PASS** — no linter errors |

TDD evidence (RED → GREEN), this chunk:

- **GAP #5 (services)** — `context.service.test.ts` + `harness-internal.service.test.ts`: `2 failed → 170 passed` (RED: the live `contentPreview` and the assemble attachment carried the `Lab/exam result:` label, not the extracted text; GREEN: both now prefer `extractedText`).
- **GAP #5 (extractor)** — `extract-text.test.ts`: `5 passed` (jsdom `File.text()` confirmed; binary → `null`).
- **GAP #4 + GAP #5 (frontend)** — `context-panel.test.tsx`: `2 failed → 5 passed` (RED: missing `mid-visit-influence-hint`; `metadata.extractedText` undefined).
- **R2** — `capture-panel.test.tsx`: `1 failed → 3 passed` (RED: `realtime.start` was called with the silent SYSTEM default; GREEN: Start blocked + actionable toast).
- **R3** — `review-panel.test.tsx`: `1 failed → 10 passed` (RED: no `review-no-transcript`; GREEN: distinct zero-transcript timeout state with retry).

**No unrelated failures observed.** The mixed working tree's TASK-343 auth-guard files (`jwtauth.guard.ts`, `decorators.ts`, `unified-auth.guard.ts`, `smr-proxy.controller.ts`, etc.) and the Python Docker/uv standardization changes (`apps/*/Dockerfile`, `*/uv.lock`, `pyproject.toml`, `.gitlab/ci/build.yml`) were **untouched** and surfaced no failures in any gate. (The `AuthorizationGuard` "refused admin route" log lines in the applications run are expected output from passing TASK-343 tests, not failures.)

---

## 6. Change History


| Date       | Description                                                                                 | Files     |
| ---------- | ------------------------------------------------------------------------------------------- | --------- |
| 2026-06-09 | Plan drafted from Clinical Workspace integration audit; status Pending (awaiting approval). | this file |
| 2026-06-09 | **GAP #1** implemented — streaming finalize persists a `TRANSCRIPT` so the harness auto-drafts for live visits; relaxed `CreateTranscriptRequest` (`jobId`/`tenantId` optional) + no-job `createTranscript` branch (idempotent, emits `TranscriptionCreated`), gateway `create_transcript` no-job variant, `_finalize_session` call. | `internal.request.ts`, `sttInternal.service.ts` (+test), `consultation.events.ts`, `gateway.py`, `session.py`, `session_manager.py`, `test_api_client.py`, `test_streaming_recording.py` |
| 2026-06-09 | **GAP #2** implemented — harness `assemble` folds case-notes/work-notes/attachments into the authoritative-SOAP prompt; `PromptAssemblyParams.clinicianNotes`/`attachments` + rendered blocks; `assemble` fetches `findCaseNotes`/`findWorknotes`/`findAttachments` and threads them. | `prompt-assembly.service.ts` (+test), `harness-internal.service.ts` (+test) |
| 2026-06-09 | **GAP #3** implemented (Services→API→Frontend, TDD) — soft-delete a context item end-to-end. New `DELETE /consultations/:id/context/:contextId` → `resourceStatus=DELETED` + `SysEvent.ResourceDeleted`; per-row remove control in the workspace context list. Live drop-out (GAP #3d) deferred (durable SOAP already excludes deleted via GAP #2). | `IContextService.ts`, `context.service.ts` (+test), `consultation.controller.ts` (+test), `constants.ts`, `clinical-workspace.api.ts`, `context-panel.tsx` (+test) |
| 2026-06-09 | Gates verified GREEN: applications/api/ui-playground builds; applications (`4939 passed/4 skipped`) + ui-playground (`1188 passed`) + Python STT (`1872 passed`) unit tests; `ReadLints` clean. §5/§6 updated; status stays **In Progress** (GAP #4, #5, R2, R3 next). | this file |
| 2026-06-09 | **GAP #4** implemented (Option b — surgical default) — documented that mid-visit live-summary influence is via Case/Work notes (already propagated) and direct edits are post-stop in Review (`PATCH …/summary/:summaryId`); added an unobtrusive cockpit hint. Option (a) seed/pin noted as a future option, not built. | `context-panel.tsx` (+test) |
| 2026-06-09 | **GAP #5** implemented (bounded — seam + lightweight extractor) — uploaded lab/exam **contents** (txt/csv/md/json) now reach the live summary (`addContext` `contentPreview` prefers `metadata.extractedText`) and harness assemble (attachment block prefers `metaData.extractedText`, falls back to label). New dependency-free `extract-text.ts`. **Heavy OCR (scanned PDF/images) deferred to a follow-up PR.** | `extract-text.ts` (+test), `context-panel.tsx` (+test), `context.service.ts` (+test), `harness-internal.service.ts` (+test) |
| 2026-06-09 | **R2** implemented — `capture-panel.tsx` drops the silent SYSTEM-tenant `DEFAULT_TRANSCRIPTION_PIPELINE_ID` fallback; blocks Start with an actionable error when no tenant pipeline resolves (no cross-tenant 404). | `capture-panel.tsx` (+test) |
| 2026-06-09 | **R3** implemented — Review surface renders an explicit "No transcript was captured" state (with retry) when the draft poll times out with zero transcripts, distinct from the "draft still generating" timeout. | `review-panel.tsx` (+test) |
| 2026-06-09 | **Final gates GREEN** — applications/api/ui-playground builds; applications (`4941 passed/4 skipped`) + ui-playground (`1196 passed`) unit tests; `ReadLints` clean; Python STT N/A this chunk (no stt-v2 change). Status → **Completed** (R1 live E2E pending GPU/model host; GAP #3d live-drop-out + GAP #5 heavy-OCR deferred as noted). No unrelated (TASK-343 / Python-standardization) failures. | this file |


