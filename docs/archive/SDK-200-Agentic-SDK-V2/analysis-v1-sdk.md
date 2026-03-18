# Deprecated Agentic SDK v1 - Detailed Analysis

## Overview

This document provides a comprehensive analysis of the deprecated `@arcaai/agentic-sdk` package to inform SDK v2 design decisions.

---

## 1. Core Architecture

### 1.1 Service Layer

| Class | File | Responsibility |
|-------|------|----------------|
| `AgenticSDK` | `core/AgenticSDK.ts` | Singleton orchestrator for all managers |
| `SessionManager` | `core/SessionManager.ts` | Session lifecycle, storage, recovery, API sync |
| `AudioCaptureManager` | `core/AudioCaptureManager.ts` | Microphone access, audio processing |
| `WebSocketManager` | `core/WebSocketManager.ts` | Real-time WebSocket connections |
| `ConfigurationManager` | `core/ConfigurationManager.ts` | SDK configuration management |
| `SessionStorageManager` | `core/SessionStorageManager.ts` | IndexedDB storage operations |
| `SessionRecoveryManager` | `core/SessionRecoveryManager.ts` | Session recovery after crashes |
| `VoiceProfileManager` | `core/VoiceProfileManager.ts` | Voice enrollment and recognition |

### 1.2 API Services

| Service | File | Responsibility |
|---------|------|----------------|
| `ApiClient` | `services/apiClient.ts` | HTTP client wrapper |
| `SessionApi` | `services/sessionApi.ts` | Session CRUD API operations |
| `RemoteSttService` | `services/remoteStt.service.ts` | Cloud-based STT |
| `LocalSttService` | `services/localStt.service.ts` | Browser-based Whisper |
| `LocalVADService` | `services/localVad.service.ts` | Browser-based VAD |
| `LocalDiarizationService` | `services/localDiarization.service.ts` | Speaker diarization |
| `DnaService` | `services/dna.service.ts` | DNA writing style analysis |

### 1.3 State Management Pattern

The SDK uses a **mixed state management pattern**:

```
useState (React State)
    │
    ├── For UI-reactive state
    │
useRef (Service Instances)
    │
    ├── For callback stability
    │
EventEmitter3
    │
    └── For service-to-component communication
```

**Issues:**
- State scattered across hooks
- Race conditions handled with `setTimeout`
- No centralized store

---

## 2. Complete Hook Signatures

### 2.1 useArcaSessionManager

```typescript
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
  createSession: (metadata?: Partial<SessionMetadata>) => Promise<MedicalSession>;
  updateSession: (jsonData?: Record<string, unknown>) => Promise<void>;
  loadSession: (sessionId: string) => Promise<MedicalSession>;
  startSession: () => Promise<void>;
  pauseSession: (reason?: string) => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
  clearError: () => void;
}
```

### 2.2 useArcaSpeechToText

```typescript
interface UseArcaSpeechToTextProps {
  sessionId: string;
  language: string;
  options?: Partial<SDKConfig>;
  transcriptTemplate?: string;
  onTranscript: (text: string, isFinal: boolean, metadata?: Record<string, any>) => void;
  onError?: (error: ErrorInfo) => void;
  onStatus?: (status: string, data?: any) => void;
}

interface UseArcaSpeechToTextReturn {
  transcript: string;
  error: ErrorInfo | null;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
  sendAudioData: (audioData: ArrayBuffer, metadata?: Record<string, any>) => void;
  uploadAudioFile: (file: File, language: string, provider?: 'azure' | 'whisper') => Promise<string>;
  getTranscriptionStatus: (taskId: string) => Promise<TranscriptionTask>;
  isUploading: boolean;
  uploadProgress: number;
  isModelLoading: boolean;
  isModelReady: boolean;
  modelLoadingPercentage: number;
}
```

### 2.3 useAudioCapture

```typescript
interface UseAudioCaptureProps {
  options?: Partial<AudioConfig>;
  autoStart?: boolean;
  onAudioData?: (data: ArrayBuffer) => void;
  onError?: (error: ErrorInfo) => void;
}

interface UseAudioCaptureReturn {
  isRecording: boolean;
  deviceStatus: AudioDeviceStatus | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  getDeviceStatus: () => Promise<AudioDeviceStatus | null>;
  error: ErrorInfo | null;
  isReady: boolean;
}
```

### 2.4 useArcaTextToSpeech (Tuple Return - Inconsistent)

```typescript
interface I_ArcaTTSOptions {
  apiEndpoint?: string;
  socketPath?: string;
  storeAudio?: boolean;
  language?: string;
  options?: Partial<SDKConfig>;
  sessionId?: string;
}

// Returns a tuple (unconventional pattern)
function useArcaTextToSpeech(props?: I_ArcaTTSOptions): readonly [
  sendTextData: (text: string, options?) => void,
  loading: boolean,
  error: string | null,
  connect: () => void,
  disconnect: () => void,
  isConnected: boolean,
  audioData: Uint8Array[],
  downloadAudio: () => Promise<string | null>,
  downloadUrl: string | null,
  play: () => void
];
```

