# Communication Patterns

The HOPE platform uses multiple communication patterns to balance low-latency interactions with reliable asynchronous processing. This document covers the protocols, data flows, and integration patterns between services.

## Communication Overview

| Pattern | Technology | Use Case |
|---------|-----------|----------|
| Synchronous HTTP | REST (NestJS ↔ FastAPI) | Simple CRUD, fast AI operations |
| Asynchronous Job Queue | Redis + BullMQ | Long-running AI tasks (summary, NER) |
| Real-Time Streaming | WebSocket (WS / Socket.IO) | Live STT audio streaming |
| Server-Sent Events | SSE | Job progress notifications |
| Event Broadcasting | EventEmitter2 + Redis Pub/Sub | Audit logging, system events |

## Service Communication Map

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (SDK / Browser)                         │
│    REST ──────────────┐  WebSocket ───────┐  SSE ──────────────┐       │
└───────────────────────┼───────────────────┼────────────────────┼───────┘
                        │                   │                    │
                        ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                API GATEWAY (NestJS :8868)                               │
│                                                                         │
│  Controllers ──► Application Services ──► Domain Repositories           │
│       │                   │                                             │
│       │     ┌─────────────┼─────────────┐                              │
│       │     │             │             │                              │
│       ▼     ▼             ▼             ▼                              │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐                     │
│  │ Job Queue  │   │  Redis     │   │  Audit Log │                     │
│  │ Service    │   │  Cache     │   │  Service   │                     │
│  │ (BullMQ)   │   │  Service   │   │ (Events)   │                     │
│  └─────┬──────┘   └────────────┘   └────────────┘                     │
└────────┼──────────────────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│ Redis  │ │PostgreSQL│
│Queues  │ │AuditLog │
└────┬───┘ └────────┘
     │
     ▼ (Workers dequeue)
┌─────────────────────────────────────────────────────────────────────────┐
│                     PYTHON MICROSERVICES                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │STT v2:8861│  │ SMR :8862│  │Guard:8863│  │ NLP :8864│               │
│  │ WebSocket│  │ HTTP     │  │ HTTP     │  │ HTTP     │               │
│  │ HTTP     │  │          │  │          │  │          │               │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘               │
│  Harness :8866 (FastAPI + Temporal) orchestrates the above as tools.   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Synchronous HTTP Communication

Used for fast, request-response operations where the client waits for a result.

```text
Client ──POST──► API Gateway ──POST──► Python Service
  │                                        │
  │◄──────── JSON Response ────────────────┘
```

**Examples:**
- `POST /api/consultations/open` — Create or retrieve a consultation
- `POST /api/consultations/:id/summary/pre-summary` — Synchronous pre-summary generation
- `GET /api/consultations/:id/context` — Retrieve context items

## Asynchronous Job Queue

Used for long-running AI processing tasks. The API enqueues a job to Redis (BullMQ) and returns a job ID immediately. Workers process the job in the background.

### Job Lifecycle

```text
1. Client ──POST /summary/async──► API Gateway
2. API ──enqueue──► Redis/BullMQ Queue
3. API ──return { jobId, sseUrl }──► Client
4. Client ──connects──► SSE endpoint (GET /jobs/{jobId}/sse)
5. Worker ──dequeue──► process ──HTTP──► Python Service
6. Worker ──publish progress──► Redis Pub/Sub
7. SSE ──stream updates──► Client
8. Worker ──save result──► PostgreSQL
9. SSE ──send COMPLETED──► Client closes connection
```

### Available Queues

| Queue | Purpose |
|-------|---------|
| `SpeechToText` | Audio transcription jobs |
| `GeneratePreSummary` | Case note summarization |
| `GenerateSummary` | Full consultation summary |
| `ExtractNamedEntities` | Medical NER extraction |
| `AuditLog` | Async audit log persistence |
| `SysEvent` | System event processing |
| `UserActivity` | User activity tracking |
| `SendEmail` / `SendSms` | Notification delivery |

### Job Status Values

| Status | Description |
|--------|-------------|
| `PENDING` | Queued, waiting for a worker |
| `RUNNING` | Being processed |
| `COMPLETED` | Finished successfully (result in response) |
| `FAILED` | Processing error (error details in response) |
| `CANCELLED` | Cancelled by user |

### SSE Client Integration

**Important:** The native `EventSource` API does not support custom HTTP headers (Authorization, X-API-Key). For authenticated SSE connections, use `fetch` with `ReadableStream` instead:

```typescript
// Authenticated SSE via fetch + ReadableStream
const res = await fetch(`/api/consultations/jobs/${jobId}/sse`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'text/event-stream',
  },
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      const status = JSON.parse(data);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.status)) break;
    }
  }
}
reader.releaseLock();
```

### SSE Heartbeat

The SMR proxy controller sends `:keepalive\n\n` SSE comments every 15 seconds to prevent proxy/load balancer timeouts. Clients should ignore lines starting with `:` (SSE comment syntax).

## WebSocket Communication

Used for real-time audio streaming between the client, API Gateway, and STT service.

```text
Client ──WebSocket──► API Gateway ──Redis Streams──► STT Service
  │                        │                              │
  │◄───Transcript──────────┼◄───Redis Streams─────────────┘
  │◄───Partial results─────┼◄───Redis Streams─────────────┘
```

The STT service supports both batch (HTTP upload) and streaming (WebSocket) modes. WebSocket enables live transcription with partial results as the user speaks.

### WebSocket Gateway (`SttWsGateway`)

**Path:** `/ws/stt-v2/stream`

The API Gateway's WebSocket gateway bridges client connections to the STT-V2 service via Redis Streams:

1. Client connects with `?sessionId=...` query parameter
2. Client sends `{ type: "auth", token: "Bearer ..." }` after connection opens
3. Client sends binary PCM audio frames (Int16 LE mono, 16kHz) as `ArrayBuffer`
4. Gateway writes audio frames to Redis Stream `audio:{sessionId}`
5. STT-V2 service reads from Redis Stream, processes audio, publishes results
6. Gateway subscribes to results Redis Stream, forwards transcript segments to client

**Protocol Messages:**

| Direction | Message | Format |
|-----------|---------|--------|
| Client → Server | Auth | `{ type: "auth", token: string }` |
| Client → Server | Audio (binary) | `ArrayBuffer` (Int16 LE mono PCM) |
| Client → Server | Audio (JSON) | `{ type: "audio", seq, data: base64 }` |
| Client → Server | Stop | `{ type: "stop" }` |
| Client → Server | Close | `{ type: "close" }` |
| Server → Client | Transcript | `{ type: "transcript", text, isFinal, startTime?, endTime? }` |
| Server → Client | Status | `{ type: "status", status, message }` |
| Server → Client | Error | `{ type: "error", code, message }` |

### Audio Format

The preferred audio format is **binary PCM Int16 LE mono at 16kHz**, sent directly as `ArrayBuffer` over WebSocket. This is ~37% more efficient than the legacy base64 JSON encoding. The gateway accepts both formats.

Audio capture uses `AudioWorkletNode` (replacing the deprecated `ScriptProcessorNode`) to process audio on the audio thread, avoiding main-thread jank.

## SMR Streaming (Summary Generation)

The SMR service supports streaming text generation via SSE, proxied through the API Gateway:

```text
1. Client ──POST /text/generate { stream: true }──► API Gateway ──► SMR Service
2. API ──return { task_id, stream_url }──► Client
3. Client ──GET /text/tasks/:task_id/stream──► API Gateway ──► SMR Service
4. SMR ──SSE chunks──► API Gateway ──SSE chunks + heartbeat──► Client
```

### API Gateway SMR Proxy Features

| Feature | Description |
|---------|-------------|
| **SSE Heartbeat** | `:keepalive\n\n` every 15 seconds prevents proxy timeouts |
| **Retry with backoff** | Transient errors (ECONNREFUSED, 502, 503, 504) retry up to 2 times |
| **Stream timeout** | 300 seconds for long-running generation tasks |
| **Auth passthrough** | JWT auth validated at gateway, service token forwarded to SMR |

### SSE Stream Format

```text
data: {"content":"Clinical ","index":0}
data: {"content":"Summary\n","index":1}
:keepalive
data: {"content":"Patient:","index":2}
data: {"usage":{"total_tokens":450}}
data: [DONE]
```

---

## Redis Architecture

Redis serves five distinct roles in the platform:

### 1. Job Queues (BullMQ)

BullMQ manages reliable job processing with retry logic, progress tracking, and dead-letter queues.

### 2. Application Cache

```text
Cache Key Patterns:
  policy:ability:{userId}:{tenantId}  — RBAC ability cache (TTL: 5 min)
  session:{sessionId}                 — User session data
  api:{endpoint}:{hash}              — API response cache
  consultation_job:{jobId}           — Job status cache
```

### 3. Rate Limiting

