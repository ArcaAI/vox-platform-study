# 02 — Recording & Live Transcription

> **Wireframe**: Audio Recording & Transcription Panel  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `transcription.tsx`, `basic-consultation.tsx`, `dev/stt-v2.tsx`

---

## 1. Overview

Real-time audio capture with live transcription supporting **two distinct audio processing workflows**: **Local (client-side)** using web-based AI models (WebAssembly), and **Remote** via backend APIs and WebSocket/WebRPC. The panel provides VAD (Voice Activity Detection), noise cancellation, speaker diarization, and language selection. Supports both live recording and file upload workflows.

### Two Audio Processing Workflows

| Aspect | Local (Client-Side) | Remote (Backend API/Socket) |
|--------|--------------------|-----------------------------|
| **Processing** | WebAssembly AI models running in the browser | STT-V2 service via WebSocket/REST |
| **Latency** | Ultra-low (<500ms), no network round-trip | Low (<2s), depends on network |
| **Privacy** | Audio never leaves the device | Audio streamed to backend for processing |
| **Accuracy** | Good (constrained by browser resources) | Best (full GPU-accelerated models) |
| **Offline** | Works offline after model download | Requires network connectivity |
| **Models** | Whisper ONNX (WASM), Silero VAD, RNNoise | Whisper (GPU), NeMo, Azure Speech |
| **Status** | Available now | Available now (WebRPC: future) |

### Separate Interfaces per Workflow

Each workflow has its own dedicated page interface, accessible from the sidebar:

| Interface | Route | Description |
|-----------|-------|-------------|
| **Transcription (Local)** | `/transcription-local` | Self-contained local recording page with WASM model management, in-browser processing, and offline support |
| **Transcription (Remote)** | `/transcription-remote` | Backend-connected recording page with pipeline selector, WebSocket streaming, and file upload |

### Core Flows

```
LOCAL PAGE (/transcription-local):
  Navigate to "Transcription (Local)" →
  Download WASM models (one-time) →
  Start recording → Browser processes audio locally →
  VAD + Noise Filter + STT all run in-browser →
  Transcript updates in real time (no server round-trip)

REMOTE PAGE (/transcription-remote):
  Navigate to "Transcription (Remote)" →
  Verify backend connectivity →
  Start recording → WebSocket streams audio to STT-V2 →
  Server processes with GPU-accelerated models →
  Transcript segments returned via WebSocket →
  Transcript updates in real time

FILE UPLOAD (Remote page only):
  Drop/select file → POST to create job →
  SSE or poll for progress → Result displayed when complete
```

---

## 2. User Stories

### Doctor Consultation Workflow (2–3)

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 2 | Doctor | Record audio during a consultation and see a live transcript appear in real time, so that I don't need to take manual notes. | — |
| 3 | Doctor | Mute/unmute the microphone during a consultation, so that I can pause recording when discussing non-clinical matters. | — |

### Audio & Transcription (16–25)

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 16 | Doctor | Real-time noise cancellation during recording, so that background noise doesn't degrade transcript quality. | — |
| 17 | Doctor | Voice activity detection (VAD) to automatically detect when I'm speaking, so that silence segments are excluded from transcription. | — |
| 18 | Doctor | Upload a pre-recorded audio file for transcription, so that I can process recordings from external devices. | — |
| 19 | Doctor | Track the progress of a transcription job (queued, processing, complete), so that I know when results are ready. | — |
| 20 | Doctor | Select my preferred transcription language (English, Hindi, Tamil, Malayalam), so that the ASR model processes my speech correctly. | — |
| 21 | Doctor | Code-switching support during transcription (e.g., English-Hindi), so that multilingual consultations are accurately captured. | — |
| 22 | Doctor | Speaker diarization in transcripts, so that doctor and patient speech segments are labeled separately. | — |
| 23 | Doctor | Record a 10-second voice sample for speaker embedding, so that the system can identify my voice for better diarization. | — |
| 24 | Doctor | Choose between local (WebAssembly) and remote STT processing, so that I can balance privacy vs. accuracy. | — |
| 25 | Doctor | Word-level timestamps in transcriptions, so that I can click on a word and jump to that point in the audio. | — |