### 2.5 useArcaaiVAD

```typescript
interface UseArcaaiVADOptions {
  config?: Partial<VADConfig>;
  serviceOptions?: Omit<LocalVADServiceOptions, 'config' | 'callbacks'>;
  autoInitialize?: boolean;
  callbacks?: VADCallbacks;
  onResult?: (result: VADResult) => void;
  onError?: (error: VADError | Error) => void;
}

interface UseArcaaiVADReturn {
  vadService: LocalVADService | null;
  isReady: boolean;
  isProcessing: boolean;
  isRecording: boolean;
  progress: number;
  progressMessage: string;
  result: VADResult | null;
  error: VADError | Error | null;
  initialize: (config?, serviceOptions?) => Promise<void>;
  processAudio: (audioBlob: Blob, sampleRate?: number) => Promise<VADResult>;
  processFile: (file: File) => Promise<VADResult>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  updateConfig: (config: Partial<VADConfig>) => void;
  reset: () => void;
  destroy: () => void;
}
```

### 2.6 useArcaaiDiarization

```typescript
interface UseArcaaiDiarizationOptions {
  serviceOptions?: Omit<LocalDiarizationServiceOptions, 'callbacks'>;
  modelUrl?: string;
  autoInitialize?: boolean;
  onProgress?: (progress: number, stage: string, message?: string) => void;
  onResult?: (result: DiarizationResult) => void;
  onError?: (error: DiarizationError | Error) => void;
  vad?: { enabled?: boolean; config?: Partial<VADConfig>; serviceOptions?: ... };
  voiceRecognition?: { enabled?: boolean; threshold?: number; ... };
}

interface UseArcaaiDiarizationReturn {
  diarizationService: LocalDiarizationService | null;
  vadService: LocalVADService | null;
  isReady: boolean;
  vadReady: boolean;
  isProcessing: boolean;
  progress: number;
  progressMessage: string;
  progressStage: string;
  result: DiarizationResult | null;
  error: DiarizationError | Error | null;
  initialize: (serviceOptions?) => Promise<void>;
  diarize: (audioBlob: Blob, options?) => Promise<DiarizationResult>;
  diarizeFile: (file: File, options?) => Promise<DiarizationResult>;
  cancel: () => void;
  reset: () => void;
  destroy: () => void;
}
```

### 2.7 useSMR

```typescript
interface SMRRequest {
  text: string;
  sessionId?: string;
  provider?: 'azure' | 'ollama';
  model?: string;
  language?: string;
  template?: string;
  async?: boolean;
  patientId?: string;
  patientInfo?: PatientInfo;
  departmentId?: Department;
  doctorId?: string;
  visitType?: VisitType;
  testResults?: TestResult[];
  previousVisits?: PreviousVisitRecord[];
  preSummaryText?: string;
  includePreSummaryInContext?: boolean;
}

interface UseSMRReturn {
  summarize: (request: SMRRequest) => Promise<SummaryResponse>;
  summarizeSync: (request: SMRRequest) => Promise<SummaryResponse>;
  summarizeAsync: (request: SMRRequest) => Promise<SMRJobStatus>;
  getJobStatus: (jobId: string) => Promise<SMRJobStatus>;
  getJobResult: (jobId: string) => Promise<SummaryResponse>;
  listJobs: () => Promise<SMRJobStatus[]>;
  getProviders: () => Promise<string[]>;
  getModels: () => Promise<string[]>;
  cancelJob: (jobId: string) => Promise<void>;
  getHealthStatus: () => Promise<any>;
  preSummarize: (request: PreSummaryRequest) => Promise<PreSummaryResponse>;
  submitFeedback: (feedback: SMRFeedbackRequest) => Promise<SMRFeedbackResponse>;
  loading: boolean;
  error: string | null;
  isConnected: boolean;
  currentJob: SMRJobStatus | null;
  jobs: SMRJobStatus[];
}
```

### 2.8 useArcaDNA

```typescript
interface UseArcaDNAOptions {
  client?: ApiClient;
  baseUrl?: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

interface UseArcaDNA {
  loading: boolean;
  error: string | null;
  style: DnaStyleResponse | null;
  versions: DnaStyleVersion[] | null;
  auditResult: DnaAuditResponse | null;
  redactionResult: DnaRedactResponse | null;
  analyzeTexts: (req: DnaAnalyzeTextsRequest, options?) => Promise<DnaStyleResponse | string>;
  getStyle: (userId: string, options?) => Promise<DnaStyleResponse | string>;
  getStyleText: (userId: string) => Promise<string>;
  getStyleVersions: (userId: string) => Promise<DnaStyleVersion[]>;
  getStyleVersion: (userId: string, versionNumber: number) => Promise<DnaStyleVersion>;
  ingest: (req: DnaIngestRequest) => Promise<TaskResponse>;
  audit: (req: DnaAuditRequest) => Promise<DnaAuditResponse>;
  redact: (req: DnaRedactRequest) => Promise<DnaRedactResponse>;
  service: DnaService;
}
```

