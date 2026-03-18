# Agentic SDK V2 — API Reference

Complete API reference for `@arcaai/vox`.

## Components

### AgenticProvider

Root provider that initializes the SDK. Must wrap all components that use SDK hooks.

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `config` | `AgenticConfig` | Yes | SDK configuration object |
| `children` | `React.ReactNode` | Yes | Child components |

```tsx
import { AgenticProvider } from '@arcaai/vox';

function App() {
  return (
    <AgenticProvider config={config}>
      <YourApp />
    </AgenticProvider>
  );
}
```

**Initialization sequence:**
1. Create `SDKLogger` (Observability — configured first)
2. Create `AgenticClient` (HTTP API)
3. Create `PluginManager` (Audio plugins)
4. Create `PersonalizationManager` (User preferences)
5. Create `ModelRegistry` (ML models)
6. Initialize Zustand store
7. Initialize Knowledge Pipeline (if NER configured)
8. Start personalization sync (if hybrid mode)

---

## Hooks

### useArca

The unified hook for accessing all SDK functionality.

```typescript
function useArca(): UseArcaReturn;
```

#### Return Type

| Property | Type | Description |
|----------|------|-------------|
| `session` | `UseArcaSession` | Session management |
| `audio` | `UseArcaAudio` | Audio capture and processing |
| `context` | `UseArcaContext` | Context items and medical entities |
| `summary` | `UseArcaSummary` | Summary generation |
| `pipelines` | `UseArcaPipelineControl` | Pipeline control |
| `isAudioSource` | `boolean` | Whether this tab owns audio capture |
| `isReady` | `boolean` | Whether the SDK has initialized |
| `error` | `Error \| null` | Global error state |
| `withRetry` | `<T>(fn: () => Promise<T>, options?: RetryOptions) => Promise<T>` | Retry wrapper for retriable API operations |

---

### Session Interface (`UseArcaSession`)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `consultation` | `Consultation \| null` | Active consultation |
| `relatedConsultations` | `Consultation[]` | Linked consultations in the chain |
| `isLoading` | `boolean` | Loading state |
| `error` | `Error \| null` | Session error |
| `open(input)` | `(OpenSessionInput) => Promise<Consultation>` | Open a consultation session (get-or-create) |
| `load(id)` | `(string) => Promise<Consultation>` | Load existing consultation by ID |
| `findByPatientDate(patientId, date)` | `(string, string) => Promise<Consultation[]>` | Find consultations by patient + date |
| `getPatientHistory(patientId, pagination?)` | `(string, PaginationParams?) => Promise<Consultation[]>` | Get patient consultation history |
| `getTimeline(scope?)` | `(TimelineScope?) => Promise<TimelineEntry[]>` | Get consultation timeline (`'single'` or `'chain'` scope) |

---

### Audio Interface (`UseArcaAudio`)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `isCapturing` | `boolean` | Whether audio is being captured |
| `isMuted` | `boolean` | Whether audio is muted |
| `level` | `number` | Audio level 0–100 |
| `isSpeaking` | `boolean` | Whether VAD detects speech |
| `currentTranscript` | `string` | Live partial transcript from STT |
| `plugins` | `AudioPluginStates` | State of each audio plugin |
| `error` | `Error \| null` | Audio error |
| `start()` | `() => Promise<void>` | Start audio capture |
| `stop()` | `() => Promise<void>` | Stop audio capture |
| `mute()` | `() => void` | Mute microphone |
| `unmute()` | `() => void` | Unmute microphone |
| `toggleNoiseFilter(enabled?)` | `(boolean?) => void` | Toggle noise filter on/off |
| `toggleSTT(enabled?)` | `(boolean?) => Promise<void>` | Toggle STT on/off |
| `toggleVAD(enabled?)` | `(boolean?) => Promise<void>` | Toggle VAD on/off |

---

### Context Interface (`UseArcaContext`)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `items` | `ContextItem[]` | All context items |
| `transcriptions` | `ContextItem[]` | Filtered transcription items |
| `caseNotes` | `ContextItem[]` | Filtered case note items |
| `entities` | `MedicalEntity[]` | Extracted medical entities |
| `sharedContext` | `ContextItem[]` | Context from linked consultations |
| `isLoading` | `boolean` | Loading state |
| `error` | `Error \| null` | Context error |
| `addCaseNote(content, metadata?)` | `(string, Record?) => Promise<ContextItem>` | Add a case note |
| `addTranscription(text, metadata?)` | `(string, Record?) => Promise<ContextItem>` | Add a transcription |
| `updateItem(id, content)` | `(string, string) => Promise<void>` | Update a context item |
| `loadSharedContext()` | `() => Promise<ContextItem[]>` | Load shared context from chain |
| `extractEntities(contextItemId?)` | `(string?) => Promise<MedicalEntity[]>` | Run NER extraction |
| `getContextVersions(contextItemId)` | `(string) => Promise<ContextVersionEntry[]>` | Get version history for a context item |
| `triggerEntityExtraction(contextItemId)` | `(string) => Promise<void>` | Trigger backend NER entity extraction |
| `fetchTranscriptions()` | `() => Promise<ContextItem[]>` | Fetch transcriptions from backend |
| `fetchCaseNotes()` | `() => Promise<ContextItem[]>` | Fetch case notes from backend |

