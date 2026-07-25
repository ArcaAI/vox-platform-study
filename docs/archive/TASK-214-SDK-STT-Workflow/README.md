# TASK-214: SDK Speech-to-Text Workflow (Local vs Remote)

- **Ticket**: TASK-214
- **Created**: 2026-02-22
- **Last Updated**: 2026-02-22
- **Status**: In Progress (Task 1 Complete, Task 2: Preferences Restructure Complete)

---

## 1. Requirement Analysis

### Description

The speech-to-text workflow is a user-personalized configurable feature where end-users decide whether to use local browser-based AI models or remote backend processing for: noise cancellation/suppression, automatic speech recognition (ASR), named entity recognition (NER), voice activity detection (VAD), and diarization.

### Business Context

- Clinicians in low-bandwidth environments benefit from local processing (no network dependency)
- High-accuracy scenarios (e.g., complex medical dictation) benefit from remote processing with larger models
- Users should be able to set and persist their preferred workflow mode and model selections

### Acceptance Criteria

1. The SDK must allow frontend developers to switch between `local`, `backend`, and `auto` processing modes
2. For **local processing**, users must be able to configure: preferred language, noise cancellation model, STT model, NER model
3. For **remote processing**, the SDK must call backend API and init WebSocket/SSE connections; the backend follows the configured pipeline
4. User preferences (language, model selections, filter levels) must be persisted to the database via the user-preferences API
5. The user-settings and API implementation must correctly capture and store user preferences

---

## 2. Current State Evaluation

### 2.1 SDK Architecture (VERIFIED)

```
AgenticProvider (initialization)
  ├── AgenticClient (HTTP/REST)
  ├── PluginManager
  │     ├── TranscriptionPipeline (NoiseFilter → VAD → STT)
  │     │     └── @arcaai/stt plugin (local: Whisper WASM, backend: delegates to WS)
  │     └── KnowledgePipeline (NER → SpellCheck → Summarization)
  ├── PersonalizationManager (local/backend/hybrid prefs)
  ├── ModelRegistry (STT/VAD/NER model catalog)
  └── Zustand Store (agenticStore)
```

### 2.2 Local vs Remote Mode Switching — PASS ✅

The SDK supports three processing modes via `STTPluginConfig.provider`:

**File**: `packages/agentic-sdk-v2/src/types/config.ts:186-199`

```typescript
interface STTPluginConfig {
  enabled: boolean;
  provider?: 'local' | 'backend' | 'auto';
  language?: string;
  modelId?: string;       // for local processing
  pipelineId?: string;    // for remote processing
  sttSocket?: string;     // WebSocket URL override
}
```

And at the pipeline level:

**File**: `packages/agentic-sdk-v2/src/types/config.ts:375-404`

```typescript
interface TranscriptionProcessingConfig {
  noiseFilter: { location: 'browser' | 'skip'; level?: 'low' | 'medium' | 'high' };
  vad: { location: 'browser'; sensitivity?: number };
  stt: {
    location: 'browser' | 'backend' | 'auto';
    provider?: 'local' | 'backend' | 'auto';
    language?: string;
    modelId?: string;
    sttSocket?: string;
    pipelineId?: string;
  };
}
```

| Mode | Behavior |
|------|----------|
| `'local'` | Whisper WASM in browser via `@arcaai/stt` plugin |
| `'backend'` | WebSocket streaming to stt service |
| `'auto'` | SDK decides based on model availability and capabilities |

Default: `location: 'auto', provider: 'auto', language: 'en-US'`

### 2.3 Configuration Capabilities per Feature

#### Noise Cancellation — PASS ✅ (Browser-only)

**File**: `packages/agentic-sdk-v2/src/types/config.ts:162-167`

| Config | Type | Notes |
|--------|------|-------|
| `enabled` | `boolean` | Toggle on/off |
| `level` | `'low' \| 'medium' \| 'high'` | Cancellation aggressiveness |

Always runs in browser. No model selection — uses built-in WebAudio processing.

#### VAD — PASS ✅ (Browser-only)

**File**: `packages/agentic-sdk-v2/src/types/config.ts:172-181`

| Config | Type | Notes |
|--------|------|-------|
| `enabled` | `boolean` | Toggle on/off |
| `sensitivity` | `number` (0-1) | Speech detection threshold |
| `minSpeechDuration` | `number` (ms) | Minimum speech segment |
| `minSilenceDuration` | `number` (ms) | Silence to end speech |

