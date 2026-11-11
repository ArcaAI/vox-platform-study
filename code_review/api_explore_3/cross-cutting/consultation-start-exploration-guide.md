# Consultation Start Flow — Exploration Guide (API + `vox-node`)

**Purpose:** Provide a functional exploration path for the case where a **doctor clicks “Start consultation”** in a client application, including how the gateway APIs are sequenced and how `@arcaai/vox-node` supports the same flow.

**Scope (primary codebases):**
- `project-hope/apps/api/src/modules/consultation/**` (consultation lifecycle, recording, events, attachments, summaries/jobs integration)
- `project-hope/packages/vox-node/**` (Node SDK client, consultation resources/handle, STT/socket/SSE/run helpers)
- Adjacent runtime surfaces as needed: `project-hope/apps/api/src/modules/streaming/**`, `speech/**`, `packages/stt/**`, `packages/room/**`

> Note: “Start consultation” is often a **client-orchestrated sequence** (not a single API call). Separate **consultation lifecycle start** from **recording start**, **STT session creation/binding**, **event subscriptions**, and **live documentation/harness side effects**.

---

## 1) Executive summary (what to understand first)

### What “Start consultation” usually decomposes into
1. **Identify/open the consultation context**
   - Open a consultation (or attach/select an existing one) with required context (patient/clinician/tenant/workflow/language as applicable).
2. **Start lifecycle/capture state for the consultation**
   - Transition consultation to a recording/capturing state (e.g. lifecycle `start` endpoint/command) with any required bindings (e.g. STT session id).
3. **Initialize realtime capture/streaming (if part of UX)**
   - Create/bind STT streaming session, connect WebSocket/audio sender, begin transcript/event flow.
4. **Subscribe to live state and outputs**
   - Lifecycle/status events (SSE), transcript streams, processing/progress, guardrail notices, note readiness signals.
5. **Handle stop/pause/resume/finalize later**
   - Pause/resume/stop, wait for final transcript/note, summary generation/approval/close (important for understanding the full state machine even if focusing on start).

### Why `vox-node` matters
- `@arcaai/vox-node` (`project-hope/packages/vox-node`) is the server-side Node SDK for the HOPE gateway.
- It provides typed resources and helpers for consultation lifecycle/recording/streams/summaries, STT sockets, jobs/workflows/agents, retries/idempotency/preconditions, and SSE/WS handling.
- For consultation flows, the key abstractions to inspect are:
  - `resources/consultations.ts` (resource entry points)
  - `resources/consultation-handle.ts` (end-to-end consultation orchestration/state tracking)
  - `resources/consultation-recording.ts` and `resources/consultation-streams.ts` (recording + live event planes)
  - `resources/stt.ts` and `core/realtime-stt-socket.ts` (STT session/socket protocol)
  - `types/consultation-lifecycle.ts`, `types/stt.ts`, and related types

### Fast mental model
- **API layer (apps/api):** defines the contract, auth/policy, request validation, and orchestration into application services.
- **Application/domain services:** perform state transitions, persistence, side effects, event emission, and dependency coordination (STT, live doc, jobs/workflows).
- **`vox-node`:** wraps the contract into client methods/handles, manages sequencing helpers, transport concerns, and stream/event consumption.
- **UI “Start” button:** typically maps to a small orchestration sequence across those layers, not a single endpoint.

---

## 2) Functional exploration sequence (recommended order)

### Phase A — Establish the API contract (what the client must call)
**Goal:** Identify the exact endpoints, payloads, headers/scopes, ordering, and success/failure signals for consultation start.

1. Read the consultation controller and lifecycle DTOs to identify:
   - Consultation open/create/select endpoints (if required before start)
   - Lifecycle commands: `start`, `pause`, `stop`, `resume/reopen/close/approve` as applicable
   - Recording endpoints (if separate from lifecycle start)
   - Events/streams endpoints and context/document endpoints relevant to startup
2. Capture for each operation:
   - HTTP method + path
   - Request body/params/headers (e.g. `If-Match`, lifecycle headers, idempotency semantics if present)
   - Response shape/state fields (`status`, `processing`, `version`, session ids, etc.)
   - Auth/policy decorators/scopes and tenant/consent implications
