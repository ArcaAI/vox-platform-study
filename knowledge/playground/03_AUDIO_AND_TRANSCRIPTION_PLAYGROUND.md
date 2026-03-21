# Audio & Transcription Playground — Implementation

## Overview

The Audio & Transcription Playground provides a comprehensive testing environment for the audio pipeline: microphone configuration, noise filtering, voice activity detection, recording, real-time transcription (WebSocket), file-based transcription (SSE), audio mixing, spectrogram analysis, and voice embedding management. It uses the `@arcaai/vox` SDK for transcription services and voice embeddings.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Audio Playground Page                      │
│  ┌────────────┬────────────┬──────────────┬────────────────┐ │
│  │   Config   │  Recording │ Transcription│    Mixer       │ │
│  │   Panel    │  Controls  │    Panel     │    Panel       │ │
│  ├────────────┼────────────┼──────────────┼────────────────┤ │
│  │ Spectrogram│   Voice    │              │                │ │
│  │ Comparison │ Embedding  │              │                │ │
│  └────────────┴────────────┴──────────────┴────────────────┘ │
└──────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌─────────────────┐    ┌──────────────────────────┐
│   Audio Store   │    │     @arcaai/vox SDK      │
│   (Zustand)     │    │  StreamingSessionManager │
│                 │    │  SttV2WebSocketClient    │
│                 │    │  FileTranscriptionService│
│                 │    │  SSEClient               │
│                 │    │  useVoiceEmbedding       │
└─────────────────┘    └──────────────────────────┘
```

---

## Audio Store

**File:** `apps/ui-playground/src/store/audio-store.ts` (155 lines)

Zustand store (no persistence) managing all audio-related state.

### State Groups

**Device & Processing:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `selectedMicrophones` | `string[]` | `[]` | Selected microphone device IDs |
| `noiseFilterEnabled` | `boolean` | `false` | RNNoise noise cancellation |
| `noiseFilterLevel` | `'low' \| 'medium' \| 'high'` | `'medium'` | Noise filter aggressiveness |
| `vadEnabled` | `boolean` | `false` | Silero VAD v5 |
| `vadThreshold` | `number` | `0.5` | VAD sensitivity (0–1) |
| `diarizationEnabled` | `boolean` | `false` | Speaker diarization |
| `sttProvider` | `'local' \| 'remote'` | `'remote'` | STT backend |
| `language` | `string` | `'en'` | Transcription language |

**Recording:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `isRecording` | `boolean` | `false` | Recording active |
| `audioLevel` | `number` | `0` | Current audio level (0–1) |
| `isSpeaking` | `boolean` | `false` | VAD speech detected |
| `speechProbability` | `number` | `0` | VAD probability (0–1) |

**WebSocket Transcription:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `transcriptionMode` | `'live' \| 'file'` | `'live'` | Active transcription mode |
| `wsStatus` | `WsStatus` | `'idle'` | WebSocket connection state |
| `wsSessionId` | `string \| null` | `null` | Active session ID |
| `wsReconnectAttempts` | `number` | `0` | Reconnection attempts |
| `bytesSent` | `number` | `0` | Total bytes sent |
| `transcripts` | `TranscriptEntry[]` | `[]` | Live transcription results |
| `isTranscribing` | `boolean` | `false` | Transcription active |

**SSE Transcription:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `sseStatus` | `SseStatus` | `'idle'` | SSE connection state |
| `sseJobId` | `string \| null` | `null` | Active job ID |
| `sseTranscripts` | `TranscriptEntry[]` | `[]` | File transcription results |
| `uploadProgress` | `number` | `0` | Upload progress (0–100) |
| `uploadedFileName` | `string \| null` | `null` | Uploaded file name |

**Mixer:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `audioSources` | `AudioSource[]` | `[]` | Mixer audio sources |
| `isMixing` | `boolean` | `false` | Mixing active |

### Types

```typescript
type TranscriptEntry = { id: string; text: string; timestamp: number; isFinal: boolean; speaker?: string }
type AudioSource = { id: string; label: string; deviceId: string; gain: number; muted: boolean }
type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed'
type SseStatus = 'idle' | 'uploading' | 'processing' | 'streaming' | 'complete' | 'error'
```

---

## Components

### Audio Config Panel

**File:** `apps/ui-playground/src/features/audio/components/audio-config-panel.tsx` (239 lines)

Configuration UI for the audio pipeline:

- **Input devices:** `MicrophoneSelector` for selecting microphones.
- **Transcription:** STT provider toggle (local/remote), language selector.
- **Audio processing:**
  - Noise cancellation (RNNoise) — toggle + level selector (low/medium/high).
  - Voice Activity Detection (Silero VAD v5) — toggle + sensitivity slider.
  - Speaker diarization — toggle.

### Recording Controls

**File:** `apps/ui-playground/src/features/audio/components/recording-controls.tsx` (324 lines)

Recording and real-time audio monitoring:

- Uses `MediaRecorder` + `navigator.mediaDevices.getUserMedia`.
- Constraints: uses first selected microphone, applies echo/noise suppression when `noiseFilterEnabled`.
- Audio monitoring via `AudioContext` + `AnalyserNode` for level, peak, and speech probability.
- VAD: `speechProbability > 0.3` triggers `speaking` state.
- Controls: Start, Pause, Resume, Stop.
- Output: WebM blob, downloadable via `URL.createObjectURL`.

### Transcription Panel

**File:** `apps/ui-playground/src/features/audio/components/transcription-panel.tsx` (437 lines)

Main transcription UI with two modes:

**Live Mode (WebSocket):**
- `LiveStreamingSection` uses `useRealtimeTranscription` hook.
- Real-time audio streaming with transcript display.
- Shows connection status, bytes sent, session ID.

**File Mode (SSE):**
- `FileUploadSection` uses `useFileTranscription` hook.
- Upload audio file, stream transcription results.
- Shows upload progress, job status, transcript results.

Sub-components: `TranscriptList`, `TranscriptItem`, `WsStatusBadge`, `LiveWaveform`.

### Audio Mixer Panel

**File:** `apps/ui-playground/src/features/audio/components/audio-mixer-panel.tsx` (294 lines)

Multi-source audio mixing:

- Add audio sources from available input devices via `enumerateDevices()`.
- Per-source controls: gain slider, mute toggle, remove.
- Start/stop mixing when 2+ sources are available.
- Uses `AudioSource` type with `id`, `label`, `deviceId`, `gain`, `muted`.

### Spectrogram Comparison

**File:** `apps/ui-playground/src/features/audio/components/spectrogram-comparison.tsx` (73 lines)

Side-by-side spectrogram visualization:

- File input for audio selection.
- Two `SpectrogramViewer` instances: raw audio vs processed (lowpass filter at 8 kHz).

### Spectrogram Viewer

**File:** `apps/ui-playground/src/features/audio/components/spectrogram-viewer.tsx` (125 lines)

Canvas-based spectrogram rendering:

- `AudioContext` + `AnalyserNode` for frequency data.
- Optional lowpass filter for "processed" view.
- Play/stop controls.

### Voice Embedding Panel

**File:** `apps/ui-playground/src/features/audio/components/voice-embedding-panel.tsx` (158 lines)

Voice embedding management via `@arcaai/vox`:

- Uses `useVoiceEmbedding` hook from SDK.
- Upload up to 3 voice samples per user.
- Actions: `upload(userId, file)`, `getStatus(userId)`, `remove(userId)`.

### Microphone Selector

**File:** `apps/ui-playground/src/features/audio/components/microphone-selector.tsx` (87 lines)

- Enumerates audio input devices via `getUserMedia` + `enumerateDevices`.
- Toggle selection per device.
- Updates `useAudioStore.setMicrophones`.

---

## Transcription Hooks

### Real-time Transcription (WebSocket)

**File:** `apps/ui-playground/src/hooks/use-realtime-transcription.ts` (253 lines)

**SDK classes:** `StreamingSessionManager`, `SttV2WebSocketClient`

**Flow:**

1. `StreamingSessionManager.createSession({ pipelineId, consultationId, sampleRate, language, codeSwitching, microphoneId })` → creates session via `POST /audio/transcription-jobs/stream/session`.
2. `sessionManager.getWebSocketUrl(token)` → builds WebSocket URL.
3. `SttV2WebSocketClient.connect(wsUrl)` → establishes WebSocket connection.
4. Client sends `{ type: "auth", token: "Bearer ..." }` after WebSocket opens.
5. `getUserMedia` → `AudioContext` + `AudioWorkletNode` (inline PCM capture processor).
6. Float32 audio → Int16 PCM conversion (in AudioWorklet thread) → binary `ArrayBuffer` sent via `wsClient.sendAudioFrame(pcm16.buffer)`.
7. `wsClient.onTranscript` → parses `WsTranscriptResult` into `TranscriptEntry` (partial/final handling).

**Audio capture:** Uses `AudioWorkletNode` (not the deprecated `ScriptProcessorNode`) with an inline processor registered via Blob URL. Audio processing runs on the audio thread, not the main thread.

**Audio format:** Binary PCM Int16 LE mono at 16kHz, sent directly as `ArrayBuffer` (not base64 JSON). This is ~37% more bandwidth-efficient than the legacy JSON encoding.

**Events:**
- `onTranscript` — new transcript segment
- `onReconnect` — WebSocket reconnecting
- `onReconnectFailed` — reconnection failed
- `onWsError` — WebSocket error
- `onDisconnect` — connection closed

**Output:** `status`, `sessionId`, `transcripts`, `bytesSent`, `reconnectAttempts`, `start(pipelineId?)`, `stop()`, `clearTranscripts()`

### File Transcription (SSE)

**File:** `apps/ui-playground/src/hooks/use-file-transcription.ts` (244 lines)

**SDK classes:** `FileTranscriptionService`, `SSEClient`

**Flow:**

1. `FileTranscriptionService.uploadAndTranscribe(file, options)` → uploads file via `POST /audio/transcription-jobs/transcribe` → returns job.
2. `SSEClient.connect(streamUrl, { autoReconnect, maxReconnectAttempts, authToken })` → connects to `GET /audio/transcription-jobs/:id/stream`.
3. Events: `transcript` (new segment), `complete` (job done), `error` (failure).
4. Parses `transcript` events into `TranscriptEntry` with `id`, `text`, `timestamp`, `isFinal`, `speaker`.

**Output:** `status`, `transcripts`, `jobId`, `uploadProgress`, `fileName`, `upload(file)`, `reset()`, `clearTranscripts()`

---

## SDK Integration

### SDK Classes Used

| Feature | SDK Class | Purpose |
|---------|-----------|---------|
| Real-time transcription | `StreamingSessionManager` | Session lifecycle (create, close) |
| Real-time transcription | `SttV2WebSocketClient` | WebSocket audio streaming |
| File transcription | `FileTranscriptionService` | File upload and job creation |
| File transcription | `SSEClient` | Server-sent events for results |
| Voice embedding | `useVoiceEmbedding` | Voice sample management |
| Auth | `useAuth` | Impersonation state display |

### SDK Endpoints

| Protocol | Endpoint | Purpose |
|----------|----------|---------|
| HTTP POST | `/audio/transcription-jobs/stream/session` | Create streaming session |
| WebSocket | `ws://.../ws/stt-v2/stream?sessionId=...` | Real-time audio stream |
| HTTP POST | `/audio/transcription-jobs/transcribe` | Upload file for transcription |
| HTTP GET | `/audio/transcription-jobs/:id/stream` | SSE transcription results |

