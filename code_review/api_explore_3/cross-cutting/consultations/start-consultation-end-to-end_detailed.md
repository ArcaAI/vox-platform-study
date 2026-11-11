# Start Consultation Flow — Detailed End-to-End Trace

**Purpose:** Explain what happens when a **doctor clicks “Start consultation”**, from client intent to `vox-node` call(s), gateway API/controller handling, DTOs, state/side effects, and live event/stream observation.

**Scope (this document):** consultation **open/attach** prerequisites, **lifecycle start/capture start**, **STT session creation/binding**, **socket/event subscription behavior**, and immediately related gateway behavior. Stop/finalize/summary/approval/close are included only where needed to explain start outcomes and state machine boundaries.

**GitHub base (apps/api):** `https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/`  
**GitHub base (vox-node):** `https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/`

**Primary evidence (code):**
- API: [`src/modules/consultation/consultation.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts), [`src/modules/consultation/consultation-lifecycle-events.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts), [`src/modules/consultation/dto/lifecycle-command.request.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts), [`src/modules/consultation/dto/lifecycle.response.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle.response.ts), [`src/modules/consultation/dto/close-consultation.request.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/close-consultation.request.ts)
- SDK: [`src/resources/consultations.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultations.ts), [`src/resources/consultation-handle.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-handle.ts), [`src/resources/consultation-recording.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-recording.ts), [`src/resources/stt.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/stt.ts), [`src/resources/consultation-streams.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-streams.ts), [`README.md`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/README.md)

> **Legend:** `Confirmed` = directly supported by inspected code. `Inferred` = likely from inspected code/docs but depends on implementation details not fully traced here (e.g. lifecycle service internals, event publisher payload internals). `Needs verification` = product/UI-specific or not confirmed in this trace.

---

## 1) Executive summary

### 1.1 What “Start consultation” means (functional decomposition)
A single UI action (“doctor clicks Start consultation”) typically maps to **multiple steps**:

1. **Ensure consultation is open/attached** (client already has consultation context, or opens/attaches it)
2. **Start capture on that consultation** (`vox-node` `ConsultationHandle.start(...)` or lower-level recording/lifecycle calls)
3. **Create/bind an STT streaming session** (if not already provided/active)
4. **Connect realtime transport for transcripts/audio** (WebSocket via `RealtimeSttSocket`) and/or subscribe to SSE event streams
5. **Observe lifecycle/processing/transcript events** to update UI state

### 1.2 Canonical `vox-node` path for a doctor/client app (recommended abstraction)
- **Open:** `hope.consultations.open(request)` → returns `ConsultationHandle`
- **Start capture:** `handle.start(options?)` → composes STT session creation + lifecycle start + socket connect, returns `CaptureHandle { sessionId, socket, state, resumed }`
- **Stream audio:** send PCM frames via `capture.socket` (SDK socket API)
- **Observe:** `handle.on('status' | 'transcript' | 'capture-state' | 'guardrail-notice' | 'error', ...)` and/or explicit stream subscriptions

`Confirmed` (SDK handle/controller contracts).

### 1.3 Happy-path sequence (high level)
1. UI click “Start consultation” with consultation inputs ready (or consultation already opened).
2. `vox-node`: `consultations.open(...)` → `POST /api/v1/consultations/open`.
3. Gateway: `ConsultationController.open(...)` resolves acting clinician, calls consultation service `getOrCreate(...)`, returns consultation/open response (used to build `ConsultationHandle`).
4. `vox-node`: `handle.start(...)`.
5. If not already recording with live socket and not a resumable paused socket path: `stt.createStreamSession({ consultationId, ... })` → `POST /api/v1/audio/transcription-jobs/stream/session`.
6. `vox-node`: lifecycle start command → `POST /api/v1/consultations/:id/start` with body `{ sessionId? }`.
7. Gateway: `ConsultationController.start(...)` → `beginLiveCapture(...)` → ownership check, wait for live-doc drain if needed, `IConsultationLifecycleService.start(...)`, then `LiveDocumentationService.start(...)`; returns `CaptureStateResponse`.
8. `vox-node`: creates `RealtimeSttSocket` for session, attaches listeners, `socket.connect()`; handle emits capture-state/transcript/status events as streams arrive.
9. UI shows recording/capturing state and begins streaming microphone audio / rendering live updates.

### 1.4 Key prerequisites and outcomes
- **Prereqs:** authenticated caller with required scopes/abilities, consultation is recordable, consent/policy checks pass (e.g. AI documentation consent on start), tenant not blocked by lock/policy as applicable.
- **Important request data:** `consultationId`, optional STT `sessionId` (for bind/start-capture flows), clinician attribution rules for machine callers on open (and on some lifecycle actions later).
- **Immediate outcomes after start:** lifecycle/capture state (`status`, `processing`, `recording`, `paused`, `encounterSeq`, `sessionId`, `version`, `updatedAt`, optional `lifecycle` pair), bound STT session/live socket, live-documentation side effects, and subsequent lifecycle/stream events.

---

## 2) Entry points, assumptions, and variants

