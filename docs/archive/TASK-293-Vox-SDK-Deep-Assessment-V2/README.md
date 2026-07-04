# TASK-293 — Vox SDK Deep Assessment V2 (Personalization, Transport, Impersonation Focus)

| | |
|---|---|
| Ticket Number | TASK-293 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Wave-5 execution complete — pending Prisma apply + integration smoke** |
| Type | Deep Assessment / Audit / Refactor / Optimization / Security |
| Owner | Architecture team |
| Predecessor | [TASK-262 Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) (Waves 0–4 complete) |
| Scope | `@arcaai/vox`, `@arcaai/room`, `@arcaai/vad`, `@arcaai/stt`, `@arcaai/noise-filter`, `@arcaai/med-ner`, `@arcaai/pipeline`, plus end-user + admin REST/SSE/WS controllers in `apps/api`, the Python services `apps/stt-v2` and `apps/smr`, and the `apps/ui-playground` impersonation/voice surfaces |
| Reviewer model | `claude-opus-4-7-thinking-xhigh` (eight parallel reviewers) |

---

## Why a V2 assessment

TASK-262 (2026-05-23) shipped four remediation waves (W0–W3) plus a Wave-4 follow-up — 9 060 / 9 060 tests green, 0 lint, `tsc --noEmit` green for the first time in the program. That audit was **structural** (one report per package).

This V2 audit is **product-requirement aligned**. The brief from the user mandated a fresh evaluation of the current code against seven concrete capabilities the SDK must deliver to be safe for a doctor user in a multi-tenant medical workflow:

1. Personal settings (profile fetch/cache/load/ready) and **personal prompt-template overlays that MUST NOT mutate tenant or department defaults**.
2. **Voice enrollment** — sample stored to **browser local storage** AND **persisted to the backend**, consumed by **both local and backend diarization/VAD**, **gated on voice sample for on-device diarization**.
3. Doctor-selectable transcription pipeline:
   - **Local** with configurable features (STT model, translation if model supports, code-switching if model supports, noise filter, VAD, diarization).
   - **Remote** with audio-processing-pipeline selection (the pipeline is authored by the tenant admin; the doctor picks one).
4. Summarization (with/without DNA writing style) — **always backend-handled**.
5. Transports: HTTP for init + summarization; **SSE / WebSocket / WebRTC** for live audio + live text.
6. **Impersonation** for global and tenant admins to impersonate user / tenant-user, exercised from the playground.

Eight parallel `opus-4.7-xhigh` code-reviewers were dispatched (one per requirement area + one cross-cutting). Each performed independent code exploration and authored a focused detail file with file:line citations, severity-rated defects, security/perf findings, test-coverage gaps, conformance verdicts, and prioritized fixes.

---

## Document map

| File | Requirement area | Reviewer | Defects (C/H/M/L) | Headline verdict |
|---|---|---|---|---|
| [`01-personalization-settings.md`](./01-personalization-settings.md) | Profile fetch, user-settings CRUD, personal prompt overlay vs tenant defaults, departments cascade | A1 | 6 / 6 / 4 / 3 | **FAIL** on all four BRs |
| [`02-voice-enrollment.md`](./02-voice-enrollment.md) | Voice capture, local + backend persistence, local + backend diarization consumption, gating | A2 | 4 / 8 / 8 / 5 | **NON-CONFORMANT** — wired in shape, broken in substance |
| [`03-local-pipeline.md`](./03-local-pipeline.md) | On-device STT with configurable features | A3 | 1 / 7 / — / — | **3 Met / 2 Partial / 2 Not-met** features |
| [`04-remote-pipeline.md`](./04-remote-pipeline.md) | Admin-configured remote pipeline selection | A4 | 5 / 7 / 5 / 4 | **3.3 / 10** — pipeline-aware client is dead code |
| [`05-impersonation.md`](./05-impersonation.md) | Global + tenant admin impersonation | A5 | 4 / 6 / 8 / 6 | **C−** — NOT production-safe for tenant admins / HIPAA |
| [`06-transports.md`](./06-transports.md) | HTTP / SSE / WS / WebRTC | A6 | 4 / 6 / 7 / 3 | HTTP **PASS**, SSE **FAIL**, WS **FAIL**, WebRTC **ABSENT (acceptable)** |
| [`07-summary-with-dna.md`](./07-summary-with-dna.md) | Backend summarization with DNA writing style | A7 | 3 / 4 / 5 / 7 | **2.1 / 5** — streaming broken end-to-end |
| [`08-cross-cutting-quality.md`](./08-cross-cutting-quality.md) | Cross-package quality + 2026 best-practice adoption | A8 | 1 / 9 / — / — | **~7%** 2026-practice adoption |

**Aggregate defect count**: **28 Critical / 53 High / 37+ Medium / 28+ Low** across the 8 areas. Each finding cites `file:line`; each detail file proposes a concrete patch.

---

## Executive Summary

### Verdict

> **The vox stack is *architecturally* aligned with the seven business requirements but **NOT production-safe** in its current execution path. Three classes of structural defect dominate:**
>
> 1. **Specified-but-unwired features** — major capabilities (admin-pipeline selection, personal prompt templates, voice-profile activation, consultation-job SSE streaming) have controllers, DTOs, and managers that exist in code but **are never reached by the hot path**.
> 2. **Authorization gaps at the service / interceptor layer** — controllers use `@Authorize()` with no permission tuple; `ContextInterceptor` lets `x-tenant-id` override the JWT; tenant-admin scope is not enforced on impersonation; biometric mutations have no ownership check; STT WebSocket gateway has no auth at all.
> 3. **TASK-262 closures that closed-in-form but not-in-substance** — GAP-01 (consultation-job controller) and TASK-274 (stream ticket) shipped routes/primitives, but the SDK contract diverged at scope strings, body shapes, event types, or wire format, leaving the user-facing capability still broken.
>
> The system is recoverable. Most of the 28 Critical defects are 1-line or single-file fixes; the dead-code-bypass defects (e.g. wiring `StreamingSessionManager` into `useArca`) are surgical refactors with tests already in place to lock the new behavior. A focused **Wave-5 remediation** is proposed below.

