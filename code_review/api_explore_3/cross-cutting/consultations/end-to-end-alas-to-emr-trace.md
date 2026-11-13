# End-to-end trace: ALaaS consultation (Start → Stream → Stop → Generate Summary → Approve → Save/Copy to EMR)

**Workspace date:** 2026-11-13  
**Scope:** File/function-level trace across **ALaaSv3.0** (`apps/web_ui`, `apps/audio-stream-svc`) → **project-hope `@arcaai/vox-node`** → **project-hope `apps/api` consultation module/services** → **harness/Temporal integration** (where applicable).  
**Primary goal:** Explain how ALaaS starts recording, streams conversation, stops, generates summary, approves, and saves/copies the note to EMR, with step-by-step call chains.

> **Evidence basis / confidence**
> - **Confirmed from code/docs inspected:** ALaaS hope-integration overview, `audio-stream-svc` consultation gateway/broker/finish service, `web_ui` consultation hooks/components, `packages/vox-node` consultation resources/types, `apps/api` consultation controllers/DTOs/harness-internal controller, harness README/client/callback routes, existing `start-consultation-end-to-end_detailed.md` and `phase-a-api-contract.md`.
> - **Partially inferred / needs deeper service trace:** exact internal implementations of some `@arcaai/applications` services (`ConsultationService`, `IConsultationLifecycleService`, `NoteGenerationService`, `ConsultationJobService`, `LiveDocumentationService`, harness workflow dispatch internals) and some ALaaS UI click handlers beyond inspected hooks/components. Where not fully traced, this is called out explicitly.
> - **ALaaS repo state checked:** current branch `refactor-hope-integaration`; latest remote by committer date `origin/test-deployment` (2026-11-12). Trace below is based on the checked-out workspace unless noted.

---

## 0) System context (how pieces fit)

### 0.1 ALaaS 3.0 realtime plane
- **Browser/UI:** `ALaaSv3.0/apps/web_ui` (e.g. `hooks/useConsultationStream.js`, `hooks/useConsultationSession.js`, `hooks/useConsultationWorkspace.js`, `components/agentic/ConsultationBar.jsx`, `pages/ConsultationWorkspace.jsx`, `services/consultationService.js`, protocol helpers in `src/consultationProtocol*.js`)
- **Backend orchestrator:** `ALaaSv3.0/apps/audio-stream-svc/src/consultation/*`
  - `consultation.gateway.ts` — raw WS server on `/ws/consultation` (JSON control + binary PCM uplink)
  - `consultation-broker.service.ts` — session lifecycle orchestration (open/start-capture/stream/stop/generate/reopen/feedback/guardrail, note waiting, runtime management)
  - `stt-lane.ts`, `live-plane.ts`, `hope-realtime.*.adapter.ts`, `hope-consultation.vox-node4.shim.ts` / consultation port adapters, `hope-consultation-finish.service.ts` (Copy to EMR/sign-off sequence)
- **HOPE access:** ALaaS uses `@arcaai/vox-node` (project-hope SDK) via adapters/ports; ALaaS does **not** call project-hope harness HTTP endpoints directly.

### 0.2 project-hope HOPE platform
- **SDK:** `project-hope/packages/vox-node/src/resources/*` (`consultations.ts`, `consultation-handle.ts`, `consultation-recording.ts`, `stt.ts`, `consultation-streams.ts`, `consultation-summaries.ts`, etc.)
- **API gateway/controllers:** `project-hope/apps/api/src/modules/consultation/*` (`consultation.controller.ts`, `consultation-lifecycle-events.controller.ts`, `harness-internal.controller.ts`, DTOs)
- **Harness (workflow runtime):** `project-hope/apps/harness` (Python/FastAPI + Temporal worker, port 8866). Harness executes durable workflows/activities and calls API callbacks at `/api/v1/internal/harness/*` (service-to-service `X-Service-Token`).
- **Workflow/agent model (as described):** workflows defined in Admin Console; workflows contain agents; agents use STT/NER/TEXT/GUARDRAIL services/capabilities. Workflow selection/triggering is driven by consultation context (department/tenant/visit details, workflow configuration/slug/id/task routing) resolved by HOPE services/workflow engine — exact resolver chain is partly in `@arcaai/applications`/harness config and requires deeper trace for a specific tenant/department.

