# TASK-933 — Native service-account realtime consultation plane + `vox-node` realtime lifecycle

| | |
|---|---|
| **Status** | `Pending` — plan approved in principle by the owner's OD answers (2026-09-09); awaiting the explicit **go** |
| **Type** | `feature` (authorization surface + SDK) |
| **Branch** | `dev-2.2` |
| **Consumer** | `ALaaSv3.0/apps/audio-stream-svc` (plan: `ALaaSv3.0/docs/HOPE_REALTIME_CONSULTATION_INTEGRATION_PLAN.md`) |
| **Owner decisions in force** | OD-1 **native** service-account plane ("system-to-system"), not delegation · OD-2 realtime socket lives in `@arcaai/vox-node` · OD-4/5/6 the four identity details (clinician user, patient, department, visit type) are REQUIRED on open; the tenant context schema was reviewed and is NOT the vehicle (§2.3) |

## 1. Requirement Analysis

An external system (`audio-stream-svc`) authenticated as a HOPE **service account** (`X-Service-Account-Token`, tenant bound at exchange) must drive a realtime consultation end to end, naming the clinician it acts for:

1. open a consultation for **clinician user + patient + department + visit type + summary language**;
2. start recording; create an STT streaming session it **owns**; stream PCM16 audio over `/ws/stt/stream`; receive transcript segments;
3. subscribe the live plane (`live-summary` snapshot + `section.patch` + `presummary`, `live-assist`, `harness-progress`, `loop`);
4. add case notes; stop recording; read the finalized note (`summary/latest`, with `structuredData.dnaStyleId`);
5. do all of it through typed `@arcaai/vox-node` methods, including a Node realtime STT socket.

Non-goals: opening the consultation-bound **workflows** plane (`:id/workflows*`) to service accounts (the registry records it as a separate owner decision; this flow does not need it — the platform dispatches the run at open); a machine ever being recorded as the clinician; per-request tenant override.

## 2. Current State Evaluation (code-verified 2026-09-09; two read-only lanes)

### 2.1 Why a service account cannot run a consultation today

- Every consultation route carries **no** `@RequiredSvcScopes` (manifest `svcScopes: []`) and `UnifiedAuthGuard.enforceServiceAccountScopes` denies by default (`packages/applications/src/authorization/unified-auth.guard.ts:584-603`).
- `ConsultationController.getDoctorId()` reads `cls.get('user')` and throws 401 otherwise (`apps/api/src/modules/consultation/consultation.controller.ts:223-229`); a service-account principal lives on CLS key `serviceAccount`, never `user` (`unified-auth.guard.ts:551-555`). `verifyConsultationAccess`/`verifyConsultationOwnership` (`:288`, `:339`) and `startRecording`'s `liveDocumentationService.start({ userId })` (`:717`) all go through it.
- `OpenConsultationRequest` has no clinician field by design (`open-consultation.request.ts:13`).
- STT: the class already carries `@RequiredSvcScopes('svc:stt:transcription:write')` (`transcription-job.controller.ts:74-104`), but `createStreamSession` writes `userId: user?.id` into the session (`:781`), mints the ticket with `userId: user?.id ?? ''` (`:815`) and binds the session with a `null` owner (`:822`), so the WS handshake's owner compare (`stt-ws.gateway.ts:548-555`) and `rebindSession` (`:765-772`) refuse a machine. The SVC-NOTE at `:91-103` records this as deliberate. `TenantOwnedResourceInterceptor.assertStreamSessionOwnership` (`tenant-owned-resource.interceptor.ts:181-190`) and the `ConsultationJob` `scope:'creator'` branch (`:231-239`) hard-code `cls.get('user')?.id`.
- `POST auth/stream-ticket` is JWT-only (`auth.controller.ts:938-941`) — but the STT ticket is auto-issued by `createStreamSession`/`refreshStreamTicket`, and the SSE routes authenticate the `X-Service-Account-Token` header directly, so this route is **not** needed by a server-side client.
- Scope registry: `svc:*` strings are derived only from existing API-key scopes (`service-account-scopes.registry.ts:225-240`); `svc:consultation:report:write` and `svc:stt:transcription:write` exist and are seeded (`seed/94-service-account.ts:187-189`); `svc:consultation:session:write/read` and `svc:consultation:report:read` do not. `svc:stt:stream:write` exists but gates the COMPAT `/api/stt` plane — do not reuse.
- Audit is already principal-correct: `BaseService.broadcastSysEvent` stamps `responsibleServiceAccountId` vs `responsibleEntityId` (`base.service.ts:99-101`); `AuditLogEntity` enforces exactly one actor. `requestUserId` returns `null` for a machine (`:178-180`) — any new code must not rely on it alone.
- `vox-node`: `hope.consultations` = `get`, `addContext` (doc says a service account cannot reach it, `resources/consultations.ts:99-103`), `.summaries.*`, `.workflows` (strict `assertCredentialClass`, `workflows.ts:186-194, 717+`); no open/recording/streams/STT socket; `agents.ts:28-30` states the package has no audio stack.