---

### Summary Interface (`UseArcaSummary`)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `preSummary` | `SummaryResponse \| null` | Generated pre-summary |
| `summary` | `SummaryResponse \| null` | Generated final summary |
| `all` | `SummaryResponse[]` | All summaries |
| `dnaStyle` | `DNAStyle \| null` | Doctor's writing style profile |
| `isGenerating` | `boolean` | Whether a summary is being generated |
| `error` | `Error \| null` | Summary error |
| `generatePreSummary(options?)` | `(opts?) => Promise<SummaryResponse>` | Generate pre-summary from case notes |
| `generateSummary(options?)` | `(opts?) => Promise<SummaryResponse>` | Generate final summary |
| `updateSummary(id, content, options?)` | `(string, string, UpdateSummaryOptions?) => Promise<void>` | Update an existing summary |
| `analyzeDNA(texts)` | `(string[]) => Promise<DNAStyle>` | Analyze writing style (deprecated — no backend endpoint) |
| `loadSummaries(pagination?)` | `(PaginationParams?) => Promise<SummaryResponse[]>` | Fetch all summaries from backend |
| `generateSummaryAsync(options?)` | `(opts?) => Promise<AsyncJobResponse>` | Generate summary asynchronously (returns job ID) |
| `generatePreSummaryAsync(options?)` | `(opts?) => Promise<AsyncJobResponse>` | Generate pre-summary asynchronously |
| `generateComprehensiveSummary(options?)` | `(opts?) => Promise<ComprehensiveSummaryResponse>` | Generate cross-chain comprehensive summary |
| `getLatestPreSummary()` | `() => Promise<SummaryResponse>` | Get the latest pre-summary |
| `getSummaryHistory(summaryId)` | `(string) => Promise<SummaryVersionEntry[]>` | Get version history for a summary |
| `compareSummaryVersions(contextItemId, v1, v2)` | `(string, number, number) => Promise<DiffResult>` | Compare two summary versions using word-level diff |

---

### Pipeline Control Interface (`UseArcaPipelineControl`)

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `transcription` | `PipelineStateInfo \| null` | Transcription pipeline state |
| `knowledge` | `PipelineStateInfo \| null` | Knowledge pipeline state |
| `pauseTranscription()` | `() => void` | Pause the transcription pipeline |
| `resumeTranscription()` | `() => void` | Resume the transcription pipeline |
| `triggerNER(text?)` | `(string?) => Promise<MedicalEntity[]>` | Manually trigger NER |
| `triggerSummarization()` | `() => Promise<string>` | Manually trigger summarization |

**`PipelineStateInfo`:**

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'IDLE' \| 'RUNNING' \| 'PAUSED' \| 'ERROR'` | Execution status |
| `progress` | `number` | 0–100 progress |
| `currentStage` | `string \| undefined` | Active stage name |
| `isReady` | `boolean` | Whether all stages are initialized |
| `error` | `Error \| undefined` | Pipeline error |

---

### useArcaSession

Lightweight hook for session management with cross-tab sync.

```typescript
function useArcaSession(): UseArcaSessionReturn;
```

**`UseArcaSessionReturn`** extends `SessionState` and `SessionActions`:

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `consultation` | `Consultation \| null` | Active consultation |
| `context` | `ContextItem[]` | Context items for current consultation |
| `isLoading` | `boolean` | Loading state |
| `error` | `Error \| null` | Error state |
| `open(input)` | `(OpenSessionInput) => Promise<Consultation>` | Open a consultation (get-or-create) |
| `addContext(input)` | `(AddContextInput) => Promise<ContextItem>` | Add context to current consultation |
| `getSharedContext()` | `() => Promise<ContextItem[]>` | Get shared context from all doctors on same date |
| `getPatientHistory(patientId)` | `(string) => Promise<Consultation[]>` | Get patient history |
| `loadConsultation(id)` | `(string) => Promise<Consultation>` | Load a specific consultation |
| `loadSummaries()` | `() => Promise<SummaryResponse[]>` | Load summaries for current consultation |

### useArcaConfig

Hook for accessing and updating user preferences and model selection.

```typescript
function useArcaConfig(): UseArcaConfigReturn;
```

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `preferences` | `UserPreferences` | Current user preferences |
| `models` | `{ stt, vad, ner, selected }` | Available models by type and current selection |
| `update(updates)` | `(Partial<UserPreferences>) => Promise<void>` | Update user preferences |
| `selectModel(type, modelId)` | `('stt' \| 'vad' \| 'ner', string) => void` | Select a model for a capability |
| `get(key)` | `(keyof UserPreferences) => value` | Get a specific preference value |
| `reset()` | `() => Promise<void>` | Reset preferences to defaults |

### useDnaStyle

Hook for DNA writing style management.

```typescript
function useDnaStyle(): UseDnaStyleReturn;
```

### usePrompts

Hook for prompt template management.

```typescript
function usePrompts(): UsePromptsReturn;
```

### useDepartments

Hook for department management.

```typescript
function useDepartments(): UseDepartmentsReturn;
```

### useSDKLogger

Hook for accessing the SDK logger in components.

```typescript
function useSDKLogger(): ISDKLogger;
```

---

### useConsultationJob

Hook for tracking async job status with authenticated SSE streaming and polling fallback.

```typescript
function useConsultationJob(): UseConsultationJobReturn;
```

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `job` | `ConsultationJob \| null` | Current job state |
| `status` | `HookStatus` | Hook loading/error state |
| `isStreaming` | `boolean` | Whether SSE stream is active |
| `error` | `Error \| null` | Error state |
| `getJob(jobId)` | `(string) => Promise<ConsultationJob>` | Fetch job status via REST |
| `cancelJob(jobId)` | `(string) => Promise<void>` | Cancel a running job |
| `streamJob(jobId, callbacks)` | `(string, StreamCallbacks) => () => void` | Stream job updates via authenticated SSE; returns unsubscribe function |
| `pollJob(jobId, options?)` | `(string, PollOptions?) => Promise<ConsultationJob>` | Poll for job completion |

**`StreamCallbacks`:**

| Property | Type | Description |
|----------|------|-------------|
| `onProgress` | `(progress: JobProgress) => void` | Called on progress updates |
| `onComplete` | `(result: JobResult) => void` | Called when job completes |
| `onError` | `(error: Error) => void` | Called on error |

**SSE connection details**: `streamJob` creates an `SSEClient` internally with auto-reconnection (15 attempts, 2s base delay, 30s max, jitter-based backoff) and passes the current JWT token for authentication. The connection is automatically cleaned up on terminal status (`COMPLETED`, `FAILED`, `CANCELLED`) or when the returned unsubscribe function is called.

---

### useSharedConnection

Hook for accessing the `SharedConnectionManager` singleton and monitoring tab count.

```typescript
function useSharedConnection(workerUrl?: string): UseSharedConnectionReturn;
```

| Property | Type | Description |
|----------|------|-------------|
| `manager` | `SharedConnectionManager \| null` | The singleton manager instance |
| `tabCount` | `number` | Number of connected browser tabs |
| `isSharedWorkerActive` | `boolean` | Whether SharedWorker is being used (vs fallback) |

**Usage:**

```typescript
import { useSharedConnection } from '@arcaai/vox';

