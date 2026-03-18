# TASK-016: STT-V2 WebSocket Real-Time Streaming

- **Ticket**: TASK-016
- **Created**: 2026-02-11
- **Last Updated**: 2026-02-11
- **Status**: In Progress (Phases 1-5 complete)
- **Depends on**: TASK-014 (Streaming Architecture Foundation), TASK-015 (Batch + SSE)

---

## Goal

Enable real-time audio streaming from client → API Gateway (NestJS) → STT-V2 (Python) via WebSocket, with live transcription results streamed back to the client. Brand-new service modules — no reuse of old STT v1 WebSocket code.

## Architecture Overview

The client creates a session via HTTP, then connects a WebSocket using the session ID. The API gateway forwards binary audio frames to Redis Streams (`stt:audio:{session_id}`), and STT-V2 consumes them via the existing `IngestionConsumer`. A new streaming preprocessor performs real-time VAD and ASR inference per utterance, publishing `SegmentResult` to `stt:result:{session_id}`. The API gateway reads results from the result stream and relays them back over the WebSocket. Control signals (stop, pause) flow through `stt:control:{session_id}`.

```
Client ──WS binary frames──> API Gateway ──XADD stt:audio:{sid}──> Redis
Client <──WS JSON events──── API Gateway <──XREAD stt:result:{sid}── Redis
                                                                      ^
                                                                      │
                                                              STT-V2 (Python)
                                                              IngestionConsumer
                                                              StreamingPreprocessor
                                                              ASR Inference
                                                              ResultPublisher
```

## Tech Stack

- **API Gateway**: NestJS 11, `@nestjs/platform-ws`, `ioredis`, TypeScript
- **STT-V2**: FastAPI, `redis.asyncio`, Python 3.11
- **Transport**: Redis Streams (audio + results + control)
- **Auth**: JWT (query param) + API Key (query param) — both supported
- **ASR**: Whisper via Optimum ONNX (reuse batch inference core)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API ↔ STT-V2 transport | Redis Streams (Option A) | Decoupled, crash-recoverable, backpressure via MAXLEN; TASK-014 foundation already built |
| ASR inference | New streaming preprocessor (Option B) | Real-time VAD + per-utterance inference for ~1-3s latency |
| WebSocket auth | Both JWT + API Key (Option C) | JWT for browser clients, API key for service-to-service |
| Session creation | Hybrid HTTP+WS (Option C) | HTTP create checks capacity upfront; WS rejects unknown sessions |
| Old STT gateway | Do NOT touch | Brand-new modules only; old `SttGateway` stays as-is |

## Key Constraints

- **No changes to old STT v1 code** (`apps/api/src/controllers/stt/`)
- **Service logic in `@arcaai/applications`**, only controllers/gateways in `apps/api`
- **All new files** — no modifications to existing streaming module files unless strictly necessary
- **Unit tests for all new components**

---

## Implementation Plan

### Phase 1: STT-V2 — Initialize Streaming Module + Session API

Bring the TASK-014 streaming module to life. Currently `SessionManager` is never started and there are no HTTP endpoints to create/manage streaming sessions.

---

#### Task 1.1: Create `initialize_streaming()` in `_runtime.py`

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/streaming/_runtime.py`
- Test: `apps/stt-v2/tests/unit/test_streaming.py` (add tests)

**What**: Add an `async initialize_streaming(redis)` function that:
1. Calls `detect_execution_profile()` → `set_execution_profile()`
2. Creates `SessionManager(redis, profile, worker_id)` → `set_session_manager()`
3. Calls `await session_manager.start()`

Add a matching `async shutdown_streaming()` that:
1. Calls `await session_manager.stop()`
2. Calls `clear_runtime()`

**Why**: `_runtime.py` references `initialize_streaming()` in docstrings but it doesn't exist. This is the critical missing piece.

---

#### Task 1.2: Wire streaming into FastAPI lifespan

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/main.py`