---

## 1) Workflow selection context (Admin Console → workflow/agents → services)

**Confirmed/inferred architecture points**
- `project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts` and harness services show workflow-aware behavior:
  - policy resolution can be consultation/task-aware (`GET /internal/harness/policy?...taskKey=...` and consultation-aware overlay logic in controller/services)
  - model/prompt/template resolution endpoints support worker activities tied to workflow nodes/tasks
  - STT batch dispatch resolves ASR agent by slug (`POST /internal/harness/stt/batch-jobs` takes `agentSlug`, language mode handling)
  - harness interpreter/nodes in `apps/harness/src/harness/temporal/interpreter/nodes/*` include consultation/NLP/guardrail/context/template/model-related actions
- ALaaS passes encounter/department/clinician/context/visit metadata into HOPE `open` (and adds context items), which feeds HOPE-side workflow/agent selection and prompt/context assembly.
- **Needs verification (exact code path):** precise mapping from **department and/or workflow slug/id** at consultation start/open/generate to the concrete workflow definition/version instance (Admin Console entities, selection service, and Temporal workflow start parameters) in the currently deployed project-hope codebase.

---

## 2) Step-by-step trace

## Step 1 — Start Button on ALaaS is pressed

### 1A. ALaaS web UI (browser)
| Step | API/message | File/function | What it does |
|---|---|---|---|
| UI action | "Start consultation" / "Start recording" click | `ALaaSv3.0/apps/web_ui/components/agentic/ConsultationBar.jsx` (primary action), `pages/ConsultationWorkspace.jsx`, `hooks/useConsultationWorkspace.js` | Renders consultation controls and invokes workspace/session callbacks (start/pause/resume/stop/generate etc.). Exact click handler wiring should be verified in the rendered action props in `ConsultationWorkspace.jsx`/bar props. |
| Session orchestration | open/start capture over realtime protocol | `hooks/useConsultationSession.js` → `hooks/useConsultationStream.js` | `useConsultationSession` is the page-level session owner (socket/audio uplink/reconnect state). `useConsultationStream` manages WS connection, protocol messages, reducer state, audio queue/replay/resume, and control actions. |
| Protocol encode/send | `open` (v4 launch/open) and/or `start` / `startCapture` semantics (depending protocol/version path) | `src/consultationProtocol*.js` (builders like `buildOpen`, `buildStartCapture`/`buildStart`, `buildMicHint`), `hooks/consultationUplink.js` | Builds JSON uplink frames and manages bounded uplink/replay behavior. v4 flow opens consultation at launch and starts capture separately; legacy v3 start path may open+record in one message (see broker/gateway). |
| Transport | WS connect/send | `hooks/useConsultationStream.js` (`consultationSocketUrl`, WebSocket lifecycle) | Connects to audio-stream-svc `/ws/consultation`, sends control frames and binary audio frames; handles reconnect/resume/replay.

### 1B. ALaaS audio-stream-svc (gateway + broker)
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Inbound WS | `ws /ws/consultation` upgrade + message dispatch | `apps/audio-stream-svc/src/consultation/consultation.gateway.ts` → `ConsultationGateway.attach()`, `onConnection()`, `onMessage()` | Accepts raw WS upgrades for consultation path, parses client messages, routes `open`/`start`/`resume`/binary audio/control verbs to broker, emits server events/errors back to sink. |
| Open consultation (v4) | internal broker call | `consultation-broker.service.ts` → `ConsultationBrokerService.open(message, sink)` | Resolves identity/mapping (`IdentityMappingService`), builds `externalRef`/context (`buildExternalRef`, `buildOpenContext`), opens HOPE consultation via consultation port (`hope-consultation` adapter/shim), stores session/runtime state, emits `consultation.state`, pushes warm-start prior case notes/context as needed, handles revisit/auto-closed/reopen cases. |
| Start capture (v4) | internal broker call | `consultation-broker.service.ts` → `ConsultationBrokerService.startCapture(sessionId,eventId)` | Ensures recordable consultation/handle state, prepares STT lane/live plane, creates STT stream session, calls HOPE recording/lifecycle start through handle/port, connects STT socket and live summary plane, marks runtime capturing/streaming. |
| Legacy path (v3 compatibility) | `start` message with identity | `ConsultationGateway.onMessage()` → `broker.start(...)` / `startLegacy(...)` in `consultation-broker.service.ts` | Opens and starts recording in legacy flow (when lifecycle port path requires), preserving one-release compatibility behavior.

