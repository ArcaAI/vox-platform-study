# Phase A — Consultation Start Flow API Contract (Code File Walkthrough)

**Scope:** `project-hope/apps/api/src/modules/consultation` (API gateway, consultation module)  
**Focus:** “Doctor clicks **Start consultation**” — identify the API contract, request/response shapes, and controller-level behavior/sequencing relevant to opening and starting capture.

**Primary files covered (Phase A):**
- `consultation.controller.ts`
- `consultation-lifecycle-events.controller.ts`
- `dto/index.ts`
- `dto/lifecycle-command.request.ts`
- `dto/lifecycle.response.ts`
- `dto/close-consultation.request.ts` (present in `dto/`; adjacent lifecycle command, included for completeness)

> **Note:** `consultation.controller.ts` is large (~2610 lines). This document explains its structure and the parts most relevant to Phase A (open/select/start/pause/stop, recording aliases, access/validation helpers, lifecycle/event/stream-adjacent endpoints). Non-start-specific endpoints are summarized where useful for sequencing context.

---

## 1) `dto/index.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/dto/index.ts`

### What this file does
- Acts as the DTO barrel/export file for consultation-module-local DTOs.
- Re-exports:
  - `./close-consultation.request`
  - `./lifecycle-command.request`
  - `./lifecycle.response`

### Why it matters for Phase A
- Centralizes local lifecycle DTO imports for controllers (e.g. `consultation.controller.ts` imports `StartConsultationRequest`, `StopConsultationRequest`, `CaptureStateResponse`, etc. from `./dto`).
- Indicates which lifecycle request/response DTOs are maintained inside this module vs imported from `@arcaai/applications`.

---

## 2) `dto/lifecycle-command.request.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts`

### What this file does
Defines request DTO classes (with `class-validator` rules and Swagger metadata) for consultation lifecycle commands.

### Classes and fields

#### `StartConsultationRequest`
- **Used by:** `POST /consultations/:id/start` body
- **Fields:**
  - `sessionId?: string` (optional, string)
    - Swagger: STT streaming session ID obtained from `POST audio/transcription-jobs/stream/session`
    - Behavior documented in DTO/controller: naming a session binds audio ingress to that STT session; a no-longer-live session yields `409 STT_SESSION_NOT_ACTIVE`
- **Validation:** `@IsOptional()`, `@IsString()`

#### `StopConsultationRequest extends StopRecordingRequest`
- **Used by:** `POST /consultations/:id/stop` body
- **Inherits:** `StopRecordingRequest` from `@arcaai/applications` (e.g. recording-stop fields such as snapshot/proposal handling; see applications DTO for full inherited shape)
- **Adds:**
  - `waitForFinal?: boolean` (optional, boolean, default documented as `true`)
    - Swagger/behavior: hold response (up to tenant final-transcript timeout) until final transcript is rebuilt
    - If wait ends first, `finalTranscript.state` is `pending`; client can re-POST stop (idempotent no-op on STOPPED consultation) or wait for `transcript_final` lifecycle event
- **Validation:** `@IsOptional()`, `@IsBoolean()`

#### `ApproveConsultationRequest`
- **Used by:** `POST /consultations/:id/approve` body (later lifecycle phase, but important for state machine understanding)
- **Fields:**
  - `clinicianUserId?: string` — required for machine credentials (API key/service account) because a machine is never the attesting clinician; human callers may name another clinician only with elevated roles (as documented)
  - `overrideSafetyFlag?: boolean` — approve despite open safety flag (recorded on attestation)
  - `acknowledgeGuardrailNotices?: boolean` — indicates client acknowledged outstanding guardrail warnings in confirm step; warnings are acknowledged in approve transaction
  - `resolveHold?: ApproveResolveHoldRequest` — nested DTO (from `@arcaai/applications`) to resolve inbound guardrail hold and approve in same transaction (outbound hold requires resume/regenerate path)
- **Validation:** optional string/boolean checks; nested validation/transform for `resolveHold`

#### `ReopenConsultationRequest`
- **Used by:** `POST /consultations/:id/reopen` body
- **Fields:**
  - `clinicianUserId?: string` — optional; attribution rules differ for service account vs human/API key (service account may omit to reopen for consultation’s clinician; machine is never clinician)
  - `reason?: string` — audited reopen reason, max length 256
- **Validation:** optional string + `@MaxLength(256)` for reason

