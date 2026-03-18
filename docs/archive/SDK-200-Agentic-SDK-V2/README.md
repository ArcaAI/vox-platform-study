# SDK-200: Agentic SDK Version 2 - Analysis & Planning

| Field | Value |
|-------|-------|
| **Ticket Number** | SDK-200 |
| **Created Date** | 2026-01-11 |
| **Last Updated** | 2026-01-11 |
| **Status** | Planning |

---

## Executive Summary

This document provides a comprehensive analysis of the deprecated Agentic SDK v1 and related packages to inform the design and implementation of Agentic SDK v2. The analysis covers:

1. **Deprecated SDK v1** - Architecture, hooks, services, pros/cons
2. **Room Package** - Foundation for audio processing pipeline
3. **Plugin Packages** - STT, VAD, Noise-Filter architecture patterns
4. **Backend API & Data Models** - Current state and gaps
5. **Recommendations** - For SDK v2 implementation

---

## Table of Contents

- [1. Deprecated SDK v1 Analysis](#1-deprecated-sdk-v1-analysis)
- [2. Room Package Architecture](#2-room-package-architecture)
- [3. Plugin Architecture Analysis](#3-plugin-architecture-analysis)
- [4. Backend API & Data Model Analysis](#4-backend-api--data-model-analysis)
- [5. Gap Analysis](#5-gap-analysis)
- [6. SDK v2 Architecture Recommendations](#6-sdk-v2-architecture-recommendations)
- [7. Hook Design Recommendations](#7-hook-design-recommendations)
- [8. Backend Data Model Recommendations](#8-backend-data-model-recommendations)

---

## 1. Deprecated SDK v1 Analysis

### 1.1 Package Structure

```
packages/agentic-sdk/
├── docs/                          # Documentation
├── examples/                      # Example React applications
├── src/
│   ├── __tests__/                 # Unit tests
│   ├── components/                # UI components
│   ├── core/                      # Core managers and services
│   ├── react/                     # React hooks
│   ├── services/                  # API and processing services
│   ├── types/                     # TypeScript type definitions
│   └── utils/                     # Utility functions
├── package.json
└── rollup.config.js               # Build configuration
```

### 1.2 Current Hooks Inventory

| Hook | Parameters | Return Properties | Issues |
|------|------------|-------------------|--------|
| `useArcaSessionManager` | 6 props | 10 returns | Too many options, mixed concerns |
| `useArcaSpeechToText` | 7 props | 12 returns | Large interface, model loading mixed with transcription |
| `useAudioCapture` | 4 props | 7 returns | Reasonable |
| `useArcaTextToSpeech` | 6 props | 10 returns (tuple) | **Inconsistent tuple return**, complex state |
| `useArcaaiVAD` | 6 props | 13 returns | Excessive state exposure |
| `useArcaaiDiarization` | 6 props | 14 returns | Very complex, mixed VAD+diarization |
| `useSMR` | 4 props | 15 returns | Too many methods, should be split |
| `useArcaDNA` | 5 props | 13 returns | Large but reasonable |

### 1.3 Pros of Current Implementation

| Aspect | Strength |
|--------|----------|
| **Feature Rich** | Covers STT, TTS, VAD, diarization, summarization, voice profiles |
| **Local + Cloud** | Supports both browser-based ML and cloud APIs |
| **React Hooks** | Hook-based API for React integration |
| **Type Safety** | Comprehensive TypeScript types |
| **Offline Support** | Session recovery, offline queue, IndexedDB persistence |
| **Noise Suppression** | Built-in RNNoise integration |
| **Medical Focus** | Domain-specific types (PatientInfo, ProviderInfo) |
| **Event System** | Flexible EventEmitter for async operations |

### 1.4 Cons of Current Implementation

| Aspect | Weakness | Impact |
|--------|----------|--------|
| **Monolithic Design** | SDK is a massive bundle | Can't use individual features |
| **Tight Coupling** | Hooks depend on internal managers | Hard to extend |
| **Inconsistent Returns** | `useTTS` returns tuple vs objects | Confusing API |
| **State Management** | No centralized store | State scattered |
| **setTimeout Workarounds** | Race conditions handled with delays | Unreliable |
| **Singleton Pattern** | `AgenticSDK.getInstance()` | Prevents multiple instances |
| **Large Bundle** | ONNX runtime, Whisper adds ~50MB+ | Performance |
| **No Tree Shaking** | Single entry exports everything | Wasted bytes |
| **Browser-Only** | No SSR/Node.js support | Limited deployment |

### 1.5 Current Hook Signatures (Reference)

```typescript
// useArcaSessionManager - 6 props, 10 returns
interface IArcaSessionOptions {
  sessionId?: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  options?: Partial<SDKConfig>;
  onError?: (error: ErrorInfo) => void;
}

interface IArcaSessionManagerReturn {
  session: MedicalSession | null;
  isLoading: boolean;
  error: ErrorInfo | null;
  createSession: (metadata?) => Promise<MedicalSession>;
  updateSession: (jsonData?) => Promise<void>;
  loadSession: (sessionId: string) => Promise<MedicalSession>;
  startSession: () => Promise<void>;
  pauseSession: (reason?: string) => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
  clearError: () => void;
}
```

---

## 2. Room Package Architecture

### 2.1 Core Components

The `@arcaai/room` package provides a well-architected foundation:

```
Room (Orchestrator)
├── AudioContextManager (Singleton AudioContext)
├── AudioTrack (Audio abstraction with processor support)
└── ProcessorPipeline (Chain multiple processors)

BaseProcessor (Abstract)
├── NativeProcessor (WebRTC constraints)
├── NoiseFilterProcessor (@arcaai/noise-filter)
├── VADProcessor (@arcaai/vad)
└── STTProcessor (@arcaai/stt)
```

### 2.2 Key Patterns to Adopt

| Pattern | Description | Benefit |
|---------|-------------|---------|
| **TypedEventEmitter** | Generic type-safe events | Compile-time validation |
| **Template Method** | `BaseProcessor.init()` → `onInit()` | Consistent lifecycle |
| **AsyncLock** | Serializes processor changes | Prevents race conditions |
| **Dual-Mode Hooks** | Works with/without Provider | Flexible usage |
| **Priority Pipeline** | Numeric priorities for ordering | Deterministic processing |

### 2.3 Room Hooks API

```typescript
// useRoom - Core room management
const { room, state, isConnected, localTracks, connect, createLocalTrack } = useRoom();

// useAudioTrack - Track capture and control
const { track, isCapturing, startCapture, stopCapture, mute, unmute } = useAudioTrack();

// useAudioLevel - Real-time audio levels
const { level, isSpeaking, peak, average } = useAudioLevel(track);

// useDevices - Device enumeration and selection
const { devices, selectInputDevice, refreshDevices } = useDevices();

// useProcessors - Processor pipeline management
const { addProcessor, removeProcessor, setProcessorEnabled } = useProcessors({ track });
```

### 2.4 Processor Integration Pattern

```typescript
// Plugin extends BaseProcessor from @arcaai/room
class MyProcessor extends BaseProcessor {
  constructor() {
    super('my-processor');
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    // 1. Create Web Audio source from input track
    this.sourceNode = audioContext.createMediaStreamSource(stream);

    // 2. Create processing node
    this.processingNode = await this.initProcessing(audioContext);

    // 3. Create destination
    this.destinationNode = audioContext.createMediaStreamDestination();

    // 4. Connect: source → processor → destination
    this.sourceNode.connect(this.processingNode);
    this.processingNode.connect(this.destinationNode);

    // 5. Set processed track
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }
}
```

---

## 3. Plugin Architecture Analysis

### 3.1 STT Package Architecture

```
@arcaai/stt
├── providers/
│   ├── BaseSTTProvider (abstract)
│   ├── LocalSTTProvider (Whisper in-browser)
│   └── BackendSTTProvider (WebSocket streaming)
├── engines/
│   ├── BaseEngine (abstract)
│   └── WhisperEngine (Transformers.js)
├── core/
│   ├── STTProcessor (extends BaseProcessor)
│   └── AudioBufferManager (chunking with overlap)
└── websocket/
    ├── WebSocketClient
    └── MessageHandler
```

**Provider Strategy Pattern:**
```typescript
type STTProviderType = 'local' | 'backend' | 'auto';

// Auto-selection based on browser capabilities
function getRecommendedProvider(): STTProviderType {
  if (isTransformersJsSupported()) return 'local';
  if (isWebSocketSupported()) return 'backend';
  return 'local';
}
```

### 3.2 VAD Package Architecture

```
@arcaai/vad
├── processors/
│   └── VADProcessor (extends BaseProcessor)
├── hooks/
│   └── useVAD
├── worklets/
│   └── vad.worklet.ts
└── utils/
    ├── frameProcessor.ts
    └── resampler.ts
```

**VAD Event Types:**
- `vad-speech-start` - Speech detected
- `vad-speech-end` - Speech ended (with audio data)
- `vad-misfire` - Speech too short

### 3.3 Noise-Filter Package Architecture

```
@arcaai/noise-filter
├── processors/
│   ├── NoiseFilterProcessor (extends BaseProcessor)
│   └── RNNoiseProcessor (WASM wrapper)
└── worklets/
    └── rnnoise.worklet.ts
```

**Key Technical Parameters:**
- RNNoise Frame Size: 480 samples (10ms at 48kHz)
- Latency: ~10ms algorithmic delay
- WASM Size: ~85KB

### 3.4 Plugin Best Practices

1. **Extend BaseProcessor** for consistent lifecycle
2. **Use factory functions** (`createSTT()`, `createVAD()`)
3. **Emit typed data events** for monitoring
4. **Implement fallback chains** (AudioWorklet → ScriptProcessor → Native)
5. **Check browser support** before initialization

---

## 4. Backend API & Data Model Analysis

### 4.1 Current Database Schema

The database uses Prisma with the following key models:

| Model | Purpose | Issues |
|-------|---------|--------|
| `Session` | Main entity holding all consultation data | **Overloaded** - contains JSONB for transcripts, audio |
| `SessionEvent` | Session lifecycle events | Good |
| `User`, `UserProfile` | User management | Good |
| `Tenant` | Multi-tenancy | Good |
| `ApiKey` | SDK authentication | Good |

**Current Session Model (Simplified):**
```prisma
model Session {
  id                String        @id
  tenantId          String?
  sessionStatus     SessionStatus
  sessionType       SessionType   // AGENTIC_SDK, WEB, etc.

  // Medical context (overloaded)
  medicalSessionId  String?
  patientId         String?
  providerId        String?

  // JSONB sprawl - untyped, hard to query
  audioSessionData  Json?
  transcriptData    Json?
  deviceCapabilities Json?
}
```

### 4.2 Current API Endpoints

| Controller | Endpoints | Auth |
|------------|-----------|------|
| `SessionController` | CRUD + validate/sync | ApiKeyGuard |
| `SttController` | Proxy to STT service | ApiKeyGuard |
| `TtsController` | Proxy to TTS service | ApiKeyGuard |
| `SmrController` | Proxy to SMR service | ApiKeyGuard |
| `NlpController` | NER processing | ApiKeyGuard |

### 4.3 Data Model Gaps

| Missing Entity | Current State | Impact |
|----------------|---------------|--------|
| **Consultation** | Conflated with Session | No proper consultation lifecycle |
| **Transcription** | JSONB in Session | Can't query segments |
| **Summary** | Only in SMR service DB | Not integrated |
| **Context** | Scattered JSONB fields | No structured CRUD |
| **CaseNote** | None | Completely missing |
| **MedicalEntity** | Real-time only (NLP) | No persistence |

### 4.4 SMR Service - Separate Database

The SMR service has its own `medical_summaries` table, not integrated with main Prisma schema:

```python
# SMR service (separate DB)
medical_summaries:
  - id
  - session_id
  - summary_text
  - llm_provider
  - model_name
  - processing_time
  - created_at
```

---

## 5. Gap Analysis

### 5.1 SDK Architecture Gaps

| Gap | V1 State | V2 Requirement |
|-----|----------|----------------|
| Modular packages | Monolithic bundle | Separate `@arcaai/room`, `@arcaai/stt`, etc. |
| State management | Scattered useState | Centralized Zustand store |
| Hook consistency | Mixed return types | Standardized `{ state, status, actions }` |
| Processor pipeline | None | ProcessorPipeline from room package |
| Session management | Over-engineered | Developer-controlled, simple lifecycle |
| Context management | Ad-hoc | Structured CRUD operations |

### 5.2 Backend Gaps

| Gap | Current State | V2 Requirement |
|-----|---------------|----------------|
| Consultation model | Session overloading | Dedicated `Consultation` entity |
| Transcription segments | JSONB blob | Typed `TranscriptionSegment` model |
| Summary persistence | SMR service only | Integrated in main schema |
| Context CRUD | None | Structured API endpoints |
| NER persistence | Real-time only | `MedicalEntity` model |
| Case notes | None | `CaseNote` or `ContextItem` model |

### 5.3 Hook Simplification Needs

**Current Problem:** Hooks have too many properties

| Hook | Current Props | Current Returns | Target Returns |
|------|---------------|-----------------|----------------|
| `useArcaSessionManager` | 7 | 10 | 3-4 |
| `useArcaSpeechToText` | 7 | 12 | 3-4 |
| `useArcaaiVAD` | 6 | 13 | 3-4 |
| `useSMR` | 4 | 15 | 3-4 |

---

## 6. SDK v2 Architecture Recommendations

### 6.1 Package Structure

```
@arcaai/vox (orchestration layer)
├── Composes plugin packages
├── Provides high-level hooks
└── Manages consultation workflow

@arcaai/room (foundation - already built)
├── Room, AudioTrack, ProcessorPipeline
├── React hooks
└── Event system

@arcaai/noise-filter (plugin - already built)
@arcaai/vad (plugin - already built)
@arcaai/stt (plugin - already built)
@arcaai/tts (plugin - to be built)
@arcaai/ner (plugin - to be built)
```

### 6.2 Core Design Principles

1. **Composition over Monolith**: SDK v2 composes existing packages
2. **Centralized State**: Zustand store for all SDK state
3. **Standardized Hook Returns**: `{ data, status, actions }` pattern
4. **Developer Control**: Simple session lifecycle, no strict management
5. **Flexible Context**: Type-agnostic context items with `type` discriminator
6. **Plugin Architecture**: All processing via room's processor pipeline

### 6.3 State Management with Zustand

```typescript
interface AgenticState {
  initialized: boolean;
  connected: boolean;
  session: ConsultationSession | null;
  context: ContextItem[];
  settings: UserSettings;
  error: Error | null;
}

interface AgenticActions {
  setSession: (session: ConsultationSession | null) => void;
  addContext: (item: ContextItem) => void;
  updateContext: (id: string, updates: Partial<ContextItem>) => void;
  clearContext: () => void;
  updateSettings: (settings: Partial<UserSettings>) => void;
}
```

### 6.4 Integration Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AgenticProvider                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │                   RoomProvider                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  │   │
│  │  │ NoiseFilter │→ │    VAD      │→ │   STT    │  │   │
│  │  │  Processor  │  │  Processor  │  │Processor │  │   │
│  │  └─────────────┘  └─────────────┘  └──────────┘  │   │
│  │                         │                         │   │
│  │                   AudioTrack                      │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│           ┌─────────────┴─────────────┐                │
│           ▼                           ▼                │
│    Zustand Store              ApiClient                │
│    (Local State)         (Backend Sync)                │
└─────────────────────────────────────────────────────────┘
```

---

## 7. Hook Design Recommendations

### 7.1 Standardized Return Pattern

All hooks should return objects with maximum 4 top-level properties:

```typescript
interface StandardHookReturn<TData, TStatus, TActions> {
  data: TData;           // Main data (nullable if loading)
  status: TStatus;       // { isLoading, error }
  actions: TActions;     // Methods to invoke
}
```

### 7.2 Recommended Hook Signatures

#### useArcaSessionManager (Simplified)

```typescript
// BEFORE (V1): 7 props, 10 returns
// AFTER (V2): 0-1 props, 3 returns

interface UseArcaSessionManagerReturn {
  session: ConsultationSession | null;
  status: { isLoading: boolean; error: Error | null };
  actions: {
    create: (input: { patientId: string; providerId: string; metadata?: object }) => Promise<ConsultationSession>;
    update: (updates: { status?: string; metadata?: object }) => Promise<void>;
    load: (sessionId: string) => Promise<ConsultationSession>;
    end: () => Promise<void>;
  };
}

function useArcaSessionManager(): UseArcaSessionManagerReturn;
```

#### useArcaAudio (Simplified, combines capture + processing)

```typescript
// Combines useAudioCapture + STT + VAD + NoiseFilter
interface UseArcaAudioOptions {
  onTranscription?: (data: TranscriptionPayload) => void;
  onVAD?: (data: VADPayload) => void;
}

interface UseArcaAudioReturn {
  track: AudioTrack | null;
  status: {
    isCapturing: boolean;
    isMuted: boolean;
    level: number;
    error: Error | null;
  };
  actions: {
    startCapture: () => Promise<void>;
    stopCapture: () => Promise<void>;
    mute: () => void;
    unmute: () => void;
  };
}

function useArcaAudio(options?: UseArcaAudioOptions): UseArcaAudioReturn;
```

#### useArcaContext (New, flexible context management)

```typescript
interface UseArcaContextReturn {
  context: ContextItem[];
  status: { isLoading: boolean; error: Error | null };
  actions: {
    addCaseNote: (note: CaseNoteInput) => Promise<ContextItem>;
    addTranscription: (text: string, metadata?: object) => Promise<ContextItem>;
    generatePreSummary: (options?: PreSummaryOptions) => Promise<PreSummary>;
    generateSummary: (options?: SummaryOptions) => Promise<Summary>;
    updateSummary: (summaryId: string, content: string) => Promise<void>;
    getContext: (filters?: ContextFilters) => Promise<ContextItem[]>;
    getNERData: (contextId?: string) => Promise<NERData>;
    clearContext: () => void;
  };
}

function useArcaContext(): UseArcaContextReturn;
```

#### useArcaSummary (Summary-specific operations)

```typescript
interface UseArcaSummaryReturn {
  summaries: ContextItem[];
  dnaStyle: DNAStyle | null;
  status: { isGenerating: boolean; isAnalyzingDNA: boolean; error: Error | null };
  actions: {
    generate: (options?: SummaryOptions) => Promise<SummaryWithDNA>;
    regenerate: (summaryId: string, options?: SummaryOptions) => Promise<SummaryWithDNA>;
    update: (summaryId: string, content: string) => Promise<void>;
    analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
    getDNAStyle: (userId: string) => Promise<DNAStyle | null>;
  };
}

function useArcaSummary(): UseArcaSummaryReturn;
```

### 7.3 Hook Comparison: V1 vs V2

| Hook | V1 Returns | V2 Returns | Reduction |
|------|------------|------------|-----------|
| `useArcaSessionManager` | 10 | 3 | 70% |
| `useArcaSpeechToText` | 12 | Merged into useArcaAudio | N/A |
| `useAudioCapture` | 7 | Merged into useArcaAudio | N/A |
| `useArcaAudio` (new) | N/A | 3 | New |
| `useArcaContext` (new) | N/A | 3 | New |
| `useArcaSummary` (new) | N/A | 4 | New |
| `useSMR` | 15 | Merged into useArcaContext/Summary | N/A |

---

## 8. Backend Data Model Recommendations

### 8.1 Recommended New Models

```prisma
// Consultation as first-class entity
model Consultation {
  id            String             @id @default(uuid(7))
  tenantId      String
  patientId     String?
  providerId    String?
  sessionId     String             @unique
  status        String             // Developer-defined, no enum
  department    String?
  visitType     String?            // new-visit, re-visit
  startedAt     DateTime
  endedAt       DateTime?
  metadata      Json?              @db.JsonB

  Session       Session            @relation(...)
  ContextItems  ContextItem[]
}

// Flexible context items (case notes, transcriptions, summaries, etc.)
model ContextItem {
  id              String           @id @default(uuid(7))
  consultationId  String
  type            String           // Developer-defined: case_note, transcription, summary, etc.
  content         String
  structuredData  Json?            @db.JsonB
  source          String           // user, system, transcription, ai
  version         Int              @default(1)
  createdAt       DateTime
  updatedAt       DateTime

  Consultation    Consultation     @relation(...)
  Entities        MedicalEntity[]
}

// NER entity persistence
model MedicalEntity {
  id              String           @id @default(uuid(7))
  contextItemId   String
  entityType      String           // DISEASE, SYMPTOM, MEDICATION, etc.
  text            String
  normalizedText  String?
  codes           Json?            // { icd10: [], snomed: [], rxnorm: [] }
  confidence      Float
  startOffset     Int
  endOffset       Int

  ContextItem     ContextItem      @relation(...)
}
```

### 8.2 Simplified API Endpoints

```
POST   /consultations                     # Create consultation
GET    /consultations/:id                 # Get consultation
PATCH  /consultations/:id                 # Update consultation
DELETE /consultations/:id                 # End/archive consultation

POST   /consultations/:id/context         # Add context item (any type)
GET    /consultations/:id/context         # List context items (with filters)
PATCH  /consultations/:id/context/:itemId # Update context item
DELETE /consultations/:id/context/:itemId # Remove context item

POST   /consultations/:id/summary         # Generate summary
GET    /consultations/:id/summary/:id     # Get summary
PATCH  /consultations/:id/summary/:id     # Update summary

GET    /consultations/:id/entities        # Get all NER entities
GET    /consultations/:id/context/:itemId/entities  # Get entities for context item
```

### 8.3 Context Item Types (Developer-Defined)

The SDK does NOT manage types. Developers define their own:

```typescript
// Common context types (examples, not enforced)
type ContextType =
  | 'case_note'           // Historical case notes
  | 'transcription'       // Real-time transcription segments
  | 'pre_summary'         // Pre-consultation summary
  | 'summary'             // Final consultation summary
  | 'manual_note'         // Doctor's manual notes
  | 'test_result'         // Lab/imaging results
  | 'medication'          // Current medications
  | string;               // Any custom type
```

---

## 9. Summary of Key Decisions

### 9.1 Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **Use Zustand for state** | Simpler than Redux, built-in persistence, works with React 18/19 |
| **Compose existing packages** | @arcaai/room provides solid foundation |
| **Standardize hook returns** | `{ data, status, actions }` pattern reduces cognitive load |
| **Type-agnostic context** | Flexible `ContextItem` with `type` string, not enum |
| **Developer-controlled session** | Simple lifecycle, no strict state machine |

### 9.2 Breaking Changes from V1

| V1 Feature | V2 Change | Migration Path |
|------------|-----------|----------------|
| `useArcaSpeechToText` | Merged into `useArcaAudio` | Use `onTranscription` callback |
| `useAudioCapture` | Merged into `useArcaAudio` | Direct replacement |
| `useSMR` | Split into `useArcaContext` + `useArcaSummary` | Separate concerns |
| Tuple returns | Object returns | Destructure differently |
| Singleton SDK | Provider-based | Wrap with `<AgenticProvider>` |

### 9.3 Backward Compatibility

**Preserved Hook Names:**
- `useArcaSessionManager` ✓
- `useArcaTextToSpeech` ✓ (via TTS plugin)
- `useArcaDNA` ✓ (integrated into useArcaSummary)

**New Hooks:**
- `useArcaAudio` (combines audio capture + processing)
- `useArcaContext` (flexible context management)
- `useArcaSummary` (summary generation with DNA)
- `useArcaSettings` (personalization)

---

## 10. Implementation Plans

The implementation is organized into 6 phases, each with a dedicated plan document:

| Phase | Document | Description |
|-------|----------|-------------|
| 1 | [Prisma Changes](./plan-01-prisma-changes.md) | Database schema for Consultation, ContextItem, MedicalEntity, Summary |
| 2 | [Domain Layer](./plan-02-domain-layer.md) | Entities, factories, mappers, repositories using @arcaai/tools |
| 3 | [API Layer](./plan-03-api-layer.md) | Application services, DTOs, NestJS controllers |
| 4 | [SDK v2](./plan-04-sdk-v2.md) | React hooks, Zustand store, AgenticProvider |
| 5 | [Examples](./plan-05-sdk-examples.md) | Usage examples for common workflows |
| 6 | [Documentation](./plan-06-documentation.md) | README, migration guide, API reference |
| 7 | [User Preferences API](./plan-07-user-preferences-api.md) | `/users/me/preferences` endpoints for SDK personalization |

### Key Design Decisions

- **Session Identifier**: `patientId + appointmentDate` (date only, no time)
- **Visit Type**: Derived from `parentConsultationId` (NULL = new-visit, set = re-visit)
- **Context Sharing**: All consultations in a chain share context
- **Hook Pattern**: Standardized `{ data, status, actions }` return

---

## Related Documents

### Analysis Documents
- [V1 SDK Analysis](./analysis-v1-sdk.md) - Detailed review of deprecated SDK
- [Backend Analysis](./analysis-backend.md) - Backend API and data model review
- [Plugin Architecture](./analysis-plugin-architecture.md) - Room, STT, VAD, noise-filter patterns

### Implementation Plans
- [Plan 01: Prisma Changes](./plan-01-prisma-changes.md)
- [Plan 02: Domain Layer](./plan-02-domain-layer.md)
- [Plan 03: API Layer](./plan-03-api-layer.md)
- [Plan 04: SDK v2](./plan-04-sdk-v2.md)
- [Plan 05: SDK Examples](./plan-05-sdk-examples.md)
- [Plan 06: Documentation](./plan-06-documentation.md)
- [Plan 07: User Preferences API](./plan-07-user-preferences-api.md)

### Migration Resources
- [Migration Guide](./migration-guide.md) - V1 to V2 migration (to be created)
- [API Reference](./api-reference.md) - Complete API documentation (to be created)
