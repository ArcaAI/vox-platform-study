# TASK-015: STT-V2 Real-Time Transcription Flow (Batch API + SSE)

- **Ticket**: TASK-015
- **Created**: 2026-02-10
- **Last Updated**: 2026-02-11
- **Status**: In Progress (All tracks complete, code review fixes applied)

---

## Requirement Analysis

### Business Context

Users need to upload audio files for transcription and receive **real-time progress and partial transcript results** via Server-Sent Events (SSE). The current system only supports fire-and-forget batch jobs — the user submits a job and must poll for completion. This task adds a real-time delivery layer on top of the existing batch transcription pipeline so that transcript chunks stream back to the user as they are produced.

### Use Cases

1. **Live transcription feedback** — user uploads a consultation recording, sees transcript text appearing in real-time as the STT-v2 service processes each audio chunk
2. **Progress monitoring** — user sees processing stage and percentage without polling
3. **SSE reconnection** — if the browser tab is refreshed, user can reconnect to an in-progress job's SSE stream

### Acceptance Criteria

- [ ] `POST /api/v1/transcription-jobs/transcribe` accepts audio file upload, creates job, and returns SSE stream
- [ ] SSE delivers real-time events: `status`, `progress`, `chunk` (partial transcript), `transcript` (final), `error`
- [ ] STT-v2 publishes chunk-level transcription results via Redis Pub/Sub as each audio segment completes
- [ ] STT-v2 gateway client correctly calls all NestJS internal endpoints (`start`, `progress`, `complete`, `fail`)
- [ ] `GET /api/v1/transcription-jobs/:jobId/stream` allows reconnecting to an in-progress job's SSE
- [ ] SSE connection terminates cleanly after `COMPLETED` or `FAILED` status
- [ ] All new service logic lives in `@arcaai/applications` package; API app only declares controllers
- [ ] No changes to existing code — all new modules
- [ ] Unit tests for all new components

---

## Current State Evaluation

### Existing Infrastructure

| Component | State | Location |
|-----------|-------|----------|
| **Batch transcription pipeline** | Working | `stt-v2/transcription/batch_service.py` — supports `chunk_callback` for per-segment results |
| **Dramatiq worker** | Working (with gateway mismatch) | `stt-v2/transcription/workers/transcribe_file.py` — calls `start_job`, `complete_job`, etc. |
| **Gateway client** | Incomplete | `stt-v2/core/api_client/gateway.py` — only has `update_job_status()`, missing `start_job()`, `complete_job()`, `fail_job()`, `update_job_progress()` |
| **NestJS internal API** | Working | `SttInternalController` — has `/start`, `/progress`, `/complete`, `/fail` endpoints |
| **NestJS internal service** | Working | `SttInternalService` in `@arcaai/applications` — job lifecycle methods |
| **TranscriptionJob model** | Working | Prisma schema with `status`, `progress`, `resultText`, `resultMetadata` |
| **Redis cache service** | Working | `IRedisCacheService` with `publish()` — used by `ConsultationJobService` |
| **Redis subscriber** | Missing | No `subscribe()` in applications package — `ioredis` requires separate connection |
| **SSE pattern** | Exists (polling) | `ConsultationJobController` uses `@Sse()` with `interval(2000)` polling |
| **Consultation job service** | Working pattern | `ConsultationJobService` publishes to `consultation_job_updates:{jobId}` via Redis |

### Gaps to Address

1. **Gateway client mismatch** — worker calls methods that don't exist on the client
2. **No Redis Pub/Sub publisher in STT-v2** — no mechanism to push real-time events from Python to NestJS
3. **No Redis subscriber in NestJS** — `IRedisCacheService` has `publish()` but no `subscribe()`
4. **chunk_callback not wired** — `BatchTranscriptionService.transcribe()` supports it, but the worker doesn't use it for external delivery
5. **No SSE endpoint for transcription** — existing SSE is polling-based on consultation jobs

---

## Architecture Design

### End-to-End Flow

```
User ──POST /api/v1/transcription-jobs/transcribe──> API Gateway (NestJS)
     <──────────── SSE connection ───────────────────┘
                        │
                        ├─ 1. Upload audio to MinIO (via existing storage)
                        ├─ 2. Create TranscriptionJob in DB (status: QUEUED)
                        ├─ 3. Dispatch Dramatiq message to stt_batch queue
                        ├─ 4. Subscribe to Redis channel stt:transcription:{jobId}
                        │
                        │   ┌─────────── Redis Pub/Sub ───────────┐
                        │   │  channel: stt:transcription:{jobId}  │
                        │   └──────────────────────────────────────┘
                        │          ^ publish              │ subscribe
                        │          │                      v
                        │   STT-v2 (Python)          API Gateway
                        │   ├─ start_job()           ├─ Forward SSE events
                        │   ├─ chunk_callback ──────>│  to user
                        │   ├─ progress_callback ───>│
                        │   ├─ complete_job() ──────>│
                        │   └─ fail_job() ──────────>│
                        │
                        └─ 5. SSE events flow to user until COMPLETED/FAILED
```

### SSE Event Schema

All events are published to Redis channel `stt:transcription:{jobId}` as JSON and forwarded as SSE `MessageEvent` objects to the client.