### Why it matters for Phase A
- `StartConsultationRequest` defines the only client-supplied binding commonly needed at start: the STT `sessionId`.
- `StopConsultationRequest` defines polling/wait behavior that clients must plan for when stopping capture (often immediately after start in test flows, and critical for end-to-end UX).

---

## 3) `dto/lifecycle.response.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/dto/lifecycle.response.ts`

### What this file does
Defines response DTO classes and enums-as-strings for consultation lifecycle commands and recording reads.

### Constants / vocabularies
- `STATUSES = ['OPEN', 'RECORDING', 'PAUSED', 'STOPPED', 'APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE']`
- `PROCESSING = ['IDLE', 'FINALIZING_TRANSCRIPT', 'SUMMARIZING', 'PROCESSING_ATTACHMENT', 'AWAITING_REVIEW', 'FAILED']`

These reflect the **real lifecycle pair** vocabulary used by lifecycle responses (and/or echoed alongside projected legacy status depending on headers/interceptors).

### Classes and fields

#### `LifecyclePairResponse`
- `status: string` (enum `STATUSES`)
- `processing: string` (enum `PROCESSING`)
- Represents the real lifecycle status/processing pair.

#### `CaptureStateResponse`
- **Returned by:** `POST /consultations/:id/start`, `POST /consultations/:id/pause` (and serves as base for stop result)
- **Fields:**
  - `consultationId: string`
  - `status: string` — lifecycle status; may be projected to legacy vocabulary for older clients unless `X-Hope-Lifecycle: 2` is sent (per description)
  - `processing: string` — orthogonal processing marker
  - `encounterSeq: number` — encounter/visit capture belongs to
  - `sessionId?: string` — STT streaming session bound by start (echoed)
  - `recording: boolean`
  - `paused: boolean`
  - `version: number` — consultation `_version` after command (If-Match value for approve/close/reopen, etc.)
  - `updatedAt: string` (ISO-8601)
  - `lifecycle?: LifecyclePairResponse` — present when `status` was projected for an older client (real values carried here)

#### `FinalTranscriptStateResponse`
- **Embedded in stop response**
- **Fields:**
  - `state: 'complete' | 'pending'` — `pending` means transcript still finalizing; client may re-POST stop to poll
  - `contextItemId: string | null` — FULL_TRANSCRIPT item once rebuilt
  - `versionNumber: number | null`
  - `segmentCount: number`
  - `lastSegmentSeq: number`

#### `StopResultResponse extends CaptureStateResponse`
- **Returned by:** `POST /consultations/:id/stop`
- Adds:
  - `finalTranscript: FinalTranscriptStateResponse`

#### `ConsultationRecordingPartResponse`
- Represents one recording part on consultation-wide timeline
- Fields: `audioRecordingId`, `encounterSeq`, `startMs`, `durationMs`, `url` (nullable presigned download URL), `expiresAt` (nullable ISO-8601)

#### `ConsultationRecordingResponse`
- **Returned by:** `GET /consultations/:id/recording`
- Fields: `contextItemId`, `versionNumber`, `codec` (nullable), `totalMs`, `parts: ConsultationRecordingPartResponse[]`

### Why it matters for Phase A
- Defines the canonical client-visible state after `start`/`pause`/`stop`.
- Shows that **status projection/compatibility** and **orthogonal processing state** are both part of the contract.
- `version` in capture responses is important for subsequent optimistic-concurrency operations.
- `StopResultResponse.finalTranscript` defines the polling/completion contract after stopping capture.

---

## 4) `dto/close-consultation.request.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/dto/close-consultation.request.ts`

### What this file does
Defines the request body DTO for `POST /consultations/:id/close` (gateway-local DTO).

### Key design points (from file comments)
- Route historically had no body; body was added to support machine callers naming an attributed clinician (similar attribution rule to `open`/approve/reopen flows).
- Must be explicitly declared because global validation pipe uses whitelist/forbid-non-whitelisted/forbid-unknown-values; undeclared fields would cause request rejection (important for SDK compatibility).
- All fields optional so human callers can send no body (`{}` after Nest parsing/validation still valid).

### Fields
- `clinicianUserId?: string` (optional)
  - Required for machine credential attribution in close flow (as documented)
  - Human callers naming another clinician restricted by role rules; API key bound-user rules enforced elsewhere
  - Tenant/clinician validation follows 404-over-403 posture in service/attribution logic