3. Distinguish:
   - **Lifecycle start** (`consultations/:id/start`-style command)
   - **Recording start/stop** (if exposed separately)
   - **STT session creation/connect** (streaming transport/session API)
   - **Live documentation/harness start hooks** (internal/service-triggered paths, not client start buttons)

**Primary files:**
- `project-hope/apps/api/src/modules/consultation/consultation.controller.ts`
- `project-hope/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts`
- `project-hope/apps/api/src/modules/consultation/dto/lifecycle.response.ts`
- `project-hope/apps/api/src/modules/consultation/dto/*` (capture/state/language/recording-related DTOs)
- `project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`

### Phase B — Trace backend behavior of “start” (what actually happens)
**Goal:** Understand state transitions, validations, side effects, and emitted events.

1. From the controller method(s), trace injected services/tokens and helpers:
   - Consultation lifecycle service, consultation/encounter services, recording/live-doc services, STT/session dependencies
2. Identify:
   - Preconditions and authorization checks (auth scopes, consent, tenant/ownership, locks, optimistic concurrency where relevant)
   - State machine transitions and idempotency behavior
   - Persistence updates and version changes
   - Emitted events / SSE publication / progress signals
   - Dependencies triggered at start (e.g. bind STT session, start live documentation watchers, workflow/harness signals)
3. Note sync vs async behavior:
   - Immediate API response vs background processing (`processing` states, jobs, streams)

**Primary files (start here, then follow dependencies):**
- `project-hope/apps/api/src/modules/consultation/consultation.controller.ts`
- `project-hope/apps/api/src/modules/consultation/consultation-access.helper.ts` (if present/referenced)
- `project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`
- `project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts` (to understand internal live-doc/harness actions; separate from client click path)
- Application/service implementations referenced by injected tokens (in `@arcaai/applications` / `project-hope/packages/applications/**` as needed)

### Phase C — Trace realtime capture and event delivery (what the doctor sees live)
**Goal:** Map start-to-live-experience: transcript, status, progress, guardrails, and note readiness.

1. Determine which live channels are involved after start:
   - Lifecycle event SSE stream(s)
   - Transcript/streaming STT WebSocket and/or consultation stream resources
   - Progress/loop/harness events, guardrail notices, attachment processing updates
2. Identify session binding and correlation keys:
   - `consultationId`, `sessionId`, tenant/user context, workflow/run identifiers (if applicable)
3. Document event names/payloads and reconnect semantics:
   - Event types, sequence/order guarantees, `Last-Event-ID`/resume behavior, terminal/error conditions

**Primary files:**
- `project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`
- `project-hope/apps/api/src/modules/consultation/consultation.controller.ts` (stream-related handlers if present)
- `project-hope/apps/api/src/modules/streaming/**` (STT/transcription/text streaming endpoints and jobs)
- `project-hope/apps/api/src/modules/speech/**` (TTS/speech proxy/internal flows, if relevant to UI)
- `project-hope/packages/stt/**` and `project-hope/packages/room/**` (lower-level streaming/session primitives, if needed)

### Phase D — Map the flow to `vox-node` (client SDK abstraction)
**Goal:** Understand how a client uses the SDK to perform the same sequence safely and idiomatically.

1. Start from package docs and examples to learn intended usage patterns.
2. Inspect the consultation resource/handle APIs and how they compose:
   - Open/attach consultation
   - Start/pause/stop capture
   - Manage streams/events and transcripts
   - Wait for final note/summaries and complete lifecycle actions
3. Inspect transport and protocol helpers used by those APIs:
   - SSE subscription/reconnect, realtime STT socket protocol, idempotency, If-Match/version handling, retries, error types
4. Build a mapping table:
   - `vox-node` method/property → gateway endpoint/stream → preconditions → emitted state/events