### 2.2 Downstream consumers read the consultation ROW, not the context

DNA style/redaction and the DNA report key off `Consultation.doctorId` (`config-resolver.service.ts:205-246`, `live-documentation.service.ts:4897-4928`, `DnaWritingStyleReportRepository.findLatestForDoctor`); patient history and consent off `patientId` (`consultation.service.ts:578-935`); the workflow cascade, department SOAP shapes and prompt tiers off `departmentId`; visit type is a pure function of `parentConsultationId` (`visit-type.service.ts:33-46`). The run payload's identity rides `subject: { consultationId, userId, externalPatientId }` built by the dispatcher (`consultation-workflow-dispatch.service.ts:224-243`), with `userId = requestUserId ?? doctorId` (`consultation.service.ts:413`) — for a machine caller that already resolves to the named clinician.

### 2.3 The tenant consultation context schema is a content vocabulary, not an identity contract (OD-4/5/6 review)

`ConsultationContextSchema` versions store `{ kinds[], outputs[] }` bound to the five platform primitives (`context-schema-definition.ts:1-134`), validated per `POST :id/context` write (`context.service.ts:214-239`), never at open; the seeded `context` kind's required fields (`visit_type`, `current_department`, `language`, `safe_*`, `formatted_*`) are platform-derived content (`seed/07e-consultation-note-context-schema.ts:96-108`), and `@arcaai/vox-codegen --tenant` types case-note kinds, not open fields. Declaring `user_id`/`patient_id`/`department_id` there would neither authorize a caller nor populate the row columns every consumer reads. **Decision:** identity is a request contract on `open` that lands on the row; the schema is unchanged; `visit_type` and `current_department` keep reaching prompts as derived context. (If the broker ever needs schema discovery for typed case-note kinds, `GET tenants/me/context-schema` would need `svc:tenant:context-schema:read` — optional, listed in §3.)

## 3. Implementation Plan

### 3.1 Scopes (registry + seed)