### 1C. vox-node (SDK) calls from ALaaS adapters/ports
| Step | API | File/function | What it does |
|---|---|---|---|
| Open consultation | `POST /api/v1/consultations/open` | `project-hope/packages/vox-node/src/resources/consultations.ts` → `ConsultationsResource.open()` | Validates request locally (e.g. `patientId`), sends open request, wraps response in `ConsultationHandle` (`handleFor`). |
| Attach existing consultation (alt path) | `GET /api/v1/consultations/:id` | `ConsultationsResource.attach()` | Reads consultation and returns handle for existing session/worker flows. |
| Start capture (recommended handle orchestration) | STT session create + lifecycle start + socket connect | `packages/vox-node/src/resources/consultation-handle.ts` → `ConsultationHandle.start()` (and related internal methods) | Orchestrates capture start: may reuse/reconnect socket, create STT stream session, call lifecycle/recording start command with `sessionId`, create/connect realtime STT socket, emit capture/lifecycle events. |
| STT session/socket primitives | `POST /api/v1/audio/transcription-jobs/stream/session`, WS connect | `packages/vox-node/src/resources/stt.ts` (`createStreamSession`, `socket`, etc.) | Creates live STT stream session and returns session/ticket/ws coordinates; builds socket client for audio/transcript transport. |
| Recording lifecycle helpers (deprecated/lower-level) | `POST /consultations/:id/recording/start|stop` / lifecycle verbs | `packages/vox-node/src/resources/consultation-recording.ts`, `consultation-handle.ts` | Lower-level recording control; handle path preferred. |

### 1D. project-hope API (gateway)
| Step | API | File/function | What it does |
|---|---|---|---|
| Open/get-or-create consultation | `POST /api/v1/consultations/open` | `apps/api/src/modules/consultation/consultation.controller.ts` → `ConsultationController.open(...)` | Validates attribution/identity rules (`resolveActingClinicianId`, machine caller rules), delegates to consultation application service (`getOrCreate/open` path), returns consultation/open response (recordable/lifecycle/version/encounter metadata). |
| Start capture/lifecycle | `POST /api/v1/consultations/:id/start` | `ConsultationController.start(...)` (and lifecycle command DTO `dto/lifecycle-command.request.ts` `StartConsultationRequest`) | Ownership/consent checks, wait for live-doc drain as needed, binds optional STT `sessionId`, calls lifecycle service `start/beginLiveCapture`, starts live documentation side effects, returns `CaptureStateResponse` (`dto/lifecycle.response.ts`). |
| Lifecycle event stream subscription (client observation) | `GET /api/v1/consultations/:id/events` (SSE) | `consultation-lifecycle-events.controller.ts` → `streamEvents(...)` | Auth/tenant/stream-scope checks, parses `since`, subscribes to lifecycle event publisher and streams lifecycle frames to clients/handles.

**Key side effects at start:** consultation opened/attached, capture state transitions, STT session bound, live documentation/watchers may start, lifecycle events emitted for UI/SDK observers.

---

## Step 2 — The conversation is streamed