### Why it matters for Phase A
- Not part of “start” itself, but part of the same lifecycle contract family and useful to understand clinician attribution rules that also appear around open/start-adjacent machine flows.

---

## 5) `consultation-lifecycle-events.controller.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`

### What this file does
Exposes the consultation lifecycle event stream over SSE so clients can observe lifecycle transitions and processing changes after actions like `start`, `pause`, `stop`, `approve`, `close`, `reopen`.

### Controller-level setup
- `@ApiBearerAuth()`, `@ApiTags('consultations')`
- `@Controller('consultations')`
- `@Authorize()`
- `@RequiredScopes('consultation:session:write')` (class-level scope for this stream endpoint)

### Dependencies
- Injects `ConsultationLifecycleEventPublisher` from `@arcaai/applications`
- Uses `@TenantOwnedResource({ modelName: 'Consultation', paramName: 'id' })` to assert tenant ownership before stream opens (cross-tenant resolved as 404 before stream)
- Uses `@StreamScope({ namespace: 'consultation_lifecycle', param: 'id' })` for ticket-scoped stream auth support
- Uses `@RequiredSvcScopes('svc:consultation:session:write')` for machine/service scope

### Endpoint

#### `GET /consultations/:id/events` (`@Sse()`)
- **Method:** `streamEvents(@Param('id') id, @Query('since') since?)`
- **Behavior:**
  - Parses `since` query param via local `parseSince()` helper
  - Returns `this.events.subscribe(id, parseSince(since))` as `Observable<MessageEvent>`
- **Query parsing/validation (`parseSince`)**
  - Accepts `undefined`/empty as no replay cursor
  - Requires non-negative integer string (`/^\d+$/`)
  - Throws `400 BadRequestException` with `code: 'SINCE_INVALID'` if invalid
- **Swagger/contract notes (from decorator):**
  - Emits one `LifecycleEvent` JSON per SSE frame: `{type, consultationId, status, processing, processingReason?, closedReason?, encounterSeq, version, at, seq}`
  - `status` is always the seven-value lifecycle vocabulary in this stream
  - Frames carry state only (no content/PHI payloads described)
  - `since` replays buffered frames with `seq > since` (last 50) before live frames; clients pass last seen `seq` on reconnect
  - If consultation silent for 30 days, `seq` may restart at 1 (client should re-read consultation)
  - Auth accepts JWT bearer, service-account token, or single-use `?ticket=` from `POST /auth/stream-ticket` with scope `consultation_lifecycle:<id>`
  - Consumers without persistent connection can observe changes via `ResourceUpdated` webhook (`data.action = "lifecycle"`)
  - 400 for invalid `since`; 404 for not found/cross-tenant (resolved before stream opens)

### Why it matters for Phase A
- After `start`/`pause`/`stop`, clients can observe authoritative lifecycle/processing transitions asynchronously (including transcript finalization/processing changes) without polling every state endpoint.
- This is a key companion to the command endpoints for a responsive “Start consultation” UX.

---

## 6) `consultation.controller.ts`

**Path:** `project-hope/apps/api/src/modules/consultation/consultation.controller.ts`  
**Size/complexity:** Large controller (~2610 lines) with many endpoints and dependencies; this walkthrough focuses on Phase A-relevant structure and behavior.

### 6.1 File role and responsibilities
`ConsultationController` is the main business-plane HTTP controller for consultations. It exposes endpoints for:
- Consultation open/list/get/update and workflow selection/discovery
- Consultation lifecycle commands (`start`, `pause`, `stop`, `approve`, etc.)
- Recording read/legacy recording start-stop aliases
- Context, summaries, timeline, highlights, tags, document sections, live streams/progress/trajectory/loop feeds, and other consultation operations

For Phase A, the most important responsibilities are:
- **Open consultation** with correct clinician attribution and validation rules
- **Start/pause/stop capture** via lifecycle service integration
- **Expose capture state and stop/final-transcript polling contract**
- **Enforce access/auth/preconditions/consent/tenant rules** before lifecycle mutations