### Severity rollup

| Area | Critical | High | Medium | Low |
|---|---:|---:|---:|---:|
| 01 Personalization & settings | 6 | 6 | 4 | 3 |
| 02 Voice enrollment | 4 | 8 | 8 | 5 |
| 03 Local pipeline | 1 | 7 | n/a | n/a |
| 04 Remote pipeline | 5 | 7 | 5 | 4 |
| 05 Impersonation | 4 | 6 | 8 | 6 |
| 06 Transports | 4 | 6 | 7 | 3 |
| 07 Summary with DNA | 3 | 4 | 5 | 7 |
| 08 Cross-cutting quality | 1 | 9 | n/a | n/a |
| **Total** | **28** | **53** | **37+** | **28+** |

> A3 and A8 ran in slim-retry mode (resource-exhaustion on first attempt); Medium/Low counts are recorded as "≥" where the slim report rolled them into the cross-cutting list.

### Top-10 risks (must be fixed before any external pilot)

The following ten findings, drawn across all reviewers, are the gating items for a HIPAA-acceptable, multi-tenant, personalised SDK. Each links to the source detail file.

| # | Finding | File:line citation | Severity | Detail |
|---|---|---|---|---|
| 1 | **STT WebSocket gateway is fully unauthenticated.** Any actor with a `sessionId` (time-ordered `uuidv7` — high bits predictable) can attach to the live PHI audio + transcript stream. The "auth-as-first-message" contract documented in `StreamingSessionManager` is implemented on neither end. | `apps/api/src/modules/streaming/stt-ws.gateway.ts:29-50,147-174`; `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:175-230`; `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:131-157` | Critical | [04 D-1](./04-remote-pipeline.md), [06 C-WS-1..3](./06-transports.md) |
| 2 | **Cross-tenant `pipelineId` not validated.** API gateway forwards `body.pipelineId` verbatim; STT-V2's `get_pipeline()` ignores tenant. A Tenant-A doctor can run Tenant-B's admin-authored pipeline. | `apps/api/src/modules/streaming/transcription-job.controller.ts:246-285`; `apps/stt-v2/src/stt_v2/pipeline/config_reader.py:get_pipeline()` | Critical | [04 D-2/D-3](./04-remote-pipeline.md) |
| 3 | **Tenant-admin cross-tenant impersonation NOT enforced.** Controller only blocks tenant-admin → another admin; never compares `adminUser.tenantId === resolvedTenantId`. A TENANT_ADMIN of tenant A can impersonate any non-admin in tenant B. | `apps/api/src/modules/auth/auth.controller.ts:312-342` | Critical | [05 C-1](./05-impersonation.md) |
| 4 | **`x-tenant-id` header overrides JWT tenant claim (SEC-J still open).** `ContextInterceptor` writes the header into CLS `tenantId`; `JwtStrategy.validate` never sets CLS `tenantId`. Any authenticated client can call any tenant's data by stuffing the header — amplified by impersonation. | `apps/api/src/interceptors/context.interceptor.ts:55-60`; `packages/applications/src/services/auth/jwt.strategy.ts:25-41` | Critical | [05 C-2](./05-impersonation.md) |
| 5 | **Cross-tenant IDOR on prompt-templates and department prompt-config.** `@Authorize()` is empty (`AuthorizationGuard` short-circuits when `required.length === 0`); `PromptManagementService.{update,delete,get}` never checks `tenantId` ownership; same on `DepartmentService.updatePromptConfig`. Any authenticated user can mutate any tenant's prompt templates and any department's default prompts. Direct violation of BR #1 ("personal changes MUST NOT impact tenant defaults"). | `apps/api/src/modules/prompt-management/prompt-management.controller.ts:14-17`; `packages/applications/src/services/prompt-management/prompt-management.service.ts:79,131,178`; `apps/api/src/modules/department/department.controller.ts:13-16,97-108`; `packages/applications/src/authorization/authorization.guard.ts:97-100` | Critical | [01 DEF-C2/C3](./01-personalization-settings.md) |
| 6 | **`PromptTemplate` schema cannot model personal overlays.** No `userId` / `scope` column. BR #1 (doctor's personal prompt template MUST NOT mutate tenant default) is **structurally unimplementable** with today's schema. + **3-tier cascade** in `ConfigManager` (no department tier; profile not preloaded). | `packages/database/src/prisma/db_main/prompt-template.prisma:15-61`; `packages/agentic-sdk-v2/src/core/ConfigManager.ts:14-25,202-207`; `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:154-376` | Critical | [01 DEF-C1/C5/C6](./01-personalization-settings.md) |
| 7 | **Enrolled voice profile created `isActive=false`; no SDK activate hook.** Backend `preseed_speaker` filters `WHERE isActive=true` so it always logs "no active profile, skipping pre-seed". The entire backend-side voice personalization is functionally inert despite correct wire-up. Plus: **IDOR on `DELETE/PATCH /voice-profile/:id*`** (no ownership check on biometric mutations) and **local diarizer has no `loadProfile`** API. | `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:47,71-102`; `packages/agentic-sdk-v2/src/core/constants.ts:595`; `apps/api/src/modules/voice-profile/voice-profile.controller.ts:91-112`; `apps/stt-v2/src/stt_v2/core/database/voice_profile_model.py:48-51`; `packages/stt/src/providers/LocalSpeakerDiarizer.ts` (no `loadProfile`); `packages/stt/src/types/index.ts:766-793` (no `voiceProfile` in `LocalProviderConfig`) | Critical | [02 C-1/C-2/C-3](./02-voice-enrollment.md) |
| 8 | **The pipeline-aware client is dead code.** `useArca → useArcaAudio.start() → STTProcessor.initializeRemoteProvider()` builds the legacy v1 `RemoteSTTProvider` that has no `pipelineId` and never calls `POST /audio/transcription-jobs/stream/session`. The newer `StreamingSessionManager` + `SttV2WebSocketClient` ship in the bundle but no production hook consumes them. **The doctor's chosen pipeline has zero effect on live transcription.** This is the root cause of BR #5 (remote pipeline) FAIL. | `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:53-205`; `packages/stt/src/core/STTProcessor.ts:520-556`; `packages/stt/src/providers/BackendSTTProvider.ts:68-121`; `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`; `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Critical | [04 D-4](./04-remote-pipeline.md) |
| 9 | **Audit log drops the impersonated subject; SSE/WS audit under impersonation is absent.** `AuditLogService.handleUserAuthenticatedEvent` writes `responsibleUserId = resourceId = adminId` and ignores `impersonatedUserId` from the event payload. Stream tickets (SSE) shed the `impersonatedBy` claim entirely → live consultations under impersonation are unaudited. HIPAA non-compliance for actor-on-subject traceability. | `packages/applications/src/services/auditLog/auditLog.service.ts:204-244`; `apps/api/src/guards/jwtauth.guard.ts:67-110`; `apps/api/src/modules/auth/stream-ticket.service.ts` | Critical | [05 C-3/M-8](./05-impersonation.md) |
| 10 | **Consultation-job SSE is broken end-to-end.** (a) Backend emits SSE events without `type:` field — `useConsultationJob.on('status'\|'progress'\|'result', …)` listeners **never fire**. (b) SDK ticket scope is the literal `'consultation-jobs'`; backend guard expects `consultation_job:<jobId>` — every SSE connect returns 401. (c) **Zero per-job authZ** — any authenticated user can read/stream/cancel any job; `result` payload is the full PHI summary text. Plus a **regression** in SharedConnectionWorker that re-introduces the `?token=<jwt>` URL pattern (SEC-A). | `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:377,394,402,409-415`; `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts:20,110`; `apps/api/src/modules/consultation/consultation-job.controller.ts:13-15,62`; `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts:99-102`; `packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts:363-366` | Critical | [07 D-1/D-2/D-3](./07-summary-with-dna.md), [06 C-SSE-1/C-SSE-2](./06-transports.md) |

