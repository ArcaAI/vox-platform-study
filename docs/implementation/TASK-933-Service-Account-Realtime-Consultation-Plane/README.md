# TASK-933 — Native service-account realtime consultation plane + `vox-node` realtime lifecycle

| | |
|---|---|
| **Status** | `In Progress` — H1 merged (`ad85ccd9f`) and H2 merged (`2b9696fb3`) into `dev-2.2` on 2026-09-09; post-merge e2e against the dev gateway and the ALaaS live proof pending |
| **Type** | `feature` (authorization surface + SDK) |
| **Branch** | `dev-2.2` |
| **Consumer** | `ALaaSv3.0/apps/audio-stream-svc` (plan: `ALaaSv3.0/docs/HOPE_REALTIME_CONSULTATION_INTEGRATION_PLAN.md`) |
| **Owner decisions in force** | OD-1 **native** service-account plane ("system-to-system"), not delegation · OD-2 realtime socket lives in `@arcaai/vox-node` · OD-4/5/6 the four identity details (clinician user, patient, department, visit type) are REQUIRED on open; the tenant context schema was reviewed and is NOT the vehicle (§2.3) · **2026-09-09 (later):** the service account must hold **every permission `vox-node` needs for a realtime consultation**, including **fetching the tenant's context-schema definition** (so ALaaS engineering can build against it) and the consultation-bound **workflows plane** — this supersedes the registry's recorded exclusion of that plane · the ArcaAI tenant must select the correct workflow per session from clinician user id, patient id, department and visit type (§1.1) |

## 1. Requirement Analysis

An external system (`audio-stream-svc`) authenticated as a HOPE **service account** (`X-Service-Account-Token`, tenant bound at exchange) must drive a realtime consultation end to end, naming the clinician it acts for:

1. open a consultation for **clinician user + patient + department + visit type + summary language**;
2. start recording; create an STT streaming session it **owns**; stream PCM16 audio over `/ws/stt/stream`; receive transcript segments;
3. subscribe the live plane (`live-summary` snapshot + `section.patch` + `presummary`, `live-assist`, `harness-progress`, `loop`);
4. add case notes; stop recording; read the finalized note (`summary/latest`, with `structuredData.dnaStyleId`);
5. do all of it through typed `@arcaai/vox-node` methods, including a Node realtime STT socket;
6. **fetch the tenant's context-schema definition** (`GET tenants/me/context-schema`, the discovery bundle `vox-codegen --tenant` types) as the service account, so ALaaS engineering can generate types and build case-note payloads against the tenant's declared kinds;
7. reach the consultation-bound **workflows plane** (`GET :id/workflows`, `POST :id/workflows/:slug/runs`, run streams) as the service account — the owner's "all permissions" ruling (2026-09-09) supersedes the registry's earlier exclusion note (`service-account-scopes.registry.ts:198-203`).

Non-goals: a machine ever being recorded as the clinician; per-request tenant override; opening `POST auth/stream-ticket` to machines (not needed: the service-account header authenticates SSE directly and the STT ticket is auto-issued by session create/refresh).

### 1.1 Workflow selection per session (what the ArcaAI tenant already does, and what ALaaS must send)

HOPE selects the governing workflow at `open` from the four details — no new mechanism is needed beyond the open contract in §3.2:

| Detail on `open` | Selection effect today |
|---|---|
| `departmentId` | `WorkflowAssignmentService.resolve(tenant, 'core', departmentId, tags)` walks DEPARTMENT → TENANT tiers (`workflow-assignment.service.ts:78-107`); ArcaAI seeds one department assignment per department (`arcaai-gen-consultation`, `arcaai-surg-consultation`, … — 11 rows, `seed/28-workflow-library.ts`) and the department-scoped SOAP shape + context schema (`07f-arcaai-department-context-schemas.ts`) |
| `parentConsultationId` (absent = new visit, present = revisit) | `VisitTypeService.forConsultation` → selector tag `visit-type:new-visit` / `visit-type:revisit` (`consultation-workflow-dispatch.service.ts:335-350`); inside the graph the `n_visit` `core.condition` routes to `n_summary_new` / `n_summary_revisit` (TASK-932, realtime lane honours it) and the revisit path carries the prior visit's context |
| `clinicianUserId` → `Consultation.doctorId` | DNA writing style + redaction gate and the doctor's report at finalize (`ConfigResolver.resolveEffectiveDnaStyleEnabled`, `resolveHandoffContext`), preferred prompt template, audit |
| `patientId` | case notes / previous-visit history for the warm-start pre-summary (`findCaseNotes`, `getPatientHistory`), consent |
| `language` | summary language of the finalized note |
| `workflowDefinitionSlug` (optional, exists) | an explicit override validated by `assertWorkflowSelectionAllowed` against the cascade — ALaaS should NOT send it; the department decides |