**Status event** — job lifecycle transitions:
```json
{
    "type": "status",
    "data": {
        "jobId": "01234567-...",
        "status": "PROCESSING",
        "timestamp": "2026-02-10T12:00:00Z",
        "workerId": "worker-12345"
    }
}
```

**Progress event** — processing percentage:
```json
{
    "type": "progress",
    "data": {
        "jobId": "01234567-...",
        "progress": 45,
        "stage": "inference"
    }
}
```

**Chunk event** — partial transcript as each audio segment completes:
```json
{
    "type": "chunk",
    "data": {
        "jobId": "01234567-...",
        "chunkIndex": 3,
        "text": "The patient reports mild discomfort in the lower back.",
        "startTime": 12.5,
        "endTime": 17.3,
        "isFinal": false,
        "wordTimestamps": [
            { "word": "The", "start": 12.5, "end": 12.7, "confidence": 0.99 }
        ]
    }
}
```

**Transcript event** — full final result:
```json
{
    "type": "transcript",
    "data": {
        "jobId": "01234567-...",
        "text": "Full transcript text...",
        "language": "en",
        "languageProbability": 0.95,
        "durationSeconds": 120.5,
        "processingTimeSeconds": 8.3,
        "wordTimestamps": [...],
        "sentenceTimestamps": [...],
        "metadata": { "timing": {...}, "diarization": {...} }
    }
}
```

**Error event** — failure notification:
```json
{
    "type": "error",
    "data": {
        "jobId": "01234567-...",
        "errorCode": "TRANSCRIPTION_ERROR",
        "message": "ASR model inference failed"
    }
}
```

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Real-time relay | Redis Pub/Sub | Low-latency, fire-and-forget, ephemeral. Already used by `ConsultationJobService`. No persistence needed — final result stored in DB. |
| Channel naming | `stt:transcription:{jobId}` | Namespaced, per-job isolation, easy subscribe/unsubscribe |
| Dramatiq dispatch from NestJS | Direct Redis LPUSH | Avoids HTTP round-trip. Dramatiq uses Redis lists natively. |
| Subscriber architecture | Dedicated `RedisSubscriberService` | `ioredis` requires separate connection for SUBSCRIBE mode |
| Service location | `@arcaai/applications` package | Project convention: services in shared package, only controllers in API app |
| Gateway client fix | Add convenience methods | Match the NestJS internal API endpoints that already exist |
| SSE delivery | NestJS `@Sse()` with RxJS Observable | Native NestJS pattern, used by existing `ConsultationJobController` |

---

## Implementation Plan

> **Status**: Track B+C implemented. Track A pending.

###Track A : STT-v2 (Python) — Real-Time Event Publishing

#### A1. Fix Gateway Client

**File**: `apps/stt-v2/src/stt_v2/core/api_client/gateway.py`

The worker (`transcribe_file.py`) calls lifecycle methods that don't exist on the gateway client. The NestJS `SttInternalController` already has the matching endpoints.

**Add methods**:

| New Method | HTTP | NestJS Endpoint | NestJS DTO |
|------------|------|-----------------|------------|
| `start_job(job_id, worker_id)` | `PATCH` | `/internal/stt/jobs/{id}/start` | `InternalStartJobRequest` |
| `update_job_progress(job_id, progress)` | `PATCH` | `/internal/stt/jobs/{id}/progress` | `InternalUpdateProgressRequest` |
| `complete_job(job_id, result_text, result_metadata)` | `PATCH` | `/internal/stt/jobs/{id}/complete` | `InternalCompleteJobRequest` |
| `fail_job(job_id, error_message, error_code)` | `PATCH` | `/internal/stt/jobs/{id}/fail` | `InternalFailJobRequest` |

**Also fix**:
- Update `create_transcript()` signature to match worker usage: `create_transcript(job_id, transcript_text, metadata, consultation_id)`
- Fix typo on line ~119: `enror_code` -> `error_code`

#### A2. Create Redis Pub/Sub Publisher

**New file**: `apps/stt-v2/src/stt_v2/core/messaging/pubsub.py`

```python
class TranscriptionEventPublisher:
    """Publishes real-time transcription events to Redis Pub/Sub.

    Channel: stt:transcription:{job_id}

    Uses redis.asyncio for non-blocking I/O. Lazy-initialized
    per worker process (Dramatiq workers run in separate processes).
    """

    async def connect(self) -> None
    async def close(self) -> None

    async def publish_status(self, job_id, status, **kwargs) -> None
    async def publish_progress(self, job_id, progress, stage="") -> None
    async def publish_chunk(self, job_id, chunk: ChunkTranscriptionResult) -> None
    async def publish_transcript(self, job_id, result: TranscriptionResult) -> None
    async def publish_error(self, job_id, error_code, message) -> None
```

**Dependencies**: `redis[hiredis]` (already used by streaming module)

**Channel key**: `stt:transcription:{job_id}` — matches what the NestJS subscriber will listen to.

#### A3. Add Pub/Sub Settings

**File**: `apps/stt-v2/src/stt_v2/core/config/settings.py`

```python
# Real-time event publishing (Redis Pub/Sub)
pubsub_channel_prefix: str = Field(
    default="stt:transcription:",
    description="Redis Pub/Sub channel prefix for real-time transcription events",
)
pubsub_enabled: bool = Field(
    default=True,
    description="Enable Redis Pub/Sub publishing for real-time events",
)
```