### Critical security findings (consolidated)

| ID | Finding | Source | Status |
|---|---|---|---|
| SEC-J | `x-tenant-id` header overrides JWT tenant claim | TASK-262 §3.4 | **Still open** ([05 C-2](./05-impersonation.md)) |
| SEC-A regression | `?token=<jwt>` in SSE URL via `SharedConnectionWorker` / `SharedConnectionManager` | New ([06 C-SSE-1](./06-transports.md)) | New |
| SEC-D residual | Admin + impersonation tokens in playground `localStorage` (`arcavox.auth`) | New playground-level ([05 H-1](./05-impersonation.md)) | New (SDK closed; app re-introduced) |
| AUTHZ-1 | Empty `@Authorize()` on `PromptManagementController`, `DepartmentController.updatePromptConfig`, `VoiceProfileController.{delete,activate,deactivate}` | New ([01 DEF-C2/C3](./01-personalization-settings.md), [02 C-3](./02-voice-enrollment.md)) | New |
| AUTHZ-2 | Tenant-admin cross-tenant impersonation not enforced | New ([05 C-1](./05-impersonation.md)) | New |
| AUTHZ-3 | No tenant validation on `pipelineId` at API gateway, STT-V2, or `PipelineService.getById` | New ([04 D-2/D-3/D-9](./04-remote-pipeline.md)) | New |
| AUTHZ-4 | No per-job authZ on `ConsultationJobController`; full PHI exposure | New ([07 D-3](./07-summary-with-dna.md)) | New |
| AUTHZ-5 | STT WebSocket gateway has zero authentication | TASK-262 H-1/S-1 unfixed ([04 D-1](./04-remote-pipeline.md), [06 C-WS-1/2/3](./06-transports.md)) | Unfixed |
| HIPAA-1 | Audit log drops `impersonatedUserId`; impersonated SSE/WS streams unaudited | New ([05 C-3/M-8](./05-impersonation.md)) | New |
| HIPAA-2 | Voice samples — no retention TTL, no consistency check across samples (impersonation vector), no zeroization | New ([02 SEC-V-1..9](./02-voice-enrollment.md)) | New |