Model selection via `ModelRegistryConfig.selected.vad` (default: `silero-vad-v5`).

#### ASR/STT — PASS ✅ (Local or Remote)

**File**: `packages/agentic-sdk-v2/src/types/config.ts:186-199`

| Config | Type | Notes |
|--------|------|-------|
| `enabled` | `boolean` | Toggle on/off |
| `provider` | `'local' \| 'backend' \| 'auto'` | Processing location |
| `language` | `string` | e.g., `'en'`, `'ml'`, `'vi'` |
| `modelId` | `string` | Local model from registry |
| `pipelineId` | `string` | Backend ASR pipeline ID |
| `sttSocket` | `string` | WebSocket URL override |

Default local models: `whisper-tiny`, `whisper-base`, `whisper-small`, `whisper-medium` (HuggingFace).

#### NER — PASS ✅ (Local or Remote)

**File**: `packages/agentic-sdk-v2/src/types/config.ts:218-231`

| Config | Type | Notes |
|--------|------|-------|
| `enabled` | `boolean` | Toggle on/off |
| `autoExtract` | `boolean` | Auto-extract from transcriptions |
| `entityTypes` | `string[]` | e.g., `['DISEASE', 'MEDICATION']` |
| `model` | `string` | `'default' \| 'biomedical' \| 'clinical' \| HF model ID` |
| `threshold` | `number` (0-1) | Confidence threshold |
| `dtype` | `string` | `'fp32' \| 'fp16' \| 'q8' \| 'q4'` |

#### Diarization — Backend-only

Configured via backend ASR pipeline YAML, not directly in SDK config. Results appear in `TranscriptionSegment.speaker` and `TranscriptSegment.speakerLabel`.

### 2.4 Remote Processing Communication — PASS ✅

| Channel | Use Case | SDK Class | API Endpoint |
|---------|----------|-----------|--------------|
| WebSocket | Real-time STT streaming | `StreamingSessionManager` → `SttWebSocketClient` | `POST /audio/transcription-jobs/stream/session` → `wss://` |
| SSE | File upload transcription | `FileTranscriptionService` → `SSEClient` | `POST /audio/transcription-jobs/transcribe` → `GET .../stream` |
| REST | Job management | `TranscriptionJobService` | `GET/PATCH /audio/transcription-jobs/...` |
| REST | NLP (NER, spell check) | `AgenticClient` | `POST /nlp/classify/tokens`, `/nlp/correct`, etc. |

**WebSocket flow detail**:
1. Create session via REST → returns `{ sessionId, wsUrl }`
2. Build WS URL (`https://` → `wss://`, append `sessionId`)
3. Stream raw PCM `ArrayBuffer` or JSON `{ type: 'audio', seq, data }` to server
4. Receive `{ type: 'transcript', text, startTime, endTime, isFinal }` from server
5. Close with `{ type: 'stop' }` then `{ type: 'close' }`
6. Auto-reconnect with exponential backoff

**SSE flow detail**:
1. Upload file via multipart `POST /audio/transcription-jobs/transcribe`
2. Subscribe to `GET /audio/transcription-jobs/:id/stream`
3. Named events: `'transcript'`, `'status'`, `'progress'`
4. Auto-reconnect with exponential backoff + jitter

### 2.5 User Preferences Persistence — PASS with GAPS

#### SDK `UserPreferences` Interface

**File**: `packages/agentic-sdk-v2/src/types/config.ts:302-315`

```typescript
interface UserPreferences {
  language?: string;                           // ✅ Preferred language
  sttModel?: string;                           // ✅ Selected STT model ID
  noiseFilterLevel?: 'low' | 'medium' | 'high'; // ✅ Noise filter level
  vadSensitivity?: number;                     // ✅ VAD sensitivity (0-1)
  dnaStyleId?: string;                         // ✅ DNA writing style
  custom?: Record<string, unknown>;            // ✅ Extensible
}
```

#### Backend `UserPreferencesResponse` DTO

**File**: `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts`

Matches SDK interface exactly: `language`, `sttModel`, `noiseFilterLevel`, `vadSensitivity`, `dnaStyleId`, `custom`, `updatedAt`.

#### Backend `UpdateUserPreferencesRequest` DTO

**File**: `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts`

All fields optional with proper validation (`@IsString`, `@IsEnum`, `@IsNumber @Min(0) @Max(1)`, `@IsObject`).

#### Storage Implementation

**File**: `packages/applications/src/services/user/userPreferences/userPreferences.service.ts`