function App() {
  const { manager, tabCount, isSharedWorkerActive } = useSharedConnection('/worker.js');

  return (
    <div>
      <p>{tabCount} tabs connected</p>
      <p>Mode: {isSharedWorkerActive ? 'SharedWorker' : 'Fallback'}</p>
    </div>
  );
}
```

---

### useSharedSSE

Hook for declarative SSE subscription via `SharedConnectionManager`.

```typescript
function useSharedSSE(
  connectionId: string,
  options: UseSharedSSEOptions,
  manager: SharedConnectionManager | null,
): UseSharedSSEReturn;
```

**`UseSharedSSEOptions`:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | Yes | SSE endpoint URL |
| `authToken` | `string` | No | Bearer token for authentication |
| `enabled` | `boolean` | No | Whether to connect (default: `true`) |
| `onEvent` | `(eventName: string, data: string) => void` | No | Event callback |

**`UseSharedSSEReturn`:**

| Property | Type | Description |
|----------|------|-------------|
| `isConnected` | `boolean` | Whether SSE connection is active |
| `error` | `Error \| null` | Connection error |

---

### useSharedWS

Hook for declarative WebSocket subscription via `SharedConnectionManager`.

```typescript
function useSharedWS(
  connectionId: string,
  options: UseSharedWSOptions,
  manager: SharedConnectionManager | null,
): UseSharedWSReturn;
```

**`UseSharedWSOptions`:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | Yes | WebSocket endpoint URL |
| `enabled` | `boolean` | No | Whether to connect (default: `true`) |
| `onMessage` | `(data: unknown) => void` | No | Message callback |

**`UseSharedWSReturn`:**

| Property | Type | Description |
|----------|------|-------------|
| `isConnected` | `boolean` | Whether WebSocket connection is active |
| `error` | `Error \| null` | Connection error |
| `send` | `(data: unknown) => void` | Send data through the WebSocket |

---

## Core Classes

### SharedConnectionManager

Manages WebSocket and SSE connections across browser tabs via `SharedWorker` (with per-tab fallback).

```typescript
import { SharedConnectionManager } from '@arcaai/vox/core';

const manager = new SharedConnectionManager(workerUrl, logger);
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `isUsingSharedWorker()` | `() => boolean` | Whether SharedWorker is active |
| `getTabCount()` | `() => number` | Current connected tab count |
| `onTabCountChange(cb)` | `(cb: (count: number) => void) => () => void` | Subscribe to tab count changes; returns unsubscribe |
| `subscribeSSE(id, sub, cbs?)` | `(string, SSESubscription, SSECallbacks?) => void` | Subscribe to an SSE stream |
| `unsubscribeSSE(id)` | `(string) => void` | Unsubscribe from SSE |
| `onSSEEvent(id, cb)` | `(string, SSEEventCallback) => void` | Register SSE event callback |
| `subscribeWS(id, sub, cbs?)` | `(string, WSSubscription, WSCallbacks?) => void` | Subscribe to a WebSocket |
| `unsubscribeWS(id)` | `(string) => void` | Unsubscribe from WebSocket |
| `sendWS(id, data)` | `(string, unknown) => void` | Send data through WebSocket |
| `onWSMessage(id, cb)` | `(string, WSMessageCallback) => void` | Register WS message callback |
| `dispose()` | `() => void` | Clean up all connections and the worker |