### Conformance to the seven business requirements

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Personal prompt-template overlay must NOT mutate tenant/department defaults | **FAIL** | Schema cannot model overlays ([01 DEF-C1](./01-personalization-settings.md)); IDOR allows any user to mutate any tenant's templates ([01 DEF-C2/C3](./01-personalization-settings.md)) |
| 2 | Profile fetched / cached / loaded / ready before SDK use | **FAIL** | `AgenticProvider` never preloads `/auth/me`; `configReady` flips without it ([01 DEF-C6](./01-personalization-settings.md)). 3-tier cascade ≠ required 4-tier ([01 DEF-C5](./01-personalization-settings.md)). |
| 3 | Voice enrollment: local storage + backend persistence; consumed by local & backend diarizer; gated as on-device-diarization prerequisite | **FAIL** | No local storage path ([02 H-1](./02-voice-enrollment.md)); backend wired but inert (`isActive=false` ([02 C-1](./02-voice-enrollment.md))); local diarizer has no `loadProfile` ([02 C-2](./02-voice-enrollment.md)); diarization not gated on enrollment ([02 C-4](./02-voice-enrollment.md), [03 §9.6](./03-local-pipeline.md)) |
| 4 | Local STT pipeline with configurable features (model, translation, code-switch, noise, VAD, diarization) | **PARTIAL** | 3 Met (noise, VAD, model-init), 2 Partial (model runtime swap, code-switching runtime), 2 Not-met (translation absent, diarization-gating absent) ([03 §3](./03-local-pipeline.md)) |
| 5 | Remote STT pipeline with admin-configured selection | **FAIL** | Selection persistence absent ([04 D-5](./04-remote-pipeline.md)); pipeline-aware client is dead code ([04 D-4](./04-remote-pipeline.md)); cross-tenant pipelineId unvalidated ([04 D-2/D-3](./04-remote-pipeline.md)) |
| 6 | Backend-handled summarization with optional DNA writing style | **PARTIAL** | Apply path PASS; learn corpus unfiltered FAIL ([07 D-11](./07-summary-with-dna.md)); SSE streaming broken end-to-end ([07 D-1/D-2/D-3](./07-summary-with-dna.md)); cancellation does not abort active SMR call ([07 D-5](./07-summary-with-dna.md)) |
| 7 | Transports — HTTP / SSE / WebSocket / WebRTC | **HTTP PASS, SSE FAIL, WS FAIL, WebRTC ABSENT (acceptable)** | HTTP solid except 401-refresh skip-list gap ([06 §3](./06-transports.md)); SSE broken on 4 of 5 producers (no `@StreamScope`) ([06 §4](./06-transports.md)); WS unauth ([06 §5](./06-transports.md)); WebRTC verified absent — recommend keeping out of scope ([06 §6](./06-transports.md)) |
| 8 | Impersonation for global + tenant admins, with personalization reflecting impersonated user | **PARTIAL FAIL** | Global PASS; tenant cross-tenant unenforced ([05 C-1](./05-impersonation.md)); audit drops subject ([05 C-3](./05-impersonation.md)); `PersonalizationManager` not isolated ([05 H-4](./05-impersonation.md)); playground keeps tokens in `localStorage` ([05 H-1](./05-impersonation.md)); SDK rehydration broken post-reload ([05 H-5](./05-impersonation.md)) |

**Aggregate**: 0 / 8 PASS, 4 / 8 FAIL, 3 / 8 PARTIAL, 1 / 8 STRUCTURAL-NON-REQUIREMENT (WebRTC absent).

### Per-area scorecard (consolidated)

| Area | Architecture | Correctness | Security | Performance | Test coverage | Conformance |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 01 Personalization | C | D | C | C | C | **FAIL** |
| 02 Voice enrollment | C | D | D+ | C | C− | **PARTIAL/FAIL** |
| 03 Local pipeline | B | B− | C | B | C+ | **PARTIAL** (3 Met / 2 Partial / 2 NotMet) |
| 04 Remote pipeline | C+ | D+ | D | C− | C− | **FAIL** (3.3 / 10) |
| 05 Impersonation | B | C− | D | B+ | C+ | **PARTIAL FAIL** (C−) |
| 06 Transports | C+ | C | D | C | C− | **PARTIAL** (HTTP ok, SSE/WS fail) |
| 07 Summary + DNA | B | C | D+ | C | C− | **FAIL** (2.1 / 5) |
| 08 Cross-cutting | B− | C+ | C− | C | C+ | **POOR** (7% 2026 adoption) |

### 2026 best-practice adoption — **~7% adopted**

Out of 15 priority items surveyed in TASK-262 §09:

| Adopted | Partial | Not yet |
|---:|---:|---:|
| 0 | 2 (Valibot for SDK config; WebGPU+fp16 Whisper) | 13 |

Full table at [`08-cross-cutting-quality.md §4`](./08-cross-cutting-quality.md).

---

## Wave-5 remediation roadmap

This roadmap is derived from the P0/P1/P2 lists in every detail file. Items are grouped by **target wave** and **execution stream** so that work can be parallelized across backend / SDK / playground teams.

### Wave 5A — Stop-the-bleed (security, IDOR, auth) — ≤ 2 weeks

These items close every Critical security finding and unlock multi-tenant production use.