Preferences stored as individual key-value rows in `UserSettings` table under namespace `arcaai-sdk`:

| Key | Value Type | Example |
|-----|-----------|---------|
| `language` | String | `"th"` |
| `sttModel` | String | `"whisper-large-v3"` |
| `noiseFilterLevel` | String | `"high"` |
| `vadSensitivity` | Float | `"0.7"` |
| `dnaStyleId` | String | `"style-123"` |
| `custom` | Json | `{"theme":"dark"}` |

#### SDK Personalization Storage Modes

**File**: `packages/agentic-sdk-v2/src/types/config.ts:290-297`

| Mode | Behavior |
|------|----------|
| `'local'` | `localStorage` only (key: `arcaai-preferences`) |
| `'backend'` | REST API only (`PUT /user/me/preferences`), rollback on failure |
| `'hybrid'` | localStorage + periodic backend sync (default interval: 60s) |

### 2.6 React Hooks for Frontend Developers

| Hook | File | Purpose |
|------|------|---------|
| `useArcaAudio` | `hooks/useArcaAudio.ts` | Audio capture, mute, toggle STT/VAD/NoiseFilter |
| `useArcaPipelines` | `hooks/useArcaPipelines.ts` | Pause/resume transcription, trigger NER/summarization |
| `usePipelines` | `hooks/usePipelines.ts` | Discover and select ASR pipelines from backend |
| `useUserSettings` | `hooks/useUserSettings.ts` | CRUD for user settings (RBAC-protected) |
| `useAiModels` | `hooks/useAiModels.ts` | AI model discovery and management |

---

## 3. Issues Found

### RECOMMENDATION 1: Missing `sttProvider` in User Preferences

**Severity**: Medium
**Impact**: The SDK's `UserPreferences` stores `sttModel` and `language` but does **not** store the user's preferred processing mode (`'local' | 'backend' | 'auto'`). If a user prefers local processing, this preference is lost on page reload unless stored in the `custom` field.

**Affected Files**:
1. `packages/agentic-sdk-v2/src/types/config.ts` — `UserPreferences` interface
2. `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts`
3. `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts`
4. `packages/applications/src/services/user/userPreferences/userPreferences.service.ts`

### RECOMMENDATION 2: Missing `nerModel` in User Preferences

**Severity**: Medium
**Impact**: The `NERPluginConfig` supports model selection (`'default' | 'biomedical' | 'clinical' | string`), but `UserPreferences` has no `nerModel` field. Users who select a specialized NER model lose that preference on reload.

**Affected Files**: Same as Recommendation 1.

### RECOMMENDATION 3: Missing `codeSwitching` Default Preference

**Severity**: Low
**Impact**: Users who frequently enable code-switching must set it on every request. A user preference for "default to code-switching on" would improve UX.

**Affected Files**: Same as Recommendation 1.

### SUGGESTION 1: Missing Language Capability Metadata on Models

**Severity**: Low
**Impact**: The SDK's `ModelDefinition` type has no language capability metadata. The UI cannot guide users on which models work best for English vs Malayalam vs Vietnamese.

**Affected File**: `packages/agentic-sdk-v2/src/types/config.ts` — `ModelDefinition` interface

### SUGGESTION 2: No Dedicated `useSTT` Hook

**Severity**: Low
**Impact**: STT is managed through `useArcaAudio` which wraps the entire audio pipeline. A dedicated `useSTT` hook would simplify frontend development for STT-only use cases.

---

## 4. Implementation Plan

### Task 1: Add `sttProvider` to User Preferences

**Priority**: Medium
**Estimated effort**: Small (~2 hours)
**Dependencies**: None

#### Step 1.1: Update SDK `UserPreferences` type

**File**: `packages/agentic-sdk-v2/src/types/config.ts`

```typescript
interface UserPreferences {
  language?: string;
  sttModel?: string;
  sttProvider?: 'local' | 'backend' | 'auto';  // NEW
  noiseFilterLevel?: 'low' | 'medium' | 'high';
  vadSensitivity?: number;
  dnaStyleId?: string;
  nerModel?: string;                             // NEW
  codeSwitching?: boolean;                        // NEW
  custom?: Record<string, unknown>;
}
```

#### Step 1.2: Update Backend Response DTO

**File**: `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts`

Add three new `@ApiPropertyOptional` fields: `sttProvider`, `nerModel`, `codeSwitching`.

#### Step 1.3: Update Backend Request DTO

**File**: `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts`