**`SSESubscription`:**

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | SSE endpoint URL |
| `authToken` | `string?` | Bearer token |

**`WSSubscription`:**

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | WebSocket endpoint URL |

### SttV2WebSocketClient

WebSocket client for live audio transcription with auto-reconnection and jitter.

```typescript
import { SttV2WebSocketClient } from '@arcaai/vox/core';

const client = new SttV2WebSocketClient(logger, {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
});
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect(url, options?)` | `(string, ConnectOptions?) => Promise<void>` | Connect to WebSocket |
| `disconnect()` | `() => void` | Disconnect |
| `sendAudioFrame(buffer)` | `(ArrayBuffer) => void` | Send binary PCM audio |
| `sendAudioFrameJson(seq, data, micId)` | `(number, string, string) => void` | Send base64 audio (legacy) |
| `sendStop()` | `() => void` | Finalize transcription |
| `sendClose()` | `() => void` | Close session |
| `cancelReconnect()` | `() => void` | Cancel pending reconnection |
| `onTranscript(cb)` | `(cb) => void` | Register transcript callback |
| `onStatus(cb)` | `(cb) => void` | Register status callback |
| `onWsError(cb)` | `(cb) => void` | Register error callback |
| `onReconnect(cb)` | `(cb) => void` | Register reconnect callback |
| `onReconnectFailed(cb)` | `(cb) => void` | Register reconnect failure callback |
| `isConnected()` | `() => boolean` | Connection state |

**Reconnection**: Exponential backoff with jitter — `delay = min(baseDelay × 2^(attempt-1), maxDelay) + random(0, delay × 0.5)`

### SSEClient

General-purpose SSE client with authentication and auto-reconnection.

```typescript
import { SSEClient } from '@arcaai/vox/core';

const sse = new SSEClient(logger);
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect(url, options?)` | `(string, SSEConnectOptions?) => void` | Connect to SSE stream |
| `disconnect()` | `() => void` | Disconnect |
| `onEvent(name, cb)` | `(string, (data: string) => void) => void` | Register named event callback |
| `onError(cb)` | `(cb) => void` | Register error callback |

**`SSEConnectOptions`:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `authToken` | `string` | — | Bearer token (appended as `?token=...`) |
| `autoReconnect` | `boolean` | `false` | Enable auto-reconnection |
| `reconnectIntervalMs` | `number` | `2000` | Base reconnection delay |
| `maxReconnectAttempts` | `number` | `3` | Maximum reconnection attempts |
| `maxDelayMs` | `number` | `30000` | Maximum backoff delay |

---

## Configuration Types

### AgenticConfig

```typescript
interface AgenticConfig {
  api: ApiConfig;
  audio?: AudioPluginConfig;
  plugins?: PluginConfig;
  models?: ModelRegistryConfig;
  personalization?: PersonalizationConfig;
  logging?: LoggingConfig;
  debug?: boolean;
}
```

### Debug Mode

Setting `debug: true` on `AgenticConfig` activates verbose console logging across all audio plugins. This is independent of the `logging` configuration (which controls `SDKLogger` transports).

**What gets logged** (all prefixed with `[ARCAAI:DEBUG]`):

| Event | When | Content |
|-------|------|---------|
| Pipeline config dump | Pipeline starts | Consolidated noise filter, VAD, STT settings, microphone source |
| Per-plugin config | Each plugin initializes | Individual plugin configuration |
| Transcript JSON | Each final transcription (local & backend) | Structured JSON with segment, speaker, timing, words |

**Transcript JSON schema:**

```json
{
  "segment": 1,
  "speaker": "speaker-1",
  "start": 1.234,
  "end": 3.567,
  "duration": 2.333,
  "inference": 0.1234,
  "words": [
    { "word": "hello", "confidence": 0.987, "start": 1.234, "end": 1.567 }
  ]
}
```

| Field | Type | Precision | Notes |
|-------|------|-----------|-------|
| `segment` | `number` | integer | Auto-incrementing per session |
| `speaker` | `string` | — | `speaker-1`, `speaker-2`, or embedded voice ID |
| `start` | `number` | 3 decimals | Seconds |
| `end` | `number` | 3 decimals | Seconds |
| `duration` | `number` | 3 decimals | Seconds |
| `inference` | `number` | 4 decimals | Seconds |
| `words` | `array` | — | Only present when word-level timestamps enabled |
| `words[].confidence` | `number` | 3 decimals | 0–1 |

**Standalone plugin usage:**

Each plugin package also accepts `debugMode?: boolean` for use outside the SDK:

```typescript
import { STTProcessor } from '@arcaai/stt';
import { VADProcessor } from '@arcaai/vad';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';

const stt = new STTProcessor({ debugMode: true, /* ... */ });
const vad = new VADProcessor({ debugMode: true, /* ... */ });
const nf = new NoiseFilterProcessor({ debugMode: true, /* ... */ });
```

