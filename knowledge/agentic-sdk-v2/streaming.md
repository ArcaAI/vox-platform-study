# Agentic SDK V2 — Streaming Architecture

Comprehensive reference for real-time streaming in `@arcaai/vox`: WebSocket audio, Server-Sent Events (SSE), cross-tab sharing, and API Gateway integration.

## Overview

The SDK provides four streaming mechanisms for real-time medical consultation workflows:

| Protocol | Direction | Use Case | SDK Class |
|----------|-----------|----------|-----------|
| WebSocket | Bidirectional | Live audio → real-time transcription | `SttV2WebSocketClient` |
| SSE (GET) | Server → Client | Job progress, file transcription results | `SSEClient` |
| SSE (fetch) | Server → Client | Streaming summary/pre-summary tokens | `smrClient.sse` / `smrClient.postSSE` |
| SharedWorker | Cross-tab | Multi-tab WS/SSE connection sharing | `SharedConnectionManager` |

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                              │
│                                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │  AudioWorkletNode    │  │  FileTranscription    │                 │
│  │  (PCM Int16 LE mono) │  │  Service              │                 │
│  └──────────┬───────────┘  └──────────┬───────────┘                 │
│             │ binary                   │ HTTP POST                    │
│             ▼                          ▼                              │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │ SttV2WebSocketClient │  │     SSEClient         │                 │
│  │ (WebSocket binary)   │  │  (EventSource-like)   │                 │
│  └──────────┬───────────┘  └──────────┬───────────┘                 │
│             │                          │                              │
│  ┌──────────┴──────────────────────────┴───────────┐                │
│  │          SharedConnectionManager                 │                │
│  │   SharedWorker (if supported) or fallback        │                │
│  └──────────┬──────────────────────────┬───────────┘                │
└─────────────┼──────────────────────────┼────────────────────────────┘
              │                          │
              ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              API Gateway (NestJS :8868)                               │
│                                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │  SttWsGateway        │  │  SmrProxyController   │                 │
│  │  /ws/stt-v2/stream   │  │  /text/tasks/:id/stream│                │
│  │  (WebSocket)         │  │  (SSE proxy + heartbeat)│                │
│  └──────────┬───────────┘  └──────────┬───────────┘                 │
│             │ Redis Streams            │ HTTP stream                  │
│             ▼                          ▼                              │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │  STT-V2 Service      │  │  SMR Service          │                 │
│  │  (FastAPI :8861)     │  │  (FastAPI :8862)      │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket — Live Audio Transcription

### Session Lifecycle

```text
1. StreamingSessionManager.createSession()
   → POST /api/v1/audio/transcription-jobs/stream/session
   → Returns { sessionId, wsUrl }

2. SttV2WebSocketClient.connect(wsUrl)
   → WebSocket handshake with ?sessionId=...

3. Client sends auth message after open:
   → { type: "auth", token: "Bearer ..." }

4. AudioWorkletNode captures PCM Int16 LE mono @ 16kHz
   → Binary ArrayBuffer sent directly via ws.send(buffer)

5. Server streams back transcript segments:
   → { type: "transcript", text, isFinal, startTime, endTime }

6. Client sends stop/close:
   → { type: "stop" }  — finalize transcription
   → { type: "close" } — close session
```

### SttV2WebSocketClient

```typescript
import { SttV2WebSocketClient } from '@arcaai/vox/core';

const client = new SttV2WebSocketClient(logger, {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
}, true /* debugMode — logs transcript JSON to console */);

await client.connect(wsUrl, { timeoutMs: 10000 });

client.onTranscript((result) => {
  // result: { text, isFinal, language?, segments?, confidence? }
});

client.onStatus((status) => {
  // status: { status, message }
});

client.onWsError((error) => {
  // error: { code, message }
});

client.onReconnect((attempt) => {
  console.log(`Reconnecting (attempt ${attempt})...`);
});

// Send binary PCM audio frame (Int16 LE mono)
client.sendAudioFrame(pcmArrayBuffer);

// Or send JSON-encoded audio (legacy, higher overhead)
client.sendAudioFrameJson(seq, base64Data, microphoneId);

// Finalize transcription
client.sendStop();

// Close session
client.sendClose();
client.disconnect();
```

