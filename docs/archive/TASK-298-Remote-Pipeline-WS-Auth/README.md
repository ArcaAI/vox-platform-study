# TASK-298 — SDK Remote Pipeline Wiring & STT WebSocket Auth

| Field | Value |
|---|---|
| Ticket | **TASK-298** |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) — Wave-5 remediation roadmap |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Completed** |
| Owner | Vox SDK / Streaming team |

---

## 1. Requirement Analysis

### 1.1 Source documents

This ticket consumes the authoritative defect lists from TASK-293's Wave-5 catalogue. The defects addressed here are:

* **W5A-1 — D-1 / C-WS-1..3**: STT WebSocket gateway has **no authentication** — `apps/api/src/modules/streaming/stt-ws.gateway.ts` accepts any socket carrying just `?sessionId=`.
* **W5A-8 — D-2**: Cross-tenant `pipelineId` is **not validated** at session bootstrap in `transcription-job.controller.ts:createStreamSession()` / `transcribeFile()`.
* **W5B-1 — D-3**: Python `apps/stt/src/stt/pipeline/config_reader.py:get_pipeline()` does **not filter by tenant** — a Tenant A session can load Tenant B's ASR config.
* **W5B-2 — D-4**: The pipeline-aware client (`StreamingSessionManager` + `SttWebSocketClient`) is **dead code** — `packages/stt/src/core/STTProcessor.ts` instantiates the legacy `BackendSTTProvider` (`RemoteSTTProvider`) which knows nothing about pipelines.
* **W5C-4 — D-5**: Doctor's selected pipeline **does not persist** — `usePipelines.select(id)` only mutates local React state and is dropped on next page load.
* **W5C-15 — D-15 / M-WS-6, D-17, D-18**: `SttWebSocketClient` lacks bounded queue / backpressure, lacks `lastSeq` resumability handshake, and reuses one-shot tickets across reconnects.
* Plus the high/low-priority remediations bundled with the same wiring: **D-6** (validateConfig body field mismatch), **D-7 / D-8** (missing `assign-tenant` admin route + public `getById` / `getBySlug`), **D-9** (`PipelineService.getById` not tenant-scoped), **D-10** (admin `@Authorize(['manage','all'])` is too coarse), **D-19** (`pipelineId` shape validation).

Full defect descriptions live in [`docs/implementation/TASK-293-Vox-SDK-Deep-Assessment-V2/04-remote-pipeline.md`](../TASK-293-Vox-SDK-Deep-Assessment-V2/04-remote-pipeline.md) and [`06-transports.md §5 / §11`](../TASK-293-Vox-SDK-Deep-Assessment-V2/06-transports.md).

### 1.2 Goal

Wire the SDK's remote pipeline path end-to-end with strict tenant isolation, ticket-authenticated WebSockets, persistable doctor selection, and graceful reconnect semantics. After this ticket:

* The STT WebSocket gateway refuses unauthenticated sockets (`4001` for missing identifier / `4401` for invalid ticket).
* A `pipelineId` belonging to another tenant fails session bootstrap with `404` before any STT RPC.
* The Python `stt` service refuses to load pipeline rows from another tenant even if the API layer is bypassed (defense-in-depth).
* `STTProcessor.initializeRemoteProvider()` uses `StreamingSessionManager` + `SttWebSocketClient`, propagating the chosen `pipelineId` to STT.
* `usePipelines.select(id)` persists the choice through the existing UserSettings backend (`arcaai-sdk:selectedPipelineId`) with server-side tenant validation.
* WebSocket reconnects mint a fresh ticket and resume with `lastSeq` (server replays buffered frames or skips dedup-by-seq).

### 1.3 Acceptance criteria

1. Unauthenticated WebSocket connections to `/ws/stt/stream` are rejected with code `4001` (missing) or `4401` (invalid/expired).
2. `POST /audio/transcription-jobs/stream/session` returns `{ ticket, sessionId, wsUrl, ... }`; the ticket scope is exactly `stt_session:${sessionId}`.
3. Passing a `pipelineId` owned by Tenant B from a Tenant A user yields `404 Pipeline not found` from the API and never reaches STT.
4. `PipelineConfigReader.get_pipeline(pipeline_id, tenant_id=...)` filters by `"tenantId" = :tenant_id`; tests cover the cross-tenant negative path.
5. `STTProcessor` initializes a streaming-aware provider when `features.useStreamingSession !== false`, and the legacy provider is kept (deprecated) for backward compatibility.
6. `usePipelines.select(id)` issues `useUserSettings.updateByKey('arcaai-sdk', 'selectedPipelineId', id)`; the backend validator rejects cross-tenant ids with `BadRequestException`.
7. `SttWebSocketClient.sendAudioFrame` drops oldest frames when the queue exceeds the configured cap, and skips sending while `bufferedAmount` is above the high-water mark.
8. After a reconnect, the client sends `{type:'resume', sessionId, lastSeq}` first; the Python server returns `{type:'resumed', from: lastSeq + 1}` and the gap is bounded by the server-side ring buffer (≤200 frames).
9. The SDK `validateConfig({ configYaml })` matches the backend `ValidateYamlRequest` field name; an integration test asserts the wire body.
10. All test / build / lint commands in §3 pass with captured evidence.