**Primary files:**
- `project-hope/packages/vox-node/README.md`
- `project-hope/packages/vox-node/examples/**`
- `project-hope/packages/vox-node/src/client.ts`
- `project-hope/packages/vox-node/src/index.ts`
- `project-hope/packages/vox-node/src/resources/consultations.ts`
- `project-hope/packages/vox-node/src/resources/consultation-handle.ts`
- `project-hope/packages/vox-node/src/resources/consultation-recording.ts`
- `project-hope/packages/vox-node/src/resources/consultation-streams.ts`
- `project-hope/packages/vox-node/src/resources/consultation-summaries.ts`
- `project-hope/packages/vox-node/src/resources/stt.ts`
- `project-hope/packages/vox-node/src/core/realtime-stt-socket.ts`
- `project-hope/packages/vox-node/src/core/sse.ts`, `src/core/sse-subscription.ts`
- `project-hope/packages/vox-node/src/core/if-match.ts`, `src/core/idempotency.ts`, `src/core/errors.ts`
- `project-hope/packages/vox-node/src/types/consultation-lifecycle.ts`, `src/types/stt.ts`, `src/types/consultation*.ts`

### Phase E — Validate with tests and produce the concrete sequence
**Goal:** Confirm real behavior, edge cases, and produce a reproducible call/event sequence.

1. Use tests as executable documentation for sequencing and failure modes.
2. Cross-check API tests, SDK tests, and types for:
   - Required order of calls
   - Idempotency/retry behavior
   - State transitions and event payloads
   - Auth/principal differences (human JWT vs service account/API key constraints)
3. Produce a sequence artifact (table or diagram) for the “Start consultation” click:
   - Trigger → `vox-node` call → gateway request/stream → response/event → UI state change → failure handling

**Primary files:**
- `project-hope/apps/api/src/modules/consultation/__tests__/*`
- `project-hope/packages/vox-node/src/resources/__tests__/*consultation*`
- `project-hope/packages/vox-node/src/__tests__/*consultation*`
- `project-hope/packages/vox-node/src/core/__tests__/*(sse|socket|if-match|idempotency|retry|run)*`

---

## 3) Files to explore next (prioritized reading order)

### A. Start here (must-read for the “Start consultation” click)
1. `project-hope/apps/api/src/modules/consultation/consultation.controller.ts`
   - **Why:** Canonical API entrypoint for consultation lifecycle/open/start/pause/stop/recording/context/events-related handlers and decorators/scopes.
   - **Look for:** Endpoint paths/methods, request/response DTOs, `@RequiresIfMatch`, auth/scope decorators, lifecycle command handling.
2. `project-hope/apps/api/src/modules/consultation/dto/lifecycle-command.request.ts`
   - **Why:** Exact payload for start/pause/stop-like lifecycle commands (e.g. session binding fields).
3. `project-hope/apps/api/src/modules/consultation/dto/lifecycle.response.ts`
   - **Why:** What the client receives after lifecycle actions (capture state, status, timings/session echoes).
4. `project-hope/apps/api/src/modules/consultation/consultation-lifecycle-events.controller.ts`
   - **Why:** Lifecycle event stream contract after start (SSE/event semantics, client observation model).
5. `project-hope/packages/vox-node/README.md`
   - **Why:** SDK mental model, credential/scopes, consultation vs recording vs streams/summaries, and transport behavior.
6. `project-hope/packages/vox-node/src/resources/consultations.ts`
   - **Why:** SDK entry points for consultation operations (open/get/attach, lifecycle helpers, sub-resources wiring).
7. `project-hope/packages/vox-node/src/resources/consultation-handle.ts`
   - **Why:** High-level orchestration object for a consultation session (start/pause/stop/event handling/state tracking) — often closest to the UI “start” action.
8. `project-hope/packages/vox-node/src/resources/consultation-recording.ts`
   - **Why:** Recording lifecycle API abstraction (if separate from handle-level start) and sequencing invariants.
9. `project-hope/packages/vox-node/src/resources/consultation-streams.ts`
   - **Why:** Live SSE planes/subscriptions the client should attach to around start.
10. `project-hope/packages/vox-node/src/resources/stt.ts` and `project-hope/packages/vox-node/src/core/realtime-stt-socket.ts`
   - **Why:** Realtime STT session creation and audio/transcript transport (core to live consultation capture).