### Auth Token

Both hooks obtain the auth token from `useAgenticStore`:
- `apiClient.getAccessToken?.()` for credentials auth
- `apiClient.getApiKey?.()` for API key auth

When impersonating, the SDK provider has already swapped in the `impersonationToken`, so all transcription calls are scoped to the impersonated user.

---

## Index Page

**File:** `apps/ui-playground/src/features/audio/index.tsx` (146 lines)

Tabbed layout with six tabs:

| Tab | Component | Purpose |
|-----|-----------|---------|
| Configuration | `AudioConfigPanel` | Device and processing settings |
| Recording | `RecordingControls` | Record and monitor audio |
| Transcription | `TranscriptionPanel` | Live and file transcription |
| Mixer | `AudioMixerPanel` | Multi-source audio mixing |
| Spectrogram | `SpectrogramComparison` | Visual audio analysis |
| Voice Embedding | `VoiceEmbeddingPanel` | Voice sample management |

- Shows impersonation banner when active.
- Reset button calls `useAudioStore().reset()`.

---

## Test Coverage

### `audio-store.test.ts` (424 lines)
- Initial state for all fields
- All action methods (set, toggle, add, remove, update, clear)
- WebSocket state management (status, session, reconnect, bytes)
- SSE state management (status, job, transcripts, upload progress)
- `reset()` restores all defaults