### 2.1 UI/client entry point (assumed)
- **Trigger:** Doctor clicks “Start consultation” in a client UI.
- **Needs verification (UI-specific):** whether the click performs `open` + `start` in one flow, or only `start` on an already-open consultation.
- **This document assumes (canonical trace):** client uses `@arcaai/vox-node` and either has a consultation ID to `attach(...)` or opens a consultation first, then calls `ConsultationHandle.start()`.

### 2.2 Integration modes
- **Primary (documented):** `vox-node` `ConsultationHandle` orchestration
- **Lower-level SDK paths:** `consultations.recording.start/stop` (deprecated), manual `stt.createStreamSession` + `POST consultations/:id/start` + manual socket wiring
- **Raw API mapping:** included per step for traceability

### 2.3 Credential/auth modes (affect behavior)
- **Human JWT:** clinician identity usually derived from authenticated user; some fields (e.g. `clinicianUserId` on open by human caller) are rejected by controller rules.
- **Service account / API key (machine callers):** can be allowed on consultation/session routes with proper scopes; machine callers must follow clinician attribution rules (especially on `open` and later attributed actions like approve/close/reopen). `ConsultationController.resolveActingClinicianId(...)` and `callerOf(...)` encode important differences.
- **Scopes (examples, from controller/README):** consultation session read/write and STT transcription scopes; exact scope checks depend on endpoint/decorator/global guard behavior.

### 2.4 Definitions (must not be conflated)
- **Open consultation:** `POST /consultations/open` (get-or-create/select/open context for visit/encounter)
- **Lifecycle start:** `POST /consultations/:id/start` (capture command; can bind `sessionId`)
- **Recording start (deprecated alias):** `POST /consultations/:id/recording/start`
- **STT stream session creation:** `POST /audio/transcription-jobs/stream/session` (returns session/ticket/ws coordinates)
- **Realtime audio/transcript transport:** WebSocket via `RealtimeSttSocket` (created/wired by `stt.socket(session)`)
- **Lifecycle observation:** `GET /consultations/:id/events` (SSE) and other consultation/live streams

### 2.5 Start-flow variants to trace
1. **Happy path (fresh start):** consultation is `OPEN` (or `STOPPED`), no active socket in handle → create STT session, call lifecycle start, connect socket
2. **Resume from paused with live socket:** handle has connected socket and consultation is `PAUSED` → send resume-capture control frame (if socket stayed connected), call lifecycle start with existing session
3. **Reconnect/resume from paused after socket drop:** handle has socket but disconnected → reconnect socket, call lifecycle start
4. **Pause expired / no resumable socket:** fall back to fresh STT session + lifecycle start + connect
5. **Bind external STT session:** `handle.startCapture(sttSessionId)` or raw lifecycle start with `sessionId` (no SDK-managed socket/session creation)

---

## 3) Master timeline — canonical end-to-end sequence (happy path)

| Step | Actor | Trigger/condition | `vox-node` function/method | Transport call | Gateway controller/handler | Request DTO/body/headers | Response DTO/body/status | State change / side effect | Client-observable outcome | Status |
|---:|---|---|---|---|---|---|---|---|---|---|
| 0 | UI / Client app | Doctor clicks Start; consultation context known or must be created | App logic (outside SDK UI) | — | — | — | — | — | Decide `open(...)` vs `attach(...)` + `start(...)` | `Needs verification` (UI-specific) |
| 1 | `vox-node` | Need consultation handle for visit | `hope.consultations.open(request)` | `POST /api/v1/consultations/open` | `ConsultationController.open()` | `OpenConsultationRequest` (apps DTO), JSON body | `ConsultationResponse` / open result (includes lifecycle fields/version context) | Get-or-create/open consultation; clinician/workflow/language/context validation and attribution in service layer | `ConsultationHandle` with tracked `status/processing/version` and open-time fields | `Confirmed` (SDK/controller entrypoints) |
| 2 | `vox-node` | User starts capture | `handle.start(options?)` | Internal orchestration (may call steps 3–5) | — | — | `Promise<CaptureHandle>` | Reads handle state, may reuse/reconnect socket or create new session | Capture handle for audio streaming | `Confirmed` |
| 3 | `vox-node` STT resource | Fresh start/resume fallback path | `stt.createStreamSession({ consultationId, agentSlug?, language? })` | `POST /api/v1/audio/transcription-jobs/stream/session` | Streaming transcription/session controller (outside consultation controller; not fully traced here) | `CreateStreamSessionRequest` | `StreamSessionResponse` (`sessionId`, ticket, ws coords/expiry, agent/context metadata) | Creates live STT session (not retried; ownership/principal-bound) | SDK obtains session to bind and socket to connect | `Confirmed` (SDK/resource); handler `Needs verification` in this doc |
| 4 | `vox-node` handle | Bind/start lifecycle capture | internal `#startCommand(sessionId, signal)` | `POST /api/v1/consultations/:id/start` | `ConsultationController.start()` | `StartConsultationRequest { sessionId? }` (or empty/undefined), `X-Hope-Lifecycle: 2` added by handle transport wrapper | `CaptureStateResponse` (200) | Ownership/consent checks, live-doc drain wait, lifecycle transition/binding, live-doc start, session supersession logic | Handle state updated (`status/processing/version/...`), returns capture state | `Confirmed` |
| 5 | `vox-node` core | Realtime transport setup | `stt.socket(session)` + `socket.connect()` | WebSocket connect/handshake to session WS URL (ticketed) | Streaming/STT WS gateway (outside this consultation controller trace) | WS handshake + protocol frames (PCM/control) | Socket events (`transcript`, `status`, etc.) | Realtime transcript/audio channel established | UI can stream PCM and receive transcript/status callbacks | `Confirmed` (SDK composition); server WS internals `Needs verification` |
| 6 | `vox-node` handle | Live lifecycle observation (if listeners added) | `handle.on('status', ...)` / `on('guardrail-notice', ...)` | `GET /api/v1/consultations/:id/events?since=<seq>` (SSE) | `ConsultationLifecycleEventsController.streamEvents()` | Query `since` optional non-negative int; auth/ticket/tenant/stream-scope checks | SSE `MessageEvent`s carrying lifecycle JSON frames (and heartbeat handling client-side) | Subscribes to lifecycle event publisher; replay + live stream | Handle tracks latest lifecycle/processing/version and emits events to UI | `Confirmed` |
| 7 | UI | After start returns/socket connected | App logic | — / ongoing WS & SSE | — | — | — | Audio streaming and live UI updates begin | Doctor sees “recording/capturing/live” state and transcripts/events | `Needs verification` (UI-specific) |