### 2A. ALaaS browser/audio capture uplink
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Mic/audio capture and chunking | binary PCM frames to WS | `apps/web_ui` audio pipeline/hooks (`useConsultationStream.js`, `consultationUplink.js`, mic hint helpers/protocol) | Sends audio chunks byte-for-byte (realtime plane) and metadata/mic hints as protocol messages; applies queue/backpressure/replay-tail rules. |
| Reconnect/resume during stream | `resume` control message + replay tail | `useConsultationStream.js`, `consultationReconnect.js`, `consultationUplink.js` | Resumes session at `lastSeq`, replays missed downlink/uplink tail as needed, preserves continuity.

### 2B. ALaaS audio-stream-svc broker/lanes
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Receive binary audio | WS binary message → broker | `consultation.gateway.ts` → `onMessage(..., isBinary)` / `onAudio` path → `ConsultationBrokerService.pushAudio(...)` | Routes PCM frames to the session runtime/STT lane (`SttLane`) after session/start checks. |
| Mic declaration/hints | `mic.hint` | `consultation.gateway.ts` → `broker.micHint(...)` → `SttLane.micHint(...)` | Declares mic identity/label metadata to STT session (timing-sensitive; must follow HOPE/STT protocol expectations). |
| Forward to HOPE STT | Realtime STT socket send/control | `stt-lane.ts` (session/socket management), `hope-realtime.*` adapter abstractions | Sends PCM/control frames to HOPE STT realtime socket/session; receives transcript/status/provider events. |
| Live summary/transcript fanout | HOPE live summary stream + internal downlink events | `live-plane.ts`, `consultation-broker.service.ts` emit/stamp paths | Subscribes to live summary/lifecycle/progress planes and emits `transcript.*`, `summary.*`, `consultation.state`, guardrail/progress events to browser sink with sequencing/replay ring behavior. |

### 2C. HOPE/vox-node/project-hope realtime processing
| Step | API | File/function | What it does |
|---|---|---|---|
| Realtime STT/session handling | STT stream session + WS (`/ws/stt/stream` or equivalent, ticketed) | `packages/vox-node/src/resources/stt.ts`; HOPE streaming services/controllers (not fully traced here) | Accepts PCM, emits partial/final transcripts/status; session bound to consultation recording/start. |
| Live documentation/progress/event publication | SSE/event streams and internal live-doc services | `ConsultationStreamsResource` (`packages/vox-node/src/resources/consultation-streams.ts`), `consultation-lifecycle-events.controller.ts`, `LiveDocumentationService` / harness live callbacks (API services + `/internal/harness/*` live-summary/progress/loop-event endpoints) | Publishes lifecycle/progress/live-summary updates consumed by ALaaS broker and/or client SDK listeners.

**Harness relationship during streaming (when enabled/configured):** live documentation and workflow-driven processing may run via harness/Temporal and report back through gateway internal harness endpoints (e.g. `/consultations/:id/live-summary`, `/live-assist`, `/progress`, `/loop-event`, `/live-documentation/start|stop`) while `apps/api` remains system-of-record.

---

## Step 3 — Stop button is pressed

### 3A. ALaaS UI → gateway/broker
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Stop action | UI stop/capture stop command | `web_ui/hooks/useConsultationWorkspace.js` / `ConsultationBar.jsx` / session controls (verify exact handler binding) → `useConsultationStream.js` `stop()`/`sendControl(buildStop(...))` | Requests stop; local UI transitions to stopping/finalizing state while broker finalizes. |
| Gateway dispatch | `stop` control message | `consultation.gateway.ts` → `broker.stop(sessionId,eventId,...)` | Routes stop to broker for active session/runtime. |
| Broker stop orchestration | internal | `consultation-broker.service.ts` → `stop()` / `stopCapture()` / legacy `stopLegacy()` | Drains/finalizes STT lane, stops live capture/recording via consultation handle/port or HOPE recording APIs, waits for final transcript/note readiness as required, emits status/progress/transcript/note events in protocol order.