### Audio Capture (AudioWorklet)

The playground uses `AudioWorkletNode` (replacing the deprecated `ScriptProcessorNode`) for audio capture:

```typescript
const workletCode = `
  class PcmCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      if (input.length > 0 && input[0].length > 0) {
        const float32 = input[0];
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
      }
      return true;
    }
  }
  registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

// Register inline worklet via Blob URL
const blob = new Blob([workletCode], { type: 'application/javascript' });
await audioContext.audioWorklet.addModule(URL.createObjectURL(blob));

const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
workletNode.port.onmessage = (e) => {
  wsClient.sendAudioFrame(e.data); // binary PCM
};
source.connect(workletNode);
```

### WebSocket Protocol Messages

**Client → Server:**

| Message | Format | Description |
|---------|--------|-------------|
| Auth | `{ type: "auth", token: string }` | Sent immediately after connection opens |
| Audio (binary) | `ArrayBuffer` (Int16 LE mono) | Raw PCM audio frames |
| Audio (JSON) | `{ type: "audio", seq: number, data: string }` | Base64-encoded PCM (legacy) |
| Stop | `{ type: "stop" }` | Finalize transcription |
| Close | `{ type: "close" }` | Close session and disconnect |

**Server → Client:**

| Message | Format | Description |
|---------|--------|-------------|
| Transcript | `{ type: "transcript", text, isFinal, startTime?, endTime? }` | Transcript segment |
| Status | `{ type: "status", status, message }` | Session status update |
| Error | `{ type: "error", code, message }` | Error notification |

### Reconnection

`SttV2WebSocketClient` supports automatic reconnection with exponential backoff and jitter:

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable auto-reconnect |
| `maxAttempts` | `5` | Maximum reconnection attempts |
| `baseDelayMs` | `1000` | Initial delay between attempts |
| `maxDelayMs` | `30000` | Maximum delay (capped) |

**Backoff formula**: `delay = exponentialDelay + random(0, exponentialDelay × 0.5)`

The jitter component (0-50% of the exponential delay) prevents the thundering herd problem — when a server restarts, multiple clients reconnect at staggered intervals instead of simultaneously overwhelming the server.

| Attempt | Base Delay | Jitter Range | Actual Delay Range |
|---------|------------|-------------|-------------------|
| 1 | 1000 ms | 0–500 ms | 1000–1500 ms |
| 2 | 2000 ms | 0–1000 ms | 2000–3000 ms |
| 3 | 4000 ms | 0–2000 ms | 4000–6000 ms |
| 4 | 8000 ms | 0–4000 ms | 8000–12000 ms |
| 5 | 16000 ms | 0–8000 ms | 16000–24000 ms |
| 6+ | 30000 ms | 0–15000 ms | 30000–45000 ms |

Reconnection can be cancelled via `cancelReconnect()` and monitored via `onReconnect(cb)` and `onReconnectFailed(cb)`. The `SSEClient` uses the same jitter strategy for consistency.

---

## SSE — Server-Sent Events

### SSEClient (SDK)

General-purpose SSE client with authentication and auto-reconnection:

```typescript
import { SSEClient } from '@arcaai/vox/core';

const sse = new SSEClient(logger);

sse.connect(streamUrl, {
  authToken: 'Bearer ...',
  autoReconnect: true,
  maxReconnectAttempts: 3,
  reconnectIntervalMs: 2000,
  maxDelayMs: 30000,
});

sse.onEvent('transcript', (data) => {
  const parsed = JSON.parse(data);
  // { text, isFinal, speaker?, timestamp? }
});

sse.onEvent('complete', (data) => {
  sse.disconnect();
});

sse.onError((event) => {
  console.error('SSE error', event);
});
```

### Authenticated SSE via fetch + ReadableStream

The native `EventSource` API does not support custom headers. For authenticated SSE connections, the playground uses `fetch` with `ReadableStream`:

```typescript
const res = await fetch(sseUrl, {
  headers: {
    ...getAuthHeaders(),
    Accept: 'text/event-stream',
  },
  signal: abortController.signal,
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
      if (data === '[DONE]') return;
      onChunk(data);
    }
  }
}
reader.releaseLock();
```

### SSE Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/v1/audio/transcription-jobs/:id/stream` | Bearer/API-Key | File transcription progress + results |
| `GET /api/v1/consultations/jobs/:jobId/sse` | Bearer/API-Key | Async job status updates |
| `GET /text/tasks/:taskId/stream` | Bearer (via gateway) | Streaming summary/pre-summary tokens |