#### A4. Wire Publisher in transcribe_file Worker

**File**: `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py`

Changes to `_transcribe_file_async()`:

1. Create and connect `TranscriptionEventPublisher` at start
2. After `start_job()` -> publish `status: PROCESSING`
3. Pass `chunk_callback` to `batch_service.transcribe()` that publishes each chunk
4. Pass `progress_callback` that publishes progress (alongside existing API callback)
5. Before `complete_job()` -> publish `transcript` event with full result
6. After `complete_job()` -> publish `status: COMPLETED`
7. On error -> publish `error` event before `fail_job()`
8. Close publisher in `finally` block

**Key code reference**: `BatchTranscriptionService.transcribe()` already supports `chunk_callback: Callable[[ChunkTranscriptionResult], None]` and `progress_callback: Callable[[int], None]` — we just need to wire them.

#### A5. Unit Tests

**New file**: `apps/stt-v2/tests/unit/test_pubsub_publisher.py`

- Test event serialization (status, progress, chunk, transcript, error)
- Test channel key construction
- Test publish with mocked Redis
- Test graceful handling when Redis is unavailable

**New file**: `apps/stt-v2/tests/unit/test_gateway_client_lifecycle.py`

- Test `start_job()`, `update_job_progress()`, `complete_job()`, `fail_job()`
- Test `create_transcript()` with updated signature
- Test error handling for each method

---

### Track B: `@arcaai/applications` Package — Service Modules

All new service logic. No changes to existing code.

#### B1. Create Event DTOs

**New file**: `packages/applications/src/services/stt/realtime/dto/transcription-events.ts`

```typescript
export enum TranscriptionEventType {
    STATUS = 'status',
    PROGRESS = 'progress',
    CHUNK = 'chunk',
    TRANSCRIPT = 'transcript',
    ERROR = 'error',
}

export interface TranscriptionStatusEvent {
    jobId: string;
    status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    timestamp: string;
    workerId?: string;
}

export interface TranscriptionProgressEvent {
    jobId: string;
    progress: number;
    stage?: string;
}

export interface TranscriptionChunkEvent {
    jobId: string;
    chunkIndex: number;
    text: string;
    startTime: number;
    endTime: number;
    isFinal: boolean;
    wordTimestamps?: Array<{
        word: string;
        start: number;
        end: number;
        confidence: number;
    }>;
}

export interface TranscriptionTranscriptEvent {
    jobId: string;
    text: string;
    language?: string;
    languageProbability?: number;
    durationSeconds: number;
    processingTimeSeconds: number;
    wordTimestamps: Array<{ word: string; startTime: number; endTime: number; confidence: number }>;
    sentenceTimestamps: Array<{ text: string; startTime: number; endTime: number }>;
    metadata: Record<string, unknown>;
}

export interface TranscriptionErrorEvent {
    jobId: string;
    errorCode: string;
    message: string;
}

export type TranscriptionEvent =
    | { type: TranscriptionEventType.STATUS; data: TranscriptionStatusEvent }
    | { type: TranscriptionEventType.PROGRESS; data: TranscriptionProgressEvent }
    | { type: TranscriptionEventType.CHUNK; data: TranscriptionChunkEvent }
    | { type: TranscriptionEventType.TRANSCRIPT; data: TranscriptionTranscriptEvent }
    | { type: TranscriptionEventType.ERROR; data: TranscriptionErrorEvent };
```

**New file**: `packages/applications/src/services/stt/realtime/dto/index.ts`

#### B2. Create Redis Subscriber Service

**New file**: `packages/applications/src/services/stt/realtime/redisSubscriber.service.ts`

A dedicated `ioredis` connection in subscriber mode. Redis requires that a connection in SUBSCRIBE mode cannot execute other commands, so this must be a separate connection from the cache service.

```typescript
@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
    private subscriber: Redis | null = null;
    private subscriptions = new Map<string, Subject<string>>();

    constructor(
        @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    ) {}

    async onModuleInit(): Promise<void>   // Connect subscriber Redis client
    async onModuleDestroy(): Promise<void> // Disconnect

    /**
     * Subscribe to a Redis channel. Returns an Observable that emits
     * each message published to that channel. Multiple callers can
     * subscribe to the same channel — they share the underlying
     * Redis subscription.
     */
    subscribeToChannel(channel: string): Observable<string>

    /**
     * Unsubscribe from a channel. If no more observers, removes
     * the Redis subscription.
     */
    unsubscribeFromChannel(channel: string): void
}
```

**Implementation notes**:
- Uses `ioredis` `subscriber.subscribe(channel)` and `subscriber.on('message', callback)`
- Per-channel `Subject<string>` dispatches messages to observers
- Reference counting: when last observer unsubscribes, calls `subscriber.unsubscribe(channel)`
- Uses `IConfigService.getRedisConfig()` for connection details (same pattern as `RedisCacheService`)

#### B3. Create Transcription Realtime Service

**New file**: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`

Orchestrates the full flow: job creation, Dramatiq dispatch, SSE stream assembly.

```typescript
@Injectable()
export class TranscriptionRealtimeService implements ITranscriptionRealtimeService {
    private readonly CHANNEL_PREFIX = 'stt:transcription:';