| Endpoint Category | Limit |
|-------------------|-------|
| General API | 100 req/min |
| STT requests | 10 req/min |
| Summary generation | 20 req/min |

### 4. Pub/Sub

Real-time notifications for job progress updates:

```text
Channel: consultation_job_updates:{jobId}
Payload: { status, progress, currentStep, timestamp }
```

### 5. Authorization Audit

Real-time publishing of authorization decisions for security monitoring:

```text
Channel: authorization:audit
Payload: { userId, action, subject, allowed, timestamp }
```

## Event-Driven Architecture

### Internal Events (EventEmitter2)

Services emit events through NestJS's `EventEmitter2` module. The `BaseService` class provides a `broadcastSysEvent()` method that automatically attaches user context, tenant ID, and correlation ID.

```text
Service Operation
    │
    ├──► broadcastSysEvent(SysEventType.ResourceCreated, { ... })
    │
    ▼
EventEmitter2
    │
    ├──► SysEventService (listener)
    │       ├──► Queue AuditLogJob to Redis
    │       ├──► Queue UserActivityJob to Redis
    │       └──► Queue SysEventJob to Redis
    │
    └──► AuditLogService (listener)
            └──► Persist AuditLog to PostgreSQL
```

### System Event Types

| Event | Trigger |
|-------|---------|
| `ResourceCreated` | New entity persisted |
| `ResourceViewed` | Entity accessed |
| `ResourceUpdated` | Entity modified |
| `ResourceDeleted` | Entity soft-deleted |
| `ResourceArchived` | Entity archived |

## Consultation Workflow

The consultation module orchestrates the complete medical conversation lifecycle:

```text
1. OPEN CONSULTATION ──────────────────────────────────────────────────
   POST /consultations/open
   Get-or-create by natural key (tenant, patient, date, doctor)

2. RECORD AUDIO ───────────────────────────────────────────────────────
   POST /consultations/:id/context (type: AUDIO_RECORDING)
   Create audio container with media reference

3. TRANSCRIPTION ──────────────────────────────────────────────────────
   POST /consultations/:id/context (type: TRANSCRIPT)
   STT service processes audio → text

4. ADD CASE NOTES ─────────────────────────────────────────────────────
   POST /consultations/:id/context (type: CASE_NOTE)
   User-provided context, shared across consultation chain

5. GENERATE PRE-SUMMARY ───────────────────────────────────────────────
   POST /consultations/:id/summary/pre-summary
   SMR service summarizes case notes

6. GENERATE FINAL SUMMARY ─────────────────────────────────────────────
   POST /consultations/:id/summary
   SMR service combines transcript + pre-summary + context

7. EXTRACT NAMED ENTITIES ─────────────────────────────────────────────
   POST /consultations/:id/summary/:contextItemId/extract-entities
   NLP service identifies medications, conditions, symptoms

8. USER EDITS ─────────────────────────────────────────────────────────
   PATCH /consultations/:id/context/:contextId
   Creates version snapshot, logs activity, marks for vector sync
```

Each step supports both synchronous and asynchronous execution. Async endpoints return a `jobId` for SSE-based progress tracking.

## Gateway Enforcement

All client-side communication must pass through the API gateway (NestJS :8868). Direct access to backend services is prohibited.

### Enforced Communication Path

```text
Client (SDK / Browser)
    │
    ├── REST ────────► API Gateway (:8868) ──► Python Services
    ├── WebSocket ───► API Gateway (:8868) ──► STT-V2 (via Redis Streams)
    └── SSE ─────────► API Gateway (:8868) ──► SMR / Job Status
```

### Why Gateway-Only

| Concern | Gateway Provides | Direct Access Lacks |
|---------|-----------------|-------------------|
| Authentication | JWT / API Key validation | None — services trust internal network |
| Authorization | CASL RBAC policy evaluation | None — no permission checks |
| Tenant Isolation | `tenantId` scoping on all queries | None — cross-tenant access possible |
| Rate Limiting | Per-user/tenant sliding window | None — unlimited requests |
| Audit Logging | All operations logged to PostgreSQL | None — no audit trail |
| Retry / Resilience | Exponential backoff for transient errors | Client must implement own retry |

### SMR Proxy Routes

The `SmrProxyController` (`@Controller('text')`) proxies all SMR requests with JWT authentication:

| Client Path | Gateway Proxies To | Auth |
|-------------|-------------------|------|
| `/text/generate` | `SMR_SERVICE_URL/api/v2/generate` | JWT |
| `/text/tasks/:id` | `SMR_SERVICE_URL/api/v2/tasks/:id` | JWT |
| `/text/tasks/:id/cancel` | `SMR_SERVICE_URL/api/v2/tasks/:id/cancel` | JWT |
| `/text/tasks/:id/stream` | `SMR_SERVICE_URL/api/v2/tasks/:id/stream` (SSE) | JWT |
| `/text/providers` | `SMR_SERVICE_URL/api/v2/providers` | JWT |
| `/text/guardrail-providers` | Gateway-resolved tenant guardrail catalog | JWT |
| `/text/health` | `SMR_SERVICE_URL/api/v2/health` | JWT |

> **SMR → Guardrail (service-to-service):** Independently of the gateway proxy, the SMR service calls the Guardrail service per generate via `ExternalGuardrailClient` → `POST GUARDRAIL_URL/api/medical/validate` (forwarding `X-Service-Token` and `X-Tenant-Id`) when `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=true`.

### Vite Dev Proxy Configuration

During development, the Vite dev server proxies all requests to the API gateway:

```typescript
// vite.config.ts — correct configuration
proxy: {
    '/api': { target: 'http://localhost:8868', changeOrigin: true },
    '/ws':  { target: 'http://localhost:8868', changeOrigin: true, ws: true },
}
```

> **Anti-pattern**: Never add proxy rules that route directly to backend services (e.g., `/api/v2` → `:8862`). This bypasses all gateway security.

## Multi-Tab Connection Management

When users open multiple browser tabs, each tab traditionally creates its own WebSocket and SSE connections. The SDK provides a `SharedWorker`-based solution to multiplex connections:

```text
┌─────────┐  ┌─────────┐  ┌─────────┐
│  Tab 1  │  │  Tab 2  │  │  Tab 3  │
│ Manager │  │ Manager │  │ Manager │
└────┬────┘  └────┬────┘  └────┬────┘
     │ MessagePort │            │
     └──────┬──────┴────────────┘
            │
   ┌────────▼────────┐
   │  SharedWorker   │    1 connection per endpoint
   │  SSE: job-123   │──────► API Gateway
   │  WS:  stt-456   │──────► API Gateway
   └─────────────────┘
```

| Without SharedWorker | With SharedWorker |
|---------------------|------------------|
| 3 tabs × 2 SSE = 6 connections | 2 SSE connections total |
| 3 tabs × 1 WS = 3 connections | 1 WS connection total |
| Server handles 9 connections | Server handles 3 connections |

When `SharedWorker` is unavailable (unsupported browser, non-HTTPS), the SDK falls back to per-tab connections with an identical API surface.

See [Streaming Architecture](../agentic-sdk-v2/streaming.md) for implementation details and React hook usage.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| **Redis unavailable** | Job queues return 503; caching falls back to database; rate limiting fails open; SSE falls back to polling |
| **PostgreSQL unavailable** | API returns 503; audit events queue in memory with retry |
| **Python service unavailable** | Job processing retries with exponential backoff (3 attempts); direct calls return 502 |

## API Endpoint Summary

### Consultation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/open` | Get or create consultation |
| POST | `/api/consultations/:parentId/revisit` | Create follow-up visit |
| GET | `/api/consultations/:id/chain` | Get consultation chain |

### Context Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/:id/context` | Add context item |
| GET | `/api/consultations/:id/context` | List context items |
| PATCH | `/api/consultations/:id/context/:contextId` | Update with versioning |
| GET | `/api/consultations/:id/context/shared` | Shared context from chain |

### Summary Endpoints (Sync + Async)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/:id/summary/pre-summary` | Pre-summary (sync) |
| POST | `/api/consultations/:id/summary/pre-summary/async` | Pre-summary (async) |
| POST | `/api/consultations/:id/summary` | Final summary (sync) |
| POST | `/api/consultations/:id/summary/async` | Final summary (async) |
| POST | `/api/consultations/:id/summary/:contextItemId/extract-entities` | NER (sync) |
| POST | `/api/consultations/:id/summary/:contextItemId/extract-entities/async` | NER (async) |

### Job Status Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/consultations/jobs/:jobId` | Poll job status |
| GET | `/api/consultations/jobs/:jobId/sse` | SSE stream for live updates |
| DELETE | `/api/consultations/jobs/:jobId` | Cancel a running job |

## Related Documentation

- [System Architecture](./README.md) — Overall system overview
- [Data Model](./data-model.md) — Entity relationships and Prisma schema
- [Security](./security.md) — Authentication and audit logging
- [Infrastructure](./infrastructure.md) — Redis, PostgreSQL setup