ALaaS therefore needs a mapping from its own department ids and consultant ids to HOPE `departmentId`s and user ids (resolved once through `hope.admin.department.list` / `hope.admin.user.list`, cached), and must pass the prior HOPE consultation id for a revisit.

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

- New source family `CONSULTATION_REALTIME_SCOPE_SOURCES = ['consultation:session:write', 'consultation:session:read', 'consultation:report:read', 'tenant:context-schema:read', 'workflows:execute']` in `service-account-scopes.registry.ts`, derived like the existing families → `svc:consultation:session:write`, `svc:consultation:session:read`, `svc:consultation:report:read`, `svc:tenant:context-schema:read`, `svc:workflows:execute`. Boot audit D reconciles it; assertion G leaves business-plane routes exempt from fixture registration. The registry's note excluding the consultation-bound workflows plane (`:198-203`) is rewritten to record the owner decision that opens it.
- SSE streams reuse `svc:consultation:session:write` (mirrors today's API-key gating; a dedicated `consultation:stream:read` would widen the API-key surface too — recommended: reuse, revisit if a read-only stream consumer appears).
- Seed all five on the ArcaAI platform service account (`94-service-account.ts`), beside the existing `svc:consultation:report:write` and `svc:stt:transcription:write` — the account then holds every permission the `vox-node` realtime consultation surface needs.

### 3.2 Consultation controller/service — acting for a named clinician

- `OpenConsultationRequest.clinicianUserId?: string` (uuid). **Honoured only when the caller is a service account**; a human caller supplying it gets 400 (`CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`). Required for a service-account caller (400 `CLINICIAN_REQUIRED`).
- `ConsultationController.resolveActingClinicianId(request)`: `cls.user.id` for a human; for a service account the validated `clinicianUserId`. Validation in the service: `assertUserBelongsToTenant` (existing, `tenant-guards.ts:164-207`) **plus** the named user must be able to own a consultation — build their CASL ability and require `can('create', 'Consultation')` (no new role list; the tenant's policy decides). Foreign/unknown user → 404 (404-over-403).
- Every subsequent call reads the clinician from the ROW: `verifyConsultationAccess`/`verifyConsultationOwnership` gain a service-account branch that asserts tenant + scope only (a machine has no doctor equality to check); `startRecording` passes `userId: consultation.doctorId` to `liveDocumentationService.start` for a machine caller. `Consultation.doctorId` never names a service account.
- `@RequiredSvcScopes` on: `open` (`session:write`), `getById` (`session:read`), `recording/start|stop` (`session:write`), `context` (`session:write`), `summary/latest` (`report:read`), `summary/pre-summary[/async]` (`report:write`, exists), `live-summary/stream`, `live-assist/stream`, `harness-progress/stream`, `loop/stream` (`session:write`), `consultations/jobs/:jobId/stream` (`report:read`; tenant-scoped already).
- `@RequiredSvcScopes('svc:workflows:execute')` on `ConsultationWorkflowRunsController.list/startRun` (`apps/api/src/modules/workflows/consultation-workflow-runs.controller.ts:66-132`) and the run stream/ticket routes of that plane; `@RequiredSvcScopes('svc:tenant:context-schema:read')` on `MyTenantContextSchemaController` (`apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts:180-227`).
- Not opened: `POST auth/stream-ticket` (not needed by a server-side client).

### 3.3 STT session ownership for a machine principal

- One resolution helper (`resolveStreamOwnerId(): cls.user?.id ?? cls.serviceAccount?.id`) used by `createStreamSession` (session `userId`, ticket `userId`, binding owner) and `refreshStreamTicket`; the empty-string/`null` owner fallbacks are removed (a session is never created ownerless). `TenantOwnedResourceInterceptor.assertStreamSessionOwnership` and the `ConsultationJob` creator branch use the same helper. `SttWsGateway` is untouched (pure string compare on both ends); `ws-gateway-owner-audit` classification stays `enforced`. The SVC-NOTE is rewritten to state the new rule.

### 3.4 `@arcaai/vox-node`

- `hope.consultations.open(request)` (`clinicianUserId` typed), `.recording.start(id, { sessionId? })`, `.recording.stop(id, opts)`, `.streams.liveSummary(id, handlers)` (SSE off `response.body`, header auth, discriminates `section.patch` / `presummary` events), `.streams.liveAssist/harnessProgress/loop`, `.jobs.stream(jobId)`, `.summaries.latest` (exists), `.addContext` doc updated.
- `hope.stt.createStreamSession(req)` (wraps `POST audio/transcription-jobs/stream/session`, returns `{ sessionId, wsUrl, ticket, ticketExpiresAt }`), `hope.stt.refreshTicket(sessionId)`, `hope.stt.close(sessionId)`, and `RealtimeSttSocket` (`globalThis.WebSocket`, Node ≥ 22): `connect()`, `sendPcm16(frame)`, `stop()`, `close()`, `resume(lastSeq)`, events `transcript` (`WsTranscriptResult`), `status`, `error`, `resumed`; ticket refresh before expiry. Zero runtime dependencies preserved; README §"no audio stack" amended to "no audio pipeline: this is a socket client".
- `hope.tenants.contextSchema()` → `GET tenants/me/context-schema` (the discovery bundle: kinds, outputs, pinned version, checksum), typed like `vox-codegen`'s fetch; and `@arcaai/vox-codegen --tenant` gains a **service-account mode** (`--client-id/--client-secret` or `HOPE_SVC_CLIENT_ID/SECRET`, `--tenant` bound at exchange) beside the super-admin JWT mode, so ALaaS engineering can generate the consultation-context types without a human token.
- `ConsultationWorkflowsResource` widens its inherited `assertCredentialClass()` to accept a service account (mirroring `WorkflowsResource`, `workflows.ts:566`) now that the plane is opened; `addContext`'s doc comment (`consultations.ts:99-103`) is rewritten.

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
| 8 | `GET tenants/me/context-schema` as a service account returns the tenant's pinned bundle; a foreign tenant's schema is never visible; `vox-codegen --tenant` in service-account mode emits the same types as the JWT mode | controller e2e + `packages/vox-codegen` tests |
| 9 | `GET :id/workflows` and `POST :id/workflows/:slug/runs` as a service account holding `svc:workflows:execute` (and 403 without it); `vox-node` `consultations.workflows.*` no longer throws `CredentialClassError` for a service account | e2e + `packages/vox-node` tests |

### 3.6 Files (creation/modification order)

1. `packages/applications/src/services/serviceAccount/service-account-scopes.registry.ts` (+ tests), `seed/94-service-account.ts`.
2. `packages/applications/src/services/consultation/consultation/dto/open-consultation.request.ts`, `consultation.service.ts` (clinician validation), `packages/applications/src/common/tenant-guards.ts` (ability check helper if needed).
3. `apps/api/src/modules/consultation/consultation.controller.ts`, `consultation-job.controller.ts`, `apps/api/src/common/tenant-owned-resource.interceptor.ts`, `apps/api/src/modules/streaming/transcription-job.controller.ts`, `apps/api/src/modules/workflows/consultation-workflow-runs.controller.ts`, `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts` (`MyTenantContextSchemaController`).
4. Regenerate the five artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` (in a worktree — never in the primary checkout while the watch API runs).
5. `packages/vox-node/src/resources/consultations.ts`, `consultation-streams.ts` (new), `stt.ts` (new), `tenants.ts` (context-schema discovery), `workflows.ts` (widened credential class), `core/realtime-stt-socket.ts` (new), README, `docs/architecture/vox-node-gateway-gaps.md`, `.claude/rules/08-vox-sdk.md`; `packages/vox-codegen/src/{cli,fetch-schema}.ts` (service-account mode).
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
| OQ-1 | `auth/stream-ticket` stays closed to service accounts (not needed) — **recommended** |
| OQ-2 | the consultation-bound workflows plane (`:id/workflows*`) is **opened** to the service account under `svc:workflows:execute` — **taken** (owner, 2026-09-09: "all permissions for vox-node to handle realtime consultation"); supersedes the registry note |
| OD-7′ | the service account also fetches the tenant context-schema definition (`svc:tenant:context-schema:read`) and `vox-codegen --tenant` gains a service-account mode — **taken** (owner, same message) |

## 5. Implementation Summary

_Not started._

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-09 | **Post-merge e2e against the dev gateway: `task-933-service-account-consultation.spec.ts` 12/12** (`SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-933`; throttle off for the run, restored v23). Two spec-only fixes on the way: the live-summary stream is now opened with a raw `node:http` request that resolves on the response headers and destroys the socket (Playwright's request context buffers the body, and an event stream never ends), and the journey case carries a 150 s budget because `recording/stop` runs the realtime lane's final flush before answering — with a case note on file that is a TEXT call, observed at 34 s when LM Studio answered 502 under load, 18 s on the re-run. The plane itself needed no change: open for a named clinician, read, record, SSE with the service-account header, case note, consultation workflows list, stop, summary latest, STT session create → refresh-ticket → close as owner, plus every negative (foreign clinician 404, human-with-clinician 400, cannot-own 404, malformed 400, unopened route deny-by-default, `auth/stream-ticket` closed, foreign consultation 404 on every verb). |
| 2026-09-09 | **H1 and H2 merged into `dev-2.2`** (`ad85ccd9f`, `2b9696fb3`, on top of the other session's `a0cf39279`). Before merging, `dev-2.2` was merged into each lane tree (clean both times); gates re-run on the merged base: H1 — `api:build` 12/12, route-manifest 743 routes, openapi/portal/gen:admin regenerated with zero drift, applications suites 218 files / 3677, api suites 69 files / 1193; H2 — `sdk-node:*` green (484), `sdk-codegen:*` green (63), gen:admin no drift; combined tree gen:admin no drift. The dev database's seeded ArcaAI service account (`hope_svc_a4ca…`) was granted the five new scopes by an idempotent SQL append (43 → 48 scopes; the seed reconciles the same set on its next run); `packages/domains`, `applications` and `vox-node` rebuilt in the primary and the watch API restarted so the running stack serves the merged code. Two TASK-932 worktrees' commits from another concurrent session were merged into `dev-2.2` during this wave — no overlap with this ticket's files. |
| 2026-09-09 | **H1 reported** (`task-933/authz`, one commit `8406e8651` on `c0d105e95`; the writer records a destructive slip mid-run — a stray `git checkout HEAD -- .` — reconstructed from its record and fully re-gated; the orchestrator re-verifies after the base merge). Contract: `clinicianUserId` (`@Matches` 8-4-4-4-12 hex, not `@IsUUID` — the seeded ids are not RFC-4122); service account without it → 400 `CLINICIAN_REQUIRED`; human with it → 400 `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`; foreign/unknown/cannot-own/unwired policy engine → 404. Fifth scope family seeded on `hope_svc_a4ca…`; 18 routes carry `svcScopes` (open/get/recording/context/four streams/summary latest/pre-summary latest+generate(+async)/jobs get+stream/consultation workflows list+start/tenants me context-schema); deliberately still closed: selectable workflows list, `:id/workflow`, job cancel, `POST :id/summary[/async]`, `auth/stream-ticket`. STT: `resolveStreamOwnerId()` (throws rather than defaulting) writes session/ticket/binding; interceptor `resolveCallerPrincipalId()`; gateway untouched, three new handshake cases. Gates in the lane: api unit 290 files / 4330, applications 743 files / 12,438 (the live-DB integration suite excluded by the repo gate), database 83 / 1702, `api:build` 12/12, openapi/portal/gen:admin checks clean, manifest 743 routes. Residuals outside its diff: two pre-existing prettier errors in `harness-internal.controller.ts` (TASK-932 lane). Deviations: `task-776-credential-classes.spec.ts` deny-by-default case moved to `GET :id/workflow`; `AuthorizationModule` named explicitly in the consultation module. Open: `Consultation.createdBy` for a machine open falls to the system user (audit itself is principal-correct); `svc:consultation:report:write` family name under-describes its reach. E2E `task-933-service-account-consultation.spec.ts` (12 tests) to be run by the orchestrator against the dev gateway. |
| 2026-09-09 | **H2 reported** (`task-933/sdk`, three commits `df06136f6`, `6be355455`, `a2718a41c`; not yet merged — order is H1 → H2): `hope.consultations.open/recording.start|stop/streams.{liveSummary,liveAssist,harnessProgress,loop}`, `hope.jobs.subscribe` (the job stream lives on the root jobs resource, not under consultations), `hope.stt.{createStreamSession,refreshTicket,closeStreamSession,socket}` + `RealtimeSttSocket` (binary PCM16, lazy single-use ticket refresh at handshake/expiry rather than a timer, resume, `SocketUnavailableError` with remedy), `ConsultationWorkflowsResource` credential check widened (two pinning suites inverted with AMENDED notes), `hope.tenants.contextSchema()` documented for service accounts, `vox-codegen --tenant` service-account mode (`--client-id/--client-secret/--working-tenant`, env `HOPE_SVC_CLIENT_ID/SECRET` added to `turbo.json#globalEnv`), README/gaps/rule 08 amended ("no audio PIPELINE"). Gates: `sdk-node:build/test (33 files, 484)/lint/typecheck/check:exports` green, `gen:admin:check` no drift (49 areas, 422 routes), `sdk-codegen:*` green (63 tests); `sdk-node:format:check` red on ten untouched test files (pre-existing drift, left alone). Deliberately not added: `harnessAssurance` stream (not in H1's scope list → would 403). Open: `?tenantId=` on the WS handshake is optional in the socket; codegen `--watch` does not refresh the service token; the live WAV replay waits for H1. No version bump (release decision). |
| 2026-09-09 | Owner said **go**. Worktrees `../hope-v2-task-933-authz` (`task-933/authz`) and `../hope-v2-task-933-sdk` (`task-933/sdk`) created off `dev-2.2` (env files copied, `pnpm install` + `db:generate` + dependency-chain builds run by the orchestrator); ALaaS `../ALaaSv3.0-hope-rt-{broker,web-ui}` off `codeSwitchImplementation`. Writers: H1 and H2 at `opus`, A1 at `opus`, A2 `sonnet` removals + `opus` hook. Merge order H1 → H2 (gates re-run after each), then A1-real. |
| 2026-09-09 | Owner refinement: the service account holds **every** permission the `vox-node` realtime consultation surface needs — the scope family grows to five (`svc:consultation:session:write/read`, `svc:consultation:report:read`, `svc:tenant:context-schema:read`, `svc:workflows:execute`); the consultation-bound workflows plane is opened (supersedes the registry exclusion note); `GET tenants/me/context-schema` and `vox-codegen --tenant` accept the service account so ALaaS engineering can build against the tenant's schema; §1.1 records how the ArcaAI tenant selects the workflow per session from clinician, patient, department and visit type (department assignment + visit-type selector + the `n_visit` branch — no new mechanism). `auth/stream-ticket` stays closed. Still `Pending`, awaiting go. |
| 2026-09-09 | Ticket opened after two read-only discovery lanes (service-account plane touchpoints; consultation context schema review) requested by the ALaaS integration plan. Status `Pending` — awaiting go. |