---

## 4) Detailed step-by-step trace

### Step 1 — Open (or attach) consultation and obtain `ConsultationHandle`

#### 4.1.1 Purpose
Create or retrieve the consultation episode/encounter context the doctor will start, and obtain a handle that tracks lifecycle state and provides start/stream/stop verbs.

#### 4.1.2 `vox-node` call (`Confirmed`)
- **Method:** `ConsultationsResource.open<TContext>(request, options?)`
- **Source:** [`packages/vox-node/src/resources/consultations.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultations.ts)
- **Local validation:** throws `TypeError` if `request.patientId` is missing/empty (before request)
- **Wire request:** `POST consultations/open` with JSON body `request`
- **Result:** wraps response in `new ConsultationHandle(...)` via `handleFor(...)`
- **Alternative:** `ConsultationsResource.attach(id)` → `GET consultations/:id` then builds handle (read-based attach; open-time fields like `recordable`/`encounterAppended` semantics differ per docs)

#### 4.1.3 Request/response (API contract, `Confirmed` at controller boundary)
- **Endpoint:** `POST /api/v1/consultations/open`
- **Controller:** [`ConsultationController.open()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts)
- **Decorators/guards/policy signals:** `@ApiEndpoint`, `@Authorize(['create', 'Consultation'])`, `@RequiredSvcScopes('svc:consultation:session:write')`, plus class-level auth/scope/interceptor behavior
- **Body DTO/type:** `OpenConsultationRequest` (from `@arcaai/applications`)
- **Key request semantics (controller/docs):**
  - May include `workflowDefinitionSlug`, `language`, `departmentId`, `parentConsultationId`, `externalRef`, `context`, `clinicianUserId` (machine-caller attribution path) etc.
  - Human caller cannot supply `clinicianUserId` (`CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`)
  - Service account must identify clinician via `clinicianUserId` or schema-resolvable context identity in some cases (`CLINICIAN_REQUIRED` if neither route possible)
- **Handler behavior:** `resolveActingClinicianId(request)` then `consultationService.getOrCreate(request, actingClinicianId)`
- **Response:** `ConsultationResponse` / open result (SDK treats as `ConsultationOpenResult`; handle copies fields and tracks lifecycle/version)

#### 4.1.4 Backend effects (`Partially inferred`)
- Get-or-create consultation episode/encounter selection, validation (context schema, department, language mode, identity resolution), authorization checks, persistence, and response shaping occur in application/domain services (`IConsultationService.getOrCreate` and dependencies). Not fully traced in this doc.

#### 4.1.5 Client-observable outcome
- `ConsultationHandle` instance with consultation fields, `status`, `processing`, `version`, etc.
- Client should inspect recordability/state before starting capture (per SDK docs on open/attach behavior; exact fields depend on response type).

#### 4.1.6 Common failures/branches
- `400` validation/attribution/context/language/department errors (controller Swagger lists many codes/messages)
- `404` clinician/department/identity not found or not usable cases (as documented)
- `409` identity ambiguity/seat quota/external ref/parent mismatch cases (per SDK/controller docs)
- `503` schema/identity resolution unavailable

---

### Step 2 — Client invokes `handle.start(...)` (SDK orchestration)

#### 4.2.1 Purpose
Begin or resume audio capture for the consultation, ensuring STT session binding and realtime socket readiness.