### ApiConfig

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `baseUrl` | `string` | Yes | — | API endpoint URL |
| `apiKey` | `string` | Yes | — | Authentication key |
| `tenantId` | `string` | No | — | Multi-tenant organization ID |
| `timeout` | `number` | No | `30000` | Request timeout in ms |
| `wsUrl` | `string` | No | — | WebSocket base URL for streaming connections |

### AudioPluginConfig

| Property | Type | Description |
|----------|------|-------------|
| `noiseFilter` | `{ enabled: boolean; level?: 'low' \| 'medium' \| 'high' } \| boolean` | RNNoise noise cancellation |
| `vad` | `{ enabled: boolean; sensitivity?: number; minSpeechDuration?: number; minSilenceDuration?: number } \| boolean` | Voice activity detection |
| `stt` | `{ enabled: boolean; provider?: 'local' \| 'backend' \| 'auto'; language?: string; modelId?: string; pipelineId?: string; sttSocket?: string } \| boolean` | Speech-to-text |

### PluginConfig

| Property | Type | Description |
|----------|------|-------------|
| `ner.enabled` | `boolean` | Enable medical NER |
| `ner.autoExtract` | `boolean` | Auto-extract from transcriptions |
| `ner.entityTypes` | `string[]` | Filter entity types |
| `ner.model` | `string` | Model identifier (`'default'`, `'biomedical'`, `'clinical'`, or HuggingFace ID) |
| `ner.threshold` | `number` | Confidence threshold 0–1 |
| `ner.dtype` | `'fp32' \| 'fp16' \| 'q8' \| 'q4'` | Model quantization for size/speed tradeoff |
| `tts.enabled` | `boolean` | Enable text-to-speech (future) |
| `tts.voiceId` | `string` | Voice identifier |
| `tts.rate` | `number` | Speech rate 0.5–2.0 |

### PersonalizationConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `storage` | `'local' \| 'backend' \| 'hybrid'` | — | Where to store preferences |
| `syncInterval` | `number` | `60000` | Sync interval in ms |
| `defaults` | `object` | — | Default preferences for language, STT model, noise filter, VAD, DNA style |

### LoggingConfig

| Property | Type | Description |
|----------|------|-------------|
| `level` | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | Log level |
| `console` | `{ enabled, level?, colorize?, prettyPrint? }` | Console transport |
| `highlight` | `{ enabled, projectId, serviceName?, environment?, networkRecording? }` | Highlight.io transport |
| `loki` | `{ enabled, url, basicAuth?, headers?, labels? }` | Grafana Loki transport |
| `otel` | `{ enabled, endpoint, protocol?, headers?, resourceAttributes?, propagateTraceContext? }` | OpenTelemetry transport |
| `redactFields` | `string[]?` | Fields to redact from logs |
| `maxMessageLength` | `number?` | Maximum message length |
| `autoCorrelationId` | `boolean?` | Auto-generate correlation ID for each session |

---

## Data Types

### Consultation

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique consultation ID |
| `patientId` | `string` | Patient identifier |
| `doctorId` | `string` | Doctor identifier |
| `doctorName` | `string?` | Doctor display name |
| `appointmentDate` | `string` | Date in `YYYY-MM-DD` format |
| `department` | `string?` | Department |
| `metadata` | `Record<string, unknown>?` | Custom metadata |
| `contextItems` | `ContextItem[]?` | Context items (when loaded) |
| `createdAt` | `string` | Creation timestamp |
| `updatedAt` | `string` | Last update timestamp |
| `isNew` | `boolean?` | Whether just created (from get-or-create) |

**`ConsultationStatus`**: `'active'` | `'completed'` | `'cancelled'`

### ContextItem

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Item ID |
| `consultationId` | `string` | Parent consultation |
| `type` | `ContextItemType \| string` | `'case_note' \| 'transcription' \| 'summary' \| 'pre_summary' \| 'audio_segment' \| 'lab_result' \| 'medication' \| 'manual_note'` |
| `content` | `string` | Text content |
| `structuredData` | `Record?` | Structured data |
| `source` | `ContextSource` | `'user' \| 'system' \| 'transcription' \| 'ai'` |
| `isSummary` | `boolean` | Derived: true if type is summary or pre_summary |
| `isTranscription` | `boolean` | Derived: true if type is transcription |

### MedicalEntity

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Entity ID |
| `entityType` | `MedicalEntityType` | See entity types below |
| `text` | `string` | Surface text |
| `normalizedText` | `string?` | Canonical form |
| `codes` | `MedicalCodes?` | ICD-10, SNOMED, RxNorm codes |
| `confidence` | `number` | Confidence 0–1 |
| `startOffset` | `number` | Character offset start |
| `endOffset` | `number` | Character offset end |

**`MedicalEntityType`**: `DISEASE` | `SYMPTOM` | `MEDICATION` | `PROCEDURE` | `ANATOMY` | `LAB_TEST` | `DOSAGE` | `FREQUENCY` | `DURATION` | `CUSTOM`

### AudioPluginStates