    constructor(
        private readonly redisSubscriber: RedisSubscriberService,
        private readonly transcriptionJobService: TranscriptionJobService,
        @Inject(IRedisCacheService) private readonly cacheService: IRedisCacheService,
    ) {}

    /**
     * Create a transcription job and return an SSE Observable.
     *
     * Flow:
     * 1. Create TranscriptionJob in DB (status: QUEUED)
     * 2. Dispatch Dramatiq message to stt_batch queue via Redis LPUSH
     * 3. Subscribe to Redis channel stt:transcription:{jobId}
     * 4. Emit initial { type: "status", data: { status: "QUEUED" } }
     * 5. Forward all Redis messages as SSE MessageEvent objects
     * 6. Complete Observable when COMPLETED or FAILED status received
     */
    async createAndStream(params: {
        tenantId: string;
        pipelineId: string;
        audioUri: string;
        consultationId?: string;
        mediaId?: string;
        createdBy?: string;
    }): Promise<{ jobId: string; events$: Observable<MessageEvent> }>

    /**
     * Subscribe to an existing job's SSE stream (reconnection).
     * Checks current job status first — if already terminal,
     * emits the final status and completes immediately.
     */
    subscribeToJob(jobId: string): Observable<MessageEvent>

    /**
     * Dispatch a Dramatiq message to the stt_batch queue.
     *
     * Dramatiq uses Redis lists: LPUSH dramatiq:stt_batch <message_json>
     * Then notifies via: PUBLISH dramatiq:__events__ stt_batch
     *
     * Message format matches Dramatiq's internal protocol.
     */
    private async dispatchDramatiqJob(params: {
        jobId: string;
        tenantId: string;
        pipelineId: string;
        audioUri: string;
        consultationId?: string;
        mediaId?: string;
    }): Promise<void>
}
```

**Dramatiq message format** (must match Python Dramatiq's internal protocol):
```json
{
    "queue_name": "stt_batch",
    "actor_name": "transcribe_file",
    "args": ["<job_id>", "<tenant_id>", "<pipeline_id>", "<audio_uri>", "<consultation_id>", "<media_id>"],
    "kwargs": {},
    "options": {},
    "message_id": "<uuid>",
    "message_timestamp": 1707580800000
}
```

**New file**: `packages/applications/src/services/stt/realtime/ITranscriptionRealtimeService.ts`

#### B4. Create Module and Update Exports

**New file**: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.module.ts`

```typescript
@Module({
    imports: [
        CoreDatabaseModule,
        EventEmitterModule,
        ClsModule,
        RedisCacheModule.register(),
        TranscriptionJobServiceModule,
    ],
    providers: [
        RedisSubscriberService,
        TranscriptionRealtimeService,
    ],
    exports: [TranscriptionRealtimeService, RedisSubscriberService],
})
export class TranscriptionRealtimeServiceModule {}
```

**New file**: `packages/applications/src/services/stt/realtime/index.ts`

**Update**: `packages/applications/src/services/stt/index.ts` — add `export * from './realtime'`

---

### Track C: API Gateway — Controller

Only controllers are declared in the API app. All service logic is in `@arcaai/applications`.

#### C1. Create Transcription Stream Controller

**New file**: `apps/api/src/controllers/stt-v2/transcriptionStream.controller.ts`

```typescript
@Controller('api/v1/transcription-jobs')
@UseGuards(JwtAuthGuard)
@ApiTags('Transcription Streaming')
export class TranscriptionStreamController {
    constructor(
        private readonly realtimeService: TranscriptionRealtimeService,
    ) {}

    /**
     * POST /api/v1/transcription-jobs/transcribe
     *
     * Upload audio file, create transcription job, return SSE stream.
     *
     * Request: multipart/form-data
     *   - file: audio file (required)
     *   - pipelineId: pipeline UUID or slug (required)
     *   - consultationId: optional consultation context
     *   - language: optional language hint
     *
     * Response: text/event-stream (SSE)
     *   Events: status, progress, chunk, transcript, error
     */
    @Post('transcribe')
    @UseInterceptors(FileInterceptor('file'))
    @Header('Content-Type', 'text/event-stream')
    @Header('Cache-Control', 'no-cache')
    @Header('Connection', 'keep-alive')
    async transcribeWithSSE(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: CreateTranscriptionStreamRequest,
        @ActiveUser() user: IActiveUserContext,
    ): Promise<Observable<MessageEvent>>

    /**
     * GET /api/v1/transcription-jobs/:jobId/stream
     *
     * Reconnect to an existing job's SSE stream.
     * If job is already completed/failed, returns final status immediately.
     */
    @Sse(':jobId/stream')
    @ApiOperation({ summary: 'SSE stream for transcription job updates' })
    streamJobUpdates(
        @Param('jobId') jobId: string,
    ): Observable<MessageEvent>
}
```

#### C2. Create Request DTO

**New file**: `apps/api/src/controllers/stt-v2/dto/create-transcription-stream.request.ts`

```typescript
export class CreateTranscriptionStreamRequest {
    @ApiProperty({ description: 'Pipeline UUID or slug' })
    @IsString()
    @IsNotEmpty()
    pipelineId: string;

    @ApiPropertyOptional({ description: 'Consultation ID to associate transcript with' })
    @IsString()
    @IsOptional()
    @IsUUID(7)
    consultationId?: string;

    @ApiPropertyOptional({ description: 'Language hint (e.g. "en", "ml")' })
    @IsString()
    @IsOptional()
    language?: string;
}
```