### 6.2 Imports and dependencies (what they indicate)
Key imports show this controller orchestrates many application-layer services and cross-cutting concerns:
- **Core Nest/Web:** `Controller`, HTTP decorators, `HttpCode`, `Headers`, `Req`, `Sse`/`MessageEvent`-related types (via RxJS/other endpoints), exceptions, logging
- **Application services/tokens (DI):** `IConsultationService`, `IContextService`, `ISummaryService`, `ITagService`, `IHighlightService`, `IDocumentSectionService`, lifecycle/encounter services (`IConsultationLifecycleServiceToken`, `IConsultationEncounterServiceToken`), `LiveDocumentationService`, harness progress/assurance/live-assist services, `RedisSubscriberService`, `LoopContextSignalService`, `TenantSettingsService`, `IMediaService`, `IBlobStorageService`, job/note generation/timeline/chain services, `PolicyEngine`
- **Request context:** `ClsService<IActiveUserContext>`
- **Decorators/guards metadata helpers:** `Authorize`, `RequiredScopes`, `RequiredSvcScopes`, `RequiresIfMatch`, `ExpectedVersion`, `RequiresConsent`, `TenantOwnedResource`, `StreamScope`, `ApiEndpoint`, `ApiDeprecated`
- **DTOs/types:** lifecycle command/response DTOs from `./dto`, request/auth types, domain/app DTOs and enums

This indicates the controller is a thin-to-moderate orchestration layer at HTTP boundary but delegates domain behavior/state transitions to injected services.

### 6.3 Class-level configuration and cross-cutting behavior
- `@ApiBearerAuth()`, `@ApiTags('consultations')`, `@Controller('consultations')`
- `@Authorize()` at class level (default auth requirement)
- `@RequiredScopes('consultation:session:write')` as a **class-level default** for routes without finer method-level `@RequiredScopes` (method-level overrides take precedence per comment)
- `@UseInterceptors(ConsultationLifecycleVocabularyInterceptor)` to project/handle status vocabulary compatibility for older clients unless lifecycle header/versioning is requested

### 6.4 Constructor and dependency wiring
- Injects a large set of consultation-related services (CRUD/context/summary/timeline/tags/highlights/live doc/harness/streams/jobs/note generation/etc.).
- Lifecycle and encounter services, media/blob services are injected as optional in TypeScript signature but expected by runtime DI in normal app wiring (`wired(...)` helper throws `503` if missing when used).
- Constructor comment notes positional parameter stability for fixtures (important maintenance constraint).

### 6.5 Helper methods (significant for Phase A behavior)

#### `wired<T>(dependency, name)`
- Ensures required runtime dependency is present; throws `503 ServiceUnavailableException` if undefined.
- Used before calling lifecycle/encounter services.

#### Principal/context helpers
- `getDoctorId()` — reads authenticated user ID from CLS; throws `401` if unavailable.
- `getServiceAccountId()` — reads service-account principal ID from CLS service-account key (not `user`).
- `getJobInitiatorId()` — resolves acting principal for job initiation (user first, else service account).
- `callerOf(req)` — derives clinical caller credential class/principal from request (`serviceAccount`, `apiKey`, or `jwt`) with fallback behavior for in-process/fixture paths. Used for attributed lifecycle actions (e.g. approve/close flows) and preserves API-key vs JWT distinction that CLS alone cannot represent.

#### Clinician attribution for open/start-adjacent flows
- `resolveActingClinicianId(request: OpenConsultationRequest)` determines who the consultation belongs to for `open`:
  - **Service account caller:** must name clinician via `clinicianUserId` **or** provide context payload that may identify clinician via schema (service resolves later). If neither, throws `400 CLINICIAN_REQUIRED`.
  - **Human caller:** supplying `clinicianUserId` is rejected with `400 CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER` (prevents impersonation/misleading input).
  - **Human caller (no clinicianUserId):** returns authenticated doctor ID.
- Enforces controller-level refusals that can be answered without schema/repository access; deeper schema/identity resolution occurs in service layer.

#### Authorization/access helpers
- `getUserAbility()` — reads CASL ability from CLS.
- `isSharingEnabled()` — resolves consultation-sharing feature via `TenantSettingsService.resolve` (synchronous cache-backed cascade), fail-closed on resolver errors.
- `verifyConsultationAccess(id)` — **read access** path:
  - Loads consultation; 404 if missing
  - **Machine branch (service account):** allows after tenant-scoped read (tenant boundary enforced by service/Prisma scoping); skips doctor/CASL/shared-patient logic
  - **Human branch:** owner match allowed; else CASL read check; else shared-patient fallback if sharing enabled and relationship exists; otherwise 403