#### 4.2.2 `vox-node` method (`Confirmed`)
- **Method:** `ConsultationHandle.start(options: StartCaptureOptions = {})`
- **Source:** [`packages/vox-node/src/resources/consultation-handle.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-handle.ts)
- **Inputs (options):** may include `agentSlug`, `language`, `signal` (per implementation usage)

#### 4.2.3 Internal decision logic (order matters)
1. **Already recording with connected socket:** if `existing socket` and `status === 'RECORDING'` and `socket.connected` → return existing capture handle (no new command/session creation)
2. **Paused with non-expired pause:**
   - If socket disconnected, attempt reconnect
   - If connected (or reconnected): send resume control frame only when socket had stayed connected (`resume-capture`), then call lifecycle start command with existing `sessionId`
   - Return capture handle marked resumed
3. **Fresh start / fallback:**
   - Build STT session request `{ consultationId: this.id, agentSlug?, language? }`
   - Create STT session
   - Call lifecycle start command with created `sessionId`
   - On start-command failure: best-effort close created STT session (if supported) and rethrow
   - Create socket via `stt.socket(session)`, attach listeners, connect socket
   - Return capture handle

#### 4.2.4 Client-observable outcome
- `CaptureHandle { sessionId, socket, state, resumed }`
- Handle internal state updated from lifecycle start response (`#apply(...)`), socket listeners emit `transcript`, `capture-state`, `error`
- UI can start sending PCM16 audio to `capture.socket`

#### 4.2.5 Important behaviors/notes
- **Composition:** one `start()` call may trigger STT session HTTP call + consultation lifecycle start HTTP call + WS connect.
- **Idempotency/resume semantics:** optimized for current handle/socket state and consultation status; server-side idempotency/transition rules still apply.
- **Consent failures:** consent for AI documentation is checked by gateway (409 path surfaced to client), per handle docs.

---

### Step 3 — Create STT streaming session (`vox-node` → STT session API)

#### 4.3.1 Purpose
Provision a live STT session (and first ticket/ws coordinates) to bind to the consultation and stream audio.

#### 4.3.2 `vox-node` method (`Confirmed`)
- **Method:** `SttResource.createStreamSession(request = {}, options?)`
- **Source:** [`packages/vox-node/src/resources/stt.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/stt.ts)
- **Typical request from handle start:** `{ consultationId, agentSlug?, language? }`
- **Wire call:** `POST /api/v1/audio/transcription-jobs/stream/session`
- **Response:** `StreamSessionResponse` (includes `sessionId`, `ticket`, `ticketExpiresAt`, `wsUrl`, and session metadata/context/agent info as defined by type)

#### 4.3.3 Gateway/controller (not fully traced in this doc)
- **Handler location (by SDK/docs reference):** `apps/api/src/modules/streaming/transcription-job.controller.ts` (stream session endpoints)
- **Behavior highlights from SDK docs:** agent resolution (consultation governing workflow / workflow slug / tenant assignment), no idempotency key (non-retried POST), session ownership/principal binding, possible 409 for unusable workflow ASR agent resolution

#### 4.3.4 Client-observable outcome
- SDK has session credentials/coordinates needed for lifecycle binding and socket connection.
- `sessionId` is passed to consultation start command in canonical handle flow.

#### 4.3.5 Failure/edge cases
- 409 agent/workflow resolution or policy conflicts (per SDK README/resource docs)
- Tenant concurrency/limits (inferred; server-side)
- Non-retriable POST semantics (duplicate-session risk if caller retries manually outside SDK guarantees)

---

### Step 4 — Lifecycle start command (`vox-node` / raw client → consultation API)

#### 4.4.1 Purpose
Transition the consultation into capturing/recording state (or idempotently confirm it), bind STT session (if provided), and trigger live documentation/session-side effects.

#### 4.4.2 `vox-node` call paths (`Confirmed`)
- **Preferred:** `ConsultationHandle.start(...)` internally issues lifecycle start command after session setup/resume decision
- **External-session bind variant:** `ConsultationHandle.startCapture(sttSessionId, options?)` → sends lifecycle start with provided session ID only (no SDK STT session creation, no socket open)
- **Deprecated lower-level alias:** `ConsultationsResource.recording.start(...)` → `POST /api/v1/consultations/:id/recording/start`

#### 4.4.3 Wire/API contract (`Confirmed`)
- **Endpoint:** `POST /api/v1/consultations/:id/start`
- **Controller:** [`ConsultationController.start()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts)
- **Request DTO:** [`StartConsultationRequest`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts)
  - `sessionId?: string` (optional STT streaming session to bind)
- **Response DTO:** [`CaptureStateResponse`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle.response.ts)
  - `consultationId`, `status`, `processing`, `encounterSeq`, `sessionId?`, `recording`, `paused`, `version`, `updatedAt`, `lifecycle?`
- **HTTP status:** `200 OK` (`@HttpCode(HttpStatus.OK)`)
- **Key decorators/controls:** `@RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)`, `@RequiredSvcScopes('svc:consultation:session:write')`, class-level auth/scope/interceptor behavior (including lifecycle vocabulary interceptor)

#### 4.4.4 Controller behavior and side effects (`Confirmed` from controller; service internals `Partially inferred`)
`ConsultationController.start()` delegates to `beginLiveCapture(id, request?.sessionId, captureFn)` which:
1. **Verifies consultation ownership/write access** (`verifyConsultationOwnership`)
2. **Waits for live documentation stop/drain completion if needed** (`liveDocumentationService.whenStopped(id)`)
3. **Executes capture command** via lifecycle service: `IConsultationLifecycleService.start(id, { sttSessionId: request?.sessionId, supersedeByDurableBinding })`
   - `supersedeByDurableBinding` is derived from whether live documentation is active in-process (`!liveDocumentationService.isActive(id)`), avoiding duplicate supersession signaling paths
4. **Starts live documentation session** (`liveDocumentationService.start({ consultationId, tenantId, userId: owned.doctorId, sessionId })`)

**Documented behavior (controller/DTO comments):**
- Transitions `OPEN / PAUSED / STOPPED → RECORDING`
- From `STOPPED`, current encounter continues (open again for a new visit)
- Binding `sessionId` associates STT streaming session; stale/non-live session rejected (`409 STT_SESSION_NOT_ACTIVE`)
- One live session per consultation; new session can supersede previous one
- Starts live-documentation session
- Idempotent while `RECORDING`

#### 4.4.5 Error cases (important for start UX)
- `404` consultation not found / cross-tenant masked as not found (per tenancy/access patterns)
- `409 CONSULTATION_NOT_RECORDABLE` (e.g. approved/closed)
- `409 STT_SESSION_NOT_ACTIVE`
- `409 CONSULTATION_TRANSITION_ILLEGAL`
- Consent/auth/scope failures (via guards/decorators/global pipeline)

#### 4.4.6 Client-observable outcome
- `CaptureStateResponse` returned to caller/SDK
- `ConsultationHandle` folds response into tracked state (`status`, `processing`, `processingReason?`, `version`, lifecycle pair fields as provided)
- `version` becomes available for later OCC-guarded operations

---

### Step 5 — Realtime socket setup and audio/transcript streaming (`vox-node`)

#### 4.5.1 Purpose
Establish the live audio upload + transcript/status receive channel for the bound STT session.

#### 4.5.2 `vox-node` behavior (`Confirmed`)
- **Socket creation:** `stt.socket(session)` wires `RealtimeSttSocket` with transport base URL and ticket refresh callback (`stt.refreshTicket`)
- **Attach listeners:** handle subscribes to socket `transcript`, `status`, `error` and re-emits via handle events (`transcript`, `capture-state`, `error`)
- **Connect:** `await socket.connect()` after lifecycle start succeeds (fresh start path)
- **Audio send:** caller streams PCM16 frames via socket API (e.g. `sendPcm16(...)`, per README/examples; exact method names depend on socket implementation)

#### 4.5.3 Transport/protocol notes
- Ticketed WS handshake; session ticket is consumed/refreshed as needed (refresh endpoint available in `stt` resource).
- Socket/session ownership is principal-bound (SDK README notes 404-over-403 posture on foreign session access).
- `closeStreamSession(...)` (HTTP DELETE) is separate from socket close; handle/start flow may best-effort close created session on lifecycle-start failure.

#### 4.5.4 Client-observable outcome
- Live transcript events and capture-status updates flow into the handle/UI.
- UI can render “listening/recording” state and live transcription.

---

### Step 6 — Lifecycle/event observation (SSE) around start

#### 4.6.1 Purpose
Observe authoritative consultation lifecycle/processing transitions (and reconnect/replay) while capture runs.

#### 4.6.2 `vox-node` handle behavior (`Confirmed`)
- `handle.on('status', listener)` or `handle.on('guardrail-notice', listener)` opens lifecycle event subscription lazily
- Subscription path: `GET consultations/:id/events` with `since=<lastSeq>` on reconnect/reopen paths
- Dispatch handling:
  - Ignores heartbeat/no-seq frames for status progression
  - Deduplicates/ignores frames with `seq <= last seen`
  - Applies status/processing/processingReason/version to handle state
  - Emits `status` event to listeners
  - On guardrail hold reason, triggers async guardrail notice fetch/delivery logic

#### 4.6.3 Gateway lifecycle events API (`Confirmed`)
- **Endpoint:** `GET /api/v1/consultations/:id/events` (`@Sse`)
- **Controller:** [`ConsultationLifecycleEventsController.streamEvents()`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts)
- **Access controls:** `@Authorize`, `@RequiredScopes('consultation:session:write')`, `@TenantOwnedResource`, `@StreamScope('consultation_lifecycle', 'id')`, `@RequiredSvcScopes('svc:consultation:session:write')`
- **Query:** `since` (optional, non-negative integer replay cursor)
- **Behavior:** parses `since` and returns `events.subscribe(id, parseSince(since))`
- **Contract notes:** lifecycle event JSON frames with `type`, `consultationId`, `status`, `processing`, `processingReason?`, `closedReason?`, `encounterSeq`, `version`, `at`, `seq`; replay buffer semantics; auth via JWT/service token or stream ticket

#### 4.6.4 Client-observable outcome
- UI can reflect async state changes (started/paused/stopped/transcript finalization/processing changes/holds) without polling every endpoint.

---

### Step 7 — Related but distinct start-adjacent paths (important to document)

#### 4.7.1 `ConsultationHandle.startCapture(sttSessionId)` (external STT/session owner)
- **SDK behavior:** validates session ID, sends lifecycle start command with that `sessionId`, detaches SDK-owned socket if it belongs to a different session; does **not** create STT session and does **not** open socket.
- **Use case:** caller manages STT/socket externally but wants consultation lifecycle binding/state update via handle.

#### 4.7.2 Deprecated `consultations.recording.start(...)` / `recording.stop(...)`
- **SDK:** `ConsultationRecordingResource.start/stop` call legacy recording endpoints.
- **API:** `POST /consultations/:id/recording/start|stop` map to shared controller helpers (`beginLiveCapture`, `finishRecordingStop`) and are marked deprecated in favor of lifecycle `:id/start|:id/stop` (or handle methods).
- **Difference:** legacy start response shape is `RecordingStateResponse` (simpler, includes `sseUrl` to live-summary stream), while lifecycle `start` returns `CaptureStateResponse`.

#### 4.7.3 `handle.on(...)` and other live streams
- `consultation-streams` resource and controller stream endpoints (live summary, progress, trajectory, loop, assist, etc.) may be relevant depending on UX; these are separate subscriptions/endpoints from lifecycle events.

---

## 5) API and DTO reference (start-flow focused)

### 5.1 Endpoint catalog (start/open/observe)

| Concern | Method | Path | `vox-node` mapping | Controller / owner | Key request DTO/body | Key response DTO/body | Notes |
|---|---|---|---|---|---|---|---|
| Open consultation | POST | `/api/v1/consultations/open` | `consultations.open(request)` | `ConsultationController.open()` | `OpenConsultationRequest` (`@arcaai/applications`) | `ConsultationResponse` / open result | Get-or-create/open episode; clinician attribution rules differ by credential type |
| Attach consultation | GET | `/api/v1/consultations/:id` | `consultations.attach(id)` / `consultations.get(id)` | `ConsultationController.getById()` | — | `ConsultationResponse` / get response | Attach reads current consultation; no open-time flags like `encounterAppended` in same way |
| Start lifecycle capture | POST | `/api/v1/consultations/:id/start` | `handle.start(...)` (composed), `handle.startCapture(...)` (bind only) | `ConsultationController.start()` | `StartConsultationRequest { sessionId? }` | `CaptureStateResponse` (200) | Consent-gated; binds STT session; starts live doc |
| Pause lifecycle capture | POST | `/api/v1/consultations/:id/pause` | `handle.pause()` (and related paths) | `ConsultationController.pause()` | none | `CaptureStateResponse` (200) | `RECORDING -> PAUSED`, idempotent while paused |
| Stop lifecycle capture | POST | `/api/v1/consultations/:id/stop` | `handle.stop(...)` (higher-level), direct transport possible | `ConsultationController.stop()` | `StopConsultationRequest { waitForFinal?, ...inherited }` | `StopResultResponse` (200) | Finalizes transcript/session, supports polling/wait for final transcript |
| Start recording (deprecated alias) | POST | `/api/v1/consultations/:id/recording/start` | `consultations.recording.start(...)` | `ConsultationController.startRecording()` | `StartRecordingRequest` (`@arcaai/applications`) | `RecordingStateResponse` (200) | Alias to shared begin-live-capture flow; deprecated |
| Lifecycle events (SSE) | GET | `/api/v1/consultations/:id/events` | `handle.on('status'/'guardrail-notice')` opens subscription internally | `ConsultationLifecycleEventsController.streamEvents()` | query `since?` | SSE `MessageEvent` stream | Replayable lifecycle/status/processing events |
| Create STT session | POST | `/api/v1/audio/transcription-jobs/stream/session` | `stt.createStreamSession(...)` / `handle.start(...)` internal | Streaming module controller (not fully traced here) | `CreateStreamSessionRequest` | `StreamSessionResponse` | Needed before canonical fresh start with SDK-managed socket |
| Refresh STT ticket | POST | `/api/v1/audio/transcription-jobs/stream/session/:sessionId/refresh-ticket` | `stt.refreshTicket(...)`, socket refresher wiring | Streaming module controller | — | `StreamTicketRefreshResponse` | Reconnect/re-handshake support |
| Close STT session (HTTP) | DELETE | `/api/v1/audio/transcription-jobs/stream/session/:sessionId` | `stt.closeStreamSession(...)` (best-effort in some flows) | Streaming module controller | — | 204 / 404 treated as already closed in SDK | Separate from WS socket close |

### 5.2 Request DTOs (consultation module, Phase A relevant)

| DTO | File | Used by | Fields | Validation / semantics |
|---|---|---|---|---|
| `StartConsultationRequest` | `src/modules/consultation/dto/lifecycle-command.request.ts` | `POST /consultations/:id/start` | `sessionId?: string` | Optional; binds STT stream session; stale/non-live session -> `409 STT_SESSION_NOT_ACTIVE` |
| `StopConsultationRequest` | same | `POST /consultations/:id/stop` | inherits `StopRecordingRequest` + `waitForFinal?: boolean` | `waitForFinal` defaults conceptually to `true`; controls wait/poll for final transcript |
| `ApproveConsultationRequest` | same | `POST /consultations/:id/approve` | `clinicianUserId?`, `overrideSafetyFlag?`, `acknowledgeGuardrailNotices?`, `resolveHold?` | Attribution/guardrail/safety options; relevant to later lifecycle |
| `ReopenConsultationRequest` | same | `POST /consultations/:id/reopen` | `clinicianUserId?`, `reason?` | Optional attribution/reason; reason max 256 |
| `CloseConsultationRequest` | `src/modules/consultation/dto/close-consultation.request.ts` | `POST /consultations/:id/close` | `clinicianUserId?` | Gateway-local DTO for whitelist/validation compatibility and clinician attribution |

### 5.3 Response DTOs (consultation module, Phase A relevant)

| DTO | File | Used by | Key fields | Semantics |
|---|---|---|---|---|
| `LifecyclePairResponse` | `src/modules/consultation/dto/lifecycle.response.ts` | embedded in capture responses | `status`, `processing` | Real lifecycle pair |
| `CaptureStateResponse` | same | `start`, `pause` | `consultationId`, `status`, `processing`, `encounterSeq`, `sessionId?`, `recording`, `paused`, `version`, `updatedAt`, `lifecycle?` | Immediate capture/lifecycle state after command; `version` used for later OCC operations |
| `FinalTranscriptStateResponse` | same | embedded in stop result | `state`, `contextItemId`, `versionNumber`, `segmentCount`, `lastSegmentSeq` | Poll/wait completion contract for final transcript |
| `StopResultResponse` | same | `stop` | `CaptureStateResponse` + `finalTranscript` | Stop outcome including final transcript status |
| `ConsultationRecordingResponse` / `Part` | same | `GET :id/recording` | recording item/version/codec/timeline/parts URLs | Recording read model (post-capture relevance) |

### 5.4 Lifecycle SSE event payload (from controller contract docs, `Confirmed` at API doc level)
- **Endpoint:** `GET /api/v1/consultations/:id/events`
- **Event data fields (documented):** `type`, `consultationId`, `status`, `processing`, `processingReason?`, `closedReason?`, `encounterSeq`, `version`, `at`, `seq`
- **Replay/query:** `since` replays frames with `seq > since` (buffered window per docs)
- **Notes:** `status` is always seven-value lifecycle vocabulary in this stream; frames carry state only

---

## 6) State, sequencing, and side-effect view

### 6.1 Start-relevant lifecycle transitions (`Confirmed` from controller/docs)
- `OPEN -> RECORDING`
- `PAUSED -> RECORDING` (resume)
- `STOPPED -> RECORDING` (continues current encounter; not a new visit)
- `RECORDING -> RECORDING` (idempotent behavior documented)
- Illegal/non-recordable transitions produce `409` codes (e.g. approved/closed not recordable)

### 6.2 Orthogonal processing and live outcomes
- `status` and `processing` are tracked separately (and may be projected for older clients unless `X-Hope-Lifecycle: 2` is used; `vox-node` handle wraps transport with lifecycle header).
- Start can lead to subsequent `processing_changed` / transcript/finalization events observed asynchronously (exact event names/payloads beyond controller docs require publisher/service trace).

### 6.3 Side effects triggered by start path (controller-level confirmed)
- Ownership/write verification for consultation
- Wait for live documentation stop/drain completion (`whenStopped`)
- Lifecycle service `start(...)` invocation (state transition, STT session validation/binding, supersession handling as implemented)
- Live documentation session start (`LiveDocumentationService.start`) for clinician/consultation/session context

### 6.4 Event/subscription channels relevant immediately after start
- **Lifecycle SSE:** `/consultations/:id/events` (status/processing/version/seq)
- **Realtime STT socket:** transcript and session/capture-status messages (SDK handle emits `transcript`, `capture-state`)
- **Other consultation streams (feature-dependent):** live summary/progress/assurance/trajectory/loop/assist endpoints exist in consultation controller; subscription timing depends on UI/feature usage

---

## 7) Failure modes and edge cases (start flow)

| Area | Failure / branch | Where observed | Client impact / handling |
|---|---|---|---|
| Input validation (SDK) | `TypeError` for invalid `open`/`startCapture` args (e.g. empty `patientId`, empty `sttSessionId`) | `vox-node` resources/handle | Fails before network call; fix request construction |
| Open attribution/validation | `400 CLINICIAN_REQUIRED`, `CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER`, context/schema/language/department errors | `ConsultationController.open` / service | Consultation not opened; UI must correct inputs/context |
| Auth/scopes/consent | Missing auth, insufficient scope, consent denied (AI documentation on start) | Guards/decorators/controller/service | `401/403/409` depending on cause; cannot start capture |
| Lifecycle conflicts | `409 CONSULTATION_NOT_RECORDABLE`, `CONSULTATION_TRANSITION_ILLEGAL` | Lifecycle service via controller | Start rejected; UI should refresh consultation state and branch (reopen/new visit/wait) |
| STT binding/session issues | `409 STT_SESSION_NOT_ACTIVE` on lifecycle start; STT session creation errors/conflicts | `ConsultationController.start` / STT session API | Session cannot be bound; create a new STT session and retry start flow |
| Optimistic concurrency (later actions) | `412/428` on OCC-guarded endpoints (approve/close/patch flows) | Controller/OCC decorators | Not typical on `start`, but start response `version` must be preserved |
| Realtime socket/connectivity | Socket connect failure, disconnect during paused/resume, ticket refresh issues | `RealtimeSttSocket`, `stt.refreshTicket`, handle reconnect logic | Transcript stream interrupted; handle may reconnect/resume or require fresh session depending on state |
| SSE reconnect/replay | `since` invalid, missed/idle reconnect behavior, `seq` reset after long inactivity | `ConsultationLifecycleEventsController`, handle SSE subscription logic | Need replay cursor handling and periodic state re-read if sequence resets |
| Duplicate clicks / repeated starts | Idempotent behavior while already recording (documented) and SDK reuse of active connected capture | Handle + lifecycle service/controller | Should not create duplicate active capture in happy path; still validate UI button disabling/state |

---

## 8) Source map and evidence index (for this trace)

### 8.1 `vox-node` (client orchestration and transport)
- [`packages/vox-node/README.md`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/README.md) — SDK overview, credential/scope model, consultation/STT concepts
- [`packages/vox-node/src/resources/consultations.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultations.ts) — `open`, `attach`, handle creation, sub-resources (`recording`, `streams`, `summaries`, `workflows`)
- [`packages/vox-node/src/resources/consultation-handle.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-handle.ts) — `start`, `startCapture`, pause/stop, lifecycle header wrapping, SSE event subscription behavior, socket attachment
- [`packages/vox-node/src/resources/consultation-recording.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-recording.ts) — deprecated recording start/stop API mapping
- [`packages/vox-node/src/resources/stt.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/stt.ts) — STT session create/refresh/close and socket wiring
- [`packages/vox-node/src/resources/consultation-streams.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/packages/vox-node/src/resources/consultation-streams.ts) — live SSE stream helpers (to trace specific subscriptions)

### 8.2 Gateway API (consultation module)
- [`apps/api/src/modules/consultation/consultation.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation.controller.ts) — `open`, lifecycle `start/pause/stop`, `beginLiveCapture`, recording aliases, access/attribution helpers, streams/read endpoints
- [`apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts) — lifecycle SSE endpoint and replay/query validation
- [`apps/api/src/modules/consultation/dto/lifecycle-command.request.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts) — start/stop/approve/reopen request DTOs
- [`apps/api/src/modules/consultation/dto/lifecycle.response.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/lifecycle.response.ts) — capture/stop/recording response DTOs and vocabularies
- [`apps/api/src/modules/consultation/dto/close-consultation.request.ts`](https://github.com/ArcaAI/project-hope/blob/dev-2.2/apps/api/src/modules/consultation/dto/close-consultation.request.ts) — adjacent lifecycle attribution/body-validation contract

### 8.3 Downstream dependencies to trace next (for full confirmation)
- `IConsultationLifecycleService` implementation (`start/pause/stop`) in `@arcaai/applications` / `packages/applications/**`
- `ConsultationLifecycleEventPublisher` implementation and lifecycle event schema/types
- `LiveDocumentationService.start/whenStopped/isActive` behavior and emitted side effects
- Streaming session controller/WS gateway implementation for STT session create/refresh/handshake/transcript protocol
- API/SDK tests covering start flow sequencing (`apps/api/src/modules/consultation/__tests__/*`, `packages/vox-node/src/**/__tests__/*consultation*`, socket/SSE tests)

---

## 9) Open questions / gaps (explicit)
- **UI-specific start action:** does the UI call `open` then `start`, or only `start` on an existing consultation? (Needs product/UI trace)
- **Exact STT session controller/service behavior:** request validation, agent resolution errors, and transcript WS protocol details not fully traced in this doc
- **Exact lifecycle service state machine internals:** persistence model, emitted event types/timing, and all idempotency/transition edge cases beyond controller/DTO/docs
- **Live documentation side effects:** what `LiveDocumentationService.start(...)` publishes/creates immediately and which stream a client should subscribe to first for “start” UX
- **Guardrail/processing events on start:** whether any `guardrail-notice`/`processing_changed` events are commonly emitted during/after start in normal flows (requires runtime/test evidence)

---

## 10) Recommended next deep-dive (to harden this document)
1. Trace and document `ConsultationController.beginLiveCapture(...)` and `finishRecordingStop(...)` fully (already partially covered) with line-anchored behavior.
2. Trace `IConsultationLifecycleService.start(...)` implementation and event publisher outputs.
3. Trace STT stream session endpoints and `RealtimeSttSocket` protocol (frames, statuses, reconnect/ticket refresh).
4. Add a confirmed Mermaid sequence diagram for the canonical `open -> start -> create STT session -> lifecycle start -> socket connect -> lifecycle SSE` flow.
5. Add test-backed evidence rows (API tests + `vox-node` tests/examples) for each step and failure case.