#### C3. Update SttV2Module

**File**: `apps/api/src/controllers/stt-v2/stt-v2.module.ts`

Add:
- Import `TranscriptionRealtimeServiceModule` from `@arcaai/applications`
- Add `TranscriptionStreamController` to controllers array

---

## Implementation Order

Tracks A and B/C are **independent** and can proceed in parallel.

### Track A (STT-v2 Python) — estimated 5 tasks:

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| A1 | Fix gateway client | None | `gateway.py` |
| A2 | Add pub/sub settings | None | `settings.py` |
| A3 | Create event publisher | A2 | `pubsub.py` (new) |
| A4 | Wire publisher in worker | A1, A3 | `transcribe_file.py` |
| A5 | Unit tests | A1-A4 | `test_pubsub_publisher.py`, `test_gateway_client_lifecycle.py` (new) |

### Track B+C (NestJS TypeScript) — estimated 5 tasks:

| # | Task | Dependencies | Files |
|---|------|-------------|-------|
| B1 | Event DTOs | None | `dto/transcription-events.ts` (new) |
| B2 | Redis subscriber service | None | `redisSubscriber.service.ts` (new) |
| B3 | Realtime service | B1, B2 | `transcriptionRealtime.service.ts` (new) |
| B4 | Module + exports | B1-B3 | `*.module.ts`, `index.ts` files |
| C1-C3 | Controller + module update | B4 | `transcriptionStream.controller.ts` (new), `stt-v2.module.ts` |

### Integration Testing (after both tracks):

1. Start API + STT-v2 + Redis + MinIO + PostgreSQL
2. Upload audio via `POST /api/v1/transcription-jobs/transcribe`
3. Verify SSE event sequence: `status:QUEUED` -> `status:PROCESSING` -> `chunk` x N -> `progress` x N -> `transcript` -> `status:COMPLETED`
4. Test reconnection via `GET /api/v1/transcription-jobs/:jobId/stream`
5. Test error flow: invalid pipeline -> `error` event -> `status:FAILED`

---

## Key Code References

### STT-v2 (Python)

| File | Relevance |
|------|-----------|
| `apps/stt-v2/src/stt_v2/transcription/batch_service.py` | `BatchTranscriptionService.transcribe()` — supports `chunk_callback` and `progress_callback` |
| `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py` | Dramatiq actor — job lifecycle, needs publisher wiring |
| `apps/stt-v2/src/stt_v2/core/api_client/gateway.py` | HTTP client — needs lifecycle methods added |
| `apps/stt-v2/src/stt_v2/core/messaging/broker.py` | Redis connection for Dramatiq — reuse `redis_url` for pub/sub |
| `apps/stt-v2/src/stt_v2/streaming/redis_streams.py` | Reference for `redis.asyncio` patterns |
| `apps/stt-v2/src/stt_v2/transcription/dto.py` | `ChunkTranscriptionResult`, `TranscriptionResult` — event payloads |

### API Gateway (NestJS)

| File | Relevance |
|------|-----------|
| `packages/applications/src/services/stt/internal/sttInternal.service.ts` | `SttInternalService` — job lifecycle methods (start, progress, complete, fail) |
| `packages/applications/src/services/stt/internal/dto/internal.request.ts` | DTOs for internal API requests |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | Reference pattern for Redis pub/sub + SSE |
| `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` | `IRedisCacheService` — `publish()` method, connection pattern |
| `apps/api/src/modules/consultation/job.controller.ts` | Reference SSE implementation with `@Sse()` |
| `apps/api/src/controllers/stt-v2/stt-v2.module.ts` | Module to update with new imports |
| `apps/api/src/controllers/stt-v2/sttInternal.controller.ts` | Internal endpoints called by STT-v2 |

### Prisma Schema

| Model | Relevance |
|-------|-----------|
| `TranscriptionJob` | Job record with `status`, `progress`, `resultText`, `resultMetadata` |
| `AsrPipeline` | Pipeline config referenced by `pipelineId` |

---

## Relationship to Other Tasks

| Task | Relationship |
|------|-------------|
| **TASK-014** (Streaming Architecture) | TASK-014 designs the WebSocket-based real-time streaming for live audio. TASK-015 is the simpler batch-upload + SSE flow. Both share the Redis Pub/Sub pattern but serve different use cases. |
| **Track 1** (Batch API Endpoint) | Completed in this session. `POST /api/v1/transcribe` exposes `BatchTranscriptionService` directly over HTTP. TASK-015 adds the Dramatiq-based flow with SSE delivery on top. |
| **STT-003** (Python Service Implementation) | Original STT-v2 service implementation. TASK-015 extends it with pub/sub publishing. |

---

## Change History

### 2026-02-10 — Initial Documentation

- Created TASK-015 documentation
- Completed architecture design with SSE event schema
- Defined implementation plan across 3 tracks (A: Python, B: TypeScript services, C: API controllers)
- Identified gateway client mismatch and designed fix
- Designed Redis Pub/Sub pattern following existing `ConsultationJobService` precedent

### 2026-02-10 — Track 1 Completed (Batch API Endpoint)