**What**: In the existing `lifespan()` async context manager:
1. After `initialize_redis()`, call `await initialize_streaming(redis_client)`
2. In shutdown, before `close_redis()`, call `await shutdown_streaming()`

**Why**: SessionManager must be running for `get_session_manager()` to return non-None. Health endpoints already handle this gracefully.

---

#### Task 1.3: Create internal streaming session API

**Files**:
- Create: `apps/stt-v2/src/stt_v2/streaming/api/__init__.py`
- Create: `apps/stt-v2/src/stt_v2/streaming/api/routes.py`
- Create: `apps/stt-v2/src/stt_v2/streaming/api/schemas.py`
- Modify: `apps/stt-v2/src/stt_v2/main.py` (register router)
- Test: `apps/stt-v2/tests/unit/test_streaming_api.py`

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/internal/streaming/sessions` | Create session (capacity check) |
| `GET` | `/internal/streaming/sessions/{session_id}` | Get session status |
| `DELETE` | `/internal/streaming/sessions/{session_id}` | Remove/finalize session |
| `GET` | `/internal/streaming/availability` | Check if streaming is available + capacity |

**`POST /internal/streaming/sessions` request**:
```python
class CreateStreamingSessionRequest(BaseModel):
    session_id: str
    tenant_id: str
    pipeline_id: str
    consultation_id: str | None = None
    sample_rate: int = 16000
    microphone_id: str | None = None
```

**Response** (201 or 503):
```python
class CreateStreamingSessionResponse(BaseModel):
    session_id: str
    status: str  # "active" or "rejected"
    reason: str | None = None  # "at_capacity" if rejected
    max_concurrent: int
    current_active: int
```

**Why**: The API gateway needs to call stt-v2 to create a session before accepting the WebSocket connection. The capacity check happens here so the client gets a clear 503 before wasting a WS connection.

---

#### Task 1.4: Add `microphone_id` to `SessionMetadata`

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/streaming/schemas.py`
- Modify: `apps/stt-v2/tests/unit/test_streaming.py` (update schema tests)

**What**: Add `microphone_id: str = ""` field to `SessionMetadata` dataclass. Include in `to_redis_dict()` / `from_redis_dict()`.

**Why**: Track which physical microphone captured the audio for diarization and debugging.

---

### Phase 2: STT-V2 — Streaming Preprocessor + ASR Pipeline

The critical missing piece: actual transcription in the streaming path.

---

#### Task 2.1: Create `StreamingPreprocessor`

**Files**:
- Create: `apps/stt-v2/src/stt_v2/streaming/preprocessor.py`
- Test: `apps/stt-v2/tests/unit/test_streaming_preprocessor.py`

**What**: A streaming-aware audio preprocessor that works on chunks rather than full files.

```python
class StreamingPreprocessor:
    """Processes streaming audio chunks for real-time transcription.

    Unlike AudioPreprocessor (batch), this works incrementally:
    - Accumulates PCM samples in a buffer
    - Runs frame-level VAD (Silero) to detect speech/silence
    - When an utterance boundary is detected (speech → silence),
      extracts the utterance, applies denoise + normalize, and
      yields it for ASR inference.
    """

    def __init__(self, sample_rate: int, vad_model, denoise_model=None):
        self.sample_rate = sample_rate
        self._buffer: bytearray  # accumulates raw PCM
        self._vad_state: dict    # Silero VAD running state
        self._in_speech: bool
        self._speech_start: float
        self._silence_frames: int

    async def feed(self, pcm_data: bytes) -> list[AudioUtterance]:
        """Feed raw PCM bytes. Returns 0 or more complete utterances."""

    async def flush(self) -> AudioUtterance | None:
        """Flush remaining audio as final utterance (on session finalize)."""
```

**Key design**:
- VAD runs per 30ms frame (480 samples at 16kHz) using Silero ONNX
- Speech onset: `vad_probability > threshold` for `min_speech_duration_ms`
- Speech offset: `vad_probability < threshold` for `min_silence_duration_ms`
- On offset → extract utterance from buffer, apply RNNoise denoise, normalize, yield
- Buffer management: keep last 300ms pre-speech for context