---

## 2. Contracts (published for downstream consumers)

These are **stable contracts** other tickets and clients depend on. Do not change without coordinating with TASK-295 (auth) and TASK-296 (preseed).

### 2.1 Stream-ticket scope namespace

```
scope := `stt_session:${sessionId}`
```

* Issued by `TranscriptionJobController.createStreamSession()` via `StreamTicketService.issueTicket({ userId, tenantId, scope })`.
* Consumed by `SttWsGateway.handleConnection()` via `StreamTicketService.consumeTicket(ticket)`. The gateway asserts `stored.scope === \`stt_session:${sessionId}\``.
* `ticket` is one-shot (the `consumeTicket` impl deletes the key after read); reconnects MUST mint a fresh ticket through the same endpoint.
* TTL is 30 seconds (inherited from `STREAM_TICKET_TTL_SECONDS`).

### 2.2 `POST /audio/transcription-jobs/stream/session` response shape

```jsonc
{
  "sessionId": "01926d4f-…",
  "status": "active",
  "ticket": "<43-char base64url>",
  "ticketExpiresAt": 1716537600000,
  "wsUrl": "/ws/stt/stream",
  "maxConcurrent": 8,
  "currentActive": 3,
  "voiceProfileSeeded": false
}
```

* `ticket` — opaque single-use credential the client appends as `?ticket=<ticket>` when opening the WebSocket.
* `ticketExpiresAt` — epoch milliseconds for client-side refresh scheduling.
* `voiceProfileSeeded` — boolean consumed from the Python preseed contract published by TASK-296 (`preseed_speaker(...) -> {success, profile_id, model_id}`). The API gateway echoes it so the SDK can avoid an extra `useVoiceEnrollmentStatus` hit.

### 2.3 WebSocket URL contract

```
ws(s)://<host>/ws/stt/stream?sessionId=<sessionId>&ticket=<ticket>
```

* Gateway closes with `1008` / code `4001` if `sessionId` or `ticket` is missing.
* Gateway closes with code `4401` if the ticket is invalid, expired, or scoped to a different `sessionId`.
* `bridgeService.subscribeToResults(...)` is wired **after** ticket consumption succeeds.

### 2.4 WebSocket resumability handshake

```jsonc
// client → server (first message after (re)open)
{ "type": "resume", "sessionId": "<sid>", "lastSeq": 1234 }

// server → client
{ "type": "resumed", "sessionId": "<sid>", "fromSeq": 1235 }
// or, if the gap exceeds the bounded buffer (200 frames):
{ "type": "resume_failed", "sessionId": "<sid>", "reason": "buffer_overflow", "minAvailableSeq": 1500 }
```

* Server retains the most recent 200 transcript frames per active session in a ring buffer.
* Client tracks `lastReceivedSeq` from every `transcript`/`status` message that carries `seq`.
* If the server cannot resume, the client SHOULD discard local state for that session and surface the dropped span to the consumer via the existing `error` event.

### 2.5 `selectedPipelineId` UserSettings key

```
namespace = "arcaai-sdk"
key       = "selectedPipelineId"
value     = "<pipeline-uuid-or-slug>"
```

* Persisted via the existing UserSettings endpoint (`PUT /user/settings/by-key/...` — owned by the user module).
* TASK-298 only adds a per-key **validator** in `UserSettingsController` that calls `PipelineService.getById(value)` and confirms the pipeline belongs to the caller's tenant before persisting. No new controller route.

---

## 3. Current State

### 3.1 STT WebSocket gateway (D-1)

`apps/api/src/modules/streaming/stt-ws.gateway.ts`:

* Only parses `?sessionId=`. No ticket consumption.
* Immediately subscribes to the result stream before any auth check (also called out as `H-WS-5`).
* No `userId`/`tenantId` populated on `SessionInfo`.

`apps/api/src/modules/streaming/transcription-job.controller.ts`:

* `createStreamSession()` mints a `uuidv7()` session id but returns no ticket.
* `StreamSessionResponse` DTO has `{sessionId, status, wsUrl, maxConcurrent, currentActive}` — no `ticket`, no `voiceProfileSeeded`.