- Created `POST /api/v1/transcribe` endpoint in `stt-v2/transcription/api/`
- New files: `schemas.py`, `routes.py`, `__init__.py`
- Registered `transcription_router` in `main.py`
- 21 unit tests passing (`test_transcription_api.py`)

### 2026-02-10 — Track B+C Completed (NestJS Services + API Controller)

**Track B: `@arcaai/applications` package — 4 tasks completed**

- **B1**: Created event DTOs — `TranscriptionEventType` enum, discriminated union `TranscriptionEvent` with 5 event types (status, progress, chunk, transcript, error), and supporting interfaces (`WordTimestamp`, `SentenceTimestamp`)
  - New: `packages/applications/src/services/stt/realtime/dto/transcription-events.ts`
  - New: `packages/applications/src/services/stt/realtime/dto/index.ts`

- **B2**: Created `RedisSubscriberService` — dedicated `ioredis` connection in subscriber mode, per-channel RxJS Subject dispatch, reference counting for auto-cleanup, `subscribeToChannel()` returns `Observable<string>`, graceful handling when Redis unavailable
  - New: `packages/applications/src/services/stt/realtime/redisSubscriber.service.ts`

- **B3**: Created `TranscriptionRealtimeService` + interface — orchestrates job creation → Dramatiq dispatch (Redis LPUSH) → Redis Pub/Sub subscription → SSE Observable assembly. Supports `createAndStream()` for new jobs and `subscribeToJob()` for reconnection. Auto-completes stream on terminal status.
  - New: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`
  - New: `packages/applications/src/services/stt/realtime/ITranscriptionRealtimeService.ts`

- **B4**: Created module + exports — `TranscriptionRealtimeServiceModule` imports CoreDatabaseModule, RedisCacheModule, TranscriptionJobServiceModule. Added `rxjs` as peer dependency to `@arcaai/applications`.
  - New: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.module.ts`
  - New: `packages/applications/src/services/stt/realtime/index.ts`
  - Modified: `packages/applications/src/services/stt/index.ts` (added `export * from './realtime'`)
  - Modified: `packages/applications/package.json` (added `rxjs` peer dependency)

**Track C: API Gateway — 3 tasks completed**

- **C1**: Created `TranscriptionStreamController` with two endpoints:
  - `POST /api/v1/transcription-jobs/transcribe` — multipart file upload + SSE stream. Uses `FileInterceptor`, `JwtAuthGuard`, `ClsService` for tenant context. Full Swagger documentation with `@ApiConsumes`, `@ApiBody` schema.
  - `GET /api/v1/transcription-jobs/:jobId/stream` — SSE reconnection endpoint using `@Sse()` decorator. Returns `Observable<MessageEvent>`.
  - New: `apps/api/src/controllers/stt-v2/transcriptionStream.controller.ts`

- **C2**: Created request DTO with `class-validator` decorators (pipelineId required, consultationId optional UUID, language optional)
  - New: `apps/api/src/controllers/stt-v2/dto/create-transcription-stream.request.ts`
  - New: `apps/api/src/controllers/stt-v2/dto/index.ts`

- **C3**: Updated `SttV2Module` — imported `TranscriptionRealtimeServiceModule`, registered `TranscriptionStreamController`
  - Modified: `apps/api/src/controllers/stt-v2/stt-v2.module.ts`
  - Modified: `apps/api/src/controllers/stt-v2/index.ts`

**Verification**: Both `@arcaai/applications` (`pnpm build`) and `apps/api` (`tsc --noEmit`) compile with zero errors.

### 2026-02-10 — Track A Completed (STT-v2 Real-Time Event Publishing)

**A1: Fixed Gateway Client** (`core/api_client/gateway.py`)
- Added 4 new lifecycle methods matching NestJS `SttInternalController` endpoints:
  - `start_job(job_id, worker_id)` → `PATCH /internal/stt/jobs/{id}/start`
  - `update_job_progress(job_id, progress)` → `PATCH /internal/stt/jobs/{id}/progress`
  - `complete_job(job_id, result_text, result_metadata)` → `PATCH /internal/stt/jobs/{id}/complete`
  - `fail_job(job_id, error_message, error_code)` → `PATCH /internal/stt/jobs/{id}/fail`
- Updated `create_transcript()` signature to match NestJS `CreateTranscriptRequest` DTO:
  `create_transcript(job_id, transcript_text, metadata, consultation_id)`
- Kept legacy `update_job_status()` for backward compatibility

**A2: Added Pub/Sub Settings** (`core/config/settings.py`)
- `pubsub_channel_prefix`: defaults to `stt:transcription:` (matches NestJS subscriber)
- `pubsub_enabled`: defaults to `True` (can be disabled via `PUBSUB_ENABLED=false`)

**A3: Created TranscriptionEventPublisher** (`core/messaging/pubsub.py` — new file)
- Uses `redis.asyncio` for non-blocking Redis Pub/Sub
- Publishes 5 event types: `status`, `progress`, `chunk`, `transcript`, `error`
- Channel: `stt:transcription:{job_id}` — per-job isolation
- Best-effort design: silently degrades when Redis unavailable
- Lazy connection per worker invocation, cleaned up in `finally` block
- Event payloads use camelCase keys to match NestJS SSE schema