- `verifyConsultationOwnership(id)` — **write/mutate access** path:
  - Loads consultation; 404 if missing
  - **Machine branch (service account):** allowed (tenant/scope-bound; clinician comes from row/request attribution rules elsewhere)
  - **Human branch:** owner or CASL `manage Consultation` allowed; shared-patient doctors never get write access
- `verifyPatientAccess(patientId)` — checks doctor-patient relationship for patient-scoped history/date endpoints.

#### Utility/helpers
- `toLifecycleCaller(...)` maps controller caller shape to lifecycle service caller shape.
- `requireExpectedVersion(...)` enforces presence of `If-Match`/expected version in handler paths where decorator/parameter handling requires it (returns 428 if missing).
- `assertEncounterSeq(...)` validates positive encounter query values.
- `lifecycleStatusOf(...)` prefers real lifecycle status (`consultation.lifecycle?.status`) over possibly projected `status`.
- `recordingManifestOf(...)` extracts/parses AUDIO_RECORDING manifest metadata.
- `RECORDING_URL_TTL_SECONDS`, recording manifest interfaces, and presign helper logic (later in file) support `GET :id/recording`.

### 6.6 Phase A-relevant endpoints and behaviors

#### A. Open consultation and workflow selection/discovery

##### `POST /consultations/open` (`open`)
- **Method/handler:** `async open(@Body() request: OpenConsultationRequest): Promise<ConsultationResponse>`
- **Decorators (key):** `@ApiEndpoint(...)`, `@Authorize(['create', 'Consultation'])`, `@RequiredSvcScopes('svc:consultation:session:write')`
- **Purpose:** Opens/gets-or-creates a consultation context for a clinician/patient/session workflow as defined by application service.
- **Controller behavior:**
  - Computes acting clinician via `resolveActingClinicianId(request)` (handles human vs service-account attribution rules, defers schema-based identity resolution in some machine cases)
  - Delegates to `consultationService.getOrCreate(request, actingClinicianId)`
- **Important documented request/response/error semantics (Swagger):**
  - Accepts `workflowDefinitionSlug` (selection authorized by service predicate)
  - 400 cases include clinician attribution/identity/context schema/department/language-mode validation errors
  - 404 for unknown/unauthorized named clinician in tenant, unknown/ambiguous/unusable identity/department cases as specified
  - 409 for identity ambiguity/seat quota conflicts in provisioning scenarios
  - 503 when context validation or identity resolution unavailable

##### `GET /consultations/workflows` (`listSelectableWorkflows`)
- **Purpose:** Returns workflows the caller may select when opening a consultation (same authorization predicate as `open` selection path, per comments).
- **Placement note:** Declared before `GET /consultations/:id` to avoid `:id` route capture.
- **Auth:** `@Authorize(['create', 'Consultation'])`, `@RequiredScopes('consultation:session:write')`, no `@RequiredSvcScopes` (service accounts denied by default as documented)
- **Behavior:** Delegates to `consultationService.listSelectableWorkflows()` (tenant-scoped via CLS/service logic)

##### `GET /consultations/:id` (`getById`)
- **Purpose:** Read consultation with relations.
- **Access:** `verifyConsultationAccess(id)` then `consultationService.getByIdWithRelations(id)`
- **Scopes:** `consultation:session:read` and `svc:consultation:session:read`

##### `GET /consultations/:id/workflow` (`getGoverningWorkflow`)
- **Purpose:** Discovery of governing engine/workflow selection outcome for a consultation (including fallback-to-default cases).
- **Access:** `verifyConsultationAccess(id)` then service lookup
- **Scopes:** read scopes

#### B. Lifecycle commands (core to “start consultation”)

##### `POST /consultations/:id/start` (`start`)
- **HTTP/contract:** `@HttpCode(200)`, `@Post(':id/start')`, returns `CaptureStateResponse`
- **Body:** `StartConsultationRequest | undefined` (optional `sessionId`)
- **Scopes/consent:** `@RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)`, `@RequiredSvcScopes('svc:consultation:session:write')`
- **Access control path:** Performed via shared helper `beginLiveCapture(...)` (ownership/recordable-state checks and binding/wait logic live there; see method in later part of file) before/around lifecycle transition
- **Service call:** Delegates to `IConsultationLifecycleService.start(id, { sttSessionId: request?.sessionId, supersedeByDurableBinding })` through `wired(...)`
- **Documented behavior:**
  - Transitions `OPEN / PAUSED / STOPPED → RECORDING`
  - From `STOPPED`, current encounter continues (to document a new visit, open again instead)
  - If `sessionId` provided, binds that STT streaming session (one live session per consultation; different session can supersede previous one)
  - Starts live-documentation session
  - Idempotent while `RECORDING`