### B. Next (to understand side effects, state, and async outcomes)
11. `project-hope/apps/api/src/modules/consultation/consultation-attachment.controller.ts`
   - **Why:** Attachment flow that may run during/around consultation sessions (intent/upload/complete sequencing).
12. `project-hope/apps/api/src/modules/consultation/consultation-job.controller.ts`
   - **Why:** Job-backed operations related to consultation processing/finalization.
13. `project-hope/apps/api/src/modules/consultation/consultation-telemetry.controller.ts`
   - **Why:** Telemetry emitted during session lifecycle (useful for observability and UI diagnostics).
14. `project-hope/apps/api/src/modules/streaming/**` (start with controllers/resources relevant to STT/transcription jobs and live sessions)
   - **Why:** Streaming/session and transcription job APIs that interact with consultation capture.
15. `project-hope/apps/api/src/modules/speech/**` (as needed)
   - **Why:** TTS/speech proxy flows if the consultation UX includes speech synthesis/playback.
16. `project-hope/packages/vox-node/src/resources/consultation-summaries.ts`
   - **Why:** Post-stop/finalization path (note/summary readiness and actions) that informs what “start” must enable.
17. `project-hope/packages/vox-node/src/resources/jobs.ts` and `project-hope/packages/vox-node/src/resources/workflows.ts`
   - **Why:** Job/workflow orchestration patterns and status/event handling often adjacent to consultation processing.
18. `project-hope/packages/vox-node/src/types/consultation-lifecycle.ts`, `src/types/stt.ts`, `src/types/consultation*.ts`, `src/types/guardrail.ts`
   - **Why:** Canonical client-side vocabularies for states/events/payloads.

### C. Validate and deepen (tests, internals, and edge cases)
19. `project-hope/apps/api/src/modules/consultation/__tests__/*`
   - **Why:** Ground-truth behavior for lifecycle, recording, events, auth/principal rules, and edge cases.
20. `project-hope/packages/vox-node/src/resources/__tests__/*consultation*` and `src/__tests__/*consultation*`
   - **Why:** Expected SDK call sequencing, handle behavior, and event/state handling.
21. `project-hope/packages/vox-node/src/core/__tests__/*sse*`, `*socket*`, `*if-match*`, `*idempotency*`, `*retry*`
   - **Why:** Transport/protocol guarantees and failure recovery behavior.
22. `project-hope/packages/vox-node/examples/**`
   - **Why:** End-to-end usage examples; compare against controller contracts to confirm real sequence.
23. `project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts` and related harness/internal modules (only if needed)
   - **Why:** Internal/harness-triggered actions (e.g. live documentation start/stop via loop actions). Useful for understanding side effects, but usually **not** the direct client “start consultation” API call path.

---

## 4) Suggested output artifact to produce during exploration (next step)

Create a sequence table for the UI action **“Doctor clicks Start consultation”** with columns like:

| Step | User/UI trigger | `vox-node` method (if used) | Gateway call/stream (HTTP/WS/SSE) | Preconditions (auth/scope/state/version/session) | Server effect / state change | Client-visible success signal | Failure modes / retries / fallback |
|---|---|---|---|---|---|---|---|
| 1 | ... | ... | ... | ... | ... | ... | ... |

**Minimum scenarios to capture:**
- Happy path: open/attach → start lifecycle → start/bind streaming → receive events/transcripts
- Pause/resume and stop transitions (to understand state machine boundaries)
- Consent/auth/scope/tenant-lock/precondition failures
- Stream disconnect/reconnect and note/finalization readiness behavior

---

## 5) Notes and cautions

- **Global pipeline still applies:** request behavior is shaped by global guards/interceptors/pipes/filters and bootstrap middleware in `apps/api` (see `nestjs-request-pipeline.md` / `bootstrap-and-global-config.md`).
- **Controller decorators are not the whole story:** application services, domain logic, and async event/stream processors determine much of the runtime behavior.
- **Distinguish planes/endpoints:** consultation lifecycle APIs, STT/streaming APIs, internal harness/service APIs, and admin APIs may look related but have different callers/auth models.
- **Prefer tests/examples for sequencing truth:** when controller/service code is complex, SDK and API tests often reveal the intended call order and edge cases fastest.