| Property | Type | Description |
|----------|------|-------------|
| `noiseFilter` | `PluginState` | Noise filter status |
| `vad` | `PluginState` | VAD status |
| `stt` | `STTPluginState` | STT status (extends `PluginState` with `isProcessing`, `currentModel?`, `modelLoadProgress?`) |

**`PluginState`**: `{ isActive, isSupported }`

### TranscriptionResult

| Property | Type | Description |
|----------|------|-------------|
| `text` | `string` | Transcribed text |
| `isFinal` | `boolean` | Whether the result is final |
| `confidence` | `number?` | Confidence 0–1 |
| `language` | `string?` | Detected language |
| `segments` | `TranscriptionSegment[]?` | Segments with timing |

### SummaryResponse

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Summary ID |
| `type` | `'pre_summary' \| 'summary'` | Summary type |
| `content` | `string` | Generated text |
| `dnaStyleId` | `string?` | DNA style used |
| `llmProvider` | `string?` | LLM provider name |
| `modelName` | `string?` | Model name |
| `processingTimeMs` | `number?` | Generation time |

### DNAStyle

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Style ID |
| `userId` | `string` | Owner |
| `styleData` | `DNAStyleData` | Vocabulary, patterns, tone |
| `sampleCount` | `number` | Number of analyzed samples |

---

## Type Guards

```typescript
import { isNewVisit, isRevisit } from '@arcaai/vox';

if (isNewVisit(consultation)) {
  // First visit of the day
}

if (isRevisit(consultation)) {
  console.log('Parent:', consultation.parentConsultationId);
}
```

---

## Utilities

### Date Utilities

| Function | Signature | Description |
|----------|-----------|-------------|
| `formatDate` | `(Date \| string) => string` | Format to display string |
| `formatDateTime` | `(Date \| string) => string` | Format to ISO date |
| `getToday` | `() => string` | Today as `YYYY-MM-DD` |
| `isSameDay` | `(Date \| string, Date \| string) => boolean` | Compare two dates |
| `parseDate` | `(string) => Date` | Parse date string |
| `formatRelativeTime` | `(Date \| string) => string` | Relative time (e.g., "2 hours ago") |

### Error Utilities

| Function | Signature | Description |
|----------|-----------|-------------|
| `isAgenticError` | `(unknown) => error is AgenticError` | Type guard |
| `getErrorCode` | `(unknown) => string` | Extract error code |
| `getErrorMessage` | `(unknown) => string` | Extract error message |
| `wrapError` | `(unknown, string?) => AgenticError` | Wrap unknown error |
| `isNetworkError` | `(unknown) => boolean` | Network error check |
| `isAuthError` | `(unknown) => boolean` | Auth error check |
| `isRetriableError` | `(unknown) => boolean` | Retriable error check |

---

## Error Codes

| Code | Description |
|------|-------------|
| `SDK_NOT_INITIALIZED` | SDK provider not found or not initialized |
| `CONSULTATION_NOT_FOUND` | Consultation with given ID not found |
| `CONSULTATION_EXISTS` | New-visit already exists for patient + date |
| `INVALID_REVISIT_PARENT` | Cannot create re-visit from another re-visit |
| `CONTEXT_NOT_FOUND` | Context item not found |
| `SUMMARY_GENERATION_FAILED` | Summary service error |
| `AUDIO_NOT_SUPPORTED` | Browser doesn't support Web Audio API |
| `AUDIO_PERMISSION_DENIED` | Microphone permission denied |
| `STT_INITIALIZATION_FAILED` | Failed to initialize STT engine |
| `STT_TRANSCRIPTION_FAILED` | Transcription processing error |
| `VAD_INITIALIZATION_FAILED` | Failed to initialize VAD |
| `NETWORK_ERROR` | Network request failed |
| `AUTH_ERROR` | Authentication failed |
| `RATE_LIMITED` | Too many requests |

---

## Logger API

```typescript
import { createSDKLogger } from '@arcaai/vox/core';

const logger = createSDKLogger({
  level: 'info',
  console: { enabled: true, colorize: true, prettyPrint: true },
  highlight: { enabled: true, projectId: 'your-id' },
  otel: { enabled: true, endpoint: 'https://otel-collector.example.com' },
});

await logger.initialize();
```

Access the logger in components via the `useSDKLogger` hook:

```typescript
import { useSDKLogger } from '@arcaai/vox';

function MyComponent() {
  const logger = useSDKLogger();
  logger.info('Component mounted', { component: 'MyComponent' });
}
```

| Method | Description |
|--------|-------------|
| `trace(message, meta?)` | Trace-level log |
| `debug(message, meta?)` | Debug-level log |
| `info(message, meta?)` | Info-level log |
| `warn(message, meta?)` | Warning-level log |
| `error(message, meta?)` | Error-level log |
| `fatal(message, meta?)` | Fatal-level log |
| `child(name, meta?)` | Create a child logger with context |
| `startOperation(name, meta?)` | Returns `OperationTimer` with `end()` and `error()` |

---

## Streaming Classes

### SttV2WebSocketClient

WebSocket client for real-time audio streaming and transcription.

```typescript
import { SttV2WebSocketClient } from '@arcaai/vox/core';
```