| ID | Action | Source | Stream | Effort |
|---|---|---|---|---|
| W5A-1 | **Add stream-ticket auth to STT WS gateway.** Extend `JwtAuthGuard` (or sibling `WsTicketGuard`) to consume `?ticket=` on upgrade; bind to `stt_session:<sessionId>`; populate `request.user` + `tenantId` on `SessionInfo`. Mint ticket from `createStreamSession`; append in `StreamingSessionManager.getWebSocketUrl()`. | [04 F-1](./04-remote-pipeline.md), [06 §11](./06-transports.md) | Backend + SDK | M |
| W5A-2 | **Close SEC-J end-to-end.** Set CLS `tenantId` from JWT in `JwtStrategy.validate`; remove the `x-tenant-id` header override in `ContextInterceptor` (or gate behind a trusted-actor claim). Add tests on both paths. | [05 P0-2](./05-impersonation.md) | Backend | M |
| W5A-3 | **Enforce tenant scope on `/auth/impersonate` for TENANT_ADMIN.** Add `adminUser.tenantId === resolvedTenantId` check; 403 otherwise. Add RED test for TENANT_ADMIN(A) → DOCTOR(B). | [05 P0-1](./05-impersonation.md) | Backend | S |
| W5A-4 | **Persist `impersonatedUserId` + `endpoint` on audit row; new `AuditAction.IMPERSONATED_ACTION`.** Extend `auditLog.service.handleUserAuthenticatedEvent`. | [05 P0-3](./05-impersonation.md) | Backend | S |
| W5A-5 | **Real token revocation.** Maintain Redis revoked-`jti` set with `TTL = exp`; check in `JwtStrategy.validate`. Wire `/auth/revoke-impersonation` to write into the set. | [05 P0-4](./05-impersonation.md) | Backend + ops | M |
| W5A-6 | **Carry `impersonatedBy` on stream tickets.** Add to `StreamTicket` payload; restore on `req.user` in `JwtAuthGuard.handleTicketAuth`. Streaming under impersonation must audit-log. | [05 P0-5, 05 M-8](./05-impersonation.md) | Backend | S |
| W5A-7 | **Add per-job authZ to `ConsultationJobController`.** Add `userId` + `tenantId` to `ConsultationJobStatus`; enforce ownership in `getJob` / `streamJob` / `cancelJob`; bind ticket-bound user. | [07 P0-1 (D-3)](./07-summary-with-dna.md) | Backend | S |
| W5A-8 | **Validate `pipelineId` belongs to caller's tenant.** Add tenant check in `createStreamSession` and `transcribeFile` (API gateway). Add `tenant_id` filter to `PipelineConfigReader.get_pipeline` (STT-V2). Tenant-scope `PipelineService.getById`. | [04 F-2/F-3/F-4](./04-remote-pipeline.md) | Backend + STT-V2 | M |
| W5A-9 | **Add IDOR ownership check to `VoiceProfileService.{deleteById, activate, deactivate}`.** `assertOwnership()` helper; throw `ForbiddenException` if `profile.userId !== requestUser.id`. | [02 P0-3 (C-3)](./02-voice-enrollment.md) | Backend | S |
| W5A-10 | **Add CASL permission tuples to `PromptManagementController` and `DepartmentController.updatePromptConfig`.** Replace empty `@Authorize()` with `['update','PromptTemplate']` / `['manage','Department']`; enforce `tenantId` ownership in service mutations. | [01 P0-2/3 (DEF-C2/C3)](./01-personalization-settings.md) | Backend | S |
| W5A-11 | **Remove `?token=<jwt>` regression in `SharedConnectionWorker` and `SharedConnectionManager`.** Force ticket-mint at SDK boundary before `subscribeSSE`. | [06 P0 (C-SSE-1)](./06-transports.md) | SDK | S |
| W5A-12 | **Hash PHI in the fallback BroadcastChannel name** when `tenantId` is missing (TASK-262 H-6 residual). | [01 DEF-M1](./01-personalization-settings.md) | SDK | S |
| W5A-13 | **Move playground tokens off `localStorage`.** Drop `accessToken` + `impersonationToken` from `persist` `partialize`; switch to `sessionStorage` for per-tab. Invert existing rehydration test. | [05 P1-2 (H-1)](./05-impersonation.md) | Playground | M |

### Wave 5B — Wire the dead code (capability conformance) — 2–4 weeks

These items wire the bypassed surfaces so that the doctor's choices actually take effect.

