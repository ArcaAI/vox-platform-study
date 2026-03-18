# SDK-206: Agentic SDK v2 — Frontend ↔ Backend Gap Analysis

| Field | Value |
|-------|-------|
| **Ticket Number** | SDK-206 |
| **Created Date** | 2026-02-17 |
| **Last Updated** | 2026-02-17 |
| **Status** | Complete (All Layers + All Streams Complete) |
| **Related Tickets** | SDK-200, SDK-204, SDK-205, TASK-016, TASK-021 |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [Architecture Overview](#3-architecture-overview)
4. [Gap Analysis by Capability](#4-gap-analysis-by-capability)
   - [4.1 Local ASR (Speech-to-Text)](#41-local-asr-speech-to-text)
   - [4.2 Remote ASR (Backend STT via WebSocket)](#42-remote-asr-backend-stt-via-websocket)
   - [4.3 Local NER (Named Entity Recognition)](#43-local-ner-named-entity-recognition)
   - [4.4 Remote NER (via NLP Service)](#44-remote-ner-via-nlp-service)
   - [4.5 Remote Summarization](#45-remote-summarization)
   - [4.6 Session Management & Data Transformation](#46-session-management--data-transformation)
   - [4.7 Hooks & React Integration](#47-hooks--react-integration)
5. [Endpoint Mapping Matrix](#5-endpoint-mapping-matrix)
6. [Type Alignment Matrix](#6-type-alignment-matrix)
7. [Priority Classification](#7-priority-classification)
8. [Implementation Plan (Pending)](#8-implementation-plan-pending)
9. [Change History](#9-change-history)

---

## 1. Executive Summary

This document provides a comprehensive gap analysis between the `agentic-sdk-v2` (`@arcaai/vox`) frontend SDK and the backend services it integrates with. The SDK is the client-facing package that provides:

- **Local ASR** — Whisper models running in-browser via ONNX / transformer.js (`@arcaai/stt`)
- **Remote ASR** — Backend speech-to-text via WebSocket (`stt` gateway, `stt-v2` module)
- **Local NER** — Medical BERT model running in-browser via ONNX / transformer.js (`@arcaai/med-ner`)
- **Remote NER** — Backend named-entity-recognition via API (`nlp` service proxied through `api` app)
- **Remote Summarization** — Backend medical text generation via API (`smr` service through `api` app)
- **Session Management** — Consultation CRUD, context management, shared context (`api` app)
- **React Hooks** — Developer-friendly hooks (`useArca`, `useArcaSession`, `useArcaConfig`)

### Key Findings

| Severity | Count | Summary |
|----------|-------|---------|
| **Critical** (compilation / runtime breaks) | 9 | Zero stt-v2 integration (3), undefined endpoint constants, missing types, broken wiring |
| **High** (feature broken or unreachable) | 12 | Wrong endpoints, missing config paths, uninitialized pipelines, no pipeline/model discovery |
| **Medium** (missing feature parity) | 15 | No job tracking, no SSE reconnection, no file upload, no async jobs, no pagination |
| **Low** (DX improvement) | 5 | Missing toggle methods, missing hooks, loading states, legacy cleanup |

---

## 2. Scope & Methodology

### In Scope

| Component | Location | Purpose |
|-----------|----------|---------|
| `@arcaai/vox` (SDK v2) | `packages/agentic-sdk-v2/` | Frontend SDK package |
| API Gateway | `apps/api/` | NestJS backend, controllers |
| NLP Service | `apps/nlp/` | Python NER/classification service |
| STT Service | `apps/stt/` | Python speech-to-text service |
| SMR Service | `apps/smr/` | Python summarization service |
| Applications Package | `packages/applications/` | Shared backend service layer |
| Domain Package | `packages/domains/` | Shared entity models |

### Files Reviewed

**SDK (Frontend)**:
- `src/index.ts`, `src/core.ts`, `src/plugins.ts` — Entry points
- `src/types/*.ts` — All type definitions (config, consultation, context, summary, audio, pipeline, models, common)
- `src/core/AgenticClient.ts` — HTTP client
- `src/core/constants.ts` — Endpoint constants
- `src/core/TranscriptionPipeline.ts` — Audio processing pipeline
- `src/core/KnowledgePipeline.ts` — Text processing pipeline
- `src/core/PluginManager.ts` — Plugin orchestration
- `src/core/ModelRegistry.ts` — Model management
- `src/core/PersonalizationManager.ts` — User preferences
- `src/hooks/useArca.ts` — Main unified hook
- `src/hooks/useArcaSession.ts` — Session management hook
- `src/hooks/useArcaConfig.ts` — Configuration hook
- `src/store/agenticStore.ts` — Zustand state store
- `src/providers/AgenticProvider.tsx` — React provider

**Backend (API Gateway)**:
- `apps/api/src/modules/consultation/consultation.controller.ts` — Consultation endpoints
- `apps/api/src/modules/consultation/summary.controller.ts` — Summary endpoints
- `apps/api/src/modules/nlp/nlp.controller.ts` — NLP proxy
- `apps/api/src/modules/stt/stt.gateway.ts` — STT WebSocket gateway
- `apps/api/src/modules/stt-v2/*.controller.ts` — STT v2 REST/streaming endpoints

---

## 3. Architecture Overview

### SDK Package Structure

```
packages/agentic-sdk-v2/
├── src/
│   ├── index.ts                    # Full bundle (core + plugins)
│   ├── core.ts                     # Core-only bundle (~200KB)
│   ├── plugins.ts                  # Plugin hooks + pipelines
│   ├── types/
│   │   ├── config.ts               # AgenticConfig, AudioPluginConfig, ProcessingConfig
│   │   ├── consultation.ts         # Consultation, OpenSessionInput, SessionState
│   │   ├── context.ts              # ContextItem, MedicalEntity, NERData
│   │   ├── summary.ts              # SummaryResponse, DNAStyle, SummaryOptions
│   │   ├── audio.ts                # AudioState, TranscriptionResult, VADEvent
│   │   ├── pipeline.ts             # Pipeline types (Transcription + Knowledge)
│   │   ├── models.ts               # ModelRegistry types
│   │   └── common.ts               # AgenticError, HookStatus, Pagination
│   ├── core/
│   │   ├── AgenticClient.ts        # HTTP client with tracing
│   │   ├── constants.ts            # Endpoint path constants
│   │   ├── TranscriptionPipeline.ts # NoiseFilter → VAD → STT
│   │   ├── KnowledgePipeline.ts    # NER → SpellCheck → Summarization
│   │   ├── PluginManager.ts        # Plugin lifecycle orchestration
│   │   ├── ModelRegistry.ts        # Model catalog + selection
│   │   ├── PersonalizationManager.ts # Preference persistence
│   │   ├── SimpleCrossTabSync.ts   # BroadcastChannel cross-tab sync
│   │   └── logger/                 # Structured logging (Console, Highlight, Loki, OTel)
│   ├── hooks/
│   │   ├── useArca.ts              # Unified hook (session+audio+context+summary+pipelines)
│   │   ├── useArcaSession.ts       # Simplified session hook (get-or-create)
│   │   └── useArcaConfig.ts        # Preferences + model selection
│   ├── store/
│   │   └── agenticStore.ts         # Zustand store (state + actions + selectors)
│   └── providers/
│       └── AgenticProvider.tsx      # Root provider (initializes all managers)
├── package.json                     # @arcaai/vox, deps: @arcaai/stt, @arcaai/vad, etc.
└── examples/vite-app/               # Example Vite application
```

### Data Flow

```
┌──────────────────── Browser ────────────────────┐
│                                                   │
│  Microphone → NoiseFilter → VAD → STT (local)    │  TranscriptionPipeline
│                                     ↓             │
│                              Transcription Text    │
│                                     ↓             │
│                              NER (local/backend)   │  KnowledgePipeline
│                              SpellCheck (future)   │
│                                     ↓             │
│                              Context Item          │
│                                                   │
│  ───── OR via STT-V2 Remote Streaming ─────      │
│  1. POST /api/v1/transcription-jobs/stream/session│  → get sessionId
│  2. Connect WS /ws/stt-v2/stream?sessionId=X     │  → real-time audio
│  3. Send binary PCM frames or JSON audio          │  → receive transcripts
│  4. Send {type:'stop'} → finalize                 │
│                                                   │
└───────────────────────────────────────────────────┘
                        ↕ HTTP / WS
┌──────────────────── Backend (API Gateway) ──────┐
│                                                   │
│  Consultation APIs                                │
│  ├── POST /consultations/open                     │
│  ├── POST /consultations/:id/context              │
│  ├── POST /consultations/:id/summary              │
│  ├── POST /consultations/:id/summary/pre-summary  │
│  ├── GET  /consultations/:id/named-entities       │
│  └── POST /nlp/classify/tokens (proxy to NLP)    │
│                                                   │
│  STT-V2 APIs (NEW — all under /api/v1/)           │
│  ├── POST   .../transcription-jobs/stream/session │  ← create session
│  ├── WS     /ws/stt-v2/stream?sessionId=X        │  ← real-time audio
│  ├── POST   .../transcription-jobs/transcribe     │  ← file upload + SSE
│  ├── SSE    .../transcription-jobs/:id/stream     │  ← reconnect to job
│  ├── POST   .../transcription-jobs/streaming      │  ← create streaming job
│  ├── GET    .../transcription-jobs/:id            │  ← job status
│  ├── GET    .../transcription-jobs/consultation/X │  ← jobs by consultation
│  ├── PATCH  .../transcription-jobs/:id/cancel     │  ← cancel job
│  ├── GET    /api/v1/pipelines                     │  ← list ASR pipelines
│  ├── GET    /api/v1/pipelines/slug/:slug          │  ← get pipeline by slug
│  ├── GET    /api/v1/ai-models                     │  ← list AI models
│  └── GET    /api/v1/ai-models/task/:taskType      │  ← models by task
│                                                   │
│  Legacy STT (v1) — DEPRECATED                     │
│  └── WS /stt (old proxy gateway)                  │
│                                                   │
│  Python Services                                  │
│  ├── STT-V2 (Whisper, streaming via Redis)        │
│  ├── NLP    (Medical NER, classification)         │
│  └── SMR    (Medical summarization)               │
│                                                   │
└───────────────────────────────────────────────────┘
```

---

## 4. Gap Analysis by Capability

### 4.1 Local ASR (Speech-to-Text)

**Goal**: Whisper models running locally in the client browser via ONNX / transformer.js

**SDK Packages**: `@arcaai/stt` (workspace dep), `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/room`

#### What Exists (Working)

- `TranscriptionPipeline` supports `location: 'browser'` for all three stages
- STT config accepts `provider: 'local' | 'backend' | 'auto'`
- `@arcaai/stt` package provides `createSTT()` factory and `useSTT()` hook
- Pipeline chain: NoiseFilter → VAD → STT runs entirely in-browser
- `ModelRegistry` supports selecting STT model by ID (`modelId` config)
- Plugin system supports enable/disable/toggle per stage

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **ASR-L-01** | Medium | `useArca` hook missing `toggleSTT` and `toggleVAD` | `UseArcaAudio` interface only exposes `toggleNoiseFilter`. The `AudioActions` type defines `toggleSTT`/`toggleVAD` but `useArca` never wires them to the pipeline. Developers cannot toggle STT/VAD from the unified hook. | `src/hooks/useArca.ts` (lines 73-74, 1107-1136) |
| **ASR-L-02** | Low | No model download progress exposed in `useArca` | `STTPluginState` has `modelLoadProgress` field, and `ModelRegistry` has loading states, but the hook never updates the store's `audioPlugins.stt.modelLoadProgress`. Large model downloads (~100MB+) have no progress indicator. | `src/hooks/useArca.ts`, `src/store/agenticStore.ts` |
| **ASR-L-03** | Low | `auto` provider fallback logic not visible | STT config supports `provider: 'auto'` but the decision logic is delegated entirely to `@arcaai/stt`. SDK has no way to report which provider was selected or why. | `src/core/TranscriptionPipeline.ts` (line 147-148) |

---

### 4.2 Remote ASR (Backend STT-V2 via WebSocket)

**Goal**: Remote speech-to-text via the `stt-v2` module exposed by the `api` app

**Backend Components**:
- `SttV2StreamGateway` — WebSocket at `/ws/stt-v2/stream` (real-time audio streaming via Redis Streams)
- `TranscriptionJobController` — REST at `/api/v1/transcription-jobs` (job management + session creation)
- `TranscriptionStreamController` — REST+SSE at `/api/v1/transcription-jobs` (file upload + SSE streaming)
- `PipelineController` — REST at `/api/v1/pipelines` (ASR pipeline configuration)
- `AiModelController` — REST at `/api/v1/ai-models` (model registry)
- `SttInternalController` — REST at `/internal/stt` (service-to-service, NOT for SDK)
- `SttGateway` — Legacy WS at `/stt` (v1, DEPRECATED — old proxy to Python STT service)

> **Note**: The old `SttGateway` (v1) at `/stt` is a simple pass-through proxy. The new `SttV2StreamGateway` uses Redis Streams for audio transport and supports JWT/API-key authentication. **The SDK should target stt-v2 exclusively.**

#### Backend STT-V2 Connection Flow (What the SDK Must Implement)

```
┌─ SDK (Browser) ─────────────────────────────────────────────────┐
│                                                                   │
│  Step 1: Create streaming session                                 │
│  POST /api/v1/transcription-jobs/stream/session                  │
│  Body: { pipelineId, consultationId?, sampleRate?, language?,    │
│          codeSwitching?, microphoneId? }                          │
│  Response: { sessionId, status, maxConcurrent, currentActive,    │
│             wsUrl: '/ws/stt-v2/stream' }                         │
│                                                                   │
│  Step 2: Connect WebSocket                                        │
│  WS /ws/stt-v2/stream?sessionId=<id>&token=<JWT> (or &key=<key>)│
│  Server sends: { type:'status', status:'connected', message:... }│
│                                                                   │
│  Step 3: Stream audio frames                                      │
│  Binary:  send raw PCM buffer (int16 LE, mono)                   │
│  JSON:    send { type:'audio', seq:N, data:'<base64>' }          │
│  Server sends: { type:'transcript', text, startTime, endTime,    │
│                  isFinal }                                        │
│                                                                   │
│  Step 4: Stop recording                                           │
│  Send: { type:'stop' }                                            │
│  Server sends: { type:'status', status:'finalizing' }            │
│                                                                   │
│  Step 5: Close session                                            │
│  Send: { type:'close' }                                           │
│  Server sends: { type:'status', status:'closed' }                │
│  Connection closes                                                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

#### Backend STT-V2 API Surface (Complete)

**Streaming Session (SDK-relevant)**:

| Route | Method | Controller | Purpose | Auth |
|-------|--------|-----------|---------|------|
| `/api/v1/transcription-jobs/stream/session` | POST | `TranscriptionJobController` | Create streaming session, returns `sessionId` + `wsUrl` | JWT |
| `/ws/stt-v2/stream?sessionId=X&token=JWT` | WS | `SttV2StreamGateway` | Real-time audio streaming (binary PCM or JSON audio frames) | JWT or API key |

**Transcription Jobs (SDK-relevant)**:

| Route | Method | Controller | Purpose | Auth |
|-------|--------|-----------|---------|------|
| `/api/v1/transcription-jobs` | POST | `TranscriptionJobController` | Create generic transcription job | JWT |
| `/api/v1/transcription-jobs/batch` | POST | `TranscriptionJobController` | Create batch job (pre-recorded audio) | JWT |
| `/api/v1/transcription-jobs/streaming` | POST | `TranscriptionJobController` | Create streaming transcription job | JWT |
| `/api/v1/transcription-jobs/transcribe` | POST | `TranscriptionStreamController` | Upload audio file + SSE stream results | JWT |
| `/api/v1/transcription-jobs/:id/stream` | SSE | `TranscriptionStreamController` | Reconnect to existing job's SSE stream | JWT |
| `/api/v1/transcription-jobs/:id` | GET | `TranscriptionJobController` | Get job by ID | JWT |
| `/api/v1/transcription-jobs` | GET | `TranscriptionJobController` | List jobs (paginated) | JWT |
| `/api/v1/transcription-jobs/stats` | GET | `TranscriptionJobController` | Job status counts | JWT |
| `/api/v1/transcription-jobs/consultation/:id` | GET | `TranscriptionJobController` | Get jobs by consultation | JWT |
| `/api/v1/transcription-jobs/status/:status` | GET | `TranscriptionJobController` | Get jobs by status | JWT |
| `/api/v1/transcription-jobs/:id/cancel` | PATCH | `TranscriptionJobController` | Cancel job | JWT |
| `/api/v1/transcription-jobs/:id/retry` | PATCH | `TranscriptionJobController` | Retry failed job | JWT |

**ASR Pipelines (SDK-relevant for configuration)**:

| Route | Method | Controller | Purpose | Auth |
|-------|--------|-----------|---------|------|
| `/api/v1/pipelines` | GET | `PipelineController` | List ASR pipelines (paginated) | JWT |
| `/api/v1/pipelines/:id` | GET | `PipelineController` | Get pipeline by ID | JWT |
| `/api/v1/pipelines/slug/:slug` | GET | `PipelineController` | Get pipeline by slug | JWT |

**AI Models (SDK-relevant for model selection)**:

| Route | Method | Controller | Purpose | Auth |
|-------|--------|-----------|---------|------|
| `/api/v1/ai-models` | GET | `AiModelController` | List AI models (paginated) | JWT |
| `/api/v1/ai-models/:id` | GET | `AiModelController` | Get model by ID | JWT |
| `/api/v1/ai-models/slug/:slug` | GET | `AiModelController` | Get model by slug | JWT |
| `/api/v1/ai-models/task/:taskType` | GET | `AiModelController` | Get models by task type | JWT |
| `/api/v1/ai-models/status/downloaded` | GET | `AiModelController` | Get downloaded models | JWT |

**Internal APIs (NOT for SDK — service-to-service only)**:

| Route | Method | Controller | Purpose | Auth |
|-------|--------|-----------|---------|------|
| `/internal/stt/transcripts` | POST | `SttInternalController` | STT-V2 creates transcript context item | API key |
| `/internal/stt/jobs/:id/start` | PATCH | `SttInternalController` | STT-V2 marks job started | API key |
| `/internal/stt/jobs/:id/progress` | PATCH | `SttInternalController` | STT-V2 updates progress | API key |
| `/internal/stt/jobs/:id/complete` | PATCH | `SttInternalController` | STT-V2 marks job complete | API key |
| `/internal/stt/jobs/:id/fail` | PATCH | `SttInternalController` | STT-V2 marks job failed | API key |
| `/internal/stt/audio-records` | POST | `SttInternalController` | STT-V2 creates audio record | API key |

**WebSocket Protocol Details** (`SttV2StreamGateway`):

Client → Server messages:
- **Binary**: Raw PCM audio buffer (int16 LE, mono)
- **JSON audio**: `{ type: 'audio', seq: number, data: string (base64 PCM), microphoneId?: string }`
- **Stop**: `{ type: 'stop' }`
- **Close**: `{ type: 'close' }`

Server → Client messages:
- **Transcript**: `{ type: 'transcript', text: string, startTime: number, endTime: number, isFinal: boolean }`
- **Status**: `{ type: 'status', status: string, message: string }`
- **Error**: `{ type: 'error', code: string, message: string }`

WS Authentication (query params, since browsers can't send custom headers):
- JWT: `?sessionId=<id>&token=<jwt>`
- API key: `?sessionId=<id>&key=<api_key>`

**Create Session Request DTO** (`CreateStreamingSessionRequestDto`):
- `pipelineId: string` — Required. Pipeline UUID or slug.
- `consultationId?: string` — Optional. Links session to consultation.
- `sampleRate?: number` — Optional (default: 16000). Range: 8000-48000.
- `language?: string` — Optional. ISO 639-1 code (e.g., `"en"`, `"th"`).
- `codeSwitching?: boolean` — Optional. Multilingual code-switching.
- `microphoneId?: string` — Optional. Microphone device identifier.

#### What Exists in SDK (Minimal)

- `TranscriptionPipelineConfig.stt.sttSocket?: string` — A field exists but is never wired to user config
- `createSTT()` in `@arcaai/stt` accepts `sttSocket` parameter — The underlying package supports remote mode
- The old `SttGateway` (v1) WS path `/stt` was the prior target — now deprecated

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **ASR-R-01** | **Critical** | SDK has zero stt-v2 endpoint constants | The entire `stt-v2` module (session creation, WebSocket URL, transcription jobs, pipelines, AI models) is **completely absent** from `constants.ts`. SDK cannot call any stt-v2 API. | `src/core/constants.ts` — needs `STT_V2_ENDPOINTS`, `PIPELINE_ENDPOINTS`, `AI_MODEL_ENDPOINTS` |
| **ASR-R-02** | **Critical** | No streaming session management in SDK | The stt-v2 connection flow requires: (1) `POST .../stream/session` to get `sessionId`, (2) connect WS with `sessionId`. SDK has no code for this two-step flow. | Missing entirely from SDK — needs `StreamingSessionManager` or similar |
| **ASR-R-03** | **Critical** | No WebSocket client for stt-v2 streaming | SDK has no WebSocket client implementation that speaks the stt-v2 protocol (binary PCM frames, JSON audio messages, stop/close control messages, transcript result handling). The old `SttGateway` (v1) at `/stt` used a different protocol. | Missing entirely from SDK |
| **ASR-R-04** | **High** | No `sttSocket` wiring from `AgenticConfig` to pipeline | `STTPluginConfig` (user-facing config) has **no `sttSocket` field**. `PluginManager.buildTranscriptionPipelineConfig()` never passes a socket URL. Even though `TranscriptionPipelineConfig.stt.sttSocket` exists, it's dead code. | `src/types/config.ts` (line 180-189), `src/core/PluginManager.ts` (line 431-457) |
| **ASR-R-05** | **High** | `AgenticConfig` lacks WebSocket/streaming configuration | There is no `wsUrl` or `sttBaseUrl` field in `ApiConfig`. The SDK expects `baseUrl` for REST but has no parallel config for the WebSocket endpoint path (`/ws/stt-v2/stream`). | `src/types/config.ts` (line 125-134) |
| **ASR-R-06** | **High** | No ASR pipeline discovery in SDK | Backend has `GET /api/v1/pipelines` and `GET /api/v1/pipelines/slug/:slug` for discovering available ASR pipeline configurations. SDK `ModelRegistry` only handles local models — it doesn't fetch backend pipeline configs. | `src/core/ModelRegistry.ts`, `src/core/constants.ts` |
| **ASR-R-07** | **High** | No backend AI model catalog integration | Backend has `GET /api/v1/ai-models`, `GET .../task/:taskType`, `GET .../status/downloaded`. SDK `MODEL_ENDPOINTS` defines `/models` and `/models/:id` which **don't match** the real backend paths (`/api/v1/ai-models`). | `src/core/constants.ts` (lines 87-90) — wrong paths |
| **ASR-R-08** | Medium | No transcription job tracking in SDK | Backend tracks transcription jobs with status, progress, consultation association. SDK has no job types, no status polling, no ability to query `GET .../transcription-jobs/consultation/:id`. | Missing entirely from SDK types and hooks |
| **ASR-R-09** | Medium | No SSE reconnection support | Backend offers `GET .../transcription-jobs/:id/stream` for reconnecting to an existing job's SSE stream (e.g., after browser refresh). SDK has no SSE client or reconnection logic. | Missing entirely |
| **ASR-R-10** | Medium | No file-upload transcription support | Backend offers `POST .../transcription-jobs/transcribe` for uploading audio files with SSE streaming results. SDK has no file-upload transcription flow. | Missing entirely |
| **ASR-R-11** | Low | Legacy STT v1 gateway still referenced | The old `SttGateway` at `/stt` is deprecated. Any existing references or documentation pointing to v1 should be updated to point to stt-v2. | Documentation + any leftover references |

---

### 4.3 Local NER (Named Entity Recognition)

**Goal**: Medical BERT model running locally in the client browser via ONNX / transformer.js

**SDK Package**: `@arcaai/med-ner` (optional peer dependency, ~300MB)

#### What Exists (Working)

- `KnowledgePipeline` supports `ner.location: 'browser'`
- Lazy-loads `@arcaai/med-ner` via dynamic `import()`
- `PluginManager` has separate `initializeNER()` and `extractEntities()` methods
- Config supports: model selection, threshold, entity types, quantization (`dtype: 'fp32' | 'fp16' | 'q8' | 'q4'`)
- `useArca().pipelines.triggerNER()` triggers manual NER via the knowledge pipeline

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **NER-L-01** | **High** | `MedicalEntity` type mismatch between local NER output and SDK type | Local NER result maps to `{ text, type, start, end, score }`. But the `MedicalEntity` interface uses `entityType` (not `type`), `confidence` (not `score`), `startOffset`/`endOffset` (not `start`/`end`). The mapping in `KnowledgePipeline.executeNER()` at line 443-448 assigns `e.type` to `type` property, but `MedicalEntity` has no `type` field — it has `entityType`. | `src/core/KnowledgePipeline.ts` (lines 439-448), `src/types/context.ts` (lines 66-83) |
| **NER-L-02** | **High** | No auto-NER on completed transcriptions | When `ner.triggerMode: 'auto'`, NER runs when `pipeline.process()` is called explicitly. But there is **no automatic wiring** that feeds completed transcriptions into the knowledge pipeline. `useArca`'s `onTranscription` callback adds text to context via API but never feeds it to the knowledge pipeline for NER extraction. | `src/hooks/useArca.ts` (lines 437-466) |
| **NER-L-03** | **High** | Knowledge pipeline not initialized by default | `AgenticProvider` creates the `PluginManager` but **never calls** `pluginManager.initializeKnowledgePipeline()`. The knowledge pipeline requires explicit initialization which is undocumented. Any call to `pipelines.triggerNER()` will throw "Knowledge pipeline not initialized". | `src/providers/AgenticProvider.tsx` (lines 118-121) |

---

### 4.4 Remote NER (via NLP Service)

**Goal**: Remote NER via the `nlp` Python service exposed through the `api` gateway

**Backend Components**: `NlpController` (proxy at `/nlp/*`), `ConsultationController` (aggregate NER at `/consultations/:id/named-entities`)

#### What Exists (Partial)

- `KnowledgePipeline` supports `ner.location: 'backend'` which calls `this.apiClient.post('/api/ner/extract', { text })`
- Backend `NlpController` proxies to NLP Python service: `POST /nlp/classify/tokens`
- SDK `ENTITY_ENDPOINTS` maps to consultation-scoped entity endpoints
- `useArca().context.extractEntities()` calls `GET /consultations/:id/entities` or `GET /consultations/:id/context/:itemId/entities`
- Backend `ConsultationController` has `GET /consultations/:id/named-entities` (aggregate NER with chain scope)

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **NER-R-01** | **Critical** | Wrong endpoint in `KnowledgePipeline.executeNER()` | Backend NER calls `/api/ner/extract` — **this endpoint does not exist**. The actual NLP service endpoint is `POST /nlp/classify/tokens` (via NLP proxy). | `src/core/KnowledgePipeline.ts` (line 454-458) |
| **NER-R-02** | **High** | Two separate NER code paths with no unification | Path 1: `useArca().context.extractEntities()` → fetches already-stored entities via `GET /consultations/:id/entities` (aggregate endpoint). Path 2: `KnowledgePipeline.executeNER()` → tries real-time extraction via non-existent `/api/ner/extract`. These paths are disconnected; the pipeline result is never stored. | `src/hooks/useArca.ts` (lines 735-781), `src/core/KnowledgePipeline.ts` (lines 420-481) |
| **NER-R-03** | Medium | Backend NER extraction tied to summary controller | On the backend, NER is triggered via `POST /consultations/:id/summary/:contextItemId/extract-entities` (sync, 204 response) or the async variant. SDK `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES` constant exists in `constants.ts` but **is never called from any hook or action**. | `src/core/constants.ts` (line 54-55), no usages |
| **NER-R-04** | Medium | NLP proxy endpoints absent from SDK constants | The NLP proxy endpoints (`/nlp/classify/tokens`, `/nlp/classify/text`, `/nlp/correct`, `/nlp/suggest`) are completely absent from SDK endpoint constants. | `src/core/constants.ts` — missing `NLP_ENDPOINTS` |
| **NER-R-05** | Medium | `ENTITY_ENDPOINTS` paths don't match backend | SDK defines `GET /consultations/:id/entities` and `GET /consultations/:id/context/:itemId/entities`. Backend has `GET /consultations/:id/named-entities` (with `?scope=single|chain`). The paths don't match. | `src/core/constants.ts` (lines 61-66) vs `consultation.controller.ts` (lines 502-525) |

---

### 4.5 Remote Summarization

**Goal**: Remote medical text summarization via the `smr` service exposed through the `api` gateway

**Backend Components**: `SummaryController` at `/consultations/:consultationId/summary`

#### What Exists (Working)

- `useArca().summary.generatePreSummary()` → `POST /consultations/:id/summary/pre-summary` ✅
- `useArca().summary.generateSummary()` → `POST /consultations/:id/summary` ✅
- `useArca().summary.updateSummary()` → `PATCH /consultations/:id/summary/:contextItemId` ✅
- `SUMMARY_ENDPOINTS` constants largely match backend `SummaryController` routes

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **SUM-01** | **High** | No async summary generation support | Backend has `POST .../summary/async`, `POST .../pre-summary/async`, `POST .../comprehensive/async` that return job IDs (HTTP 202). SDK has **no async job creation, polling, or SSE support**. Long-running summary generations will timeout. | No implementation exists |
| **SUM-02** | Medium | No comprehensive (cross-chain) summary support | Backend has `POST .../summary/comprehensive` for aggregating content across linked consultations. SDK has no types, constants, or methods for comprehensive summaries. | `ComprehensiveSummaryResponse` type exists in backend only |
| **SUM-03** | Medium | No `getLatestPreSummary` endpoint | Backend has `GET .../summary/pre-summary/latest`. SDK `SUMMARY_ENDPOINTS.LATEST` only maps the latest summary, not the latest pre-summary. | `src/core/constants.ts` (lines 46-56) |
| **SUM-04** | Medium | No `getSummaries` (list all) usage in hook | Backend has `GET /consultations/:id/summary` returning all summaries. SDK accumulates summaries locally but never bulk-fetches from backend on consultation load. | `src/hooks/useArca.ts` — no `loadSummaries()` |
| **SUM-05** | **Critical** | `KnowledgePipeline.executeSummarization()` uses wrong endpoint | Calls `/api/consultations/${contextId}/summaries` (plural) but backend path is `/consultations/:id/summary` (singular, no `/api` prefix). | `src/core/KnowledgePipeline.ts` (lines 545-547) |
| **SUM-06** | **High** | DNA analysis (`analyzeDNA`) has no backend endpoint | `useArca().summary.analyzeDNA()` calls `POST /dna/analyze` via `DNA_ENDPOINTS.ANALYZE`. There is **no `DnaController`** or `/dna/*` route on the backend. Also `DNA_ENDPOINTS.GET_STYLE` calls `GET /dna/styles/:userId` which also doesn't exist. | `src/core/constants.ts` (lines 79-82), no matching backend controller |

---

### 4.6 Session Management & Data Transformation

**Goal**: Consultation lifecycle management, context CRUD, and shared context via the `api` gateway

**Backend Components**: `ConsultationController` at `/consultations`

#### What Exists (Two Implementations)

**`useArcaSession` (Simplified — matches backend)**:
- `open()` → `POST /consultations/open` (get-or-create) ✅
- `addContext()` → `POST /consultations/:id/context` ✅
- `getSharedContext()` → `GET /consultations/:id/context/shared` ✅
- `getPatientHistory()` → `GET /consultations/patient/:id/history` ✅
- `loadConsultation()` → `GET /consultations/:id` ✅
- Cross-tab sync via `SimpleCrossTabSync` (BroadcastChannel)

**`useArca` (Full — references non-existent endpoints)**:
- `session.create()` → calls `CONSULTATION_ENDPOINTS.CREATE` ❌
- `session.startRevisit()` → calls `CONSULTATION_ENDPOINTS.REVISIT()` ❌
- `session.load()` → calls `CONSULTATION_ENDPOINTS.CHAIN()` ❌
- `session.end()` → calls `CONSULTATION_ENDPOINTS.END()` ❌
- `session.pause()` → calls `CONSULTATION_ENDPOINTS.PAUSE()` ❌
- `session.resume()` → calls `CONSULTATION_ENDPOINTS.RESUME()` ❌

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **SES-01** | **Critical** | `useArca` references endpoint constants that don't exist | The hook calls `CONSULTATION_ENDPOINTS.CREATE`, `.REVISIT()`, `.CHAIN()`, `.END()`, `.PAUSE()`, `.RESUME()`, `.BY_PATIENT_DATE()`. But `constants.ts` only defines `OPEN`, `GET`, `PATIENT_HISTORY`, `PATIENT_DATE`. This is either a compilation error or these were removed without updating the hook. | `src/hooks/useArca.ts` (lines 208, 258, 265, 308, 340, 361, 391, 406), `src/core/constants.ts` (lines 19-28) |
| **SES-02** | **Critical** | `core.ts` exports types not defined in `types/consultation.ts` | `core.ts` exports `ConsultationStatus`, `CreateConsultationInput`, `StartRevisitInput`, `UpdateConsultationInput`. The `types/consultation.ts` file only defines `Consultation`, `OpenSessionInput`, `SessionState`, `SessionActions`. The exported types do not exist. | `src/core.ts` (lines 84-86), `src/types/consultation.ts` |
| **SES-03** | **High** | `CONTEXT_ENDPOINTS.UPDATE` not defined | `useArca` calls `CONTEXT_ENDPOINTS.UPDATE(consultation.id, id)` at line 681, but `constants.ts` only defines `ADD`, `GET`, `SHARED` in `CONTEXT_ENDPOINTS`. | `src/hooks/useArca.ts` (line 681), `src/core/constants.ts` (lines 33-40) |
| **SES-04** | Medium | No consultation timeline support | Backend has `GET /consultations/:id/timeline` with `scope=chain\|single`. SDK has no timeline type, endpoint constant, or hook method. | Missing entirely from SDK |
| **SES-05** | Medium | No context version history support | Backend has `GET /consultations/:id/context/:contextId/versions` and `GET .../versions/:versionNumber`. SDK has no version-related types or methods. | Missing entirely from SDK |
| **SES-06** | Medium | No pagination support in SDK | Backend supports optional `page`/`limit` query params on patient history, context items, and patient-date endpoints. SDK types/methods have no pagination parameters. `PaginatedResponse` and `PaginationParams` types exist in `common.ts` but are never used. | `src/types/common.ts` (types exist), hooks never use them |
| **SES-07** | Low | No dedicated transcription/case-note fetch endpoints | Backend has `GET /consultations/:id/context/transcriptions` and `GET .../context/case-notes`. SDK filters locally via store selectors (`selectTranscriptions`, `selectCaseNotes`). | `src/store/agenticStore.ts` (lines 322-329) |

---

### 4.7 Hooks & React Integration

**Goal**: Provide developer-friendly React hooks and methods for frontend integration

**Components**: `AgenticProvider`, `useArca`, `useArcaSession`, `useArcaConfig`

#### What Exists (Working)

- `AgenticProvider` initializes `AgenticClient`, `PluginManager`, `PersonalizationManager`, `ModelRegistry`, `SDKLogger` into Zustand store
- `useArca()` returns `{ session, audio, context, summary, pipelines, isAudioSource, isReady, error }`
- `useArcaSession()` returns simplified session-only interface with cross-tab sync
- `useArcaConfig()` returns preferences + model selection
- Zustand store provides fine-grained selectors and actions
- All hooks log operations via structured `SDKLogger`

#### Gaps

| ID | Severity | Gap | Detail | Files Affected |
|----|----------|-----|--------|----------------|
| **HOOK-01** | **Critical** | `useArca` and `useArcaSession` are incompatible | `useArca.session` exposes `create`/`startRevisit`/`end`/`pause`/`resume` (old lifecycle model that references non-existent endpoints). `useArcaSession` exposes `open` (get-or-create model that matches backend). Developers choosing `useArca` get broken session management. | `src/hooks/useArca.ts`, `src/hooks/useArcaSession.ts` |
| **HOOK-02** | **Critical** | `PluginManager` not passed `apiClient` in `AgenticProvider` | `AgenticProvider.tsx` line 120-121 creates `PluginManager(audioConfig, logger)` without the third `apiClient` parameter. This means `KnowledgePipeline` backend calls (NER, summarization) **always fail** with "API client required for backend NER/summarization". | `src/providers/AgenticProvider.tsx` (line 120-121) |
| **HOOK-03** | **High** | `loadDNAStyle` not implemented | `SummaryActions` interface defines `loadDNAStyle(userId?: string)` but it is **never implemented** in any hook. | `src/types/summary.ts` (line 147), `src/hooks/useArca.ts` — missing |
| **HOOK-04** | Medium | No `useNER` or dedicated NER hook | Unlike `useVAD`, `useSTT`, `useNoiseFilter` which are re-exported in `plugins.ts`, there is no `useNER` or `useMedNER` re-export. Only a comment telling developers to import directly. | `src/plugins.ts` (lines 78-86) |
| **HOOK-05** | Medium | `audio.toggleSTT` and `audio.toggleVAD` missing from returned interface | `UseArcaAudio` interface (line 61-74) only includes `toggleNoiseFilter`. The store and pipeline support toggling all three stages, but the hook doesn't expose STT/VAD toggles. | `src/hooks/useArca.ts` (lines 61-74, 1107-1136) |
| **HOOK-06** | Medium | Store summaries not loaded on consultation open | When opening or loading a consultation, summaries from the backend are never fetched. Only summaries generated during the current session are available in `store.summaries`. | `src/hooks/useArcaSession.ts` — missing summary fetch |
| **HOOK-07** | Low | No error recovery / retry logic | All API calls in hooks throw on failure but provide no retry mechanism. `isRetriableError()` utility exists but is never used in any hook. | `src/utils/errorUtils.ts` (exported), hooks don't use it |

---

## 5. Endpoint Mapping Matrix

### Consultation Endpoints

| Backend Route | HTTP | Backend Controller | SDK Constant | SDK Hook Usage | Status |
|--------------|------|-------------------|--------------|----------------|--------|
| `POST /consultations/open` | POST | `ConsultationController.open` | `CONSULTATION_ENDPOINTS.OPEN` | `useArcaSession.open()` | ✅ Match |
| `GET /consultations/:id` | GET | `ConsultationController.getById` | `CONSULTATION_ENDPOINTS.GET(id)` | `useArcaSession.loadConsultation()` | ✅ Match |
| `POST /consultations/:parentId/revisit` | POST | `ConsultationController.createRevisit` | **Missing** | `useArca.session.startRevisit()` calls undefined `.REVISIT()` | ❌ Missing constant |
| `GET /consultations/:id/chain` | GET | `ConsultationController.getConsultationChain` | **Missing** | `useArca.session.load()` calls undefined `.CHAIN()` | ❌ Missing constant |
| `GET /consultations/patient/:patientId/history` | GET | `ConsultationController.getPatientHistory` | `CONSULTATION_ENDPOINTS.PATIENT_HISTORY(id)` | `useArcaSession.getPatientHistory()` | ✅ Match |
| `GET /consultations/patient/:patientId/date/:date` | GET | `ConsultationController.getByPatientAndDate` | `CONSULTATION_ENDPOINTS.PATIENT_DATE(id, date)` | `useArca.session.findByPatientDate()` calls undefined `.BY_PATIENT_DATE()` | ⚠️ Constant exists but hook uses wrong name |
| `GET /consultations/:id/timeline` | GET | `ConsultationController.getTimeline` | **Missing** | Not implemented | ❌ Missing |
| `GET /consultations/:id/named-entities` | GET | `ConsultationController.getAggregateNamedEntities` | **Missing** (wrong path in `ENTITY_ENDPOINTS`) | `useArca.context.extractEntities()` uses different path | ❌ Path mismatch |

### Context Endpoints

| Backend Route | HTTP | Backend Controller | SDK Constant | SDK Hook Usage | Status |
|--------------|------|-------------------|--------------|----------------|--------|
| `POST /consultations/:id/context` | POST | `ConsultationController.addContext` | `CONTEXT_ENDPOINTS.ADD(id)` | `useArcaSession.addContext()`, `useArca.addCaseNote()` | ✅ Match |
| `PATCH /consultations/:id/context/:contextId` | PATCH | `ConsultationController.updateContext` | **Missing** (`CONTEXT_ENDPOINTS.UPDATE` not defined) | `useArca.updateItem()` calls undefined `.UPDATE()` | ❌ Missing constant |
| `GET /consultations/:id/context` | GET | `ConsultationController.getContext` | `CONTEXT_ENDPOINTS.GET(id)` | Not directly called | ✅ Constant exists |
| `GET /consultations/:id/context/shared` | GET | `ConsultationController.getSharedContext` | `CONTEXT_ENDPOINTS.SHARED(id)` | `useArcaSession.getSharedContext()` | ✅ Match |
| `GET /consultations/:id/context/:contextId/versions` | GET | `ConsultationController.getContextVersionHistory` | **Missing** | Not implemented | ❌ Missing |
| `GET /consultations/:id/context/transcriptions` | GET | `ConsultationController.getTranscriptions` | **Missing** | Filtered locally | ⚠️ Works but inefficient |
| `GET /consultations/:id/context/case-notes` | GET | `ConsultationController.getCaseNotes` | **Missing** | Filtered locally | ⚠️ Works but inefficient |

### Summary Endpoints

| Backend Route | HTTP | Backend Controller | SDK Constant | SDK Hook Usage | Status |
|--------------|------|-------------------|--------------|----------------|--------|
| `POST /consultations/:id/summary` | POST | `SummaryController.generateSummary` | `SUMMARY_ENDPOINTS.GENERATE(id)` | `useArca.summary.generateSummary()` | ✅ Match |
| `POST /consultations/:id/summary/pre-summary` | POST | `SummaryController.generatePreSummary` | `SUMMARY_ENDPOINTS.PRE_SUMMARY(id)` | `useArca.summary.generatePreSummary()` | ✅ Match |
| `GET /consultations/:id/summary/latest` | GET | `SummaryController.getLatestSummary` | `SUMMARY_ENDPOINTS.LATEST(id)` | Not called | ⚠️ Constant exists, unused |
| `GET /consultations/:id/summary/pre-summary/latest` | GET | `SummaryController.getLatestPreSummary` | **Missing** | Not implemented | ❌ Missing |
| `GET /consultations/:id/summary` | GET | `SummaryController.getSummaries` | **Missing** | Not implemented | ❌ Missing |
| `PATCH /consultations/:id/summary/:contextItemId` | PATCH | `SummaryController.updateSummary` | `SUMMARY_ENDPOINTS.UPDATE(id, sid)` | `useArca.summary.updateSummary()` | ✅ Match |
| `POST .../summary/:contextItemId/extract-entities` | POST | `SummaryController.extractEntities` | `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES(id, cid)` | **Never called** | ⚠️ Constant exists, unused |
| `POST .../summary/comprehensive` | POST | `SummaryController.generateComprehensiveSummary` | **Missing** | Not implemented | ❌ Missing |
| `POST .../summary/async` | POST | `SummaryController.generateSummaryAsync` | **Missing** | Not implemented | ❌ Missing |
| `POST .../summary/pre-summary/async` | POST | `SummaryController.generatePreSummaryAsync` | **Missing** | Not implemented | ❌ Missing |
| `POST .../summary/comprehensive/async` | POST | `SummaryController.generateComprehensiveSummaryAsync` | **Missing** | Not implemented | ❌ Missing |

### NLP Endpoints

| Backend Route | HTTP | Backend Controller | SDK Constant | SDK Pipeline Usage | Status |
|--------------|------|-------------------|--------------|-------------------|--------|
| `POST /nlp/classify/tokens` | POST | `NlpController.classifyTokens` (proxy) | **Missing** | `KnowledgePipeline` calls wrong `/api/ner/extract` | ❌ Wrong endpoint |
| `POST /nlp/classify/text` | POST | `NlpController.classifyText` (proxy) | **Missing** | Not implemented | ❌ Missing |
| `POST /nlp/correct` | POST | `NlpController.correctText` (proxy) | **Missing** | `KnowledgePipeline` spell check calls wrong `/api/spellcheck` | ❌ Wrong endpoint |
| `POST /nlp/suggest` | POST | `NlpController.suggestFindings` (proxy) | **Missing** | Not implemented | ❌ Missing |

### STT-V2 Endpoints (NEW — Primary SDK Target)

**Streaming Session + WebSocket**:

| Backend Route | Protocol | Backend Component | SDK Constant | SDK Usage | Status |
|--------------|----------|-------------------|--------------|-----------|--------|
| `POST /api/v1/transcription-jobs/stream/session` | HTTP | `TranscriptionJobController.createStreamingSession` | **Missing** | Not implemented | ❌ Missing |
| `/ws/stt-v2/stream?sessionId=X&token=JWT` | WebSocket | `SttV2StreamGateway` | **Missing** | Not implemented | ❌ Missing |

**Transcription Jobs**:

| Backend Route | Method | Backend Component | SDK Constant | SDK Usage | Status |
|--------------|--------|-------------------|--------------|-----------|--------|
| `POST /api/v1/transcription-jobs` | POST | `TranscriptionJobController.create` | **Missing** | Not implemented | ❌ Missing |
| `POST /api/v1/transcription-jobs/batch` | POST | `TranscriptionJobController.createBatch` | **Missing** | Not implemented | ❌ Missing |
| `POST /api/v1/transcription-jobs/streaming` | POST | `TranscriptionJobController.createStreaming` | **Missing** | Not implemented | ❌ Missing |
| `POST /api/v1/transcription-jobs/transcribe` | POST (multipart) | `TranscriptionStreamController.transcribeWithSSE` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs/:id/stream` | SSE | `TranscriptionStreamController.streamJobUpdates` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs` | GET | `TranscriptionJobController.list` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs/stats` | GET | `TranscriptionJobController.getStatusCounts` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs/:id` | GET | `TranscriptionJobController.getById` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs/consultation/:id` | GET | `TranscriptionJobController.getByConsultation` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/transcription-jobs/status/:status` | GET | `TranscriptionJobController.getByStatus` | **Missing** | Not implemented | ❌ Missing |
| `PATCH /api/v1/transcription-jobs/:id/cancel` | PATCH | `TranscriptionJobController.cancel` | **Missing** | Not implemented | ❌ Missing |
| `PATCH /api/v1/transcription-jobs/:id/retry` | PATCH | `TranscriptionJobController.retry` | **Missing** | Not implemented | ❌ Missing |

**ASR Pipelines**:

| Backend Route | Method | Backend Component | SDK Constant | SDK Usage | Status |
|--------------|--------|-------------------|--------------|-----------|--------|
| `GET /api/v1/pipelines` | GET | `PipelineController.list` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/pipelines/:id` | GET | `PipelineController.getById` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/pipelines/slug/:slug` | GET | `PipelineController.getBySlug` | **Missing** | Not implemented | ❌ Missing |
| `POST /api/v1/pipelines/validate` | POST | `PipelineController.validateYaml` | **Missing** | Not implemented | ❌ Missing |

**AI Models**:

| Backend Route | Method | Backend Component | SDK Constant | SDK Usage | Status |
|--------------|--------|-------------------|--------------|-----------|--------|
| `GET /api/v1/ai-models` | GET | `AiModelController.list` | `MODEL_ENDPOINTS.LIST` (wrong path: `/models`) | Not called | ❌ Wrong path |
| `GET /api/v1/ai-models/:id` | GET | `AiModelController.getById` | `MODEL_ENDPOINTS.GET(id)` (wrong path: `/models/:id`) | Not called | ❌ Wrong path |
| `GET /api/v1/ai-models/slug/:slug` | GET | `AiModelController.getBySlug` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/ai-models/task/:taskType` | GET | `AiModelController.getByTaskType` | **Missing** | Not implemented | ❌ Missing |
| `GET /api/v1/ai-models/status/downloaded` | GET | `AiModelController.getDownloadedModels` | **Missing** | Not implemented | ❌ Missing |

**Legacy STT (DEPRECATED — do NOT use in SDK)**:

| Backend Route | Protocol | Backend Component | SDK Usage | Status |
|--------------|----------|-------------------|-----------|--------|
| `/stt?key=...&sessionId=...` | WebSocket | `SttGateway` (v1, old proxy) | Not configured | ⛔ Deprecated, use stt-v2 |

### DNA / Personalization Endpoints

| Backend Route | HTTP | Backend Controller | SDK Constant | SDK Hook Usage | Status |
|--------------|------|-------------------|--------------|----------------|--------|
| `POST /dna/analyze` | POST | **Does not exist** | `DNA_ENDPOINTS.ANALYZE` | `useArca.summary.analyzeDNA()` | ❌ No backend |
| `GET /dna/styles/:userId` | GET | **Does not exist** | `DNA_ENDPOINTS.GET_STYLE(id)` | Not called | ❌ No backend |
| `GET /users/me/preferences` | GET | `UserPreferencesController` | `PERSONALIZATION_ENDPOINTS.GET_PREFERENCES` | `PersonalizationManager.loadFromBackend()` | ⚠️ Needs verification |
| `PATCH /users/me/preferences` | PATCH | `UserPreferencesController` | `PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES` | `PersonalizationManager.updatePreferences()` | ⚠️ Needs verification |

---

## 6. Type Alignment Matrix

### Consultation Types

| SDK Type | Defined In | Backend DTO | Match Status |
|----------|-----------|-------------|--------------|
| `Consultation` | `types/consultation.ts` | `ConsultationResponse` | ⚠️ Fields differ (no `status`, no `isNew` on backend) |
| `OpenSessionInput` | `types/consultation.ts` | `OpenConsultationRequest` | ✅ Compatible |
| `CreateConsultationInput` | **Exported in `core.ts` but NOT defined** | N/A | ❌ Type doesn't exist |
| `StartRevisitInput` | **Exported in `core.ts` but NOT defined** | N/A | ❌ Type doesn't exist |
| `UpdateConsultationInput` | **Exported in `core.ts` but NOT defined** | N/A | ❌ Type doesn't exist |
| `ConsultationStatus` | **Exported in `core.ts` but NOT defined** | N/A | ❌ Type doesn't exist |
| `SessionState` | `types/consultation.ts` | N/A (SDK-only) | ✅ Internal |
| `SessionActions` | `types/consultation.ts` | N/A (SDK-only) | ✅ Internal |

### Context Types

| SDK Type | Defined In | Backend DTO | Match Status |
|----------|-----------|-------------|--------------|
| `ContextItem` | `types/context.ts` | `ContextItemResponse` | ⚠️ SDK has derived fields (`isSummary`, `isTranscription`, `isAiGenerated`) not on backend |
| `AddContextInput` | `types/context.ts` | `AddContextRequest` | ✅ Compatible |
| `MedicalEntity` | `types/context.ts` | Backend NER output | ⚠️ Field names differ: `entityType` vs `type`, `confidence` vs `score`, `startOffset`/`endOffset` vs `start`/`end` |
| `ContextFilters` | `types/context.ts` | `ContextFiltersDto` | ⚠️ SDK missing `page`/`limit` |

### Summary Types

| SDK Type | Defined In | Backend DTO | Match Status |
|----------|-----------|-------------|--------------|
| `SummaryResponse` | `types/summary.ts` | `SummaryResponse` | ⚠️ SDK uses `contextItemId`, backend may use different field |
| `SummaryOptions` | `types/summary.ts` | `GenerateSummaryRequest` | ⚠️ Field names may differ |
| `PreSummaryOptions` | `types/summary.ts` | `GeneratePreSummaryRequest` | ⚠️ Field names may differ |
| `DNAStyle` | `types/summary.ts` | **No backend type** | ❌ No backend support |
| `DNAStyleData` | `types/summary.ts` | **No backend type** | ❌ No backend support |
| `ComprehensiveSummaryResponse` | **Missing from SDK** | `ComprehensiveSummaryResponse` | ❌ Missing from SDK |
| `JobResponse` | **Missing from SDK** | `JobResponse` | ❌ Missing from SDK (needed for async) |

### Audio/Pipeline Types

| SDK Type | Defined In | Backend Equivalent | Match Status |
|----------|-----------|-------------------|--------------|
| `TranscriptionResult` | `types/audio.ts` | STT service output | ✅ Internal to SDK |
| `VADEvent` | `types/audio.ts` | N/A (browser-only) | ✅ Internal |
| `PipelineStateInfo` | `types/pipeline.ts` | N/A (SDK-only) | ✅ Internal |
| `KnowledgePipelineConfig` | `types/pipeline.ts` | N/A (SDK-only) | ✅ Internal |

---

## 7. Priority Classification

### Critical (Must Fix — Compilation/Runtime Breaks)

| ID | Gap | Impact |
|----|-----|--------|
| **ASR-R-01** | SDK has zero stt-v2 endpoint constants | Cannot call any stt-v2 API — entire remote STT integration broken |
| **ASR-R-02** | No streaming session management in SDK | Cannot create session (step 1 of connection flow) |
| **ASR-R-03** | No WebSocket client for stt-v2 protocol | Cannot stream audio or receive transcripts |
| **SES-01** | `useArca` references 6+ undefined endpoint constants | Compilation error or runtime TypeError |
| **SES-02** | `core.ts` exports 4 types not defined in source files | Compilation error on consumers |
| **NER-R-01** | `KnowledgePipeline` calls non-existent `/api/ner/extract` | Runtime 404 on backend NER |
| **SUM-05** | `KnowledgePipeline` calls wrong summary endpoint (plural) | Runtime 404 on summarization |
| **HOOK-01** | `useArca.session` and `useArcaSession` are incompatible | Developer confusion, broken behavior |
| **HOOK-02** | `PluginManager` not passed `apiClient` in provider | Backend NER/summarization always fails |

### High (Feature Broken or Unreachable)

| ID | Gap | Impact |
|----|-----|--------|
| **ASR-R-04** | No `sttSocket` wiring from config to pipeline | Even local remote-mode code path is dead |
| **ASR-R-05** | No WebSocket/streaming config in `AgenticConfig` | Cannot configure WS endpoint path |
| **ASR-R-06** | No ASR pipeline discovery in SDK | Cannot fetch or select backend pipeline configs |
| **ASR-R-07** | `MODEL_ENDPOINTS` paths wrong (`/models` vs `/api/v1/ai-models`) | Backend AI model catalog inaccessible |
| **NER-L-01** | `MedicalEntity` type mismatch | Local NER results mapped to wrong fields |
| **NER-L-02** | No auto-NER on transcriptions | Key workflow broken |
| **NER-L-03** | Knowledge pipeline never initialized | Manual NER trigger always throws |
| **NER-R-02** | Two disconnected NER code paths | Confusing DX, pipeline results lost |
| **SES-03** | `CONTEXT_ENDPOINTS.UPDATE` undefined | Context update throws |
| **SUM-01** | No async summary generation | Long summaries timeout |
| **SUM-06** | DNA endpoints have no backend | `analyzeDNA()` always fails |
| **HOOK-03** | `loadDNAStyle` not implemented | Advertised API that doesn't work |

### Medium (Missing Feature Parity)

| ID | Gap | Impact |
|----|-----|--------|
| **ASR-R-08** | No transcription job tracking in SDK | Cannot query job status or history |
| **ASR-R-09** | No SSE reconnection support | Cannot resume after browser refresh |
| **ASR-R-10** | No file-upload transcription support | Cannot transcribe pre-recorded audio files |
| **NER-R-03** | `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES` never called | Dead code |
| **NER-R-04** | NLP proxy endpoints missing from constants | Cannot call NLP directly |
| **NER-R-05** | Entity endpoint path mismatch | Wrong entity data returned |
| **SUM-02** | No comprehensive summary support | Cross-chain summaries unavailable |
| **SUM-03** | No `getLatestPreSummary` endpoint | Cannot load latest pre-summary |
| **SUM-04** | Summaries not loaded from backend | History lost on reload |
| **SES-04** | No timeline support | Timeline feature unavailable |
| **SES-05** | No context version history | Version history unavailable |
| **SES-06** | No pagination support | Large datasets problematic |
| **HOOK-04** | No dedicated NER hook | Inconsistent plugin hook pattern |
| **HOOK-05** | Missing `toggleSTT`/`toggleVAD` | Incomplete audio controls |
| **HOOK-06** | Summaries not fetched on load | Stale data after refresh |

### Low (DX Improvement)

| ID | Gap | Impact |
|----|-----|--------|
| **ASR-L-02** | No model download progress | Poor UX for large models |
| **ASR-L-03** | `auto` provider not visible | Debugging difficulty |
| **ASR-R-11** | Legacy STT v1 references still exist | Misleading documentation |
| **SES-07** | No dedicated transcription/case-note endpoints | Inefficient client-side filtering |
| **HOOK-07** | No error retry logic | Poor resilience |

---

## 8. Implementation Plan (Pending)

> **Status**: This section will be populated after user review and approval of the gap analysis.

### Proposed Phases

| Phase | Focus | Priority Gaps Addressed | Estimated Effort |
|-------|-------|------------------------|-----------------|
| **Phase 1** | Fix Critical Breaks | SES-01, SES-02, SES-03, HOOK-01, HOOK-02 | Align `useArca` with `useArcaSession` model, fix type exports, fix provider wiring |
| **Phase 2** | Fix Backend Integration | NER-R-01, SUM-05, NER-L-01, NER-R-05, ASR-R-07 | Correct all endpoint paths, fix type mappings, fix AI model paths |
| **Phase 3** | **STT-V2 Remote ASR Integration** | ASR-R-01, ASR-R-02, ASR-R-03, ASR-R-04, ASR-R-05, ASR-R-06 | Full stt-v2 integration: endpoint constants, streaming session manager, WebSocket client, pipeline/model discovery, config wiring |
| **Phase 4** | Knowledge Pipeline | NER-L-02, NER-L-03, NER-R-02 | Auto-init pipeline, wire auto-NER on transcription |
| **Phase 5** | STT-V2 Advanced Features | ASR-R-08, ASR-R-09, ASR-R-10 | Transcription job tracking, SSE reconnection, file-upload transcription |
| **Phase 6** | Feature Parity | SUM-01, SUM-02, SES-04, SES-05, SES-06 | Async jobs, comprehensive summaries, timeline, versioning, pagination |
| **Phase 7** | DX Polish | HOOK-04, HOOK-05, ASR-L-02, HOOK-07, ASR-R-11 | Additional hooks, toggle methods, progress, retry, deprecation cleanup |

### Parallelization Analysis

The gaps fall into **5 independent work streams** that can execute concurrently, plus a final integration layer that depends on all of them. The key insight is that most gaps touch **different files** — the main contention point is `constants.ts` (all endpoint fixes land there) and `useArca.ts` (the main hook), but these can be handled with a constants-first approach.

#### Dependency Graph

```
                    ┌─────────────────────────────┐
                    │  LAYER 0: Shared Foundation  │
                    │  (must run FIRST)            │
                    │                              │
                    │  constants.ts — all new      │
                    │  endpoint constants           │
                    │  types/ — all new types       │
                    │                              │
                    │  Gaps: ASR-R-01, ASR-R-07,   │
                    │  NER-R-04, NER-R-05, SES-03  │
                    └──────────┬──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
          ▼                    ▼                     ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ STREAM A         │ │ STREAM B         │ │ STREAM C         │
│ STT-V2 Remote    │ │ Knowledge Pipe   │ │ Session/Hook     │
│ (new files)      │ │ (existing files) │ │ Alignment        │
│                  │ │                  │ │ (existing files)  │
│ ASR-R-02 session │ │ NER-R-01 fix ep  │ │ SES-01 fix refs  │
│ ASR-R-03 WS cli  │ │ NER-R-02 unify   │ │ SES-02 fix types │
│ ASR-R-04 config  │ │ NER-L-01 types   │ │ HOOK-01 align    │
│ ASR-R-05 config  │ │ NER-L-02 auto    │ │ HOOK-02 apiClient│
│ ASR-R-06 pipeline│ │ NER-L-03 init    │ │ SUM-05 fix ep    │
│                  │ │ SUM-06 DNA clean │ │ HOOK-03 DNA clean│
│ Files:           │ │                  │ │                  │
│ NEW Streaming*   │ │ Files:           │ │ Files:           │
│ config.ts        │ │ KnowledgePipe.ts │ │ useArca.ts       │
│ PluginManager.ts │ │ context.ts types │ │ useArcaSession.ts│
│ ModelRegistry.ts │ │ AgenticProvider  │ │ core.ts exports  │
│                  │ │ useArca.ts (NER) │ │ consultation.ts  │
│                  │ │                  │ │ summary.ts types │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                     │
         │    ┌───────────────┼─────────────────┐   │
         │    │               │                 │   │
         ▼    ▼               ▼                 ▼   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ STREAM D         │ │ STREAM E         │ │ STREAM F         │
│ STT-V2 Advanced  │ │ Feature Parity   │ │ DX Polish        │
│ (after A)        │ │ (after B + C)    │ │ (after A + C)    │
│                  │ │                  │ │                  │
│ ASR-R-08 jobs    │ │ SUM-01 async     │ │ HOOK-04 NER hook │
│ ASR-R-09 SSE     │ │ SUM-02 compreh.  │ │ HOOK-05 toggles  │
│ ASR-R-10 upload  │ │ SUM-03 pre-sum   │ │ HOOK-06 load sum │
│                  │ │ SUM-04 load sum  │ │ HOOK-07 retry    │
│ Files:           │ │ SES-04 timeline  │ │ ASR-L-01 toggles │
│ NEW SSE client   │ │ SES-05 versions  │ │ ASR-L-02 progress│
│ NEW file upload  │ │ SES-06 pagination│ │ ASR-L-03 auto    │
│ stt-v2 types     │ │ NER-R-03 extract │ │ ASR-R-11 legacy  │
│ useArca.ts       │ │                  │ │ SES-07 dedicated │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

#### Parallel Execution Plan

| Layer | Streams | Can Run In Parallel? | Gaps | Key Constraint |
|-------|---------|---------------------|------|----------------|
| **Layer 0** | Foundation | **Sequential prerequisite** | ASR-R-01, ASR-R-07, NER-R-04, NER-R-05, SES-03 | All streams depend on correct endpoint constants and types |
| **Layer 1** | A, B, C | **YES — all 3 in parallel** | 14 gaps total | Different files, minimal overlap. Stream B touches `useArca.ts` NER section, Stream C touches `useArca.ts` session section — non-overlapping regions |
| **Layer 2** | D, E, F | **YES — all 3 in parallel** | 17 gaps total | D depends on A. E depends on B+C. F depends on A+C. But D, E, F themselves are independent |

#### Layer 0: Foundation (Sequential — Do First)

All streams need correct endpoint constants and type definitions. This is a single file-focused effort.

| Gap | File | What Changes |
|-----|------|-------------|
| ASR-R-01 | `constants.ts` | Add `STT_V2_ENDPOINTS`, `PIPELINE_ENDPOINTS` |
| ASR-R-07 | `constants.ts` | Fix `MODEL_ENDPOINTS` paths (`/models` → `/api/v1/ai-models`), add `AI_MODEL_ENDPOINTS` |
| NER-R-04 | `constants.ts` | Add `NLP_ENDPOINTS` (`/nlp/classify/tokens`, `/nlp/correct`, `/nlp/suggest`) |
| NER-R-05 | `constants.ts` | Fix `ENTITY_ENDPOINTS` paths (`.../entities` → `.../named-entities`) |
| SES-03 | `constants.ts` | Add `CONTEXT_ENDPOINTS.UPDATE` |
| — | `types/*.ts` | Add all new types (streaming session, WS protocol, transcription job, pipeline, AI model) |

**Estimated effort**: Small-medium. Pure additive changes to `constants.ts` + new type definitions.

#### Layer 1: Three Parallel Streams

**Stream A — STT-V2 Remote ASR** (new files, minimal merge conflict risk):

| Gap | File(s) | What Changes | Depends On |
|-----|---------|-------------|------------|
| ASR-R-02 | **NEW** `StreamingSessionManager.ts` | Session creation + lifecycle | Layer 0 (constants) |
| ASR-R-03 | **NEW** `SttV2WebSocketClient.ts` | WS client speaking stt-v2 protocol | Layer 0 (constants) |
| ASR-R-04 | `types/config.ts`, `PluginManager.ts` | Wire `sttSocket` / `pipelineId` from config | Layer 0 (types) |
| ASR-R-05 | `types/config.ts` | Add `wsUrl` to `ApiConfig` | None |
| ASR-R-06 | `ModelRegistry.ts`, **or NEW** `PipelineRegistry.ts` | Fetch backend pipeline configs | Layer 0 (constants) |

**Stream B — Knowledge Pipeline Fixes** (existing files, NER + summarization logic):

| Gap | File(s) | What Changes | Depends On |
|-----|---------|-------------|------------|
| NER-R-01 | `KnowledgePipeline.ts` | Fix endpoint: `/api/ner/extract` → `/nlp/classify/tokens` | Layer 0 (NLP constants) |
| NER-R-02 | `KnowledgePipeline.ts`, `useArca.ts` (NER section only) | Unify NER paths: pipeline stores results via context API | NER-R-01 |
| NER-L-01 | `KnowledgePipeline.ts`, `types/context.ts` | Fix `MedicalEntity` field mapping | None |
| NER-L-02 | `useArca.ts` (onTranscription callback, ~lines 437-466) | Feed transcriptions into knowledge pipeline when `auto` | NER-L-03 |
| NER-L-03 | `AgenticProvider.tsx` | Call `initializeKnowledgePipeline()` on mount | None |
| SUM-06 | `constants.ts` (DNA removal), `useArca.ts` (DNA section) | Remove or stub DNA endpoints/methods (no backend) | None |

**Stream C — Session & Hook Alignment** (existing files, session + type exports):

| Gap | File(s) | What Changes | Depends On |
|-----|---------|-------------|------------|
| SES-01 | `useArca.ts` (session section, ~lines 200-410) | Replace undefined endpoint refs with real constants | Layer 0 (constants) |
| SES-02 | `core.ts`, `types/consultation.ts` | Define missing exported types or remove dead exports | None |
| HOOK-01 | `useArca.ts` (session interface) | Align `useArca.session` with `useArcaSession.open()` model | SES-01 |
| HOOK-02 | `AgenticProvider.tsx` (line 120-121) | Pass `apiClient` as 3rd arg to `PluginManager` | None |
| SUM-05 | `KnowledgePipeline.ts` (line 545-547) | Fix `/api/consultations/.../summaries` → `/consultations/.../summary` | None |
| HOOK-03 | `useArca.ts` (summary section) | Remove or implement `loadDNAStyle` | Depends on SUM-06 decision |

#### Layer 2: Three Parallel Streams (After Layer 1 Completes)

**Stream D — STT-V2 Advanced** (depends on Stream A):

| Gap | File(s) | What Changes |
|-----|---------|-------------|
| ASR-R-08 | New types + `useArca.ts` | Transcription job types, status polling, `getJobsByConsultation()` |
| ASR-R-09 | **NEW** `SSEClient.ts` or extend `StreamingSessionManager` | SSE reconnection to `GET .../transcription-jobs/:id/stream` |
| ASR-R-10 | **NEW** `FileTranscriptionService.ts` or method in `StreamingSessionManager` | File upload + SSE stream for `POST .../transcribe` |

**Stream E — Feature Parity** (depends on Streams B + C):

| Gap | File(s) | What Changes |
|-----|---------|-------------|
| SUM-01 | `useArca.ts`, new types | Async job creation (`POST .../async`), polling, SSE |
| SUM-02 | `useArca.ts`, new types | Comprehensive summary (`POST .../comprehensive`) |
| SUM-03 | `constants.ts`, `useArca.ts` | Add `getLatestPreSummary` endpoint + method |
| SUM-04 | `useArca.ts`, `useArcaSession.ts` | Fetch summaries on consultation open/load |
| SES-04 | `constants.ts`, `useArca.ts`, new types | Timeline endpoint + method |
| SES-05 | `constants.ts`, `useArca.ts`, new types | Version history endpoint + method |
| SES-06 | `useArca.ts`, types | Add pagination params to list methods |
| NER-R-03 | `useArca.ts` | Wire `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES` into NER flow |

**Stream F — DX Polish** (depends on Streams A + C):

| Gap | File(s) | What Changes |
|-----|---------|-------------|
| ASR-L-01 / HOOK-05 | `useArca.ts` (audio section) | Expose `toggleSTT`, `toggleVAD` |
| ASR-L-02 | `useArca.ts`, `agenticStore.ts` | Wire model download progress to store |
| ASR-L-03 | `TranscriptionPipeline.ts` | Expose selected provider info |
| ASR-R-11 | Documentation + any leftover v1 refs | Clean up legacy STT v1 references |
| SES-07 | `constants.ts`, `useArca.ts` | Add dedicated transcription/case-note fetch methods |
| HOOK-04 | `plugins.ts` | Re-export `useNER` / `useMedNER` hook |
| HOOK-06 | `useArcaSession.ts`, `useArca.ts` | Fetch summaries on consultation load |
| HOOK-07 | `useArca.ts` | Add retry wrapper using existing `isRetriableError()` |

#### File Contention Summary

| File | Touched By | Conflict Risk | Mitigation |
|------|-----------|---------------|------------|
| `constants.ts` | Layer 0 (all), Stream E | **High** | Complete all constant additions in Layer 0 before branching |
| `useArca.ts` | Streams B, C, D, E, F | **High** | Streams touch **different sections**: B=NER, C=session, D=audio, E=summary, F=DX. Use section-based isolation or merge carefully |
| `types/config.ts` | Streams A, C | **Medium** | A adds `wsUrl`+`pipelineId`, C may adjust session types — non-overlapping |
| `AgenticProvider.tsx` | Streams B, C | **Low** | B adds `initializeKnowledgePipeline()`, C adds `apiClient` param — different lines |
| `KnowledgePipeline.ts` | Streams B, C | **Medium** | B fixes NER endpoint, C fixes summarization endpoint — different methods |
| All **NEW** files | Stream A only | **None** | New files have zero conflict risk |

#### Recommended Execution Order

```
Week 1 (Sequential):
  └── Layer 0: Foundation (constants + types)               ← 1 developer, ~1 day

Week 1-2 (Parallel — 3 developers):
  ├── Stream A: STT-V2 Remote ASR                           ← Developer 1, ~3-4 days
  ├── Stream B: Knowledge Pipeline Fixes                    ← Developer 2, ~2-3 days
  └── Stream C: Session & Hook Alignment                    ← Developer 3, ~2-3 days

Week 2-3 (Parallel — 3 developers, after Layer 1 merge):
  ├── Stream D: STT-V2 Advanced Features                    ← Developer 1, ~2-3 days
  ├── Stream E: Feature Parity                              ← Developer 2, ~3-4 days
  └── Stream F: DX Polish                                   ← Developer 3, ~2-3 days
```

**Maximum parallelism**: 3 concurrent streams per layer.
**Total calendar time** (with 3 developers): ~2.5 weeks vs ~6 weeks sequential.
**Critical path**: Layer 0 → Stream A → Stream D (STT-V2 is the longest chain).

### Phase 3 Detail: STT-V2 Remote ASR Integration

This is the highest-impact phase as it enables the core remote speech-to-text functionality.

**What needs to be implemented in the SDK**:

1. **Endpoint Constants** — Add `STT_V2_ENDPOINTS`, `PIPELINE_ENDPOINTS`, `AI_MODEL_ENDPOINTS` to `constants.ts`:
   ```
   STT_V2_ENDPOINTS.CREATE_SESSION       → POST /api/v1/transcription-jobs/stream/session
   STT_V2_ENDPOINTS.WS_STREAM            → /ws/stt-v2/stream
   STT_V2_ENDPOINTS.CREATE_JOB           → POST /api/v1/transcription-jobs
   STT_V2_ENDPOINTS.CREATE_BATCH_JOB     → POST /api/v1/transcription-jobs/batch
   STT_V2_ENDPOINTS.CREATE_STREAMING_JOB → POST /api/v1/transcription-jobs/streaming
   STT_V2_ENDPOINTS.TRANSCRIBE           → POST /api/v1/transcription-jobs/transcribe
   STT_V2_ENDPOINTS.JOB_STREAM(id)       → GET  /api/v1/transcription-jobs/:id/stream
   STT_V2_ENDPOINTS.GET_JOB(id)          → GET  /api/v1/transcription-jobs/:id
   STT_V2_ENDPOINTS.LIST_JOBS            → GET  /api/v1/transcription-jobs
   STT_V2_ENDPOINTS.JOB_STATS            → GET  /api/v1/transcription-jobs/stats
   STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION(id) → GET /api/v1/transcription-jobs/consultation/:id
   STT_V2_ENDPOINTS.CANCEL_JOB(id)       → PATCH /api/v1/transcription-jobs/:id/cancel
   STT_V2_ENDPOINTS.RETRY_JOB(id)        → PATCH /api/v1/transcription-jobs/:id/retry
   PIPELINE_ENDPOINTS.LIST                → GET  /api/v1/pipelines
   PIPELINE_ENDPOINTS.GET(id)             → GET  /api/v1/pipelines/:id
   PIPELINE_ENDPOINTS.GET_BY_SLUG(slug)   → GET  /api/v1/pipelines/slug/:slug
   AI_MODEL_ENDPOINTS.LIST                → GET  /api/v1/ai-models
   AI_MODEL_ENDPOINTS.GET(id)             → GET  /api/v1/ai-models/:id
   AI_MODEL_ENDPOINTS.GET_BY_SLUG(slug)   → GET  /api/v1/ai-models/slug/:slug
   AI_MODEL_ENDPOINTS.BY_TASK(type)       → GET  /api/v1/ai-models/task/:taskType
   AI_MODEL_ENDPOINTS.DOWNLOADED          → GET  /api/v1/ai-models/status/downloaded
   ```

2. **Types** — Add SDK types matching backend DTOs:
   - `CreateStreamingSessionRequest` (pipelineId, consultationId?, sampleRate?, language?, codeSwitching?, microphoneId?)
   - `StreamingSessionResponse` (sessionId, status, maxConcurrent, currentActive, wsUrl)
   - `TranscriptionJobResponse` (id, status, progress, consultationId, pipelineId, ...)
   - `WsAudioFrame`, `WsStopMessage`, `WsCloseMessage` (client → server)
   - `WsTranscriptResult`, `WsStatusMessage`, `WsErrorMessage` (server → client)
   - `PipelineResponse`, `AiModelResponse` (from backend DTOs)

3. **StreamingSessionManager** (new core class) — Manages the two-step connection flow:
   - `createSession(options)` → POST to create session, returns sessionId
   - `connectWebSocket(sessionId, token)` → opens WS, handles auth
   - `sendAudioFrame(buffer | base64)` → sends PCM data
   - `stop()` → sends stop signal, waits for finalization
   - `close()` → graceful close
   - `onTranscript(callback)` → registers transcript handler
   - `onStatus(callback)` → registers status handler
   - `onError(callback)` → registers error handler

4. **Config Extension** — Add stt-v2 config to `AgenticConfig`:
   - `api.wsUrl?: string` — WebSocket base URL (defaults to same host as `baseUrl`)
   - `audio.stt.pipelineId?: string` — Backend ASR pipeline to use
   - `audio.stt.provider: 'local' | 'backend' | 'auto'` — Already exists, needs wiring

5. **Hook Integration** — Wire into `useArca`:
   - `audio.startRemoteStreaming(consultationId?)` → creates session + connects WS
   - `audio.stopRemoteStreaming()` → sends stop + close
   - `audio.onRemoteTranscript(callback)` → handles incoming transcripts
   - `audio.streamingSessionId` — current session ID (reactive)
   - `audio.streamingStatus` — current status (reactive)

---

## 9. Breaking Changes & Migration Guide

The following changes in SDK-206 are **breaking** for existing consumers of `useArca()`. If you are upgrading from a prior version of `@arcaai/vox`, follow the migration steps below.

### 9.1 Session API (HOOK-01)

The `useArca().session` interface was refactored from a lifecycle model to a get-or-create model.

**Removed methods:**
| Old Method | Replacement | Notes |
|------------|-------------|-------|
| `session.create(input)` | `session.open(input)` | `open()` uses get-or-create semantics (finds existing or creates new). Input type changed from `CreateConsultationInput` to `OpenSessionInput`. |
| `session.startRevisit(input)` | `session.open(input)` | Revisit logic is now handled server-side by the `CONSULTATION_ENDPOINTS.OPEN` route. |
| `session.end()` | — (removed) | Server-side consultation lifecycle management. If needed, call `apiClient.post(CONSULTATION_ENDPOINTS.END(id))` directly. |
| `session.pause()` | — (removed) | No backend `PAUSE` endpoint exists. |
| `session.resume()` | — (removed) | No backend `RESUME` endpoint exists. |

**New methods added:**
| Method | Description |
|--------|-------------|
| `session.getPatientHistory(patientId, pagination?)` | Fetch patient consultation history with optional pagination. |
| `session.getTimeline(scope?)` | Get consultation timeline. Supports `scope='single'` (default) or `'chain'`. |

**Migration example:**

```typescript
// Before (v1)
const consultation = await session.create({ patientId, doctorId, appointmentDate });
const revisit = await session.startRevisit({ parentConsultationId: 'abc' });
await session.end();

// After (v2)
const consultation = await session.open({ patientId, doctorId, appointmentDate });
// Revisits are handled automatically by open() — backend determines if it's new or revisit.
// end/pause/resume are removed.
```

### 9.2 DNA Analysis (SUM-06)

| Old Method | Change |
|------------|--------|
| `summary.analyzeDNA(texts)` | Now throws immediately with `"DNA analysis is not supported"`. Marked `@deprecated`. |
| `DNA_ENDPOINTS.ANALYZE` | Marked `@deprecated`. No backend exists. |

### 9.3 Entity Endpoint Paths (NER-R-05)

If you use `ENTITY_ENDPOINTS` directly (rather than through hooks), note that paths changed:

| Old Path | New Path |
|----------|----------|
| `/consultations/:id/entities` | `/consultations/:id/named-entities` |
| `/consultations/:id/context/:itemId/entities` | `/consultations/:id/context/:itemId/named-entities` |

### 9.4 Model Endpoint Paths (ASR-R-07)

| Old Path | New Path |
|----------|----------|
| `/models` | `/api/v1/ai-models` |
| `/models/:id` | `/api/v1/ai-models/:id` |

---

## 10. Change History

| # | Date | Description | Status |
|---|------|-------------|--------|
| 1 | 2026-02-17 | Initial gap analysis document created. Full review of `agentic-sdk-v2` package against backend API controllers. Identified 24 gaps across 7 capability areas. | Complete |
| 2 | 2026-02-17 | Deep-dive into `stt-v2` module. Updated Remote ASR section (4.2) with complete STT-V2 API surface, connection flow, WebSocket protocol, DTOs. Added 11 STT-V2-specific gaps (ASR-R-01 through ASR-R-11). Updated Endpoint Mapping Matrix with full STT-V2 endpoint tables. Updated Priority Classification. Added Phase 3 detailed implementation plan for STT-V2 integration. Total gaps now: 41. | Complete |
| 3 | 2026-02-17 | Added Parallelization Analysis to Section 8. Mapped dependency graph across all 41 gaps into 3 layers (Foundation → 3 parallel streams → 3 parallel streams). Identified file contention points and mitigation strategies. Estimated ~2.5 weeks with 3 developers vs ~6 weeks sequential. Critical path: Layer 0 → Stream A (STT-V2) → Stream D (STT-V2 Advanced). | Complete |
| 4 | 2026-02-17 | **Layer 0: Foundation implemented (TDD).** All 5 gaps resolved: **ASR-R-01** added `STT_V2_ENDPOINTS` (14 endpoints) + `PIPELINE_ENDPOINTS` (4 endpoints); **ASR-R-07** fixed `MODEL_ENDPOINTS` paths (`/models` → `/api/v1/ai-models`) + added `AI_MODEL_ENDPOINTS` (5 endpoints); **NER-R-04** added `NLP_ENDPOINTS` (4 endpoints); **NER-R-05** fixed `ENTITY_ENDPOINTS` paths (`.../entities` → `.../named-entities`); **SES-03** added `CONTEXT_ENDPOINTS.UPDATE`. Created new `types/stt-v2.ts` with 16 type/enum definitions (4 enums, 12 interfaces/types) matching backend DTOs. All 533 tests pass (67 constants + 25 types + 441 existing). Files: `constants.ts`, `types/stt-v2.ts`, `types/index.ts`, `constants.test.ts`, `stt-v2.types.test.ts`. | Complete |
| 5 | 2026-02-17 | **Layer 1 Stream B: Knowledge Pipeline Fixes implemented (TDD).** 7 gaps resolved: **NER-R-01** fixed backend NER endpoint from `/api/ner/extract` → `NLP_ENDPOINTS.CLASSIFY_TOKENS` (`/nlp/classify/tokens`); also fixed spell check from `/api/spellcheck` → `NLP_ENDPOINTS.CORRECT` (`/nlp/correct`). **NER-L-01** fixed browser NER entity field mapping: `type`→`entityType`, `score`→`confidence`, `start/end`→`startOffset/endOffset` to match `MedicalEntity` interface; introduced `RawNEREntity` interface for raw processor output. **SUM-05** fixed summarization endpoint from `/api/consultations/:id/summaries` → `SUMMARY_ENDPOINTS.GENERATE()` (`/consultations/:id/summary`). **NER-L-03 + HOOK-02** `AgenticProvider.tsx` now passes `apiClient` as 3rd arg to `PluginManager` constructor (backend NER/summarization no longer fails); also initializes knowledge pipeline on mount when NER config is enabled. **NER-L-02** wired auto-NER on final transcriptions: `useArca.ts` `onTranscription` callback now feeds completed transcriptions into the knowledge pipeline, storing extracted entities in the store. **NER-R-02** unified NER paths: pipeline NER results now flow through auto-NER → store, no longer disconnected from context. **SUM-06** deprecated DNA endpoints (no backend exists): `DNA_ENDPOINTS` marked `@deprecated`; `analyzeDNA()` now throws "not supported" immediately instead of calling non-existent `/dna/analyze`. All 72 Stream B tests pass (34 KnowledgePipeline + 24 useArca + 14 AgenticProvider, including 15 new TDD tests). Files modified: `KnowledgePipeline.ts`, `useArca.ts`, `AgenticProvider.tsx`, `constants.ts` (deprecation only); test files: `KnowledgePipeline.test.ts`, `useArca.test.tsx`, `AgenticProvider.test.tsx`. | Complete |
|| 6 | 2026-02-17 | **Layer 1 Stream A: STT-V2 Remote ASR implemented (TDD).** All 5 gaps resolved. **ASR-R-05**: Added `wsUrl` to `ApiConfig` for WebSocket base URL configuration. **ASR-R-04**: Added `pipelineId` and `sttSocket` to `STTPluginConfig` and `TranscriptionProcessingConfig.stt`; made `PluginManager.getTranscriptionPipelineConfig()` public and wired new fields through. **ASR-R-02**: Created `StreamingSessionManager` — manages the two-step stt-v2 connection flow (POST session → store sessionId → build WS URL → close). Supports event callbacks (`onSessionCreated`, `onSessionClosed`, `onError`), state inspection, and prevents duplicate sessions (21 tests). **ASR-R-03**: Created `SttV2WebSocketClient` — full WebSocket client speaking stt-v2 protocol. Supports binary PCM frames, JSON audio frames (with seq/base64/microphoneId), stop/close control messages, and dispatches server messages (`transcript`, `status`, `error`) to registered callbacks (20 tests). **ASR-R-06**: Created `PipelineRegistry` — discovers and caches backend ASR pipeline configs (`GET /api/v1/pipelines`) and AI models (`GET /api/v1/ai-models`) with graceful error handling, lookup by ID/slug, and task type filtering (18 tests). All 633 tests pass (78 new Stream A: 9 config types + 4 PluginManager wiring + 21 SessionManager + 20 WebSocketClient + 18 PipelineRegistry + 6 implicit, plus 555 baseline). New files: `StreamingSessionManager.ts`, `SttV2WebSocketClient.ts`, `PipelineRegistry.ts`, `config.types.test.ts`, `StreamingSessionManager.test.ts`, `SttV2WebSocketClient.test.ts`, `PipelineRegistry.test.ts`. Modified: `config.ts` (ApiConfig, STTPluginConfig, TranscriptionProcessingConfig), `PluginManager.ts` (public method + wiring). | Complete |
| 7 | 2026-02-17 | **Layer 1 Stream C: Session & Hook Alignment implemented (TDD).** 6 gaps addressed. **SES-02**: Defined 4 missing types in `consultation.ts`: `ConsultationStatus` (string literal union), `CreateConsultationInput`, `StartRevisitInput`, `UpdateConsultationInput`; exported through `types/index.ts` and `core.ts`. Added `isNewVisit()` and `isRevisit()` utility functions (14 type tests). **SES-01 + HOOK-01**: Refactored `useArca.ts` session interface from old lifecycle model (`create`/`startRevisit`/`end`/`pause`/`resume`) to get-or-create model (`open`/`load`/`findByPatientDate`/`getPatientHistory`), aligning with `useArcaSession`. Removed all references to non-existent `CONSULTATION_ENDPOINTS` constants (`.CREATE`, `.REVISIT()`, `.CHAIN()`, `.END()`, `.PAUSE()`, `.RESUME()`, `.BY_PATIENT_DATE()`); replaced with real constants (`.OPEN`, `.GET()`, `.PATIENT_DATE()`, `.PATIENT_HISTORY()`). Removed imports of `CreateConsultationInput` and `StartRevisitInput` from useArca; now imports `OpenSessionInput` (10 alignment tests). **HOOK-02**: Verified `AgenticProvider` correctly passes `apiClient` to `PluginManager` (already fixed by Stream B); wrote 4 regression tests including source code verification, backend NER success/failure with/without apiClient. **SUM-05**: Confirmed already fixed by Stream B — `KnowledgePipeline.executeSummarization()` uses correct singular `/consultations/:id/summary` endpoint. **HOOK-03**: Marked `loadDNAStyle` and `analyzeDNA` as `@deprecated` in `SummaryActions` interface (no backend endpoint exists); `UseArcaSummary` does not expose `loadDNAStyle` (3 tests). All 166 Stream C tests pass across 8 test files. Files modified: `useArca.ts`, `consultation.ts`, `summary.ts`, `types/index.ts`, `core.ts`. New test files: `consultation.types.test.ts`, `useArca.session.test.ts`, `useArca.summary.test.ts`, `AgenticProvider.test.ts` (providers). | Complete |
| 8 | 2026-02-17 | **Layer 2 Stream D: STT-V2 Advanced Features implemented (TDD).** All 3 gaps resolved. **ASR-R-08**: Created `TranscriptionJobService` — full transcription job lifecycle management. Provides `getJob(id)`, `listJobs(pagination)`, `getJobsByConsultation(id)`, `getJobsByStatus(status)`, `getJobStats()`, `cancelJob(id)`, `retryJob(id)`, and `pollJobStatus(id, options)` with configurable polling interval, max attempts, terminal status detection, and error callbacks. Uses all `STT_V2_ENDPOINTS` job-related constants (24 tests). **ASR-R-09**: Created `SSEClient` — Server-Sent Events client for reconnecting to job update streams at `GET /api/v1/transcription-jobs/:id/stream`. Supports generic message listeners, named event listeners (e.g., `transcript`, `status`, `progress`), automatic reconnection with configurable interval and max attempts, reconnect count reset on successful connection, and clean disconnect that prevents further reconnection (20 tests). **ASR-R-10**: Created `FileTranscriptionService` — file upload transcription workflow. Uploads audio files via `POST /api/v1/transcription-jobs/transcribe` as multipart/form-data with pipelineId, optional consultationId/language/sampleRate fields. Returns job response for SSE subscription. Provides `buildJobStreamUrl(jobId)` for constructing SSE URLs to pair with `SSEClient`, and `getActiveJobId()` for tracking the most recent upload (14 tests). All 58 Stream D tests pass. Zero regressions on 746 baseline+prior tests. New files: `TranscriptionJobService.ts`, `SSEClient.ts`, `FileTranscriptionService.ts`, `TranscriptionJobService.test.ts`, `SSEClient.test.ts`, `FileTranscriptionService.test.ts`. | Complete |
| 9 | 2026-02-17 | **Layer 2 Stream F: DX Polish implemented (TDD).** 7 of 8 gaps resolved (1 deferred). **ASR-L-01 / HOOK-05**: Added `toggleSTT(enabled?)` and `toggleVAD(enabled?)` to `UseArcaAudio` interface; both call `pluginManager.setEnabled()` and update store audio plugin states. Toggle without argument inverts current state (6 tests). **ASR-L-03**: Added `selectedProvider` and `sttLocation` read-only getters to `TranscriptionPipeline`; expose which STT provider (`local`/`backend`/`auto`) and processing location (`browser`/`backend`/`auto`) are configured, updated after `updateConfig()` (6 tests). **ASR-R-11**: Verified no legacy STT v1 gateway references (`STT_GATEWAY`, `STT_V1`, `LEGACY_STT`) exist in exported constants; confirmed `STT_V2_ENDPOINTS.WS_STREAM` is the sole streaming path (4 tests). **SES-07**: Added `CONTEXT_ENDPOINTS.TRANSCRIPTIONS(id)` → `/consultations/:id/context/transcriptions` and `CONTEXT_ENDPOINTS.CASE_NOTES(id)` → `/consultations/:id/context/case-notes`; added `fetchTranscriptions()` and `fetchCaseNotes()` to `UseArcaContext` interface in `useArca` (4 constant tests + 5 hook tests). **HOOK-04**: Re-exported `useMedNER` from `@arcaai/med-ner` in `plugins.ts` for consistent plugin hook pattern alongside `useVAD`, `useSTT`, `useNoiseFilter` (6 tests). **HOOK-06**: Added `loadSummaries()` to both `UseArcaSummary` (in `useArca`) and `UseArcaSessionReturn` (in `useArcaSession`); fetches all summaries via `GET /consultations/:id/summary` and populates store via `setSummaries()` — ensures summaries survive page refresh (3 + 3 tests). **HOOK-07**: Added `withRetry<T>(fn, options?)` to `UseArcaReturn`; uses existing `isRetriableError()` from `errorUtils` to decide retry eligibility. Supports configurable `maxRetries` (default 3) and `delayMs` (default 1000). Non-retriable errors are thrown immediately without retry (4 tests). **ASR-L-02** (deferred): `STTPluginState.modelLoadProgress` type field already exists; actual progress wiring requires changes to `@arcaai/stt` package internals (out of SDK scope). All 767 tests pass (41 new Stream F + 726 baseline+prior). Zero regressions. Files modified: `useArca.ts`, `useArcaSession.ts`, `TranscriptionPipeline.ts`, `constants.ts`, `plugins.ts`. New test files: `useArca.dx.test.ts`, `useArcaSession.dx.test.ts`, `TranscriptionPipeline.provider.test.ts`, `constants.ses07.test.ts`, `constants.sttv1.test.ts`, `plugins.exports.test.ts`. | Complete |
| 10 | 2026-02-17 | **Layer 2 Stream E: Feature Parity implemented (TDD).** All 8 gaps resolved. **SUM-01**: Added async summary generation — new `SUMMARY_ENDPOINTS.GENERATE_ASYNC`, `.PRE_SUMMARY_ASYNC`, `.COMPREHENSIVE_ASYNC` constants; new `AsyncJobResponse` and `SummaryJobStatus` types in `summary.ts`; new `generateSummaryAsync()` and `generatePreSummaryAsync()` methods on `UseArcaSummary` interface (5 tests). **SUM-02**: Added comprehensive (cross-chain) summary — new `SUMMARY_ENDPOINTS.COMPREHENSIVE` constant; new `ComprehensiveSummaryResponse` and `ComprehensiveSummaryOptions` types; new `generateComprehensiveSummary()` method on `UseArcaSummary` (2 tests). **SUM-03**: Added latest pre-summary fetch — new `SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY` constant; new `getLatestPreSummary()` method on `UseArcaSummary` (2 tests). **SUM-04**: Enhanced `loadSummaries()` to use `SUMMARY_ENDPOINTS.LIST` constant; added pagination support via optional `PaginationParams` argument; populates store via `setSummaries()` (2 tests). **SES-04**: Added consultation timeline — new `CONSULTATION_ENDPOINTS.TIMELINE` constant; new `TimelineEntry` and `TimelineScope` types in `consultation.ts`; new `getTimeline(scope?)` method on `UseArcaSession` supporting `?scope=single|chain` query param (3 tests). **SES-05**: Added context version history — new `CONTEXT_ENDPOINTS.VERSIONS` and `CONTEXT_ENDPOINTS.VERSION` constants; new `ContextVersionEntry` type in `context.ts`; new `getContextVersions(contextItemId)` method on `UseArcaContext` (2 tests). **SES-06**: Added pagination parameters to `ContextFilters.page`, `getPatientHistory(patientId, pagination?)` and `loadSummaries(pagination?)` — URL query string constructed via `URLSearchParams` (2 tests). **NER-R-03**: Wired `SUMMARY_ENDPOINTS.EXTRACT_ENTITIES` into NER flow — new `triggerEntityExtraction(contextItemId)` method on `UseArcaContext` calls `POST /consultations/:id/summary/:contextItemId/extract-entities` (3 tests). All 767 tests pass (43 new Stream E: 10 constants + 12 types + 21 hooks, plus 724 baseline+prior). Zero regressions. Files modified: `constants.ts` (7 new endpoints), `useArca.ts` (8 new methods + 2 enhanced methods + interface updates), `types/summary.ts` (4 new types), `types/consultation.ts` (2 new types), `types/context.ts` (1 new type + pagination field), `types/index.ts` (new exports), `core.ts` (new exports). New test files: `stream-e-constants.test.ts`, `stream-e-types.test.ts`, `useArca.streamE.test.ts`. | Complete |
| 11 | 2026-02-17 | **Post-review fixes: all recommendations and suggestions addressed.** (1) **Bug fix**: `useArcaSession.loadSummaries()` was calling `SUMMARY_ENDPOINTS.GENERATE` (POST endpoint) instead of `SUMMARY_ENDPOINTS.LIST` (GET endpoint) — would have caused HTTP 405. Fixed. (2) **DRY refactor**: Extracted `withRetry()` and `RetryOptions` from `useArca.ts` into shared `utils/errorUtils.ts` with `onRetry` callback support. Hook's `withRetry` now delegates to the shared utility, enabling reuse in `useArcaSession`, STT-V2 services, and any consumer. (3) **Cache TTL**: Added `PipelineRegistryOptions.cacheTtlMs` (default 5 min), `isPipelinesStale()`/`isModelsStale()` checks, `invalidate()` to clear all caches, and `refresh()` to invalidate + reload. `PipelineRegistryState` now includes staleness fields. (4) **WS reconnection**: Added `WsReconnectOptions` to `SttV2WebSocketClient` constructor with `enabled`, `maxAttempts` (5), `baseDelayMs` (1s), `maxDelayMs` (30s). Auto-reconnect on unexpected disconnect with exponential backoff. Added `onReconnect(cb)`, `onReconnectFailed(cb)`, `cancelReconnect()`, `getReconnectAttempts()`. Intentional `disconnect()` suppresses reconnection. (5) **Breaking changes documented**: Added Section 9 "Breaking Changes & Migration Guide" covering session API (HOOK-01), DNA deprecation (SUM-06), entity paths (NER-R-05), model paths (ASR-R-07) with migration examples. Files: `useArcaSession.ts`, `useArca.ts`, `errorUtils.ts`, `PipelineRegistry.ts`, `SttV2WebSocketClient.ts`, `README.md`. | Complete |