**Constructor:** `new SttV2WebSocketClient(logger?: ISDKLogger, reconnect?: WsReconnectOptions, debugMode?: boolean)`

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `(url: string, options?: { timeoutMs?: number }) => Promise<void>` | Connect to WebSocket endpoint |
| `sendAudioFrame` | `(buffer: ArrayBuffer) => void` | Send binary PCM audio frame (Int16 LE mono) |
| `sendAudioFrameJson` | `(seq: number, data: string, microphoneId?: string) => void` | Send JSON-encoded audio (legacy) |
| `sendStop` | `() => void` | Finalize transcription |
| `sendClose` | `() => void` | Close session |
| `disconnect` | `() => void` | Disconnect WebSocket |
| `isConnected` | `() => boolean` | Connection status |
| `onTranscript` | `(cb: (result: WsTranscriptResult) => void) => void` | Listen for transcript segments |
| `onStatus` | `(cb: (status: WsStatusMessage) => void) => void` | Listen for status updates |
| `onWsError` | `(cb: (error: WsErrorMessage) => void) => void` | Listen for errors |
| `onDisconnect` | `(cb: () => void) => void` | Listen for disconnection |
| `onReconnect` | `(cb: (attempt: number) => void) => void` | Listen for reconnection attempts |
| `onReconnectFailed` | `(cb: () => void) => void` | Listen for reconnection failure |
| `cancelReconnect` | `() => void` | Cancel pending reconnection |

**`WsReconnectOptions`:** `{ enabled: boolean; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }`

### SSEClient

General-purpose Server-Sent Events client with authentication and auto-reconnection.

```typescript
import { SSEClient } from '@arcaai/vox/core';
```

**Constructor:** `new SSEClient(logger?: ISDKLogger)`

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `(url: string, options?: SSEConnectOptions) => void` | Connect to SSE endpoint |
| `onMessage` | `(cb: (data: string) => void) => void` | Listen for unnamed messages |
| `onEvent` | `(eventName: string, cb: (data: string) => void) => void` | Listen for named events |
| `onError` | `(cb: (event: Event) => void) => void` | Listen for errors |
| `onOpen` | `(cb: () => void) => void` | Listen for connection open |
| `isConnected` | `() => boolean` | Connection status |
| `disconnect` | `() => void` | Close SSE connection |

**`SSEConnectOptions`:** `{ autoReconnect?: boolean; reconnectIntervalMs?: number; maxReconnectAttempts?: number; maxDelayMs?: number; authToken?: string }`

### StreamingSessionManager

Manages STT-V2 streaming session lifecycle.

```typescript
import { StreamingSessionManager } from '@arcaai/vox/core';
```

**Constructor:** `new StreamingSessionManager(apiClient: AgenticClient, logger?: ISDKLogger)`

| Method | Signature | Description |
|--------|-----------|-------------|
| `createSession` | `(request: CreateStreamingSessionRequest) => Promise<StreamingSessionResponse>` | Create a streaming session |
| `getWebSocketUrl` | `(token: string) => string \| null` | Get WebSocket URL for current session |
| `closeSession` | `() => Promise<void>` | Close the active session |
| `getSessionId` | `() => string \| null` | Current session ID |
| `getStatus` | `() => SessionManagerStatus` | Current status |
| `getState` | `() => SessionManagerState` | Full state snapshot |
| `onSessionCreated` | `(cb) => () => void` | Listen for session creation |
| `onSessionClosed` | `(cb) => () => void` | Listen for session closure |
| `onError` | `(cb) => () => void` | Listen for errors |

**`SessionManagerStatus`:** `'idle' | 'creating' | 'session_created' | 'closed' | 'error'`

### FileTranscriptionService

Handles file upload for transcription and SSE stream URL construction.

```typescript
import { FileTranscriptionService } from '@arcaai/vox/core';
```

**Constructor:** `new FileTranscriptionService(apiClient: AgenticClient, logger?: ISDKLogger)`

| Method | Signature | Description |
|--------|-----------|-------------|
| `uploadAndTranscribe` | `(file: File, options: FileTranscribeOptions) => Promise<TranscriptionJobResponse>` | Upload file and start transcription |
| `buildJobStreamUrl` | `(jobId: string) => string` | Build SSE stream URL for job |
| `getActiveJobId` | `() => string \| null` | Current active job ID |
| `dispose` | `() => void` | Cleanup resources |

**`FileTranscribeOptions`:** `{ pipelineId: string; consultationId?: string; sampleRate?: number; language?: string; codeSwitching?: boolean }`

### SharedConnectionManager

Cross-tab WebSocket and SSE connection sharing via SharedWorker.

```typescript
import { SharedConnectionManager } from '@arcaai/vox/core';
```

**Constructor:** `new SharedConnectionManager(workerUrl?: string, logger?: ISDKLogger)`

| Method | Signature | Description |
|--------|-----------|-------------|
| `isUsingSharedWorker` | `() => boolean` | Whether SharedWorker is active |
| `getTabCount` | `() => number` | Number of connected tabs |
| `onTabCountChange` | `(cb) => () => void` | Listen for tab count changes |
| `subscribeSSE` | `(id, subscription, callbacks?) => void` | Subscribe to SSE stream |
| `unsubscribeSSE` | `(id) => void` | Unsubscribe from SSE |
| `subscribeWS` | `(id, subscription, callbacks?) => void` | Subscribe to WebSocket |
| `unsubscribeWS` | `(id) => void` | Unsubscribe from WebSocket |
| `sendWS` | `(id, data) => void` | Send data via WebSocket |
| `dispose` | `() => void` | Cleanup all connections |