---

## 3. Type Definitions

### 3.1 SDK Configuration

```typescript
interface SDKConfig {
  apiEndpoint: string;
  websocketUrl: string;
  sttProvider: 'azure' | 'whisper';
  audioSettings: AudioConfig;
  errorReporting: ErrorConfig;
  logging: LogConfig;
  credentials?: CredentialsConfig;
  environment?: 'development' | 'staging' | 'production';
}

interface AudioConfig {
  sampleRate: number;           // 16000, 44100, 48000
  format: 'pcm' | 'wav' | 'mp3';
  channels: 1 | 2;
  bitDepth: 8 | 16 | 24 | 32;
  chunkSize: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}
```

### 3.2 Session Types

```typescript
type SessionStatus = 'IDLE' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'TERMINATED' | 'SUSPENDED';

interface MedicalSession {
  id: string;
  patientId?: string;
  startTime: Date;
  lastActivity: Date;
  endTime?: Date;
  status: SessionStatus;
  audioData: AudioSessionData;
  transcriptData: TranscriptSessionData;
  metadata: SessionMetadata;
  deviceInfo: DeviceInfo;
  version: number;
  checksum: string;
}

interface SessionMetadata {
  title?: string;
  description?: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  patientInfo?: PatientInfo;
  providerInfo?: ProviderInfo;
  appointmentId?: string;
  sessionType: 'consultation' | 'follow-up' | 'emergency' | 'routine';
  customFields: Record<string, unknown>;
  serverSessionId?: string;
}
```

---

## 4. Dependencies

### 4.1 Runtime Dependencies

| Package | Version | Purpose | Bundle Impact |
|---------|---------|---------|---------------|
| `@huggingface/transformers` | ^3.7.5 | Whisper model inference | ~30MB |
| `onnxruntime-web` | ^1.23.2 | ONNX runtime for VAD/diarization | ~20MB |
| `@jitsi/rnnoise-wasm` | ^0.2.1 | RNNoise noise suppression | ~85KB |
| `socket.io-client` | ^4.8.1 | WebSocket abstraction | ~50KB |
| `eventemitter3` | ^5.0.1 | Event system | ~5KB |
| `idb` | ^8.0.3 | IndexedDB wrapper | ~10KB |
| `jszip` | ^3.10.1 | File compression | ~100KB |
| `highlight.run` | ^9.21.0 | Error tracking & APM | ~200KB |

**Total Bundle Impact:** ~50MB+ (including ML models)

### 4.2 Deleted Workspace Dependencies

These packages were deleted but are still imported:

| Package | Status | Impact |
|---------|--------|--------|
| `@arcaai/audio` | Deleted | Broken imports |
| `@arcaai/diarization` | Deleted | Broken imports |
| `@arcaai/silero-stt` | Deleted | Broken imports |
| `@arcaai/speaker-mapping` | Deleted | Broken imports |
| `@arcaai/storage` | Deleted | Broken imports |

---

## 5. Complexity Analysis

### 5.1 SessionManager (~1300 lines)

**Responsibilities (Too Many):**
- Session lifecycle management
- IndexedDB storage
- API synchronization
- Offline queue management
- Page refresh handling
- Network monitoring
- Recovery management

**Recommendation:** Split into smaller services

### 5.2 LocalSttService (~870 lines)

**Issues:**
- Web Worker communication mixed with audio processing
- Transcript enrichment logic interleaved
- Multiple concerns in single class

### 5.3 useTTS Hook (~530 lines)

**Issues:**
- Binary message handling is convoluted
- Multiple fallback audio playback methods
- Tuple return type (inconsistent with other hooks)

---

## 6. Critical Issues Summary

| Issue | Severity | Impact | Recommendation |
|-------|----------|--------|----------------|
| Monolithic bundle | High | 50MB+ load | Split into packages |
| Singleton pattern | Medium | Can't have multiple instances | Use Provider pattern |
| Inconsistent returns | Medium | Confusing API | Standardize to objects |
| No tree shaking | High | Wasted bytes | Proper exports |
| Deleted dependencies | Critical | Broken imports | Clean up or replace |
| setTimeout workarounds | Medium | Race conditions | Proper state sync |
| Browser-only | Medium | Limited deployment | Add SSR guards |

---

## 7. What to Preserve in V2

1. **Hook names** - For backward compatibility
2. **Type definitions** - Extend, don't replace
3. **Event system** - EventEmitter pattern works well
4. **API client structure** - HTTP client abstraction is good
5. **Offline queue concept** - Useful for resilience

## 8. What to Discard in V2

1. **Singleton pattern** - Replace with Provider
2. **SessionManager monolith** - Split into smaller services
3. **Tuple returns** - Use objects consistently
4. **Hardcoded defaults** - External configuration
5. **Mixed concerns** - Separate audio, STT, storage