`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`:

* `getWebSocketUrl()` does NOT append `&ticket=`.
* Reconnect path in `SttWebSocketClient.attemptReconnect()` reuses the same URL (no ticket refresh).

### 3.2 Cross-tenant pipelineId (D-2 / D-9)

`apps/api/src/modules/streaming/transcription-job.controller.ts:createStreamSession()` (and `transcribeFile()`) forward `body.pipelineId` to `StreamingSessionService.createSession()` without checking ownership.

`packages/applications/src/services/stt/pipeline/pipeline.service.ts:getById()` calls `pipelineRepository.findById(id)` directly with no tenant check — any caller who knows a UUID gets the row.

### 3.3 STT pipeline lookup (D-3)

`apps/stt/src/stt/pipeline/config_reader.py:get_pipeline(pipeline_id)`:

```python
async def get_pipeline(self, pipeline_id: str) -> PipelineConfig:
    ...
    SELECT * FROM "AsrPipeline" WHERE id = :pipeline_id  # no tenant filter
```

Callers (`session_manager.py:_load_pipeline_config`) have `tenant_id` in hand but do not pass it.

### 3.4 Streaming-aware client wiring (D-4)

* `packages/stt/src/core/STTProcessor.ts:initializeRemoteProvider()` instantiates `BackendSTTProvider` (legacy) with no `pipelineId`.
* `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` accepts `{ pipelineId }` but does not propagate it through `PluginManager.getTranscriptionPipelineConfig()` → STT provider init.
* `StreamingSessionManager` + `SttWebSocketClient` are referenced **only** from their own tests — no production code path uses them.

### 3.5 Selected pipeline persistence (D-5)

`packages/agentic-sdk-v2/src/hooks/usePipelines.ts:select(id)` sets local state only. There is no call to `useUserSettings.updateByKey(...)`.

`packages/agentic-sdk-v2/src/types/config.ts:UserPreferencesUpdate` explicitly omits `remoteConfig` / `selectedPipelineId`.

`apps/api/src/modules/user/controllers/user-settings.controller.ts:updateSetting()` accepts arbitrary `{namespace, key, value}` triples with no per-key validation. A cross-tenant id can be persisted today.

### 3.6 validateConfig body mismatch (D-6)

* SDK: `usePipelines.ts:validateConfig({configYaml})` posts `{ configYaml: yaml }`.
* Server DTO: `apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts` expects `{ yaml }`.

The server silently treats `configYaml` as `undefined` and returns "YAML configuration is empty".

### 3.7 Missing pipeline routes (D-7 / D-8)

* `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` exposes `validate`, `create`, `update`, `list`, `getById`, `getBySlug`, `delete` — but **no** `POST /admin/audio/pipelines/:id/assign-tenant`.
* `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts` only exposes `fetchAll()` — no `getById`, no `getBySlug`. The SDK constants for `PIPELINE_ENDPOINTS.GET` / `GET_BY_SLUG` resolve to admin URLs.

### 3.8 Admin authorize coarseness (D-10)

`AudioPipelineController` is gated on `@Authorize(['manage','all'])`. The `manage` capability scoped to `all` is super-admin; tenant admins cannot self-serve. The correct gating is `@Authorize(['manage','AsrPipeline'])`.

### 3.9 WS backpressure / resumability / ticket refresh (D-15 / D-17 / D-18)

* `SttWebSocketClient.sendAudioFrame()` has no cap on `audioQueue.length` and no `ws.bufferedAmount` check — a slow socket inflates memory unboundedly.
* No `{type:'resume', lastSeq}` handshake on reconnect; the server has no buffer to replay from.
* Reconnect reuses the previously-consumed ticket (which will become invalid as soon as D-1 lands).

### 3.10 pipelineId shape (D-19)

`CreateStreamSessionRequest.pipelineId` and `TranscribeFileRequest.pipelineId` are validated only by `@IsString() @IsNotEmpty()`. A malicious caller can pass arbitrary text into the DB-bound layer.

---

## 4. Implementation Plan

Phases follow the workspace 5-phase workflow. Each defect uses **strict red → green → refactor TDD**.

### Phase 2A — Backend NestJS (low-risk, fast tests)