---

### useConsultationJob

Hook for async job tracking with SSE streaming and polling fallback.

```typescript
import { useConsultationJob } from '@arcaai/vox';
```

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `job` | `ConsultationJob \| null` | Current job |
| `status` | `JobStatus` | Job status |
| `isStreaming` | `boolean` | Whether SSE stream is active |
| `error` | `Error \| null` | Error state |
| `getJob(jobId)` | `(string) => Promise<ConsultationJob>` | Fetch job by ID |
| `cancelJob(jobId)` | `(string) => Promise<void>` | Cancel a running job |
| `streamJob(jobId, callbacks)` | `(string, JobStreamCallbacks) => () => void` | Stream job updates via SSE |
| `pollJob(jobId, options?)` | `(string, PollOptions?) => Promise<ConsultationJob>` | Poll until terminal state |

### useSharedConnection

Hook for accessing the shared connection manager.

```typescript
import { useSharedConnection, useSharedSSE, useSharedWS } from '@arcaai/vox';
```

**`useSharedConnection(workerUrl?)`** returns `{ manager, tabCount, isSharedWorkerActive }`

**`useSharedSSE(connectionId, options, manager)`** returns `{ isConnected, error }`

**`useSharedWS(connectionId, options, manager)`** returns `{ isConnected, error, send }`

---

## Backend API Endpoints

### Consultation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/open` | Open consultation (get-or-create) |
| GET | `/consultations/:id` | Get consultation with context |
| GET | `/consultations/patient/:patientId/history` | Get patient consultation history |
| GET | `/consultations/patient/:patientId/date/:date` | Find consultations by patient + date |
| GET | `/consultations/:id/timeline` | Get consultation timeline (supports `?scope=single\|chain`) |
| GET | `/consultations/:id/chain` | Get consultation chain |

### Context Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/context` | Add context item |
| GET | `/consultations/:id/context` | Get context items |
| GET | `/consultations/:id/context/shared` | Get shared context |
| PATCH | `/consultations/:id/context/:itemId` | Update context item |
| GET | `/consultations/:id/context/:itemId/versions` | Get context item version history |
| GET | `/consultations/:id/context/:itemId/versions/:versionNumber` | Get specific version |
| GET | `/consultations/:id/context/transcriptions` | Get transcription items only |
| GET | `/consultations/:id/context/case-notes` | Get case note items only |

### Summary Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/summary` | Generate summary |
| POST | `/consultations/:id/summary/pre-summary` | Generate pre-summary |
| GET | `/consultations/:id/summary` | List all summaries |
| GET | `/consultations/:id/summary/latest` | Get latest summary |
| GET | `/consultations/:id/summary/pre-summary/latest` | Get latest pre-summary |
| PATCH | `/consultations/:id/summary/:summaryId` | Update summary |
| POST | `/consultations/:id/summary/async` | Generate summary asynchronously |
| POST | `/consultations/:id/summary/pre-summary/async` | Generate pre-summary asynchronously |
| POST | `/consultations/:id/summary/comprehensive` | Generate comprehensive cross-chain summary |
| GET | `/consultations/:id/summary/:summaryId/versions` | Get summary version history |
| POST | `/consultations/:id/summary/:contextItemId/extract-entities` | Trigger backend NER extraction |

### Entity Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/consultations/:id/named-entities` | Get aggregate named entities |
| GET | `/consultations/:id/context/:itemId/named-entities` | Get entities for a specific context item |

### Job Status Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/consultations/jobs/:jobId` | Poll job status |
| GET | `/consultations/jobs/:jobId/sse` | SSE stream for live updates (use `SSEClient` with auth) |
| DELETE | `/consultations/jobs/:jobId` | Cancel a running job |

### SMR Proxy Endpoints (via API Gateway)

All SMR routes require JWT authentication and are proxied through the API gateway.

| Method | Client Path | Description |
|--------|-------------|-------------|
| POST | `/text/generate` | Start text generation task |
| GET | `/text/tasks/:taskId` | Poll task status |
| POST | `/text/tasks/:taskId/cancel` | Cancel a running task |
| GET | `/text/tasks/:taskId/stream` | SSE stream of content chunks |
| GET | `/text/providers` | List available LLM providers |
| GET | `/text/health` | SMR service health check |

> **Important**: Always use `/text/*` paths through the API gateway. Never access the SMR service directly on port 8862.

### Audio Transcription Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/audio/transcription-jobs/transcribe` | Upload audio file for transcription |
| GET | `/audio/transcription-jobs/:jobId` | Get transcription job status |
| GET | `/audio/transcription-jobs/:jobId/stream` | SSE stream for transcription progress |
| POST | `/audio/transcription-jobs/stream/session` | Create streaming session (returns `wsUrl`) |

### WebSocket Endpoints

| Protocol | Path | Description |
|----------|------|-------------|
| WebSocket | `/ws/stt-v2/stream?sessionId=...` | Live audio transcription stream |