### 3B. vox-node / HOPE API stop path
| Step | API | File/function | What it does |
|---|---|---|---|
| Stop capture (handle) | lifecycle stop + transcript finalization wait semantics | `packages/vox-node/src/resources/consultation-handle.ts` → `ConsultationHandle.stop()` | Sends stop command, updates handle state, may await final transcript completion per API contract/options. |
| Recording stop (lower-level/deprecated path) | `POST /api/v1/consultations/:id/recording/stop` or lifecycle stop endpoint usage via handle internals | `packages/vox-node/src/resources/consultation-recording.ts`, `consultation-handle.ts` | Stops recording/capture on HOPE. |
| Gateway stop handler | `POST /api/v1/consultations/:id/stop` (and related recording stop semantics) | `apps/api/src/modules/consultation/consultation.controller.ts` → `stop(...)`, DTOs `StopConsultationRequest`, `StopResultResponse` | Finalizes capture, triggers/finalizes transcript rebuild as configured (`waitForFinal` behavior), returns capture/final transcript state; may require client polling/retry depending on pending finalization. |

**Important contract:** stop can return with `finalTranscript.state = 'pending'`; clients may re-POST stop or observe lifecycle events until transcript/note readiness completes.

---

## Step 4 — Generate Summary button is pressed

### 4A. ALaaS UI / audio-stream-svc
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Generate action | `generate` / regenerate control message | `web_ui/hooks/useConsultationStream.js` (`buildGenerate`, `generate/regenerate` actions), `useConsultationWorkspace.js` (e.g. `regenerate`/phase logic), UI controls in workspace/bar components | Sends generate/regenerate intent to audio-stream-svc for the session (whole note or section targets depending on message). |
| Broker generate | internal | `consultation-broker.service.ts` → `generate(sessionId,eventId,message)` / `requestNote(...)` / note wait helpers | Validates session/handle/state, requests summary generation (after stop or on-demand regenerate depending flow), tracks note request/progress, emits `note.requested`/`note.progress`/`note.final` events.

### 4B. HOPE API/SDK summary generation
| Step | API | File/function | What it does |
|---|---|---|---|
| Async summary generation (public consultation API) | `POST /api/v1/consultations/:id/summary/async` | `apps/api/src/modules/consultation/consultation.controller.ts` → `generateSummaryAsync(...)` → `startHarnessSummaryJob(...)` | Verifies ownership, resolves initiator/user, applies idempotency (`ConsultationJobService.runIdempotent`), calls note-generation seam, registers harness job or fails visibly if seam cannot produce harness generator for this route. |
| Note generation seam decision/dispatch | application service call | `ConsultationController.startHarnessSummaryJob(...)` → `noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, { consultationId, tenantId, userId, contextItemId })` (`@arcaai/applications`) | Selects generation path (harness vs legacy seam outcome). In current traced path, non-harness is rejected for async summary route (legacy removed). **Exact dispatch internals need deeper trace.** |
| Harness job registration/status surfacing | application service call | `consultationJobService.registerHarnessNoteJob(...)`, async job DTO/lookup endpoints (`/consultations/jobs/:jobId`, etc.) | Persists/registers job status for returned harness correlation/job id so polling/stream/cancel endpoints can resolve it. |
| SDK-side note waiting (alternate/client-driven path) | `GET /api/v1/consultations/:id/summary/latest` (polling) | `packages/vox-node/src/resources/consultations.ts` → `waitForFinalNote(...)`; `ConsultationHandle.generateSummary()` / handle stream helpers | Polls for a finalized note newer than `since`, or handle methods may orchestrate generate/wait/stream behavior depending on client usage.

---

## Step 5 — The summary is generated

### 5A. Harness workflow execution (project-hope)
| Step | API/call | File/function | What it does |
|---|---|---|---|
| Workflow runtime | Temporal workflow/activities (not HTTP from ALaaS) | `project-hope/apps/harness/src/harness/temporal/*`, `services/api_client.py`, interpreter/nodes | Runs `HarnessDocWorkflow`/interpreter activities (policy fetch, NER/retrieval/generate/sensors/persist/gate, progress/assurance/live updates) deterministically in workflow body with I/O in activities. |
| Harness → API callbacks (system-of-record writes/reads) | `/api/v1/internal/harness/*` | `apps/api/src/modules/consultation/harness-internal.controller.ts` handlers; harness `ApiClient`/activities | Harness reads policy/config/models/templates/context and writes entities/draft/progress/assurance/trajectory/gate/escalation/live outputs etc. (see section 6 mapping below). |
| Consultation/job status and note availability | DB/job/summary read surfaces (application/domain services) | `ConsultationJobService`, summary/context services, consultation streams/lifecycle publishers (**needs deeper trace**) | Marks job progression/completion/failure and exposes latest summary/note/version/provenance for clients.