**A4: Wired Publisher in Worker** (`transcription/workers/transcribe_file.py`)
- Publisher created and connected at start of `_transcribe_file_async()`
- After `start_job()` → publishes `status: PROCESSING`
- `chunk_callback` wired to `batch_service.transcribe()` → publishes each `chunk` event
- `progress_callback` now also publishes `progress` events (alongside API call)
- Before `complete_job()` → publishes `transcript` event with full result
- After `complete_job()` → publishes `status: COMPLETED`
- On error → publishes `error` event, then `status: FAILED`
- Publisher closed in `finally` block

**A5: Unit Tests** (2 new test files, 37 tests)
- `test_gateway_client_lifecycle.py` (14 tests): payload construction, boundary values, error propagation, optional field handling
- `test_pubsub_publisher.py` (23 tests): event serialization, channel keys, connection lifecycle, graceful degradation, settings integration
- Updated existing `test_api_client.py` and `test_workers.py` for new signatures
- **Total: 122 tests passing** (37 new + 85 existing, all green)

### 2026-02-11 — Track B Completed (`@arcaai/applications` Service Modules)

Implemented all Track B tasks (B1–B4) in the `@arcaai/applications` package.

**B1 — Event DTOs** (`packages/applications/src/services/stt/realtime/dto/`):
- `transcription-events.ts` — `TranscriptionEventType` enum, 5 event data interfaces (`TranscriptionStatusEvent`, `TranscriptionProgressEvent`, `TranscriptionChunkEvent`, `TranscriptionTranscriptEvent`, `TranscriptionErrorEvent`), and `TranscriptionEvent` discriminated union
- `index.ts` — barrel export

**B2 — RedisSubscriberService** (`packages/applications/src/services/stt/realtime/redisSubscriber.service.ts`):
- Dedicated `ioredis` connection for Redis SUBSCRIBE mode (separate from RedisCacheService)
- Per-channel `Subject<string>` dispatches messages to observers
- Reference counting: auto-cleanup Redis subscription when last observer unsubscribes
- `subscribeToChannel(channel): Observable<string>` — returns RxJS Observable per channel
- `unsubscribeFromChannel(channel)` — forced cleanup for explicit teardown
- `OnModuleInit`/`OnModuleDestroy` lifecycle management
- Follows existing `RedisCacheService` patterns (IConfigService, connection timeouts, structured logging)

**B3 — TranscriptionRealtimeService** (`packages/applications/src/services/stt/realtime/`):
- `ITranscriptionRealtimeService.ts` — service interface with `createAndStream()` and `subscribeToJob()` methods
- `transcriptionRealtime.service.ts` — full implementation:
  - `createAndStream()`: creates job → dispatches Dramatiq message → subscribes to Redis channel → returns SSE Observable
  - `subscribeToJob()`: reconnection support — checks current status, subscribes if in-progress, emits final status if terminal
  - `dispatchDramatiqJob()`: Redis-based Dramatiq message dispatch (LPUSH + notification)
  - `buildEventStream()`: assembles SSE Observable from Redis Pub/Sub with initial QUEUED event, timeout safety net, and auto-cleanup
  - Terminal status detection for clean stream completion (COMPLETED, FAILED, CANCELLED, DEAD)

**B4 — Module + Exports**:
- `transcriptionRealtime.service.module.ts` — NestJS module importing `CoreDatabaseModule`, `EventEmitterModule`, `ClsModule`, `RedisCacheModule`, `TranscriptionJobServiceModule`; exports `TranscriptionRealtimeService` and `RedisSubscriberService`
- `realtime/index.ts` — barrel export for the entire realtime module
- Updated `stt/index.ts` — added `export * from './realtime'`

**Files created** (6 new):
- `packages/applications/src/services/stt/realtime/dto/transcription-events.ts`
- `packages/applications/src/services/stt/realtime/dto/index.ts`
- `packages/applications/src/services/stt/realtime/redisSubscriber.service.ts`
- `packages/applications/src/services/stt/realtime/ITranscriptionRealtimeService.ts`
- `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`
- `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.module.ts`
- `packages/applications/src/services/stt/realtime/index.ts`

**Files modified** (1):
- `packages/applications/src/services/stt/index.ts` — added `export * from './realtime'`

### 2026-02-11 — Track B Enhancement: LPUSH Fix + Unit Tests

**Fixed Dramatiq dispatch limitation**:
- Added `lpush(key, value): Promise<number>` to `IRedisCacheService` interface and `RedisCacheService` implementation
- Updated `TranscriptionRealtimeService.dispatchDramatiqJob()` to use `cacheService.lpush()` for proper Redis list enqueue (Dramatiq workers consume via BRPOP)
- `cacheService.publish()` is now used only for the `dramatiq:__events__` notification channel (correct separation of concerns)

**Files modified** (1):
- `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` — added `lpush()` to interface + implementation