| ID | Action | Source | Stream | Effort |
|---|---|---|---|---|
| W5B-1 | **Route `useArcaAudio.start({pipelineId})` through `StreamingSessionManager` + `SttV2WebSocketClient`.** Replace (or extend) `RemoteSTTProvider` so `pipelineId` reaches `POST /audio/transcription-jobs/stream/session`. Delete `STTPluginConfig.pipelineId` if the legacy field is replaced. | [04 F-5 (D-4)](./04-remote-pipeline.md) | SDK | L |
| W5B-2 | **Persist doctor's selected pipeline in user settings.** Extend `UserPreferencesUpdate` with `selectedPipelineId`; validate server-side that it belongs to caller's tenant; have `usePipelines.select(id)` call `updatePreferences`. | [04 F-6 (D-5)](./04-remote-pipeline.md) | SDK + backend | M |
| W5B-3 | **Auto-activate first enrolled voice profile + expose `activate`/`deactivate` in `useVoiceEmbedding`.** Add `VOICE_EMBEDDING_ENDPOINTS.{ACTIVATE,DEACTIVATE}` constants. Server-side: when no active profile exists, auto-set `isActive=true` on enroll. | [02 P0-1/P0-2 (C-1)](./02-voice-enrollment.md) | Backend + SDK | M |
| W5B-4 | **Gate `stt.diarization` on enrolled voice profile.** Add `useVoiceEnrollmentStatus()` helper; in `STTProcessor` / `useSTT`, throw `AgenticError('ENROLLMENT_REQUIRED', …)` when `features.diarization && !hasActive`. Echo `voiceProfileSeeded: boolean` in `StreamSessionResponse` for backend pipeline. | [02 P0-5/P0-6 (C-4)](./02-voice-enrollment.md), [03 §5 HIGH](./03-local-pipeline.md) | SDK + backend | M |
| W5B-5 | **Add `LocalProviderConfig.voiceProfile?: { id, reservedSpeakerId }`** and wire `LocalSpeakerDiarizer` to accept a "doctor pre-seed" slot that pins speaker-1 to the enrolled user (workaround for 40-d MFCC vs 256-d backend embedding incompatibility). | [02 P0-4 (C-2)](./02-voice-enrollment.md) | SDK | M |
| W5B-6 | **Lift `voiceProfiles` into `agenticStore` + persist via `SecureStorage` keyed by `vox.voiceProfiles.${userId}.${tenantId}`.** Stale-while-revalidate cache. | [02 P1-1 (H-1)](./02-voice-enrollment.md) | SDK | M |
| W5B-7 | **Extend `PromptTemplate` schema with `scope` enum + `ownerUserId`.** Migrate existing rows to `TENANT_DEFAULT`. Update factory, mapper, repo, service. Split prompt-template service into `listDefaultsForDepartment`, `listMyPersonalForDepartment`, `createPersonal(...)`. | [01 P0-1 (DEF-C1)](./01-personalization-settings.md) | Backend (DB) | L |
| W5B-8 | **Implement `POST /prompt-templates/assign-department` route.** Backend method missing; SDK calls it. | [01 P0-4 (DEF-C4)](./01-personalization-settings.md) | Backend | S |
| W5B-9 | **Extend `ConfigManager` to a 4-tier cascade with `setDepartmentConfig`.** Surface `departmentId` from `/auth/me`; hydrate in `AgenticProvider`. Add CONFIG_PERMISSIONS department tier. | [01 P0-5 (DEF-C5)](./01-personalization-settings.md) | SDK + backend | M |
| W5B-10 | **Preload `/auth/me` in `AgenticProvider` before `configReady` flips.** Block mutation hooks on `configReady === false`. | [01 P0-6 (DEF-C6)](./01-personalization-settings.md) | SDK | S |
| W5B-11 | **Namespace IndexedDB / localStorage preference keys by `${tenantId}::${userId}`.** Clear IDB in `clearOnLogout` and on impersonation switch. | [01 P0-7 (DEF-H1)](./01-personalization-settings.md) | SDK | S |
| W5B-12 | **Fix `PersonalizationManager.syncToBackend` verb mismatch (POST → PATCH).** One-line fix to align with `@Patch()` handler. | [01 P0-8 (DEF-H2)](./01-personalization-settings.md) | SDK | XS |
| W5B-13 | **Add `PersonalizationManager.setImpersonationReadOnly()`** and wire from `useAuth.impersonate` / `endImpersonation`. Mirror TASK-245's `ConfigManager` lifecycle. | [05 P1-1 (H-4)](./05-impersonation.md) | SDK | S |
| W5B-14 | **Emit named SSE events (`type: 'status'|'progress'|'result'|'error'`)** from `ConsultationJobService.subscribeToJobUpdates`. Mirror working `streamDnaJobStatus` shape. | [07 P0-2 (D-1)](./07-summary-with-dna.md) | Backend | S |
| W5B-15 | **Fix SDK ticket scope for consultation-job SSE: `consultation_job:${jobId}`.** One-line builder change in `useConsultationJob.ts`. | [07 P0-3 (D-2)](./07-summary-with-dna.md) | SDK | XS |
| W5B-16 | **Add diarization translation feature: `STTFeatureFlags.task: 'transcribe' \| 'translate'`.** Pipe to `transcribeOptions.task` in `WhisperEngine`. Capability-check (English-only `.en` models reject). | [03 P0](./03-local-pipeline.md) | SDK | S |
| W5B-17 | **`AudioContextManager` sample-rate enforcement.** Warn (or throw with override) when `sampleRate !== 48000` and noise-filter is enabled. | [03 P0 (CRITICAL)](./03-local-pipeline.md) | SDK | S |

### Wave 5C — Cross-cutting performance + DX — 4–6 weeks

These items address the 2026-best-practice adoption gap and the cross-cutting perf defects from [`08-cross-cutting-quality.md`](./08-cross-cutting-quality.md).