---

## 3. Wireframe Description

### 3.1 Recording Controls

Primary controls for live audio capture:

| Element | Description |
|---------|-------------|
| **Start/Stop** | Large primary button: Start (Circle icon) when idle, Stop (Square icon, destructive) when recording |
| **Mute/Unmute** | Icon button toggles microphone mute; muted state visually distinct (MicOff icon) |
| **Timer** | Elapsed recording time (e.g., `2m 34s`) displayed during capture |
| **Status badges** | `Recording` / `Idle`, `Muted` / `Unmuted`, `Speaking` / `Silence` (VAD indicator) |
| **WebSocket status** | Green pulse dot when connected, gray when disconnected; "Processing" badge when STT is active |

**Behavior:**
- Mute guard: When muted, audio capture continues but no audio is sent to STT; visual state change (destructive badge) makes mute obvious
- VAD indicator: Green pulsing dot when speech detected, gray when silence

### 3.2 Audio Waveform Visualization

| Element | Description |
|---------|-------------|
| **Live waveform** | Real-time visualization of audio amplitude (bar or line graph) |
| **VAD state indicator** | Overlay or color change on waveform when speech is detected vs. silence |
| **Audio level meter** | Horizontal bar (0–100%) with color zones: green (0–40%), yellow (40–70%), red (70–100%) |

**Behavior:**
- Waveform provides immediate feedback that the microphone is capturing
- Level meter uses `audio.level` from SDK; updates at ~60fps

### 3.3 Local Transcription Page (`/transcription-local`)

A dedicated page for client-side audio processing. All elements are specific to the local workflow:

| Element | Description |
|---------|-------------|
| **Page header** | "Transcription — Local Processing" with laptop icon and "Client-Side" badge |
| **Privacy banner** | Info banner: "All audio processing happens in your browser. Audio never leaves this device." |
| **WASM model status card** | Shows each required model with download status |

**WASM Model Management Panel:**

| Element | Description |
|---------|-------------|
| **Whisper model selector** | Dropdown: Whisper Tiny (39MB), Whisper Base (74MB), Whisper Small (244MB); shows download status per model |
| **Download button** | Downloads selected model to browser IndexedDB (one-time); progress bar during download |
| **VAD model** | Silero VAD v5 — auto-loaded; status badge: "Ready" (green) or "Loading..." |
| **Noise filter** | RNNoise WASM; toggle on/off with status badge |
| **Offline indicator** | "Works offline" badge (green) when all models are downloaded |

**Audio Settings (Local):**

| Element | Description |
|---------|-------------|
| **Language selector** | Dropdown: English, Hindi, Tamil, Malayalam; supports code-switching |
| **Noise filter level** | Slider: Off / Low / Medium / High |
| **VAD sensitivity** | Slider: Low / Medium / High |

**SDK Config:** `sttProvider: 'local'`; uses `@arcaai/stt` and `@arcaai/vad` WASM plugins.

### 3.4 Remote Transcription Page (`/transcription-remote`)

A dedicated page for backend-connected audio processing. All elements are specific to the remote workflow:

| Element | Description |
|---------|-------------|
| **Page header** | "Transcription — Remote Processing" with cloud icon and "Backend" badge |
| **Backend status card** | STT service health, WebSocket connectivity, active sessions count |
| **Connection indicator** | Live WebSocket status: "Connected" (green pulse) / "Disconnected" (red) |

**Pipeline & Model Configuration:**

| Element | Description |
|---------|-------------|
| **STT pipeline selector** | Dropdown: Default STT, Medical Transcription, Multilingual; fetched from `/audio/pipelines` |
| **Server model info** | Shows active server-side model (e.g., "Whisper Large v3 — GPU accelerated") |
| **Noise filter** | Server-side noise cancellation toggle |

**Audio Settings (Remote):**

| Element | Description |
|---------|-------------|
| **Language selector** | Dropdown: English, Hindi, Tamil, Malayalam; supports code-switching |
| **Noise filter level** | Slider: Off / Low / Medium / High |

**File Upload Zone** (Remote page only):
- Drag-and-drop zone for pre-recorded audio files
- Format validation, size validation, progress bar, job tracking
- (See section 3.6 for full details)