- **Error semantics (Swagger):**
  - 404 consultation not found/cross-tenant
  - 409 `CONSULTATION_NOT_RECORDABLE` (approved/closed), `STT_SESSION_NOT_ACTIVE` (named session no longer live), or illegal transition

##### `POST /consultations/:id/pause` (`pause`)
- **Returns:** `CaptureStateResponse`
- **Access:** `verifyConsultationOwnership(id)`
- **Service call:** `lifecycleService.pause(id, { reason: 'user' })`
- **Documented behavior:** `RECORDING → PAUSED`; bound STT session flushes last final then drops audio without advancing clock; `start` resumes; idempotent while `PAUSED`
- **Scopes:** `@RequiredSvcScopes('svc:consultation:session:write')`

##### `POST /consultations/:id/stop` (`stop`)
- **Body:** `StopConsultationRequest | undefined` (`waitForFinal` default true; inherits recording-stop fields)
- **Returns:** `StopResultResponse` (capture state + `finalTranscript` status/object)
- **Access:** `verifyConsultationOwnership(id)` to load consultation and enforce ownership
- **Behavior:**
  - Computes `waitForFinal = request?.waitForFinal ?? true`
  - If consultation is already `STOPPED` (real lifecycle status): returns lifecycle service `stop` result immediately as idempotent poll (no drain/signal side effects repeated)
  - Otherwise:
    - `await liveDocumentationService.markHandoffPending(id)` before stop transition
    - Calls `lifecycleService.stop(id, { waitForFinal })`
    - On stop error: calls `finishRecordingStop(id, request ?? {}, { signalEnding: false })` then rethrows
    - On success: calls `finishRecordingStop(id, request ?? {}, { signalEnding: true })` and returns result
- **Documented behavior:**
  - `RECORDING / PAUSED → STOPPED` (`processing FINALIZING_TRANSCRIPT`)
  - Finalizes every live STT session bound to consultation
  - With `waitForFinal` (default true), waits up to tenant final-transcript timeout
  - Re-POSTing stop on already STOPPED consultation is an idempotent poll for final transcript state
  - Live note drains and consultation loop notified that recording ended after response (via async post-response completion helper)

##### `POST /consultations/:id/approve` (`approve`) *(post-start lifecycle, relevant for full state machine)*
- **Preconditions:** `@RequiresIfMatch()` + `@ExpectedVersion()` and `requireExpectedVersion(...)`
- **Access:** `verifyConsultationOwnership(id)`
- **Service call:** `lifecycleService.approve(...)` with clinician attribution/caller mapping and guardrail/safety options
- **Importance to Phase A:** Shows versioned/OCC and attribution patterns used in later lifecycle transitions; start flow must surface/store consultation `version` for future commands.

##### `GET /consultations/:id/encounters` (`listEncounters`)
- **Purpose:** Lists encounters/visits for consultation (current encounter tracked by `currentEncounterSeq` in lifecycle state)
- **Access:** read access check, then encounter service
- **Relevance:** Start response includes `encounterSeq`; this endpoint helps clients inspect encounter progression.

#### C. Recording read endpoint and legacy recording aliases (important for start/recording sequencing)

##### `GET /consultations/:id/recording` (`getRecording`)
- **Purpose:** Returns consultation recording as parts on a consultation-wide timeline (one recording assembled from appended parts)
- **Access:** `verifyConsultationAccess(id)`
- **Behavior:**
  - Reads `AUDIO_RECORDING` context items via `contextService.getContextItems(...)`
  - Selects newest item with parseable recording manifest metadata
  - 404 `RECORDING_NOT_READY` if none found
  - Presigns each part’s stored object URL via media/blob storage services (best-effort per part; null URL/expiry on presign failure)
  - Returns `ConsultationRecordingResponse`

##### Deprecated aliases: `POST /consultations/:id/recording/start` and `.../recording/stop`
- Marked as one-release deprecated aliases of lifecycle `:id/start|:id/stop` (see `LIFECYCLE_ALIAS_DEPRECATION`)
- Share underlying helper logic with lifecycle commands (`beginLiveCapture`, `finishRecordingStop`)
- Important for compatibility tracing: older clients/SDK paths may still use recording-style endpoints while newer flow uses lifecycle commands and/or `ConsultationHandle` orchestration.