### 5B. Delivery to ALaaS/client
| Step | API/message | File/function | What it does |
|---|---|---|---|
| Progress/readiness events | harness progress/lifecycle/SSE or polling | `consultation-broker.service.ts` (note wait/readiness/watch), `live-plane.ts`, `ConsultationStreamsResource`/handle listeners | Observes HOPE progress and note readiness, then fetches final note/document sections as needed. |
| Final note emission | WS downlink event(s) | `consultation-broker.service.ts` / notifier/protocol mapping | Emits `note.progress`, `note.final` (and related status/state transitions) to web_ui for clinician review/edit/copy.

---

## Step 6 — Approve button is pressed

### 6A. ALaaS UI and "Copy to EMR" sign-off intent
| Step | API/message | File/function | What it does |
|---|---|---|---|
| UI action | Approve/sign-off or Copy to EMR flow | `web_ui/hooks/useConsultationWorkspace.js` (phase/review/export/copy-related logic), consultation UI components/services (`services/consultationService.js`, review/export components) | Collects reviewed/edited note and triggers sign-off/copy action. **Exact button component and REST/WS call path should be verified in workspace/export service implementation.** |
| ALaaS backend finish/sign-off | service call/endpoint invoking finish logic | `apps/audio-stream-svc/src/consultation/hope-consultation-finish.service.ts` → `HopeConsultationFinishService.finish()` / `finishViaPort()` / legacy `finishLegacy()` | Performs Copy-to-EMR sign-off sequence against HOPE: apply correction/update if needed, then approve, then close (order required by HOPE lifecycle). Handles idempotency, version conflicts, not-ready/signed-off states, and never throws raw failures to clinician action path.

### 6B. HOPE approve API (project-hope)
| Step | API | File/function | What it does |
|---|---|---|---|
| Approve consultation | `POST /api/v1/consultations/:id/approve` | `apps/api/src/modules/consultation/consultation.controller.ts` → `approve(...)` with `ApproveConsultationRequest` (`dto/lifecycle-command.request.ts`) and `@RequiresIfMatch()`/lifecycle guards | AuthZ/scope checks, clinician attribution for machine callers, delegates to `IConsultationLifecycleService.approve(...)` (application service). Handles sign-off semantics (including late sign-off/idempotent cases per endpoint docs in controller). |
| Approve side effects | lifecycle/service/domain transitions | `IConsultationLifecycleService`, consultation/summary/domain services (**needs deeper trace**) | Moves consultation to approved/signed state as applicable, records attestation/acknowledgements/guardrail resolutions, emits lifecycle events/audit updates.

---

## Step 7 — Summary/case note is saved to EMR

### 7A. ALaaS Copy-to-EMR behavior (client-visible)
| Step | API/call | File/function | What it does |
|---|---|---|---|
| Copy/export to EMR | internal ALaaS action calling finish/sign-off path | `HopeConsultationFinishService.finishViaPort()` (preferred when lifecycle v2 port bound) | Ensures HOPE note matches copied/submitted text when allowed (correction/update), then calls consultation handle/port `approve()` and `close()` in required order; reports outcome (`finished`, `updated`, `approved`, `closed`, `notReady`, `emrUpdatedAfterSignoff`, etc.). |
| Local EMR write/paste integration | ALaaS-specific EMR integration/UI copy path | `web_ui` export/copy logic and/or downstream EMR connector (**needs verification in ALaaS EMR integration code**) | Places note into EMR/clipboard/workflow as implemented by ALaaS; HOPE sign-off state and local EMR copy must be interpreted together (service distinguishes cases like already signed with different text). |