### SSE Event Format

```text
event: status
data: {"status":"running","progress":45}

event: progress
data: {"text":"Patient presents...","percent":60}

event: result
data: {"transcript":"Full transcript text..."}

data: {"content":"Summary chunk...","index":0}

data: [DONE]
```

---

## SMR Proxy — Streaming Summary Generation

### API Gateway SSE Proxy

The `SmrProxyController` (`@Controller('text')`) proxies all SMR requests through the API gateway with JWT authentication. All routes are protected by `@UseGuards(JwtAuthGuard)` and documented with `@ApiBearerAuth()`.

**Security features**:
- **JWT authentication**: All routes require a valid Bearer token (enforced at class level)
- **RBAC enforcement**: Requests pass through the gateway's authorization pipeline
- **Audit logging**: All SMR operations are captured in the audit trail

**Reliability features**:
- **Heartbeat**: `:keepalive\n\n` comment every 15 seconds to prevent proxy/load balancer timeouts
- **Retry with backoff**: Transient errors (ECONNREFUSED, 502, 503, 504) retry up to 2 times with exponential backoff
- **Stream timeout**: 300 seconds for long-running generation tasks

### Gateway Route Table

| Method | Gateway Path | Proxied To | Description |
|--------|-------------|------------|-------------|
| POST | `/text/generate` | `SMR_SERVICE_URL/api/v2/generate` | Start generation task |
| GET | `/text/tasks/:taskId` | `SMR_SERVICE_URL/api/v2/tasks/:taskId` | Poll task status |
| POST | `/text/tasks/:taskId/cancel` | `SMR_SERVICE_URL/api/v2/tasks/:taskId/cancel` | Cancel running task |
| GET | `/text/tasks/:taskId/stream` | `SMR_SERVICE_URL/api/v2/tasks/:taskId/stream` | SSE stream of content chunks |
| GET | `/text/providers` | `SMR_SERVICE_URL/api/v2/providers` | List available providers |
| GET | `/text/health` | `SMR_SERVICE_URL/api/v2/health` | Service health check |

> **Important**: Client applications must use `/text/*` paths (via the API gateway), never `/api/v2/*` paths directly to the SMR service. The gateway handles authentication, rate limiting, and audit logging.

### Streaming Summary Flow

```text
1. POST /text/generate { stream: true, prompt, system_prompt, provider }
   → Returns { task_id, stream_url }

2. GET /text/tasks/:task_id/stream
   → SSE stream of content chunks:
     data: {"content":"Clinical ","index":0}
     data: {"content":"Summary\n","index":1}
     data: {"content":"Patient:","index":2}
     ...
     data: {"usage":{"total_tokens":450}}
     data: [DONE]
```

### smrClient SSE Methods

```typescript
// GET-based SSE stream (with 401 retry)
await smrClient.sse(
  `/text/tasks/${taskId}/stream`,
  (data) => { /* onChunk */ },
  () => { /* onDone */ },
);

// POST-based SSE stream
await smrClient.postSSE(
  '/text/generate',
  { prompt, stream: true },
  {
    onChunk: (data) => { /* chunk received */ },
    onDone: () => { /* stream complete */ },
    onError: (err) => { /* error */ },
  },
  { signal: abortController.signal },
);
```

### Streaming TanStack Query Hooks

```typescript
import { useStreamPreSummary, useStreamSummary } from '@/features/summarization/api/summarization';

// Streaming pre-summary
const streamPreSummary = useStreamPreSummary();
streamPreSummary.mutate({
  contextText: 'Clinical notes...',
  provider: 'ollama',
  onChunk: (text) => setAccumulated(prev => prev + text),
  onDone: (taskId) => console.log('Done:', taskId),
});

// Streaming summary with DNA writing style
const streamSummary = useStreamSummary();
streamSummary.mutate({
  transcript: 'Full transcript...',
  preSummaryText: 'Pre-summary...',
  dnaStyleText: 'Use formal medical terminology...',
  format: 'SOAP',
  includeNER: true,
  provider: 'ollama',
  onChunk: (text) => setAccumulated(prev => prev + text),
  onDone: (taskId) => console.log('Done:', taskId),
});
```