#### D. Streams and live-update endpoints (adjacent to start, often subscribed after start)
Controller includes multiple SSE endpoints (e.g. live summary, live assist, harness progress/assurance, trajectory, loop streams). These are typically:
- Protected by tenant ownership checks before stream open (`@TenantOwnedResource`)
- Ticket-scoped via `@StreamScope` for browser/stream-ticket use cases
- Backed by Redis pub/sub relays and/or service observables

For Phase A, the key takeaway is that **starting a consultation can trigger side effects whose outputs are observed on separate SSE channels**, and clients may need to subscribe around/after start depending on UX.

#### E. Other endpoint groups (context for sequencing, not primary Phase A targets)
The same controller also contains endpoints for:
- List/get-by-patient/history/chain
- Update consultation metadata (including language mode; OCC/If-Match enforced)
- Context item CRUD/versioning, highlights, tags
- Summaries, jobs, timeline, document sections, close/reopen/approve-related flows, and more

These matter when mapping the full consultation workflow after start (e.g. context ingestion, note generation, approval/close), but Phase A should focus first on open/start/capture/events contract.

### 6.7 Start-flow sequencing implications from controller code
- **Client identity and attribution matter at open/start boundaries**, especially for machine credentials (service accounts/API keys) vs human users.
- **`start` is not just a status flip:** it can bind an STT session and initiates live-documentation/session-side effects via lifecycle/service orchestration.
- **`stop` has async follow-up work** (live note drain, loop-ending signal) and supports polling for final transcript completion (`waitForFinal`, `finalTranscript.state`).
- **Real-time observation is split across endpoints:** lifecycle events controller (`/events`) plus additional consultation SSE feeds (live summary/progress/trajectory/loop/assist) depending on features enabled.
- **Compatibility layers exist:** lifecycle vocabulary projection/interceptor and deprecated recording start/stop aliases; clients/SDKs may use newer lifecycle methods or legacy-compatible paths.

---

## 7) Phase A file-by-file summary (quick reference)

| File | Primary responsibility | Key Phase A takeaways |
|---|---|---|
| `consultation.controller.ts` | Main consultation HTTP API orchestration and endpoint definitions | Defines `open`, workflow discovery, lifecycle `start/pause/stop`, recording aliases, access/attribution helpers, and hooks into lifecycle/live-doc/streaming side effects |
| `consultation-lifecycle-events.controller.ts` | SSE stream of consultation lifecycle events | Provides replayable (`since`) lifecycle/status/processing event feed used to observe start/pause/stop/finalization transitions |
| `dto/lifecycle-command.request.ts` | Request DTOs for lifecycle commands | `start` takes optional `sessionId` (STT binding); `stop` controls final transcript wait/poll behavior |
| `dto/lifecycle.response.ts` | Response DTOs for lifecycle/recording reads | Defines capture state, lifecycle/status-processing vocabulary, stop result/final transcript polling contract, recording manifest response |
| `dto/close-consultation.request.ts` | Close command request DTO | Documents clinician attribution/body-validation constraints for machine vs human callers (adjacent lifecycle contract) |
| `dto/index.ts` | DTO exports barrel | Aggregates local consultation DTOs for controller/module imports |

---

## 8) Suggested next inspection targets (to deepen Phase A into actual call sequence)

1. **`consultation.controller.ts` helper implementations not fully expanded above**
   - `beginLiveCapture(...)`
   - `finishRecordingStop(...)`
   - Any method-level handling around recording/session binding and live summary/progress stream subscriptions
2. **Application-layer lifecycle service implementation** behind `IConsultationLifecycleService.start/pause/stop`
   - State machine rules, idempotency, STT session validation/binding, event emission
3. **`ConsultationLifecycleEventPublisher` and event payload schema**
   - Event types, `seq` semantics, buffering/replay behavior
4. **`vox-node` counterparts** (Phase D prep)
   - `packages/vox-node/src/resources/consultations.ts`
   - `packages/vox-node/src/resources/consultation-handle.ts`
   - `packages/vox-node/src/resources/consultation-recording.ts`
   - `packages/vox-node/src/resources/consultation-streams.ts`
   - `packages/vox-node/src/core/realtime-stt-socket.ts`

These will convert the Phase A contract understanding into an exact “Start consultation” runtime sequence (API + SDK + events).