### 7B. HOPE close/sign-off persistence (project-hope)
| Step | API | File/function | What it does |
|---|---|---|---|
| Close consultation | `POST /api/v1/consultations/:id/close` | `apps/api/src/modules/consultation/consultation.controller.ts` → `close(...)` with `CloseConsultationRequest` (`dto/close-consultation.request.ts`) and `@RequiresIfMatch()` | Validates caller/scopes/attribution, delegates to `IConsultationLifecycleService.close(...)` / consultation close service logic. Endpoint docs indicate: approved → `CLOSED_COMPLETE`, open/recording/paused/stopped → `CLOSED_INCOMPLETE` (manual), idempotent on closed consultation; machine integrations approve before close. |
| Close side effects | lifecycle/service/domain | lifecycle/consultation services, event publisher (**needs deeper trace**) | Persists final consultation lifecycle state/reason/timestamps, emits lifecycle events (`consultation.state`/SSE/webhooks as applicable), making note/sign-off state durable in HOPE.

**Operational rule (from existing docs/finish service):** `approve` must precede `close` for review/sign-off closure path; `close` alone cannot substitute for sign-off where HOPE requires `SIGNED/APPROVED` transition preconditions.

---

## 3) File/function chain summary (condensed)

### ALaaS UI (web_ui)
- `hooks/useConsultationSession.js` → session provider/owner (`useConsultationController`, `useConsultationSession`, lifecycle/capture helpers)
- `hooks/useConsultationStream.js` → WS connect/send/receive, protocol encode/decode, reconnect/resume/replay, uplink queue, generation event buffering, action builders dispatch (`open/start/startCapture/stop/generate/...`)
- `hooks/useConsultationWorkspace.js` → workspace phase/state derivation, recording timing, stop/generate/regenerate/review/copy/export orchestration hooks
- `components/agentic/ConsultationBar.jsx` / `pages/ConsultationWorkspace.jsx` → UI controls and phase-specific actions (verify exact button-to-handler wiring)

### ALaaS audio-stream-svc (consultation module)
- `consultation.gateway.ts` → `ConsultationGateway.attach/onConnection/onMessage` (WS ingress/dispatch)
- `consultation-broker.service.ts` → `ConsultationBrokerService.open/start/startLegacy/startCapture/pushAudio/micHint/stop/generate/.../note wait & state emission`
- `hope-consultation-finish.service.ts` → `HopeConsultationFinishService.finish/finishViaPort/finishLegacy` (Copy to EMR sign-off: correction/update + approve + close)
- `hope-realtime*.adapter.ts`, `hope-consultation*.shim/adapter`, `stt-lane.ts`, `live-plane.ts`, `identity-mapping.service.ts`, `consultation-session.store.ts` (supporting lanes/ports/state)

### project-hope vox-node SDK
- `packages/vox-node/src/resources/consultations.ts` → `open`, `attach`, `waitForFinalNote`, `close`/`updateLanguage` helpers, `workflows/summaries/recording/streams`
- `packages/vox-node/src/resources/consultation-handle.ts` → `start/pause/stop/generateSummary/approve/close/reopen/sendAttachment/sendFeedback/history` (high-level orchestration)
- `packages/vox-node/src/resources/stt.ts` → `createStreamSession`, socket/connect helpers
- `packages/vox-node/src/resources/consultation-streams.ts` → live event/SSE subscriptions

### project-hope API (consultation)
- `apps/api/src/modules/consultation/consultation.controller.ts` → `open/start/pause/stop/.../generateSummaryAsync/startHarnessSummaryJob/.../approve/close/...`
- `apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts` → `streamEvents` (`GET :id/events` SSE)
- `apps/api/src/modules/consultation/dto/*.ts` → request/response contracts for lifecycle/close/stop/start/capture states
- `apps/api/src/modules/consultation/harness-internal.controller.ts` → `/internal/harness/*` callbacks consumed by harness worker/activities