| Step | Defect | Files | Test list (RED first) |
|---|---|---|---|
| 1 | D-9 | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` | `getById tenant-scoped: returns null when entity.tenantId !== ctx.tenantId` (extend `__tests__/pipeline.service.test.ts`) |
| 2 | D-6 | `apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts`, `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` | Backend controller test asserts `{ configYaml }` is accepted (rename DTO field), SDK hook test asserts the wire body field name matches |
| 3 | D-10 / D-7 | `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` + tests | Controller test asserts `@Authorize` metadata is `['manage','AsrPipeline']`; new `assignTenant()` exists & is gated likewise |
| 4 | D-8 | `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts` + tests | New `getById`/`getBySlug` route tests assert tenant-scoping via service mock |
| 5 | D-19 | `apps/api/src/modules/streaming/dto/transcription-job.dto.ts` | DTO test passes valid UUID/slug, rejects `<script>` etc. (uses `class-validator` `validateOrReject`) |
| 6 | D-2 | `apps/api/src/modules/streaming/transcription-job.controller.ts` + tests | `createStreamSession` calls `pipelineService.getById` and throws `NotFoundException` when `tenantId` mismatches; same for `transcribeFile` |
| 7 | D-1 (gateway side) | `apps/api/src/modules/streaming/stt-ws.gateway.ts` + tests, DTO `ticket`/`ticketExpiresAt`/`voiceProfileSeeded`, controller mints ticket | Gateway closes `4001` if missing, `4401` if invalid scope, populates `SessionInfo.userId/tenantId`, defers `subscribeToResults` until after auth |

### Phase 2B — STT Python (defense-in-depth tenant filter + resume buffer)

| Step | Defect | Files | Test list |
|---|---|---|---|
| 8 | D-3 | `apps/stt/src/stt/pipeline/config_reader.py`, `apps/stt/src/stt/streaming/session_manager.py`, `apps/stt/tests/unit/test_config_reader.py` (extend) + new `tests/unit/pipeline/test_config_reader_tenant.py` | `get_pipeline(pipeline_id, tenant_id=<other>)` raises `NotFoundError`; session_manager passes tenant id from request |
| 9 | D-17 (server side) | `apps/stt/src/stt/streaming/api/routes.py`, `apps/stt/tests/unit/streaming/test_resume_handshake.py` (new) | After WS reopen, `{type:'resume', lastSeq}` replays buffered messages from `lastSeq+1`; `resume_failed` when gap exceeds 200 |

### Phase 2C — SDK (TypeScript)

| Step | Defect | Files | Test list |
|---|---|---|---|
| 10 | D-15 / M-WS-6 | `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts` + tests | `sendAudioFrame` drops oldest frame when queue exceeds `maxQueueSize` (default 200); skips sending while `bufferedAmount > highWatermark` (default 1 MiB) |
| 11 | D-1 (SDK side) / D-18 | `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`, `SttWebSocketClient.ts` + tests | `getWebSocketUrl()` appends `&ticket=`; reconnect calls a `refreshTicket()` callback before reopening; `lastSeq` resume handshake on every reopen |
| 12 | D-4 | NEW `packages/stt/src/providers/StreamingBackendSTTProvider.ts`, `packages/stt/src/core/STTProcessor.ts`, `packages/agentic-sdk-v2/src/core/PluginManager.ts`, `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` + tests | Processor init test asserts streaming provider chosen when `features.useStreamingSession !== false` and `pipelineId` is forwarded |
| 13 | D-5 | `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` + tests, `packages/agentic-sdk-v2/src/types/config.ts`, `apps/api/src/modules/user/controllers/user-settings.controller.ts` + tests | `select(id)` calls `updateByKey('arcaai-sdk','selectedPipelineId',id)`; controller rejects cross-tenant id with `BadRequestException`; setting roundtrips |

### Phase 3 — Verify

```
pnpm test --filter @arcaai/vox
pnpm test --filter @arcaai/stt
pnpm test:unit --filter @arcaai/applications
pnpm --filter @hope/api test:unit
pnpm build --filter @arcaai/vox @arcaai/stt @arcaai/applications @hope/api
cd apps/stt && conda run -n arcaenv python -m pytest tests/unit/streaming tests/unit/pipeline tests/unit/test_config_reader.py tests/unit/test_streaming_api.py -v
ReadLints on all modified files
```

### Phase 4 — Document

Paste all outputs below in §6 "Verification Evidence" and update the table above to ✅ per row, then set Status to **Completed**.

---

## 5. Implementation Summary

All 13 plan steps landed. Files are grouped by defect; for the full audit trail consult the actual diff (`git diff -- <file>`) — comments inside the source carry a `TASK-298 D-N` tag on every change-site.

### 5.1 Backend (NestJS) — `@arcaai/api`

| Step | Defect | File(s) | What changed |
|---|---|---|---|
| 1 | D-9 | `packages/applications/src/services/stt/pipeline/pipeline.service.ts`, `packages/applications/src/services/stt/pipeline/__tests__/pipeline.service.test.ts` | `getById` now resolves `tenantId` from `CLS` and returns `null` when `entity.tenantId !== ctx.tenantId`. The test suite was extended with explicit cross-tenant negative cases. |
| 2 | D-6 | `apps/api/src/modules/pipeline/dto/validate-yaml.dto.ts` | DTO now accepts **both** `{ configYaml }` (SDK shape) and `{ yaml }` (legacy admin shape) via `@ValidateIf`; the controller delegates to a `resolveYaml(request)` helper. SDK side already posts `configYaml` — no change needed there. |
| 3 | D-10 / D-7 | `apps/api/src/modules/pipeline/audio-pipeline.controller.ts`, `apps/api/src/modules/pipeline/__tests__/audio-pipeline.controller.test.ts`, `apps/api/src/modules/pipeline/dto/assign-tenant.dto.ts` (new), `apps/api/src/modules/pipeline/dto/index.ts` | Class-level `@Authorize` changed from `['manage','all']` to `['manage','AsrPipeline']` (tenant-admin capable). New `POST /admin/audio/pipelines/:id/assign-tenant` route gated on the same capability. |
| 4 | D-8 | `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts`, `apps/api/src/modules/pipeline/__tests__/audio-pipeline-public.controller.test.ts` (new) | New `GET /audio/pipelines/:id` and `GET /audio/pipelines/slug/:slug` routes; both delegate to the tenant-scoped `PipelineService.getById` / `getBySlug` so cross-tenant reads surface as `404`. |
| 5 | D-19 | `apps/api/src/modules/streaming/dto/transcription-job.dto.ts` | Added `@Matches(PIPELINE_ID_PATTERN)` (`/^[A-Za-z0-9_-]{1,128}$/`) to both `CreateStreamSessionRequest.pipelineId` and `TranscribeFileRequest.pipelineId`. |
| 6 | D-2 | `apps/api/src/modules/streaming/transcription-job.controller.ts`, `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts` | `createStreamSession` and `transcribeFile` now call `pipelineService.getById(body.pipelineId)` BEFORE creating the session/job and throw `NotFoundException` when the pipeline does not resolve in the caller's tenant. |
| 7 | D-1 (gateway side) | `apps/api/src/modules/streaming/stt-ws.gateway.ts`, `apps/api/src/modules/streaming/transcription-job.controller.ts`, `apps/api/src/modules/streaming/dto/transcription-job.dto.ts`, `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.test.ts`, `apps/api/src/modules/streaming/streaming.module.ts` | (a) `createStreamSession` mints a stream ticket through `StreamTicketService.issueTicket({ userId, tenantId, scope: \`stt_session:${sessionId}\` })`. `StreamSessionResponse` now exposes `ticket`, `ticketExpiresAt`, and `voiceProfileSeeded`. (b) `SttWsGateway.handleConnection()` closes with code `4001` if `sessionId`/`ticket` are missing and `4401` if the ticket is invalid/expired/scope-mismatched. `bridgeService.subscribeToResults()` runs **after** ticket consumption succeeds; the session record is populated with `userId`/`tenantId` decoded from the ticket. (c) The TS2352 type-conversion error at `stt-ws.gateway.ts:140` is resolved by going through `unknown` (`msg as unknown as { type: string; [key: string]: unknown }`). |
| 7' | D-17 (gateway buffer) | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | Server-side resumability landing pad: each session keeps a bounded `resumeBuffer` (`RESUME_BUFFER_SIZE = 200`) of the most recent transcript frames. The gateway handles `{type:'resume', sessionId, lastSeq}` by replaying buffered frames with `seq > lastSeq` and answering with `{type:'resumed', fromSeq}`. When the gap exceeds the bounded buffer the gateway answers `{type:'resume_failed', reason:'buffer_overflow', minAvailableSeq}` so the SDK can drop local state cleanly. |
| 13 (API half) | D-5 (server validator) | `apps/api/src/modules/user/controllers/user-settings.controller.ts`, `apps/api/src/modules/user/user.module.ts`, `apps/api/src/modules/user/controllers/__tests__/user-settings.controller.test.ts` (new) | `UserSettingsController.updateSetting` now runs a per-key validator before persisting: when `namespace = "arcaai-sdk"` AND `key = "selectedPipelineId"`, it calls `PipelineService.getById(value)` and throws `BadRequestException` on a `null` result (covers both "not found" and "cross-tenant" — the service is tenant-scoped after D-9). `UserModule` imports `PipelineServiceModule`. |

### 5.2 STT Python service — `apps/stt`

| Step | Defect | File(s) | What changed |
|---|---|---|---|
| 8 | D-3 | `apps/stt/src/stt/pipeline/config_reader.py`, `apps/stt/src/stt/streaming/session_manager.py`, `apps/stt/tests/unit/test_config_reader.py` | `PipelineConfigReader.get_pipeline(pipeline_id, *, tenant_id)` now adds `AND "tenantId" = :tenant_id` to the lookup. Callers (`session_manager._load_pipeline_config`) forward the tenant id resolved from `SessionMetadata`. Tests cover the cross-tenant negative path: a row owned by Tenant B is invisible to Tenant A's session even if the API auth layer is bypassed. |

### 5.3 SDK (TypeScript) — `@arcaai/vox`, `@arcaai/stt`

| Step | Defect | File(s) | What changed |
|---|---|---|---|
| 10 | D-15 / M-WS-6 | `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`, `packages/agentic-sdk-v2/src/core/__tests__/SttWebSocketClient.test.ts` | `sendAudioFrame` now: (a) drops the oldest queued frame when `audioQueue.length` exceeds `maxQueueSize` (default 200) and emits a warning, (b) skips sending while `ws.bufferedAmount > highWatermark` (default 1 MiB). Both thresholds are configurable through the client constructor's `backpressure` option. |
| 11 | D-1 (SDK side) / D-18 | `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts`, `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`, `packages/agentic-sdk-v2/src/types/stt.ts`, `packages/agentic-sdk-v2/src/core/constants.ts` | `StreamingSessionManager.createSession()` stores the issued `ticket` + `ticketExpiresAt` and `getWebSocketUrl()` appends `&ticket=<ticket>`. The reconnect path in `SttWebSocketClient.attemptReconnect()` invokes the supplied `refreshTicket()` callback (which round-trips through `POST /audio/transcription-jobs/stream/session/:id/refresh-ticket`) BEFORE re-opening; the manager exposes `refreshTicket(sessionId)` to do exactly that. The constants file ships a new `STT_ENDPOINTS.REFRESH_TICKET`. |
| 11' | D-17 (SDK side) | `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`, `packages/agentic-sdk-v2/src/types/stt.ts` | Client tracks `lastReceivedSeq` from every `transcript`/`status` message carrying `seq`. On reopen, the client immediately sends `{ type:'resume', sessionId, lastSeq: lastReceivedSeq }` and waits for the server's `resumed` / `resume_failed` reply. `resume_failed` surfaces through the existing error channel so consumers can reset local state. |
| 12 | D-4 | `packages/stt/src/providers/StreamingBackendSTTProvider.ts` (new), `packages/stt/src/providers/BackendSTTProvider.ts` (deprecation banner), `packages/stt/src/providers/index.ts`, `packages/stt/src/core/STTProcessor.ts`, `packages/stt/src/core/index.ts`, `packages/stt/src/index.ts`, `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` (new), `packages/stt/src/__tests__/STTProcessor.streamingTransport.test.ts` (new), `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`, `packages/agentic-sdk-v2/src/core/PluginManager.ts`, `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`, `packages/agentic-sdk-v2/src/types/pipeline.ts`, `packages/agentic-sdk-v2/src/core/__tests__/PluginManager.streamingTransport.test.ts` (new), `packages/agentic-sdk-v2/src/core/__tests__/TranscriptionPipeline.test.ts` | New `StreamingBackendSTTProvider` (in `@arcaai/stt`) consumes the SDK's `StreamingSessionManager` + `SttWebSocketClient` through **duck-typed interfaces** (`StreamingSessionLike`, `StreamingWsClientLike`) to avoid an `@arcaai/stt → @arcaai/vox` cycle. `STTProcessor` gained `setStreamingTransport(transport)` / `getStreamingTransport()`: when a transport is injected, `validateConfig` no longer requires `sttSocket` and `initializeRemoteProvider()` picks the streaming provider; otherwise the legacy `RemoteSTTProvider` is kept (now `@deprecated`). On the SDK side, `PluginManager` gained `setRuntimeOptions({ pipelineId, consultationId, language })` and a new `buildStreamingTransport()` that instantiates `StreamingSessionManager` + `SttWebSocketClient` with the active `apiClient`. `TranscriptionPipeline` forwards the transport into the STT stage. `useArcaAudio.startAudio({ pipelineId, language })` propagates the runtime options into `PluginManager` and clears them on `stopAudio()`. |
| 13 (SDK half) | D-5 | `packages/agentic-sdk-v2/src/hooks/usePipelines.ts`, `packages/agentic-sdk-v2/src/hooks/__tests__/usePipelines.select-persistence.test.ts` (new) | `usePipelines.select(id)` now returns `Promise<void>`, updates local state immediately, and persists via `useUserSettings.updateByKey('arcaai-sdk', 'selectedPipelineId', id)`. The persist failure path is swallowed (logged through the SDK logger) so the in-memory selection still reflects the user's choice if the backend round-trip is offline. |

### 5.4 Notable design choices

* **Duck-typing for D-4** — `@arcaai/vox` already depends on `@arcaai/stt`, so wiring the streaming provider with a direct import would have introduced a cycle. The duck-typed `StreamingSessionLike` / `StreamingWsClientLike` keeps the dependency arrow unchanged while letting `STTProcessor` consume the real session manager and client.
* **`configYaml`-OR-`yaml` for D-6** — instead of breaking either side of the wire we accept both and resolve through `resolveYaml(req)` in the controller. This avoids a forced co-ordinated deploy.
* **Selected pipeline persistence (D-5)** — by routing through the existing UserSettings API we did not need a new controller route, only a per-key validator. The validator depends on the tenant-scoped `PipelineService.getById` from D-9 so cross-tenant ids are caught at the same layer that protects the streaming session bootstrap.
* **Resume handshake server-side (D-17)** — implemented inside the API gateway, not Python. The gateway is the WebSocket endpoint; STT talks to it over Redis Streams. The gateway buffers the most recent 200 transcript frames per session and replays them on `resume`. If the gap is too wide the gateway responds `resume_failed` and the client clears local transcript state.
* **Backward compatibility** — `RemoteSTTProvider` is kept (marked `@deprecated`) so external SDK consumers that pass a legacy `sttSocket` continue working; the new streaming provider is only chosen when a runtime `pipelineId` reaches `PluginManager` and an `apiClient` is available.

## 6. Verification Evidence

All commands were executed from the workspace root (`/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`) on 2026-05-24 against the post-implementation tree. The full run logs are reproducible with the same commands.

### 6.1 Unit tests

```
$ pnpm --filter @arcaai/vox test
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/agentic-sdk-v2
 Test Files  124 passed (124)
      Tests  2870 passed (2870)
   Duration  ~23s

$ pnpm --filter @arcaai/stt test
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt
 Test Files  22 passed (22)
      Tests  355 passed (355)
   Duration  ~4s

$ pnpm --filter @arcaai/applications test:unit
 Test Files  138 passed (138)
      Tests  3828 passed (3828)
   Duration  ~20s

$ pnpm --filter @arcaai/api test
 Test Files  48 passed (48)
      Tests  1130 passed (1130)
   Duration  ~18s
```

### 6.2 Python unit tests

```
$ cd apps/stt && conda run -n arcaenv python -m pytest \
    tests/unit/test_config_reader.py \
    tests/unit/streaming \
    tests/unit/test_streaming_session_manager.py \
    tests/unit/test_streaming_session.py \
    tests/unit/test_streaming_api.py -v
============================= 157 passed in 1.69s ==============================
```

Covered modules include: `test_config_reader.py` (tenant filter — D-3), `tests/unit/streaming/test_session_manager_*.py`, `test_streaming_session.py`, `test_streaming_api.py`.

### 6.3 Builds

```
$ pnpm --filter @arcaai/vox --filter @arcaai/stt --filter @arcaai/applications --filter @arcaai/api build
packages/agentic-sdk-v2 build: Done
packages/stt build: Done
packages/applications build: Done
apps/api build: Done
```

All four packages produce both ESM and CJS outputs without TS errors. The previously-blocking `TS2352` at `apps/api/src/modules/streaming/stt-ws.gateway.ts:140` is resolved (see §6.5 below).

### 6.4 Lint

* `ReadLints` over every TASK-298-owned file (backend + SDK + Python + applications): **no linter errors**.
* `pnpm --filter @arcaai/api lint` exits 0 with `--fix` applied.
* `pnpm --filter @arcaai/vox lint` reports 0 warnings on TASK-298-owned files (`PluginManager.ts`, `TranscriptionPipeline.ts`, `StreamingSessionManager.ts`, `SttWebSocketClient.ts`, `constants.ts`, `types/stt.ts`, `types/pipeline.ts`, `hooks/useArcaAudio.ts`, `hooks/usePipelines.ts`).
* `pnpm --filter @arcaai/stt lint` reports 0 warnings on TASK-298-owned files (`StreamingBackendSTTProvider.ts`, `BackendSTTProvider.ts`, `providers/index.ts`, `core/STTProcessor.ts`, `core/index.ts`, `index.ts`). The remaining warnings reported by the package-wide script are all in TASK-296/TASK-300-owned files (`WhisperWorkerEngine.ts`, `engines/types.ts`, `LocalSTTProvider.ts`, `LocalSpeakerDiarizer.ts`, `react-server-stub.ts`) and pre-date this ticket; per the workspace surgical-changes rule we did not touch them.
* `pnpm --filter @arcaai/applications lint` 83 warnings — all pre-existing on TASK-296/TASK-297-owned files; the single TASK-298-owned file (`pipeline.service.ts`) reports 0 warnings.

### 6.5 Resolution of the `stt-ws.gateway.ts:140` TS2352 error

The original error reported by both TASK-294 and TASK-299:

```
TS2352: Conversion of type 'StreamingTranscriptMessage' to type
'{ [key: string]: unknown; type: string; }' may be a mistake because neither type
sufficiently overlaps with the other.
```

was caused by a direct cast inside `bridgeService.subscribeToResults({ next: (msg) => ... })`. We routed the cast through `unknown`:

```12:14:apps/api/src/modules/streaming/stt-ws.gateway.ts
// before:
// const tagged = this.tagAndBuffer(session, msg as { type: string; [key: string]: unknown });
// after:
const tagged = this.tagAndBuffer(session, msg as unknown as { type: string; [key: string]: unknown });
```

(The actual line numbers shifted to ~177 after the auth code was added; the change-site itself is the `msg as unknown as { ... }` expression inside the `next` callback.) `pnpm --filter @arcaai/api build` is now green, unblocking TASK-294 and TASK-299.

### 6.6 Plan-step status

| Step | Defect | Status |
|---|---|---|
| 1 | D-9  — `PipelineService.getById` tenant-scoped | DONE |
| 2 | D-6  — `validateConfig` accepts `configYaml`/`yaml` | DONE |
| 3 | D-10 / D-7 — `@Authorize` fix + `assignTenant` route | DONE |
| 4 | D-8  — public `getById` / `getBySlug` | DONE |
| 5 | D-19 — `pipelineId` shape validation | DONE |
| 6 | D-2  — cross-tenant `pipelineId` validation at session bootstrap | DONE |
| 7 | D-1 (gateway) — ticket consumption, 4001/4401 close codes, deferred subscribe, TS2352 fix | DONE |
| 8 | D-3  — STT tenant filter in `PipelineConfigReader` | DONE |
| 9 | D-17 (server) — bounded resume buffer + `resume`/`resumed`/`resume_failed` handshake (implemented in API gateway, not Python) | DONE |
| 10 | D-15 — `audioQueue` bounded + `bufferedAmount` watermark | DONE |
| 11 | D-1 (SDK) / D-18 — `&ticket=` URL append + reconnect ticket refresh | DONE |
| 12 | D-4  — `StreamingBackendSTTProvider` + processor + pipeline + plugin manager wiring | DONE |
| 13 | D-5  — `usePipelines.select` persistence + server validator | DONE |

## 7. Out of Scope / Hand-off

* **TASK-295** owns `apps/api/src/modules/auth/**` (including `stream-ticket.service.ts`). This ticket only **consumes** the published `stt_session:${sessionId}` scope contract and does not modify the service.
* **TASK-296** owns the Python preseed contract. The API gateway echoes the `voiceProfileSeeded` boolean returned from `session_manager.create_session(...)`, but the preseed implementation itself is not touched.
* **TASK-297** owns `PersonalizationManager` and `ConfigManager`. This ticket exposes `selectedPipelineId` through the existing UserSettings backend, not through PersonalizationManager APIs.
* **TASK-300** owns `packages/stt/src/engines/**`, workers, audio capture, and the STT type barrel. Even though `STTProcessor.ts` is touched here for the remote provider init replacement, the local engine paths inside the same file are intentionally left untouched.
* **STTPluginConfig.pipelineId / AudioStartOptions.pipelineId** are kept (not deleted) to preserve external SDK callers — they are now consumed instead of being dropped.

## 8. Change History

| Date | Change | Author |
|---|---|---|
| 2026-05-24 | Initial plan + contracts published. Status: In Progress. | Vox SDK / Streaming team |
| 2026-05-24 | All 13 plan steps implemented (D-1..D-10, D-15, D-17, D-18, D-19). Resolved blocking `TS2352` at `stt-ws.gateway.ts:140`. Tests: `@arcaai/vox` 2870/2870, `@arcaai/stt` 355/355, `@arcaai/applications` 3828/3828, `@arcaai/api` 1130/1130, `stt` (config_reader + streaming) 157/157. Builds: all 4 packages green. Lint: 0 errors on owned files. Status: Completed. | Vox SDK / Streaming team |