- New source family `CONSULTATION_REALTIME_SCOPE_SOURCES = ['consultation:session:write', 'consultation:session:read', 'consultation:report:read']` in `service-account-scopes.registry.ts`, derived like the existing families → `svc:consultation:session:write`, `svc:consultation:session:read`, `svc:consultation:report:read`. Boot audit D reconciles it; assertion G leaves business-plane routes exempt from fixture registration.
- SSE streams reuse `svc:consultation:session:write` (mirrors today's API-key gating; a dedicated `consultation:stream:read` would widen the API-key surface too — recommended: reuse, revisit if a read-only stream consumer appears).
- Seed the three on the ArcaAI platform service account (`94-service-account.ts`); optional `svc:tenant:context-schema:read` for discovery.

### 3.2 Consultation controller/service — acting for a named clinician

- `OpenConsultationRequest.clinicianUserId?: string` (uuid). **Honoured only when the caller is a service account**; a human caller supplying it gets 400 (`CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`). Required for a service-account caller (400 `CLINICIAN_REQUIRED`).
- `ConsultationController.resolveActingClinicianId(request)`: `cls.user.id` for a human; for a service account the validated `clinicianUserId`. Validation in the service: `assertUserBelongsToTenant` (existing, `tenant-guards.ts:164-207`) **plus** the named user must be able to own a consultation — build their CASL ability and require `can('create', 'Consultation')` (no new role list; the tenant's policy decides). Foreign/unknown user → 404 (404-over-403).
- Every subsequent call reads the clinician from the ROW: `verifyConsultationAccess`/`verifyConsultationOwnership` gain a service-account branch that asserts tenant + scope only (a machine has no doctor equality to check); `startRecording` passes `userId: consultation.doctorId` to `liveDocumentationService.start` for a machine caller. `Consultation.doctorId` never names a service account.
- `@RequiredSvcScopes` on: `open` (`session:write`), `getById` (`session:read`), `recording/start|stop` (`session:write`), `context` (`session:write`), `summary/latest` (`report:read`), `summary/pre-summary[/async]` (`report:write`, exists), `live-summary/stream`, `live-assist/stream`, `harness-progress/stream`, `loop/stream` (`session:write`), `consultations/jobs/:jobId/stream` (`report:read`; tenant-scoped already).
- Not opened: `:id/workflows*` (separate owner decision), `POST auth/stream-ticket` (not needed).

### 3.3 STT session ownership for a machine principal

- One resolution helper (`resolveStreamOwnerId(): cls.user?.id ?? cls.serviceAccount?.id`) used by `createStreamSession` (session `userId`, ticket `userId`, binding owner) and `refreshStreamTicket`; the empty-string/`null` owner fallbacks are removed (a session is never created ownerless). `TenantOwnedResourceInterceptor.assertStreamSessionOwnership` and the `ConsultationJob` creator branch use the same helper. `SttWsGateway` is untouched (pure string compare on both ends); `ws-gateway-owner-audit` classification stays `enforced`. The SVC-NOTE is rewritten to state the new rule.

### 3.4 `@arcaai/vox-node`

- `hope.consultations.open(request)` (`clinicianUserId` typed), `.recording.start(id, { sessionId? })`, `.recording.stop(id, opts)`, `.streams.liveSummary(id, handlers)` (SSE off `response.body`, header auth, discriminates `section.patch` / `presummary` events), `.streams.liveAssist/harnessProgress/loop`, `.jobs.stream(jobId)`, `.summaries.latest` (exists), `.addContext` doc updated.
- `hope.stt.createStreamSession(req)` (wraps `POST audio/transcription-jobs/stream/session`, returns `{ sessionId, wsUrl, ticket, ticketExpiresAt }`), `hope.stt.refreshTicket(sessionId)`, `hope.stt.close(sessionId)`, and `RealtimeSttSocket` (`globalThis.WebSocket`, Node ≥ 22): `connect()`, `sendPcm16(frame)`, `stop()`, `close()`, `resume(lastSeq)`, events `transcript` (`WsTranscriptResult`), `status`, `error`, `resumed`; ticket refresh before expiry. Zero runtime dependencies preserved; README §"no audio stack" amended to "no audio pipeline: this is a socket client".
- `ConsultationWorkflowsResource` keeps its strict credential check (plane not opened).

### 3.5 TDD list (RED first, each lane)

| # | Test | Location |
|---|---|---|
| 1 | registry derives the three new `svc:consultation:*` scopes; wildcard `svc:admin:*` does not cover them | `service-account-scopes.registry` tests |
| 2 | `open` as a service account with `clinicianUserId` creates the row with `doctorId = clinician`, `patientId/departmentId/parentConsultationId/language` set; missing clinician → 400; human caller with clinician → 400; foreign/unknown user → 404; user without `create:Consultation` → 404 | `consultation.controller` + `consultation.service` unit tests |
| 3 | `recording/start` as a service account starts the live session with `userId = consultation.doctorId` | controller test |
| 4 | `createStreamSession` as a service account binds owner = service-account id, ticket owner = same; refresh works; a different service account 404s; WS handshake accepts the owner and refuses another principal | `transcription-job.controller` + `stt-ws.gateway` tests |
| 5 | SSE routes reachable with the service-account header; foreign tenant 404 | e2e `task-776-credential-classes` additions |
| 6 | `vox-node`: open/recording/streams/stt methods hit the right routes with the right headers; `RealtimeSttSocket` frames PCM16, honours stop/close/resume, refreshes the ticket | `packages/vox-node` unit tests (fetch/WebSocket doubles) |
| 7 | route-authz matrix: regenerated manifest carries the new `svcScopes`; boot audits D/G green | existing suites |

### 3.6 Files (creation/modification order)

1. `packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts` (+ tests), `seed/94-service-account.ts`.
2. `packages/applications/src/services/consultation/consultation/dto/open-consultation.request.ts`, `consultation.service.ts` (clinician validation), `packages/applications/src/common/tenant-guards.ts` (ability check helper if needed).
3. `apps/api/src/modules/consultation/consultation.controller.ts`, `consultation-job.controller.ts`, `apps/api/src/common/tenant-owned-resource.interceptor.ts`, `apps/api/src/modules/streaming/transcription-job.controller.ts`.
4. Regenerate the five artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` (in a worktree — never in the primary checkout while the watch API runs).
5. `packages/vox-node/src/resources/consultations.ts`, `consultation-streams.ts` (new), `stt.ts` (new), `core/realtime-stt-socket.ts` (new), README, `docs/architecture/vox-node-gateway-gaps.md`, `.claude/rules/08-vox-sdk.md`.
6. e2e: `apps/api/tests/e2e/task-933-service-account-consultation.spec.ts`; an integration script replaying `apps/admin-console/tests/e2e/fixtures/audio/cardiology_consult_01.wav` through `RealtimeSttSocket` against the dev gateway.

### 3.7 Lanes and tiers (rule 14)

| Lane | Boundary | Tier | Gates |
|---|---|---|---|
| H1 authorization | registry, seed, DTO, consultation service/controller, interceptor, STT controller, artifacts, e2e | `opus` (deciding lane) | applications tests, api unit, route-authz matrix, credential-class e2e against the dev gateway |
| H2 SDK | `packages/vox-node/**`, docs | `opus` | `sdk-node:*` gates, `gen:admin:check`, live replay script |

H2 can start against the pinned contracts while H1 lands; merge H1 first, then H2, re-run gates after each merge (rule 14 §5).

### 3.8 Verification criteria

- A seeded service account opens a consultation for `DOCTOR` in `GEN_ARCAAI`, records a replayed WAV through `RealtimeSttSocket`, receives transcript segments and live-summary/section-patch events, stops, and reads `summary/latest` with `structuredData.dnaStyleId = 73000000-0000-0000-0001-000000000001`; audit rows name the service account as actor and the clinician as doctor.
- The same account 404s on another tenant's consultation and on a session owned by another principal; a human caller cannot name a clinician.
- All five artifacts regenerated; boot audits green; `lint:all`, `typecheck:all` green for the touched packages.

## 4. Owner decisions (taken) and remaining calls

| Id | Decision |
|---|---|
| OD-1 | Native service-account plane — **taken** (owner, 2026-09-09) |
| OD-2 | Realtime STT socket in `vox-node` — **taken** |
| OD-4/5/6 | Identity on the open request → row; context schema unchanged — **recommended by the review**, owner to confirm at go |
| OQ-3 | Who may be named as clinician: any tenant user holding `create:Consultation` (no new role list) — **recommended** |
| OQ-4 | SSE scope: reuse `svc:consultation:session:write` — **recommended** |
| OQ-1 / OQ-2 | `auth/stream-ticket` and `:id/workflows*` stay closed to service accounts — **recommended** |

## 5. Implementation Summary

_Not started._

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-09 | Ticket opened after two read-only discovery lanes (service-account plane touchpoints; consultation context schema review) requested by the ALaaS integration plan. Status `Pending` — awaiting go. |