---

## File Transcription (Upload + SSE)

### FileTranscriptionService

```typescript
import { FileTranscriptionService } from '@arcaai/vox/core';

const service = new FileTranscriptionService(apiClient, logger);

const job = await service.uploadAndTranscribe(audioFile, {
  pipelineId: 'default',
  language: 'en-US',
  sampleRate: 16000,
});

const streamUrl = service.buildJobStreamUrl(job.jobId);
// → /api/v1/audio/transcription-jobs/:jobId/stream
```

### Flow

```text
1. FileTranscriptionService.uploadAndTranscribe(file, options)
   → POST /api/v1/audio/transcription-jobs/transcribe (multipart)
   → Returns { jobId, status }

2. SSEClient.connect(streamUrl, { authToken })
   → GET /api/v1/audio/transcription-jobs/:jobId/stream
   → Events: status, progress, transcript, result, complete, error

3. On 'result' event:
   → Full transcript text available
   → Optionally chain to summary generation
```

---

## Cross-Tab Connection Sharing

### SharedConnectionManager

Manages WebSocket and SSE connections across browser tabs via `SharedWorker` (with fallback to per-tab connections):

```typescript
import { SharedConnectionManager } from '@arcaai/vox/core';

const manager = new SharedConnectionManager(workerUrl, logger);

// Check if SharedWorker is active
manager.isUsingSharedWorker(); // true if SharedWorker supported

// Monitor tab count
manager.onTabCountChange((count) => {
  console.log(`${count} tabs connected`);
});

// Subscribe to SSE
manager.subscribeSSE('transcription-job-123', {
  url: '/api/v1/audio/transcription-jobs/123/stream',
  authToken: 'Bearer ...',
});
manager.onSSEEvent('transcription-job-123', (eventName, data) => {
  // Received in all tabs
});

// Subscribe to WebSocket
manager.subscribeWS('stt-session-456', {
  url: 'ws://localhost:8868/ws/stt-v2/stream?sessionId=456',
});
manager.onWSMessage('stt-session-456', (data) => {
  // Transcript received in all tabs
});
manager.sendWS('stt-session-456', audioBuffer);

// Cleanup
manager.dispose();
```

### React Hooks

```typescript
import { useSharedConnection, useSharedSSE, useSharedWS } from '@arcaai/vox';

// Get the shared connection manager
const { manager, tabCount, isSharedWorkerActive } = useSharedConnection(workerUrl);

// Subscribe to SSE via shared connection
const { isConnected, error } = useSharedSSE('job-123', {
  url: '/api/v1/audio/transcription-jobs/123/stream',
  authToken: token,
  enabled: !!jobId,
  onEvent: (eventName, data) => { /* handle event */ },
}, manager);

// Subscribe to WebSocket via shared connection
const { isConnected, error, send } = useSharedWS('stt-456', {
  url: wsUrl,
  enabled: !!sessionId,
  onMessage: (data) => { /* handle message */ },
}, manager);
```

---

## Consultation Job Tracking

### useConsultationJob

Hook for tracking async job status with authenticated SSE streaming and polling fallback. The `streamJob` method uses the SDK's `SSEClient` internally, providing:

- **Authentication**: Passes the current JWT token to the SSE connection
- **Auto-reconnection**: Exponential backoff with jitter (15 attempts, 2s base, 30s max)
- **Structured logging**: All SSE events logged via the SDK logger
- **Graceful error handling**: Malformed JSON events are logged but do not crash the stream
- **Terminal status detection**: Automatically disconnects on `COMPLETED`, `FAILED`, or `CANCELLED`

```typescript
import { useConsultationJob } from '@arcaai/vox';

const { job, status, isStreaming, error, getJob, cancelJob, streamJob, pollJob } = useConsultationJob();

// Stream job updates via authenticated SSE
const unsubscribe = streamJob(jobId, {
  onProgress: (progress) => setProgress(progress),
  onComplete: (result) => setResult(result),
  onError: (err) => setError(err),
});

// Or poll for status
const completedJob = await pollJob(jobId, {
  intervalMs: 2000,
  maxAttempts: 60,
});

// Cancel a running job
await cancelJob(jobId);
```