### `use-file-transcription.test.ts` (106 lines)
- Initial state: idle, empty transcripts, null job/file
- Exposes `upload`, `reset`, `clearTranscripts`
- Throws when `apiClient` is null
- `clearTranscripts` and `reset` clear state correctly

### `use-realtime-transcription.test.ts` (100 lines)
- Initial state: idle, empty transcripts, null session
- Exposes `start`, `stop`, `clearTranscripts`
- Throws when `apiClient` is null
- `start` accepts `pipelineId`

---

## File Index

| File | Lines | Purpose |
|------|-------|---------|
| `features/audio/index.tsx` | 146 | Main page with tabbed layout |
| `features/audio/components/audio-config-panel.tsx` | 239 | Audio pipeline configuration |
| `features/audio/components/audio-mixer-panel.tsx` | 294 | Multi-source audio mixing |
| `features/audio/components/recording-controls.tsx` | 324 | Recording and monitoring |
| `features/audio/components/transcription-panel.tsx` | 437 | Live + file transcription UI |
| `features/audio/components/microphone-selector.tsx` | 87 | Microphone device selection |
| `features/audio/components/spectrogram-comparison.tsx` | 73 | Side-by-side spectrogram |
| `features/audio/components/spectrogram-viewer.tsx` | 125 | Canvas spectrogram renderer |
| `features/audio/components/voice-embedding-panel.tsx` | 158 | Voice embedding management |
| `store/audio-store.ts` | 155 | Audio state management |
| `hooks/use-realtime-transcription.ts` | 253 | WebSocket transcription hook |
| `hooks/use-file-transcription.ts` | 244 | SSE file transcription hook |
| `store/__tests__/audio-store.test.ts` | 424 | Audio store tests |
| `hooks/__tests__/use-file-transcription.test.ts` | 106 | File transcription hook tests |
| `hooks/__tests__/use-realtime-transcription.test.ts` | 100 | Realtime transcription hook tests |