**Unit tests** (3 new test files, 102 new tests):

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `redisSubscriber.service.test.ts` | 33 | Connection lifecycle, event handler registration, channel subscribe/unsubscribe, message dispatch, reference counting, shared subscriptions, re-subscription after cleanup, graceful degradation |
| `transcriptionRealtime.service.test.ts` | 35 | createAndStream flow (job creation, LPUSH dispatch, notification publish), subscribeToJob reconnection (terminal/in-progress/not-found), SSE stream behavior (chunk forwarding, auto-complete on terminal status, malformed messages, cleanup), Dramatiq message format validation (args order, field presence, queue key), lpush vs publish separation |
| `transcription-events.test.ts` | 27 | Enum values, event serialization/deserialization (all 5 types), optional field handling, type narrowing via switch, boundary values (0%/100% progress, empty text, startTime 0, all status values) |
| `redis-cache.service.test.ts` (updated) | +7 | lpush disconnected fallback, lpush not called when disconnected, lpush in graceful fallback suite |

**Total: 2590 tests passing** across 90 test files (zero regressions)

### 2026-02-11 — Code Review Fixes (6 issues resolved)

**Context**: Post-implementation code review identified 1 critical issue, 5 recommendations. All fixed.

#### Critical Fix: Dramatiq Message Dispatch Protocol

**File**: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`

The original implementation used `LPUSH dramatiq:stt_batch <full_json>` to dispatch messages. Dramatiq's RedisBroker protocol requires:

1. `HSET dramatiq:stt_batch.msgs <message_id> <encoded_json>` — store payload in hash
2. `RPUSH dramatiq:stt_batch <message_id>` — push message ID to queue
3. `PUBLISH dramatiq:__events__ stt_batch` — notify workers

Workers `BRPOP` the queue to get a message ID, then `HMGET` from the `.msgs` hash to retrieve the payload. The old approach caused workers to receive the raw JSON as if it were a key, find nothing in the hash, and silently discard the message.

Also added `redis_message_id` to `options` (a separate UUID from `message_id`) as required by Dramatiq protocol.

**Files modified**:
- `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` — added `rpush()` and `hset()` to `IRedisCacheService` interface + implementation
- `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts` — rewrote `dispatchDramatiqJob()` to use HSET+RPUSH protocol

#### Fix: Terminal Status Check Missing CANCELLED/DEAD

**File**: `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`

`buildSseStream()` only checked `['COMPLETED', 'FAILED']` for stream termination. The domain enum `TranscriptionJobStatus` includes `CANCELLED` and `DEAD`. If a job was cancelled/dead while streaming, the SSE connection would hang.

**Fix**: Changed to `['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD']` in both `buildSseStream()` and `subscribeToJob()`.

#### Fix: Redis Subscription Race Condition

**File**: `packages/applications/src/services/stt/realtime/redisSubscriber.service.ts`

`subscribeToChannel()` was synchronous — it called `this.subscriber.subscribe(channel)` via fire-and-forget `.then()`. The Observable was returned before the Redis SUBSCRIBE command completed, creating a window where early events could be missed.

**Fix**: Changed `subscribeToChannel()` to `async subscribeToChannel()` that returns `Promise<Observable<string>>`. The Redis SUBSCRIBE command is now awaited, ensuring the subscription is active before any dispatch occurs. All callers updated to `await`.

#### Fix: Word Timestamp Naming Consistency

**File**: `apps/stt-v2/src/stt_v2/core/messaging/pubsub.py`

`publish_transcript()` used `startTime`/`endTime` for word timestamps, but the TypeScript `WordTimestamp` interface uses `start`/`end`. Chunk word timestamps already used `start`/`end`.

**Fix**: Unified `publish_transcript()` to use `start`/`end` for word timestamps, matching both the TS interface and chunk events.

#### Fix: Fire-and-Forget Event Ordering

**File**: `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py`

`asyncio.create_task()` for chunk/progress callbacks were fire-and-forget. After `transcribe()` returned, the code immediately published the final `transcript` and `status: COMPLETED` events. Pending tasks could finish after the terminal events, causing out-of-order delivery.

**Fix**: Collected all callback tasks in `_pending_tasks` list and `await asyncio.gather(*_pending_tasks)` before publishing the final transcript event.

#### Fix: Publisher Close Error Logging

**File**: `apps/stt-v2/src/stt_v2/core/messaging/pubsub.py`

`close()` silently swallowed exceptions with `except Exception: pass`.

**Fix**: Now logs warnings on failure: `logger.warning("Failed to close Redis Pub/Sub connection", error=str(exc))`.

**Files created**: None
**Files modified** (5):
- `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` — added `rpush()`, `hset()` to interface + implementation
- `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts` — HSET+RPUSH protocol, terminal statuses, async subscribe
- `packages/applications/src/services/stt/realtime/redisSubscriber.service.ts` — `subscribeToChannel()` now async
- `apps/stt-v2/src/stt_v2/core/messaging/pubsub.py` — word timestamp naming, close() logging
- `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py` — await pending callback tasks

**Test files updated** (3):
- `packages/applications/src/services/stt/realtime/__tests__/transcriptionRealtime.service.test.ts` — HSET+RPUSH assertions, CANCELLED/DEAD terminal tests (48 tests)
- `packages/applications/src/services/stt/realtime/__tests__/redisSubscriber.service.test.ts` — async subscribeToChannel (44 tests)
- `packages/applications/src/services/baseServices/redis/__tests__/redis-cache.service.test.ts` — rpush/hset tests (35 tests)

**Verification**: TypeScript compiles with zero errors (`tsc --noEmit`). All 125 realtime module tests pass. All 35 Redis cache tests pass. All 82 Python unit tests pass.