**Reuse from batch**: `AudioPreprocessor._apply_denoise()`, `AudioPreprocessor._normalize_audio()`, `AudioPreprocessor._resample()` — call these on extracted utterances.

---

#### Task 2.2: Create `StreamingInferenceWorker`

**Files**:
- Create: `apps/stt-v2/src/stt_v2/streaming/inference.py`
- Test: `apps/stt-v2/tests/unit/test_streaming_inference.py`

**What**: An async worker that receives utterances from the preprocessor and runs ASR inference.

```python
class StreamingInferenceWorker:
    """Runs ASR inference on utterances from StreamingPreprocessor.

    Uses the same Optimum ONNX / Transformers pipeline as batch,
    but called per-utterance rather than per-file.
    """

    def __init__(self, pipeline_config, asr_model, result_publisher):
        ...

    async def process_utterance(
        self, session_id: str, utterance: AudioUtterance, utterance_index: int
    ) -> SegmentResult:
        """Run ASR on a single utterance, publish result."""
```

**Key design**:
- Loads ASR model once (shared across sessions via model cache)
- Calls `_run_inference()` logic from `BatchTranscriptionService` on the utterance samples
- Produces `SegmentResult` with text, timestamps, is_final
- Publishes via `ResultPublisher.publish(result)` to `stt:result:{session_id}`
- Handles errors gracefully (publish error result, don't crash session)

**Reuse from batch**: `BatchTranscriptionService._run_optimum_onnx_inference()` core logic, `ChunkTranscriptionResult` → map to `SegmentResult`.

---

#### Task 2.3: Wire preprocessor + inference into SessionManager

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/streaming/session_manager.py`
- Modify: `apps/stt-v2/src/stt_v2/streaming/session.py` (add preprocessor reference)
- Test: `apps/stt-v2/tests/unit/test_streaming.py` (update session manager tests)

**What**: Update `_make_frame_handler()` to:
1. Feed PCM data to `StreamingPreprocessor.feed()`
2. For each returned utterance, submit to `StreamingInferenceWorker.process_utterance()`
3. On `frame.final`, call `preprocessor.flush()` and process any remaining utterance

Update `create_session()` to:
1. Create `StreamingPreprocessor` with VAD model from pipeline config
2. Create `StreamingInferenceWorker` with ASR model
3. Store references in `StreamSession`

**Why**: This is where the frame handler goes from "record only" to "record + transcribe."

---

### Phase 3: `@arcaai/applications` — Streaming Session Service

Brand-new service modules in the applications package. Separate from the existing `realtime/` (which handles batch SSE).

---

#### Task 3.1: Create streaming session DTOs

**Files**:
- Create: `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts`
- Create: `packages/applications/src/services/stt/streaming/dto/index.ts`

**What**: TypeScript DTOs for streaming session management:

```typescript
export interface CreateStreamingSessionRequest {
    sessionId: string;
    tenantId: string;
    pipelineId: string;
    consultationId?: string;
    sampleRate?: number;
    microphoneId?: string;
}

export interface StreamingSessionStatus {
    sessionId: string;
    status: 'active' | 'finalizing' | 'closed' | 'rejected';
    reason?: string;
    maxConcurrent: number;
    currentActive: number;
}

export interface StreamingAvailability {
    available: boolean;
    maxConcurrent: number;
    currentActive: number;
    availableSlots: number;
}
```

---

#### Task 3.2: Create `StreamingSessionService`

**Files**:
- Create: `packages/applications/src/services/stt/streaming/IStreamingSessionService.ts`
- Create: `packages/applications/src/services/stt/streaming/streamingSession.service.ts`
- Test: (unit tests in a later task)

**What**: Service that communicates with stt-v2's internal streaming API:

```typescript
@Injectable()
export class StreamingSessionService implements IStreamingSessionService {
    constructor(
        @Inject(IConfigService) private readonly configService: IConfigService,
    ) {}

    /** Call stt-v2 POST /internal/streaming/sessions */
    async createSession(request: CreateStreamingSessionRequest): Promise<StreamingSessionStatus>

    /** Call stt-v2 GET /internal/streaming/sessions/{sessionId} */
    async getSessionStatus(sessionId: string): Promise<StreamingSessionStatus | null>

    /** Call stt-v2 DELETE /internal/streaming/sessions/{sessionId} */
    async removeSession(sessionId: string): Promise<void>

    /** Call stt-v2 GET /internal/streaming/availability */
    async checkAvailability(): Promise<StreamingAvailability>
}
```

Uses `HttpService` (axios) to call stt-v2's internal endpoints. Connection URL from `STT_V2_URL` config.

---

#### Task 3.3: Create `StreamingAudioBridge`

**Files**:
- Create: `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`

**What**: Service that writes audio frames to Redis Streams and reads results:

```typescript
@Injectable()
export class StreamingAudioBridge {
    private subscriber: Redis;  // dedicated ioredis for XREAD blocking

    constructor(
        @Inject(IRedisCacheService) private readonly redis: IRedisCacheService,
        @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    ) {}

    /** XADD stt:audio:{sessionId} with MAXLEN ~ 2000 */
    async writeAudioFrame(sessionId: string, frame: {
        seq: number; sr: number; enc: string; ch: number;
        data: Buffer; final: boolean; ts: number;
    }): Promise<void>

    /** XADD stt:control:{sessionId} */
    async writeControlCommand(sessionId: string, command: 'finalize'): Promise<void>

    /** Subscribe to stt:result:{sessionId} — returns Observable<SegmentResult> */
    subscribeToResults(sessionId: string): Observable<TranscriptionSegmentEvent>

    /** Unsubscribe from result stream */
    unsubscribeFromResults(sessionId: string): void
}
```

**Key design**:
- `writeAudioFrame` uses `IRedisCacheService` raw ioredis access for `XADD`
- `subscribeToResults` uses a dedicated ioredis connection with blocking `XREAD` on `stt:result:{session_id}`, wrapped in an RxJS Observable
- Reference counting for cleanup (similar to `RedisSubscriberService` pattern)

---

#### Task 3.4: Create module + exports

**Files**:
- Create: `packages/applications/src/services/stt/streaming/streamingSession.service.module.ts`
- Create: `packages/applications/src/services/stt/streaming/index.ts`
- Modify: `packages/applications/src/services/stt/index.ts` (add `export * from './streaming'`)

---

### Phase 4: API Gateway — WebSocket Gateway

Brand-new gateway. Does NOT touch old `SttGateway`.

---

#### Task 4.1: Create `SttV2StreamGateway`

**Files**:
- Create: `apps/api/src/controllers/stt-v2/sttV2Stream.gateway.ts`
- Modify: `apps/api/src/controllers/stt-v2/stt-v2.module.ts` (register gateway)

**What**: NestJS WebSocket gateway at path `/stt-v2/stream`:

```typescript
@WebSocketGateway({ path: '/stt-v2/stream' })
export class SttV2StreamGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    private connections = new Map<WebSocket, StreamingConnection>();

    constructor(
        private readonly sessionService: StreamingSessionService,
        private readonly audioBridge: StreamingAudioBridge,
        private readonly apiKeyValidation: ApiKeyValidationService,
        @Inject(IGracefulShutdownService) private readonly shutdownService: GracefulShutdownService,
    ) {}

    async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void>
    handleDisconnect(client: WebSocket): void
    onModuleDestroy(): void
}
```

**`handleConnection` flow**:
1. Parse query params: `token` (JWT) or `key` (API key) + `sessionId`
2. Validate auth (try JWT first, then API key)
3. If no valid auth → `client.close(1008, 'Unauthorized')`
4. If no sessionId → `client.close(1008, 'Session ID required')`
5. Call `sessionService.getSessionStatus(sessionId)` → verify session exists and is active
6. If not found or not active → `client.close(1008, 'Invalid session')`
7. Subscribe to `audioBridge.subscribeToResults(sessionId)` → forward events to client as JSON
8. Register `client.on('message', handler)` for incoming audio/control
9. Store connection in `connections` map

**`client.on('message')` handler**:
- Binary frame → `audioBridge.writeAudioFrame(sessionId, ...)`
- Text frame → parse JSON message by `type` (`audio` | `stop` | `close`)

**`handleDisconnect`**:
- Unsubscribe from results
- Write `finalize` to control stream
- Remove from connections map

**Frame rate limiting**: Max 50 frames/second per connection. Drop excess with warning log.

---

#### Task 4.2: Create JWT WebSocket auth helper

**Files**:
- Create: `apps/api/src/controllers/stt-v2/helpers/ws-auth.helper.ts`

**What**: Helper function to validate JWT or API key from WebSocket upgrade request:

```typescript
export async function authenticateWebSocket(
    request: IncomingMessage,
    jwtService: JwtService,
    apiKeyValidation: ApiKeyValidationService,
): Promise<{ authenticated: boolean; userId?: string; tenantId?: string; reason?: string }>
```

**Logic**:
1. Parse URL query params
2. If `token` param exists → verify JWT, extract user/tenant
3. Else if `key` param exists → validate API key via `ApiKeyValidationService`
4. Else → return `{ authenticated: false, reason: 'No credentials' }`

**Why**: Reusable auth for any future stt-v2 WebSocket endpoints. Does NOT modify existing guards.

---

#### Task 4.3: WebSocket protocol messages

**Files**:
- Create: `apps/api/src/controllers/stt-v2/dto/streaming-protocol.dto.ts`

**What**: TypeScript types for the WebSocket protocol:

```typescript
// Client → Server (text or JSON frames)
export interface StreamingControlMessage {
    type: 'stop' | 'close';
    microphoneId?: string;
    sampleRate?: number;
    encoding?: string;
}