**SDK Config:** `sttProvider: 'backend'`; connects WebSocket to `ws://host/ws/stt-v2/stream`. Pipeline ID passed via `audio.start({ pipelineId })`.

### 3.5 Live Transcript Panel (Shared)

| Element | Description |
|---------|-------------|
| **Speaker-diarized segments** | Each segment shows `Doctor` or `Patient` label (or Speaker 1/2/3 if diarization not resolved) |
| **Timestamps** | Per-segment start time (e.g., `0:42`) |
| **Interim vs. final text** | Interim text in italic/muted; final text in normal weight |
| **Auto-scroll** | New segments scroll into view; user can manually scroll up to read; auto-scroll resumes when new content arrives |

**Behavior:**
- Segments from `audio.transcriptSegments` (TranscriptSegment[])
- Color-coded labels: Doctor (blue), Patient (green), Speaker 3 (amber), Speaker 4 (purple)
- Empty state: "No transcript yet. Start recording to see live transcription."

### 3.6 File Upload Zone (Remote Page Only)

| Element | Description |
|---------|-------------|
| **Drag-and-drop** | Drop zone with dashed border; hover state on drag-over |
| **Format validation** | Accepted: `.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`, `.webm`; error message for unsupported types |
| **Size validation** | Max 100 MB; error message for oversized files |
| **Progress bar** | Upload progress 0–100% during upload |
| **Job tracking** | After upload, `JobProgressTracker` shows status (pending → processing → completed/failed), progress %, elapsed time, cancel button |

**Behavior:**
- `FileUploadZone` validates before calling `onFileSelect`
- Upload uses `POST /api/v1/audio/transcription-jobs` (or TRANSCRIBE endpoint) with `multipart/form-data`
- `consultationJob.streamJob(jobId, callbacks)` or `pollJob(jobId)` for status updates

### 3.7 Service Status Bar (Remote Page Only)

| Element | Description |
|---------|-------------|
| **Health indicators** | Per-service status: STT, API, WebSocket (healthy / degraded / unknown) |
| **Active sessions** | Count of active streaming sessions |
| **Processing jobs** | Count of in-progress transcription jobs |

**Behavior:**
- Uses `useMonitoring()` + `useHealthCheck()`; polls every 10s
- `ServiceStatusBar` component displays badges; aggregate status badge (healthy/destructive)

---

## 4. API Endpoints

Base URL: `/api/v1`. All endpoints require JWT or API Key unless noted.

### 4.1 Transcription Jobs

| Method | Path | Description | Request | Response |
|--------|------|-------------|---------|---------|
| POST | `/api/v1/audio/transcription-jobs` | Create transcription job | `FormData` (file) or JSON | `{ jobId, id?, status }` |
| POST | `/api/v1/audio/transcription-jobs/batch` | Create batch job | `{ files[], consultationId?, ... }` | `{ jobIds[] }` |
| POST | `/api/v1/audio/transcription-jobs/streaming` | Create streaming job | `{ consultationId?, pipelineId? }` | `{ jobId }` |
| POST | `/api/v1/audio/transcription-jobs/stream/session` | Create WebSocket session | `{ consultationId?, language? }` | `{ sessionId, wsUrl }` |
| GET | `/api/v1/audio/transcription-jobs` | List jobs (paginated) | Query: `page, limit, status, consultationId` | `PaginatedResponse<TranscriptionJob>` |
| GET | `/api/v1/audio/transcription-jobs/stats` | Job status counts | — | `{ pending, processing, completed, failed }` |
| GET | `/api/v1/audio/transcription-jobs/:id` | Get job by ID | — | `TranscriptionJob` |
| PATCH | `/api/v1/audio/transcription-jobs/:id/cancel` | Cancel job | — | `TranscriptionJob` |
| PATCH | `/api/v1/audio/transcription-jobs/:id/retry` | Retry failed job | — | `TranscriptionJob` |
| POST | `/api/v1/audio/transcription-jobs/transcribe` | Upload + SSE stream | `multipart/form-data` (file) | SSE stream + `jobId` in initial response |
| SSE | `/api/v1/audio/transcription-jobs/:jobId/stream` | Reconnect to job SSE | — | SSE stream (status, progress, result) |