Add three new fields with proper validation:
- `sttProvider`: `@IsEnum(['local', 'backend', 'auto'])`
- `nerModel`: `@IsString()`
- `codeSwitching`: `@IsBoolean()`

#### Step 1.4: Update `UserPreferencesService`

**File**: `packages/applications/src/services/user/userPreferences/userPreferences.service.ts`

Add new `PREFERENCE_KEYS`:
```typescript
STT_PROVIDER: 'sttProvider',
NER_MODEL: 'nerModel',
CODE_SWITCHING: 'codeSwitching',
```

Add corresponding `case` branches in `getPreferences()` and update entries in `updatePreferences()`.

#### Step 1.5: Update `PersonalizationManager` (SDK)

**File**: `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts`

Ensure the new fields are synced to/from localStorage and backend.

#### Step 1.6: Write Tests

- Unit test: `UserPreferencesService` handles new keys correctly
- Unit test: SDK `PersonalizationManager` persists/retrieves new fields
- Unit test: DTO validation accepts valid values, rejects invalid

### Task 2: Add Language Capability Metadata to Models (Optional)

**Priority**: Low
**Estimated effort**: Medium (~4 hours)

#### Step 2.1: Extend `ModelDefinition`

**File**: `packages/agentic-sdk-v2/src/types/config.ts`

```typescript
interface ModelDefinition {
  id: string;
  name: string;
  type: 'stt' | 'vad' | 'ner';
  source: 'huggingface' | 'custom' | 'backend';
  url?: string;
  size?: 'tiny' | 'small' | 'medium' | 'large';
  description?: string;
  languages?: string[];        // NEW: e.g., ['en', 'ml', 'vi']
  supportsCodeSwitching?: boolean; // NEW
}
```

#### Step 2.2: Update Default Models

Add language metadata to the default model definitions in `types/models.ts`.

### Task 3: Cross-reference with TASK-213 SSE Fix

**Priority**: Critical (dependency on TASK-213)

After TASK-213 fixes the SSE endpoint to accept `codeSwitching`, verify the SDK's `FileTranscriptionService` sends the field in the multipart form data. If not, update it.

---

## 5. Implementation Summary

### Task 1: Add `sttProvider`, `nerModel`, `codeSwitching` to User Preferences — COMPLETE

**Methodology**: Test-Driven Development (Red-Green-Refactor)

#### Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/types/config.ts` | Added `sttProvider`, `nerModel`, `codeSwitching` to `UserPreferences` interface |
| `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts` | Added 3 new `@ApiPropertyOptional` fields |
| `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts` | Added 3 new validated fields (`@IsEnum`, `@IsString`, `@IsBoolean`) |
| `packages/applications/src/services/user/userPreferences/userPreferences.service.ts` | Added 3 new `PREFERENCE_KEYS`, `case` branches in `getPreferences()`, update entries in `updatePreferences()` |
| `packages/applications/src/services/user/userPreferences/__tests__/userPreferences.service.test.ts` | Added 10 new tests (5 get, 5 update) |
| `packages/agentic-sdk-v2/src/core/__tests__/PersonalizationManager.test.ts` | Added 8 new tests (store/retrieve, defaults, localStorage, listeners, backend sync) |

#### New Storage Keys

| Key | Value Type | Example |
|-----|-----------|---------|
| `sttProvider` | String | `"local"`, `"backend"`, `"auto"` |
| `nerModel` | String | `"biomedical"`, `"clinical"`, `"default"` |
| `codeSwitching` | Boolean | `"true"`, `"false"` |

#### Test Results

- **Backend (UserPreferencesService)**: 31 tests passing (21 existing + 10 new)
- **SDK (PersonalizationManager)**: 36 tests passing (28 existing + 8 new)
- **Total**: 67 tests, 0 failures, 0 regressions

---

## 6. Task 2: User Preferences Restructure — COMPLETE

### Problem

The flat `UserPreferences` structure (9 individual keys) did not reflect the doctor consultation workflow. Doctors either work in **local mode** (selecting individual models) or **remote mode** (using an admin-configured pipeline). The data model needed to encode this two-mode architecture with clear separation between doctor-controlled and admin-controlled settings.

### Key Design Decisions

1. **Pipeline is admin-controlled**: Doctors cannot select pipelines. Resolution chain: per-user admin override (`UserSettings`, namespace=`arcaai-admin`) > tenant-wide default (`GlobalSettings`, key=`default-stt-pipeline`).