| ID | Action | Source | Stream | Effort |
|---|---|---|---|---|
| W5C-1 | **Vanilla `createStore()` + Context + atomic selectors + `useShallow`.** Single biggest perf + SSR fix. Replace every `useAgenticStore()` no-selector call. | [08 P0-1](./08-cross-cutting-quality.md), [01 DEF-H3](./01-personalization-settings.md) | SDK | M |
| W5C-2 | **Add `"use client"` to `room`, `vad`, `noise-filter`.** Add `react-server` export condition (friendly throw stub) to all 7 packages. Add `sideEffects: false` (or explicit array for worklets) to the 5 missing. | [08 P0-2](./08-cross-cutting-quality.md) | All packages | S |
| W5C-3 | **Pin `onnxruntime-web` to one stable version across `vox`, `stt`, `vad`.** Stop using `1.22.0-dev.*` tag in production. | [08 P0-3](./08-cross-cutting-quality.md) | All packages | S |
| W5C-4 | **Add resumability tokens + full-jitter + token pre-refresh to `SttV2WebSocketClient`.** `lastSeq`/replay handshake on reconnect; bounded local replay buffer. | [08 P1-4](./08-cross-cutting-quality.md), [04 F-17](./04-remote-pipeline.md) | SDK | M |
| W5C-5 | **Migrate `tsup → tsdown` + enable `isolatedDeclarations`** across all 7 packages. Schedule `useActionState` / `useOptimistic` rollout for streaming hooks. | [08 P1-5](./08-cross-cutting-quality.md) | All packages | M |
| W5C-6 | **Soft-bypass disabled processors in `ProcessorPipeline`.** Don't destroy WASM state on toggle. (TASK-262 MEDIUM-2 unaddressed at `room` layer.) | [03 §4](./03-local-pipeline.md) | room | M |
| W5C-7 | **VAD `restart()` API** that destroys+recreates `MicVAD` for hidden-state reset + threshold/sensitivity hot-reload. | [03 P1, TASK-262 H-1](./03-local-pipeline.md) | vad | S |
| W5C-8 | **VAD sliding-window probability average (~1024 frames).** Replace unbounded sum. | [03 P1, TASK-262 H-2](./03-local-pipeline.md) | vad | S |
| W5C-9 | **STT live `setLanguage` / `setModelId` that rebuild only the STT stage.** Use existing local-provider cache-key invalidation. | [03 P1](./03-local-pipeline.md) | stt + SDK | S |
| W5C-10 | **Remove (or wire through) dead VAD worklet exports** (`registerVADWorklet`, `createVADWorkletNode`, `VADWorkletConfig*`). | [03 P1, TASK-262 C-3](./03-local-pipeline.md) | vad | S |
| W5C-11 | **Move `STTProcessor.localProviderPool`** from `static` to per-AgenticClient `WeakMap`. | [03 P1, TASK-262 H-4](./03-local-pipeline.md) | stt | S |
| W5C-12 | **Wire `ort.env.wasm.numThreads = navigator.hardwareConcurrency`** in `whisper.worker.ts` and `VADProcessor` when `crossOriginIsolated`. Document COOP/COEP in package READMEs. | [03 §6](./03-local-pipeline.md), [08 §3 C-XCUT-8](./08-cross-cutting-quality.md) | stt + vad | S |
| W5C-13 | **Fix `LocalSpeakerDiarizer` FFT bit-reversal** (build permuted copy then in-place). | [03 P2, §5 HIGH](./03-local-pipeline.md) | stt | S |
| W5C-14 | **Skip 401-refresh on `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate`** in `AgenticClient`. | [06 P1 (H-HTTP-1)](./06-transports.md) | SDK | XS |
| W5C-15 | **Add `bufferedAmount` watermark + drop/pause policy in `SttV2WebSocketClient.sendAudioFrame`.** | [06 P1 (M-WS-6)](./06-transports.md), [04 F-15](./04-remote-pipeline.md) | SDK | S |
| W5C-16 | **De-dup SSE in `SharedConnectionWorker` by `(id, userId)`, not `id` alone.** Refuse to share an upstream connection across distinct tickets. | [06 P1 (H-SSE-5)](./06-transports.md) | SDK | S |
| W5C-17 | **Add `@StreamScope` to remaining SSE producers (`transcription-job`, `dna-writing-style`, `dna-writing-style-admin`, `smr-proxy`).** Or switch them to fetch-based readable streams. | [06 P1 (H-SSE-3/4)](./06-transports.md) | Backend + SDK | M |
| W5C-18 | **DNA-learning corpus = approved/edited summaries only.** Join on `SummaryMeta.status === 'APPROVED'`; persist source `contextItemId` list. | [07 P1 (D-11)](./07-summary-with-dna.md) | Backend | M |
| W5C-19 | **`AbortController` through `summaryService.callSmrService`; forward cancel to SMR `/text/tasks/:taskId/cancel`.** | [07 P1 (D-5)](./07-summary-with-dna.md) | Backend | M |
| W5C-20 | **Add idempotency-key header for consultation/summary POSTs.** Redis-backed dedup with 24h TTL. | [07 P2 (D-9/D-10)](./07-summary-with-dna.md) | Backend + SDK | M |

### Wave 5D — Polish + 2026 best-practice rollout — 8–12 weeks

Defers most of TASK-262's Wave-3 items into a single, sequenced roll-out (Whisper-large-v3-turbo, TEN-VAD, DeepFilterNet3, SAB ringbuffer, GLiNER-BioMed, OPFS model weights, per-user LoRA, OpenAPI codegen, etc.). Refer to TASK-262 Wave-3 for the full inventory.

### Dependencies between waves

```
W5A (security)  ──┐
                  ├─► W5C (perf + DX) ─► W5D (2026 adoption)
W5B (wiring)  ────┘
```

- **W5A and W5B can run in parallel** across separate teams (W5A mostly backend + auth + audit; W5B mostly SDK + DB schema + small backend additions).
- **W5C cannot start until W5A-11** (SSE token regression removed) and **W5B-1** (pipeline-aware client wired) are merged — both invalidate previous behavioral assumptions used by the perf-fix tests.
- **W5D** depends on the COOP/COEP rollout coordinated with the platform's security headers (W5C-12).

---

## Verification strategy

For each Wave-5 remediation, captured evidence must include:

- **A failing RED test** that reproduces the defect before the fix.
- **Build evidence**: `pnpm build --filter <package>` actual output for every modified package.
- **Lint evidence**: `pnpm lint --filter <package>` actual output.
- **Backend integration test** through the live `INestApplication` for every endpoint contract fix (esp. the 401-on-SSE, the IDOR closures, the impersonation cross-tenant gate).
- **Playwright e2e** for the user-visible flows: enroll → diarize, doctor selects pipeline → audio routes there, admin impersonates → audit row contains both identities.
- **Bundle-size delta** captured via `size-limit` for the `@arcaai/vox/core` and `@arcaai/vox/plugins` entries before/after `useShallow` adoption (W5C-1).