### 4.2 WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| WebSocket | `ws://host/ws/stt-v2/stream` | Real-time audio streaming; client sends binary audio frames; server returns transcription segments |

### 4.3 Voice Embedding

| Method | Path | Description | Request | Response |
|--------|------|-------------|---------|---------|
| POST | `/api/v1/users/:id/voice-embedding` | Upload 10s voice sample | `multipart/form-data` (audio file) | `{ status, dimensions?, createdAt? }` |
| GET | `/api/v1/users/:id/voice-embedding` | Get embedding status | — | `{ exists, createdAt?, dimensions? }` |
| DELETE | `/api/v1/users/:id/voice-embedding` | Remove embedding | — | `204` |

### 4.4 Pipelines & AI Models

| Method | Path | Description | Request | Response |
|--------|------|-------------|---------|---------|
| POST | `/api/v1/audio/pipelines` | Create ASR pipeline | `{ name, slug, configYaml, ... }` | `SttPipeline` |
| GET | `/api/v1/audio/pipelines` | List pipelines | Query: `page, limit` | `PaginatedResponse<SttPipeline>` |
| GET | `/api/v1/audio/pipelines/:id` | Get pipeline | — | `SttPipeline` |
| GET | `/api/v1/audio/pipelines/slug/:slug` | Get by slug | — | `SttPipeline` |
| POST | `/api/v1/audio/ai-models` | Create AI model | `{ slug, taskType, source, ... }` | `AiModel` |
| GET | `/api/v1/audio/ai-models` | List models | Query: `page, limit, taskType` | `PaginatedResponse<AiModel>` |
| GET | `/api/v1/audio/ai-models/:id` | Get model | — | `AiModel` |
| GET | `/api/v1/audio/ai-models/task/:taskType` | Get by task (e.g., stt) | — | `AiModel[]` |

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useArca()` | Main entry: `session`, `audio`, `context`, `isReady`, `error` |
| `useArcaAudio()` | Standalone audio hook (alternative to `useArca().audio`) |
| `useConsultationJob()` | Job lifecycle: `streamJob`, `pollJob`, `cancelJob`, `job`, `status` |
| `useMonitoring()` | Active sessions, processing jobs |
| `useHealthCheck()` | Per-service health; `startPolling`, `stopPolling` |

### 5.2 Key Methods

| Method | Description |
|--------|-------------|
| `audio.start({ language?, pipelineId? })` | Start capture; connects WebSocket, begins streaming |
| `audio.stop()` | Stop capture; finalizes transcript, disconnects WebSocket |
| `audio.mute()` | Mute microphone (no audio sent to STT) |
| `audio.unmute()` | Unmute microphone |
| `audio.toggleNoiseFilter(enabled?)` | Toggle noise filter plugin |
| `audio.toggleVAD(enabled?)` | Toggle VAD plugin |
| `audio.toggleSTT(enabled?)` | Toggle STT plugin |
| `consultationJob.streamJob(jobId, { onStatus, onProgress, onResult })` | Subscribe to job via SSE; returns cleanup function |
| `consultationJob.pollJob(jobId, { intervalMs })` | Poll job status until terminal state |
| `consultationJob.cancelJob(jobId)` | Cancel in-progress job |

### 5.3 Types

| Type | Fields |
|------|--------|
| `AudioState` | `isCapturing`, `isMuted`, `level`, `isSpeaking`, `currentTranscript`, `plugins`, `error` |
| `TranscriptSegment` | `text`, `startTime`, `endTime`, `isFinal`, `speakerLabel?`, `confidence?`, `language?` |
| `AudioStartOptions` | `language?`, `pipelineId?` |
| `VADEvent` | `type: 'speech-start' \| 'speech-end' \| 'misfire'`, `timestamp`, `audioData?` |

---

## 6. Data Models

| Model | Description |
|-------|-------------|
| **AudioRecording** | MinIO reference; metadata (id, duration, format, sampleRate, etc.); created when recording is stored |
| **ContextItem** | `type: TRANSCRIPT`; stores final transcript content; linked to consultation; versioned |
| **TranscriptionJob** | `id`, `status` (QUEUED, PROCESSING, COMPLETED, FAILED), `progress`, `result`, `error`, `createdAt`, `completedAt` |
| **SttPipeline** | YAML-based ASR config; references AiModel slugs; tenant/user assignable |
| **AiModel** | Model registry; `slug`, `taskType`, `source`, `format`, `downloadStatus` |
| **VoiceEmbedding** | Speaker embedding stored in Qdrant; referenced by user ID; used for diarization |

---

## 7. Existing Implementation

### 7.1 Current Pages

| Page | Description |
|------|-------------|
| `transcription.tsx` | 2 tabs: **Live** (RecordingControls + TranscriptDisplay) and **Upload** (FileUploadZone + JobProgressTracker) |
| `basic-consultation.tsx` | Minimal audio: start/stop, mute/unmute, level meter, `currentTranscript` only |
| `dev/stt-v2.tsx` | Internal SDK demo: StreamingSessionManager, SttV2WebSocketClient, TranscriptionJobService, PipelineRegistry |

### 7.2 Current Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `RecordingControls` | `@/components/recording-controls` | Start/stop, mute/unmute, status badges, VAD indicator, language selector, level meter |
| `TranscriptDisplay` | `@/components/transcript-display` | Speaker-diarized segments, timestamps, interim/final styling, auto-scroll |
| `FileUploadZone` | `@/components/file-upload-zone` | Drag-and-drop, format/size validation, progress bar |
| `JobProgressTracker` | `@/components/job-progress-tracker` | Job ID, status badge, progress bar, elapsed time, cancel, expandable result |
| `StreamingTextDisplay` | `@/components/streaming-text-display` | Streaming text with copy button; used in summarization, not transcription |
| `ServiceStatusBar` | `@arcaai/ui` | Service health badges, active sessions, processing jobs |

### 7.3 Gaps

| Gap | Description |
|-----|-------------|
| No separate workflow pages | No dedicated Local and Remote transcription page interfaces — currently a single page with inline settings |
| No WASM model download UI | No UI for downloading/managing client-side WASM models (Whisper ONNX, Silero VAD, RNNoise) |
| No speaker diarization UI | TranscriptDisplay supports `speakerLabel` but backend may not yet return Doctor/Patient; UI ready |
| No voice embedding upload | No UI for recording 10s sample and calling `POST /users/:id/voice-embedding` |
| No word-level timestamp click-to-seek | TranscriptSegment has `startTime`/`endTime` but no `words[]`; no click handler to seek audio |
| Limited language options | RecordingControls has English, Malayalam, Vietnamese; missing Hindi, Tamil per spec |
| No STT model/pipeline selector | No pipeline dropdown for remote mode; no WASM model selector for local mode |
| No live waveform | Level meter only; no waveform visualization |

---

## 8. UX Best Practices

| Practice | Implementation |
|----------|----------------|
| **Separate pages per workflow** | Dedicated Local and Remote transcription pages accessible from the sidebar; no toggle or switcher needed — each page is self-contained with workflow-specific controls |
| **WASM model management (Local page)** | Show model download progress, size, and "ready" status; cache in IndexedDB for instant re-use; offline indicator |
| **Backend status (Remote page)** | Show STT service health, WebSocket connectivity, and pipeline info prominently at the top of the page |
| **Live waveform for recording feedback** | Provide real-time amplitude visualization so user knows mic is capturing |
| **Speaker diarization with color-coded labels** | Doctor (blue), Patient (green); consistent colors across segments |
| **Mute guard with visual state change** | Destructive badge when muted; icon change (MicOff); prevent accidental unmute confusion |
| **Language selector with code-switching support** | Support English, Hindi, Tamil, Malayalam; allow mixed-language sessions |
| **Auto-scroll transcript with manual override** | Auto-scroll to bottom on new content; if user scrolls up, pause auto-scroll until they scroll back down |
| **Format validation feedback** | Show clear error messages for unsupported file types and oversized files |
| **Job progress visibility** | Show status, progress %, elapsed time, and cancel option for long-running jobs |
| **Service status awareness** | Status bar visible so user knows if STT/API is degraded before starting; critical for Remote workflow |