2. **Code-switching is a pipeline config**: Removed from `UserPreferences` entirely. It lives in the ASR pipeline YAML (`inference.code_switching`).

3. **remoteConfig is read-only**: Included in the response so doctors can see their assigned pipeline, but not in the update request.

### New Data Structure

**Update Request (doctor-writable)**:
```
workflowMode: 'local' | 'remote'
language: string
dnaStyleId: string
localConfig: { noiseCancellation, stt, vad, ner, diarization }
custom: Record<string, unknown>
```

**Response (includes read-only remoteConfig)**:
```
workflowMode, language, dnaStyleId, localConfig, custom, updatedAt
remoteConfig: { pipelineId, pipelineName, assignedBy, codeSwitchingEnabled }
```

### Pipeline Resolution Flow

```
GET /user/me/preferences
  → Check UserSettings (namespace='arcaai-admin', key='assigned-pipeline')
    → If found: remoteConfig.assignedBy = 'admin'
    → If not: Check GlobalSettings (key='default-stt-pipeline')
      → If found: remoteConfig.assignedBy = 'tenant-default'
      → If not: remoteConfig = undefined
```

### Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/types/config.ts` | Restructured `UserPreferences` with `WorkflowMode`, `LocalWorkflowConfig`, `RemoteConfigResponse`, `UserPreferencesUpdate` types. Removed flat fields. Added `DEFAULT_LOCAL_CONFIG`. |
| `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts` | Replaced 9 flat fields with `workflowMode`, `language`, `dnaStyleId`, `localConfig` (nested `@ValidateNested`), `custom`. No `remoteConfig` or `codeSwitching`. |
| `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts` | Added `workflowMode`, `localConfig`, read-only `remoteConfig` with `pipelineId`, `pipelineName`, `assignedBy`, `codeSwitchingEnabled`. |
| `packages/applications/src/services/user/userPreferences/userPreferences.service.ts` | New `PREFERENCE_KEYS` (workflowMode, language, dnaStyleId, localConfig, custom). Pipeline resolution via `AppSettingsService` + `AsrPipelineRepository`. Deep merge for `localConfig`. Backward compat for legacy flat keys. |
| `packages/applications/src/services/user/userPreferences/userPreferences.service.module.ts` | No structural changes (CoreDatabaseModule already provides AsrPipelineRepository). |
| `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts` | Deep merge for `localConfig` updates. `syncToBackend()` strips `remoteConfig`. `loadFromBackend()` deep-merges `localConfig` from response. |
| `packages/database/src/prisma/db_main/seed/91-user.ts` | Rewrote SDK preferences with workflow-oriented structure. Added GlobalSettings `default-stt-pipeline`. Added admin pipeline assignment for Jane Doe (namespace=`arcaai-admin`). |
| `packages/applications/src/services/user/userPreferences/__tests__/userPreferences.service.test.ts` | Rewrote tests for nested structure, pipeline resolution, backward compat, deep merge. |
| `packages/agentic-sdk-v2/src/core/__tests__/PersonalizationManager.test.ts` | Replaced TASK-214 flat-field tests with workflow-oriented tests (localConfig deep merge, remoteConfig read-only, rollback). |

### Backward Compatibility

- Legacy flat keys (`sttModel`, `noiseFilterLevel`, `vadSensitivity`, `nerModel`, `sttProvider`, `codeSwitching`) are mapped into `localConfig` structure during `getPreferences()` when new keys don't exist yet.
- `codeSwitching` is discarded (no longer a preference).
- New writes always use the new key format.
- No database migration needed (key-value storage).

### Seed Data Summary

| User | Workflow | Config |
|------|----------|--------|
| Doctor (John Smith) | `local` | whisper-large-v3, rnnoise/high, silero-vad-v5/0.6, biomedical NER, diarization enabled |
| Doctor2 (Jane Doe) | `remote` | Admin-assigned Turbo Pipeline, Thai language |
| Dept Head (Michael Johnson) | `local` | whisper-large-v3, rnnoise/high, silero-vad-v5/0.7, all features, custom shortcuts |

---

## 7. Change History

| # | Date | Description | Status |
|---|------|-------------|--------|
| 1 | 2026-02-22 | Initial review and planning | Complete |
| 2 | 2026-02-22 | Task 1: Add sttProvider, nerModel, codeSwitching to User Preferences (TDD) | Complete |
| 3 | 2026-02-22 | Task 2: Restructure UserPreferences to workflow-oriented structure (local/remote), admin-controlled pipeline, remove codeSwitching from preferences | Complete |