### project-hope harness
- `apps/harness/src/harness/temporal/*`, `services/api_client.py`, `temporal/interpreter/*` → workflow execution and API callback client
- `apps/api` `/internal/harness/*` ← called by harness for policy/model/template/context/entity/draft/assurance/progress/trajectory/gate/loop/live-doc/STT batch operations

---

## 4) Harness callback API map (called by harness during consultation workflows)

**Caller:** `project-hope/apps/harness` (Temporal activities/workflow support via `ApiClient`)  
**Callee:** `project-hope/apps/api` `HarnessInternalController` (`/api/v1/internal/harness/*`, `X-Service-Token`)

| Harness-side purpose | API endpoint (gateway) |
|---|---|
| Fetch effective policy / loop config | `GET /internal/harness/policy`, `GET /internal/harness/loop-config` |
| Resolve prompt/model/credentials/tokens | `GET /internal/harness/prompt-templates/:id/resolved`, `GET /internal/harness/models/resolve`, `GET /internal/harness/provider-credential`, `GET /internal/harness/mcp-token` |
| Read/write consultation workflow artifacts | `POST/GET /internal/harness/consultations/:id/entities`, `POST .../assemble`, `POST .../draft`, `GET .../context-items/:contextItemId/extracted-text` |
| Gate/escalation/assurance | `POST .../gate-decision`, `POST .../escalation`, `POST .../assurance`, `POST .../assurance-event` |
| Live progress/summary/assist/docs | `POST .../progress`, `POST .../loop-event`, `POST .../live-summary`, `POST .../live-assist`, `POST .../live-documentation/start|stop`, `GET .../live-handoff` |
| Endpoint/session/finalize/feedback callbacks | `POST .../endpoint/session`, `POST .../endpoint/finalize`, `POST .../endpoint/feedback` |
| Telemetry/compute reporting | `POST /internal/harness/trajectory` |
| STT batch dispatch/poll (workflow node) | `POST /internal/harness/stt/batch-jobs`, `GET /internal/harness/stt/batch-jobs/:id` |
| Note plan read (separate internal controller) | `GET /api/v1/internal/consultations/:consultationId/note-plans/:planId` |

---

## 5) Open questions / verification gaps to close with a deeper trace

1. **Exact UI click wiring in ALaaS web_ui:** map specific button components/handlers in `ConsultationWorkspace.jsx`, `ConsultationBar.jsx`, and export/copy-to-EMR actions to `useConsultationWorkspace`/service calls.
2. **Workflow selection resolution (admin-defined):** trace from consultation open/start and note generation to the exact services/entities that select workflow by **department and/or workflow slug/id** (Admin Console config, department-agent/workflow binding, Temporal workflow start args).
3. **Note-generation dispatch internals:** trace `NoteGenerationService.generate(...)` and `ConsultationJobService`/Temporal client implementation to the concrete workflow type/id and signal/callback flow.
4. **Approve/close attribution and EMR persistence split:** verify where local EMR write happens vs HOPE sign-off (`approve`/`close`) in ALaaS UI/service layer.
5. **Harness FastAPI endpoint callers:** enumerate `apps/harness/src/harness/api/endpoints/*` and confirm any direct callers from `apps/api` or ops (separate from `/internal/harness/*` callbacks into API).
6. **Generated/checked-out drift:** if behavior differs from production, compare against ALaaS `origin/test-deployment` and corresponding project-hope branch/tag.

---

## 6) Related docs in this folder (existing)
- `phase-a-api-contract.md` — Phase A consultation open/start API contract and DTO/controller walkthrough
- `start-consultation-end-to-end_detailed.md` — detailed start/open/capture/lifecycle trace (SDK + API)
- `../consultation-start-exploration-guide.md` — broader exploration pointers
- `../../harness/consultation-harness-relationship.md` — harness service relationship and callback mapping (created in this review pass)

*This document is intended as a maintained cross-cutting trace. Update it as service internals (`@arcaai/applications`, workflow dispatch, EMR integration handlers) are traced to exact function-level implementations.* 