// Server → Client (text frames)
export interface StreamingTranscriptEvent {
    type: 'transcript';
    sessionId: string;
    text: string;
    isFinal: boolean;
    startTime: number;
    endTime: number;
    speakerId?: string;
    speakerConfidence?: number;
    wordTimestamps?: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export interface StreamingStatusEvent {
    type: 'status';
    sessionId: string;
    status: 'connected' | 'processing' | 'finalizing' | 'completed' | 'error';
    message?: string;
}

export interface StreamingErrorEvent {
    type: 'error';
    sessionId: string;
    code: string;
    message: string;
}

export type StreamingServerEvent = StreamingTranscriptEvent | StreamingStatusEvent | StreamingErrorEvent;
```

---

### Phase 5: Control Flow + Lifecycle

---

#### Task 5.1: Add audio idle timeout to SessionManager

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/streaming/session.py` (add `last_audio_at` field)
- Modify: `apps/stt-v2/src/stt_v2/streaming/session_manager.py` (update reaper)
- Modify: `apps/stt-v2/src/stt_v2/core/config/settings.py` (add `streaming_audio_idle_timeout_s`)
- Test: update reaper tests

**What**:
- Add `last_audio_at: float` to `StreamSession`, updated in `record_frame()`
- Add `streaming_audio_idle_timeout_s: int = 300` (5 minutes) to Settings
- Update `_reap_expired_sessions()` to check both:
  - `last_activity` > `streaming_session_timeout_s` (60s) → finalize (safety net)
  - `last_audio_at` > `streaming_audio_idle_timeout_s` (300s) → finalize (no audio)

**Why**: Distinguishes "no activity at all" (60s, something is wrong) from "no audio but session is alive" (5min, user paused recording).

---

#### Task 5.2: Audio storage on finalize (stub)

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/streaming/session.py`

**What**: In `StreamSession.close()`, add a stub for uploading ring buffer to MinIO:

```python
# TODO (Phase 4): Upload ring buffer to MinIO
# audio_bytes = bytes(self.ring_buffer)
# uri = await upload_to_minio(self.session_id, audio_bytes)
# self._metadata.raw_audio_uri = uri
```

**Why**: Placeholder so the architecture is clear. Actual MinIO integration is a separate task.

---

### Phase 6: Unit Tests

---

#### Task 6.1: STT-V2 unit tests for new components

**Files**:
- Create: `apps/stt-v2/tests/unit/test_streaming_api.py`
- Create: `apps/stt-v2/tests/unit/test_streaming_preprocessor.py`
- Create: `apps/stt-v2/tests/unit/test_streaming_inference.py`
- Modify: `apps/stt-v2/tests/unit/test_streaming.py` (add initialize/shutdown tests)

**Coverage**:
- `initialize_streaming()` / `shutdown_streaming()` lifecycle
- Internal session API endpoints (create, get, delete, availability)
- `StreamingPreprocessor.feed()` / `flush()` with mock VAD
- `StreamingInferenceWorker.process_utterance()` with mock ASR
- `microphone_id` in SessionMetadata serialization

---

#### Task 6.2: NestJS unit tests for new services

**Files**:
- Create: tests for `StreamingSessionService`
- Create: tests for `StreamingAudioBridge`
- Create: tests for `SttV2StreamGateway`
- Create: tests for `ws-auth.helper.ts`

**Coverage**:
- Session creation/status/removal via HTTP to stt-v2
- Audio frame writing to Redis Streams
- Result subscription and Observable behavior
- WebSocket auth (JWT + API key)
- Connection lifecycle (connect, disconnect, shutdown)
- Frame rate limiting

---

## Implementation Order

| Phase | Tasks | Dependencies | Estimated effort |
|-------|-------|-------------|-----------------|
| **Phase 1** | 1.1–1.4 | None | Small — wiring existing code |
| **Phase 2** | 2.1–2.3 | Phase 1 | Large — core streaming ASR |
| **Phase 3** | 3.1–3.4 | Phase 1 (session API must exist) | Medium — NestJS services |
| **Phase 4** | 4.1–4.3 | Phase 3 | Medium — WebSocket gateway |
| **Phase 5** | 5.1–5.2 | Phase 2 | Small — lifecycle polish |
| **Phase 6** | 6.1–6.2 | All phases | Medium — comprehensive tests |

**Parallelism**: Phase 1 must go first. Then Phase 2 (Python) and Phase 3+4 (TypeScript) can proceed in parallel.

---

## Files Summary

### New files (17)

| # | Path | Purpose |
|---|------|---------|
| 1 | `apps/stt-v2/src/stt_v2/streaming/api/__init__.py` | Package marker |
| 2 | `apps/stt-v2/src/stt_v2/streaming/api/routes.py` | Internal session management endpoints |
| 3 | `apps/stt-v2/src/stt_v2/streaming/api/schemas.py` | Request/response Pydantic models |
| 4 | `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | Streaming audio preprocessor (VAD + denoise) |
| 5 | `apps/stt-v2/src/stt_v2/streaming/inference.py` | Streaming ASR inference worker |
| 6 | `apps/stt-v2/tests/unit/test_streaming_api.py` | Session API tests |
| 7 | `apps/stt-v2/tests/unit/test_streaming_preprocessor.py` | Preprocessor tests |
| 8 | `apps/stt-v2/tests/unit/test_streaming_inference.py` | Inference worker tests |
| 9 | `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | Session DTOs |
| 10 | `packages/applications/src/services/stt/streaming/dto/index.ts` | DTO barrel export |
| 11 | `packages/applications/src/services/stt/streaming/IStreamingSessionService.ts` | Service interface |
| 12 | `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | Session management service |
| 13 | `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | Audio bridge (Redis Streams) |
| 14 | `packages/applications/src/services/stt/streaming/streamingSession.service.module.ts` | NestJS module |
| 15 | `packages/applications/src/services/stt/streaming/index.ts` | Barrel export |
| 16 | `apps/api/src/controllers/stt-v2/sttV2Stream.gateway.ts` | WebSocket gateway |
| 17 | `apps/api/src/controllers/stt-v2/helpers/ws-auth.helper.ts` | WS auth helper |
| 18 | `apps/api/src/controllers/stt-v2/dto/streaming-protocol.dto.ts` | WS protocol types |

### Modified files (8)

| # | Path | Change |
|---|------|--------|
| 1 | `apps/stt-v2/src/stt_v2/streaming/_runtime.py` | Add `initialize_streaming()` / `shutdown_streaming()` |
| 2 | `apps/stt-v2/src/stt_v2/main.py` | Wire streaming in lifespan, register router |
| 3 | `apps/stt-v2/src/stt_v2/streaming/schemas.py` | Add `microphone_id` to `SessionMetadata` |
| 4 | `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Wire preprocessor + inference in frame handler |
| 5 | `apps/stt-v2/src/stt_v2/streaming/session.py` | Add `last_audio_at`, preprocessor reference |
| 6 | `apps/stt-v2/src/stt_v2/core/config/settings.py` | Add `streaming_audio_idle_timeout_s` |
| 7 | `apps/api/src/controllers/stt-v2/stt-v2.module.ts` | Register gateway + import streaming module |
| 8 | `packages/applications/src/services/stt/index.ts` | Add `export * from './streaming'` |

---

## WebSocket Protocol Reference

### Connection

```
ws://host:port/stt-v2/stream?token=<jwt>&sessionId=<session_id>
ws://host:port/stt-v2/stream?key=<api_key>&sessionId=<session_id>
```

### Client → Server

| Frame type | Content | Purpose |
|------------|---------|---------|
| Binary | Raw PCM bytes (16-bit LE, mono) | Audio data (~30ms chunks) |
| Text | `{"type":"stop"}` | Stop recording, finalize |
| Text | `{"type":"close"}` | Close connection/session |

### Server → Client

| Event type | Example | Purpose |
|------------|---------|---------|
| `status` | `{"type":"status","sessionId":"...","status":"connected"}` | Connection confirmed |
| `transcript` | `{"type":"transcript","sessionId":"...","text":"...","isFinal":false,...}` | Partial/final transcript |
| `status` | `{"type":"status","sessionId":"...","status":"completed"}` | Session finalized |
| `error` | `{"type":"error","sessionId":"...","code":"...","message":"..."}` | Error occurred |

---

## Relationship to Other Tasks

| Task | Relationship |
|------|-------------|
| **TASK-014** | Foundation — SessionManager, Redis Streams, CapacityGuard, schemas. All reused. |
| **TASK-015** | Parallel — batch SSE flow. Shares Redis patterns but different use case. |
| **STT-003** | Original service. Batch pipeline reused for inference core. |

---

## Implementation Summary

### Files Created (14 new files)

**Python (STT-V2)**:
| File | Description |
|------|-------------|
| `apps/stt-v2/src/stt_v2/streaming/api/__init__.py` | Package marker for streaming API |
| `apps/stt-v2/src/stt_v2/streaming/api/schemas.py` | Pydantic request/response schemas for internal streaming API |
| `apps/stt-v2/src/stt_v2/streaming/api/routes.py` | FastAPI routes: create/get/delete sessions, availability check |
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | Real-time VAD + utterance extraction using Silero ONNX |
| `apps/stt-v2/src/stt_v2/streaming/inference.py` | Per-utterance ASR inference worker with result publishing |
| `apps/stt-v2/tests/unit/test_streaming_api.py` | 23 tests for Phase 1 (runtime init, API endpoints, microphone_id) |
| `apps/stt-v2/tests/unit/test_streaming_preprocessor.py` | 15 tests for preprocessor (VAD, utterance, timing, errors) |
| `apps/stt-v2/tests/unit/test_streaming_inference.py` | 12 tests for inference worker (sync/async pipeline, publishing, errors) |

**TypeScript (applications package)**:
| File | Description |
|------|-------------|
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | TypeScript DTOs: session requests/responses, WebSocket protocol messages |
| `packages/applications/src/services/stt/streaming/dto/index.ts` | Barrel export |
| `packages/applications/src/services/stt/streaming/IStreamingSessionService.ts` | Service interface |
| `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | HTTP client for STT-V2 internal streaming API |
| `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | Redis Streams bridge: XADD audio, XADD control, XREAD results |
| `packages/applications/src/services/stt/streaming/streamingSession.service.module.ts` | NestJS module with HttpModule + ConfigModule |
| `packages/applications/src/services/stt/streaming/index.ts` | Barrel export |

**TypeScript (API Gateway)**:
| File | Description |
|------|-------------|
| `apps/api/src/controllers/stt-v2/helpers/ws-auth.helper.ts` | WebSocket auth: JWT + API key via query params |
| `apps/api/src/controllers/stt-v2/dto/streaming-protocol.dto.ts` | WebSocket protocol DTOs (audio, stop, close, transcript) |
| `apps/api/src/controllers/stt-v2/sttV2Stream.gateway.ts` | WebSocket gateway: auth, session validation, audio forwarding, result relay |

### Files Modified (8 files)

| File | Change |
|------|--------|
| `apps/stt-v2/src/stt_v2/streaming/_runtime.py` | Added `initialize_streaming()`, `shutdown_streaming()`, `get_redis_client()` |
| `apps/stt-v2/src/stt_v2/main.py` | Wired streaming init/shutdown into lifespan, registered streaming router |
| `apps/stt-v2/src/stt_v2/streaming/schemas.py` | Added `microphone_id` to `SessionMetadata` (to_redis_dict, from_redis_dict) |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Added preprocessor + inference worker per session, wired into frame/control handlers |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | Added `streaming_audio_idle_timeout_s` (300s = 5 min default) |
| `packages/applications/src/services/stt/index.ts` | Added `export * from './streaming'` |
| `apps/api/src/controllers/stt-v2/stt-v2.module.ts` | Added `StreamingSessionServiceModule` import, `SttV2StreamGateway` provider |
| `apps/api/src/controllers/stt-v2/index.ts` | Added gateway export |

### Test Results

- **1183 passed, 4 skipped** (full STT-V2 unit test suite)
- **50 new tests** added across 3 test files (23 + 15 + 12)
- Zero regressions on existing 1133 tests

## Change History

### 2026-02-11 — Protocol + Config Alignment

- Finalized WebSocket protocol message field to `type` (not `action`)
- Finalized API key query parameter to `key` (not `apiKey`)
- Confirmed dedicated STT-v2 gateway config key as `STT_V2_URL`
- Deprecated legacy `transcribe_stream` worker path in favor of Redis Streams session flow

### 2026-02-11 — Initial Planning

- Created TASK-016 documentation
- Completed full codebase review across all layers (Python, NestJS, applications package)
- Identified 17 new files and 8 modifications across 6 implementation phases
- Design decisions: streaming preprocessor (Option B), dual auth (Option C), hybrid session creation (Option C)
- Confirmed: no changes to old STT v1 WebSocket code

### 2026-02-10 — Phases 1-5 Implementation

- **Phase 1**: Created `initialize_streaming()`/`shutdown_streaming()`, internal streaming API (4 endpoints), `microphone_id` in SessionMetadata, 23 tests
- **Phase 2**: Created `StreamingPreprocessor` (real-time VAD + utterance extraction) and `StreamingInferenceWorker` (per-utterance ASR), 27 tests
- **Phase 3**: Created TypeScript `StreamingSessionService`, `StreamingAudioBridgeService` (Redis Streams XADD/XREAD), DTOs, NestJS module
- **Phase 4**: Created `SttV2StreamGateway` WebSocket gateway with dual auth (JWT + API key), binary + JSON audio support, result relay
- **Phase 5**: Wired preprocessor + inference into SessionManager frame handler, added 5-min audio idle timeout setting
- Full test suite: 1183 passed, 4 skipped, 0 failures