### SSE Connection Details

When `streamJob` is called, the hook:

1. Creates an `SSEClient` instance with the SDK logger
2. Retrieves the auth token via `apiClient.getAccessToken()`
3. Constructs the SSE URL: `{baseUrl}/api/v1/consultations/jobs/{jobId}/sse`
4. Registers event listeners for `status`, `progress`, and `result` events
5. Connects with auto-reconnection enabled

```typescript
// Internal SSEClient configuration (for reference)
sseClient.connect(sseUrl, {
  autoReconnect: true,
  reconnectIntervalMs: 2000,
  maxReconnectAttempts: 15,
  maxDelayMs: 30000,
  authToken: token,
});
```

The SSE connection is automatically cleaned up when:
- The component unmounts (via the returned `unsubscribe` function)
- A terminal status is received (`COMPLETED`, `FAILED`, `CANCELLED`)
- `streamJob` is called again (previous connection is disconnected first)

---

## Authentication

### WebSocket Authentication

WebSocket connections cannot carry HTTP headers. Authentication is handled in two stages:

1. **Session creation** (HTTP): `POST /api/v1/audio/transcription-jobs/stream/session` with `Authorization: Bearer` header
2. **Post-connect auth message**: After WebSocket opens, client sends `{ type: "auth", token: "Bearer ..." }`

### SSE Authentication

The native `EventSource` API does not support custom headers. The SDK uses two approaches:

1. **SSEClient**: Appends `?token=...` as query parameter (for `EventSource`-based connections)
2. **fetch + ReadableStream**: Sends `Authorization` header directly (used by `smrClient.sse` and playground demos)

The `smrClient.requestSSE` method includes automatic 401 retry with token refresh.

---

## Error Handling

### WebSocket Errors

| Error Code | Meaning | Recovery |
|------------|---------|----------|
| 4001 | Missing sessionId | Fix client code |
| 4003 | Auth failed | Refresh token, reconnect |
| 1006 | Abnormal close | Auto-reconnect (if enabled) |
| 1000 | Normal close | No action needed |

### SSE Errors

| Scenario | Behavior |
|----------|----------|
| Network disconnect | Auto-reconnect with backoff |
| 401 Unauthorized | Refresh token, retry once |
| 502/503 Bad Gateway | Retry with exponential backoff |
| Stream timeout | Heartbeat keeps connection alive |

### SMR Proxy Retry

The API Gateway retries transient SMR errors:

| Error | Retries | Backoff |
|-------|---------|---------|
| ECONNREFUSED | 2 | 1s, 2s |
| ECONNRESET | 2 | 1s, 2s |
| ETIMEDOUT | 2 | 1s, 2s |
| 502/503/504 | 2 | 1s, 2s |

---

## Performance Considerations

### Binary PCM vs Base64 JSON

| Format | Overhead | Bandwidth (16kHz mono) |
|--------|----------|----------------------|
| Binary PCM (ArrayBuffer) | 0% | ~32 KB/s |
| Base64 JSON | ~37% | ~44 KB/s |

The playground uses binary PCM for optimal performance. The gateway's `SttWsGateway` accepts both formats.

### AudioWorklet vs ScriptProcessorNode

| Feature | AudioWorklet | ScriptProcessorNode |
|---------|-------------|-------------------|
| Thread | Audio thread | Main thread |
| Latency | Low | Higher |
| Status | Current standard | Deprecated |
| Browser support | Chrome 66+, Firefox 76+, Safari 14.1+ | Universal (legacy) |

The playground uses `AudioWorkletNode` with an inline processor registered via Blob URL.

---

## Related Documentation

- [API Reference](./api-reference.md) — Full hook and type reference
- [Examples](./examples.md) — Working integration examples
- [Architecture — Communication](../architecture/communication.md) — System-level communication patterns
- [Audio & Transcription Playground](../playground/03_AUDIO_AND_TRANSCRIPTION_PLAYGROUND.md) — Playground implementation
- [Pre-Summary & Summary Playground](../playground/04_PRESUMMARY_AND_SUMMARY_PLAYGROUND.md) — Summary streaming implementation