Wave-5 acceptance criteria:

1. Every Wave-5A item has merged with passing RED-first tests + security-team sign-off.
2. Every Wave-5B item has merged; the eight per-area conformance verdicts go to PASS or at worst PARTIAL with documented residual.
3. Every Critical finding in the top-10 has a regression test that fails on the pre-W5 main branch and passes on the post-W5 branch.
4. P95 transcription latency on the playground for a 30 s clip does not regress vs Wave-4 baseline; ideally improves with W5B-1 wiring.
5. The 2026 best-practice adoption matrix shows ≥ 30% adoption (vs ~7% today).

---

## Sub-tickets to create

The Wave-5 work should be split into discrete child tickets following the TASK-263-through-TASK-291 pattern from TASK-262 — one ticket per implementer agent with non-overlapping write scopes. Suggested mapping:

| Child ticket | Scope | Wave 5 IDs |
|---|---|---|
| TASK-294 SSE/WS auth alignment | W5A-1, W5A-6, W5A-11, W5C-17 | |
| TASK-295 SEC-J + impersonation tenant scope | W5A-2, W5A-3, W5A-4, W5A-5 | |
| TASK-296 Voice-profile activate + IDOR + diarizer wire | W5A-9, W5B-3, W5B-4, W5B-5, W5B-6 | |
| TASK-297 Prompt-template scope schema + 4-tier cascade | W5B-7, W5B-8, W5B-9, W5B-10, W5B-11, W5B-12, W5A-10 | |
| TASK-298 Remote-pipeline wiring + tenant pipelineId validation | W5B-1, W5B-2, W5A-8 | |
| TASK-299 Consultation-job SSE fix + per-job authZ + DNA learning | W5A-7, W5B-14, W5B-15, W5C-18, W5C-19, W5C-20 | |
| TASK-300 Playground token hygiene + SDK impersonation rehydration | W5A-13, W5B-13, [05 H-5](./05-impersonation.md) | |
| TASK-301 Local-pipeline conformance: translation, sample-rate, VAD reset | W5B-16, W5B-17, W5C-6..W5C-13 | |
| TASK-302 Cross-cutting React 19 / RSC / Zustand 5 / tsdown migration | W5C-1, W5C-2, W5C-3, W5C-5 | |
| TASK-303 STT WS reconnect resumability + backpressure + token pre-refresh | W5C-4, W5C-14, W5C-15, W5C-16 | |

These map to ~10 implementer subagents — runnable in two parallel batches (W5A + W5B in batch 1; W5C in batch 2 after W5A-11 + W5B-1 land).

---

## Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | Architecture team | Created TASK-293 V2 deep-assessment scope: 7 requirement-aligned detail files + 1 cross-cutting quality file. Dispatched 8 parallel `claude-opus-4-7-thinking-xhigh` code-reviewer subagents. |
| 2026-05-24 | Synthesis pass | All 8 reviewers complete. Master README compiled with verdict, severity rollup (28 Critical / 53 High / 37+ Medium / 28+ Low), top-10 risks, per-requirement conformance (0 PASS / 4 FAIL / 3 PARTIAL / 1 N/A), consolidated scorecard, and **Wave-5 remediation roadmap** with 50 itemized actions across 4 phases (W5A stop-the-bleed, W5B wire-the-dead-code, W5C perf+DX, W5D 2026 best-practice rollout). Mapped to 10 proposed child tickets (TASK-294 → TASK-303). Status set to **Review — Wave-5 remediation required**. |
| 2026-05-24 | **Wave-5 remediation execution** | Seven `claude-opus-4-7-thinking-xhigh` implementer subagents dispatched in parallel with strict non-overlapping file ownership, executed Wave-5A + Wave-5B + most of Wave-5C of the roadmap. **All 7 sub-tickets shipped Completed**: [TASK-294](../TASK-294-Backend-AuthZ-Closures-Prompt-Template/README.md) · [TASK-295](../TASK-295-Backend-Impersonation-Security/README.md) · [TASK-296](../TASK-296-Voice-Profile-End-to-End/README.md) · [TASK-297](../TASK-297-SDK-Personalization-Cascade/README.md) · [TASK-298](../TASK-298-Remote-Pipeline-WS-Auth/README.md) · [TASK-299](../TASK-299-Consultation-Job-SSE-DNA/README.md) · [TASK-300](../TASK-300-Local-Pipeline-Cross-Cutting/README.md). **Aggregate**: 217 files modified across 12 packages/apps, ~8 800+ tests green across `@arcaai/vox` (2 870/2 870), `@arcaai/stt` (355/355), `@arcaai/applications` (3 828/3 828), `@hope/api` (1 130/1 130), `apps/stt-v2` (157/157), `@arcaai/{room,vad,noise-filter,med-ner,pipeline}` (1 490/1 490), `@hope/ui-playground` (152/152), `@arcaai/domains` (974/974). All Critical defects from §3 top-10 risks closed in-source; **2 additive Prisma migrations remain to be applied by the user** (`20260524000000_add_prompt_template_scope`, `20260524100000_add_audit_action_impersonated`). Cross-ticket hand-off contracts (`stt_session:${sessionId}` ticket scope, `preseed_speaker → {success, profile_id, model_id}`, `selectedPipelineId` UserSettings key, `VoiceEnrollmentChecker` interface, `STTFeatureFlags.task`) all met. Status: **Wave-5 execution complete — pending Prisma apply + integration smoke test**. |
