# Plan 06: Documentation Updates

| Field | Value |
|-------|-------|
| **Parent Ticket** | SDK-200 |
| **Phase** | 6 - Documentation |
| **Created Date** | 2026-01-11 |
| **Status** | Pending |
| **Dependencies** | Plans 01-05 must be completed first |

---

## Overview

Update all project documentation to reflect the new SDK v2, including README files, API documentation, migration guides, and architecture diagrams.

---

## Documentation Structure

```
docs/
├── implementation/
│   └── SDK-200-Agentic-SDK-V2/
│       ├── README.md                    # Update with implementation summary
│       ├── plan-*.md                    # Implementation plans (already done)
│       ├── migration-guide.md           # V1 to V2 migration guide (new)
│       └── api-reference.md             # API endpoint reference (new)
packages/
├── agentic-sdk-v2/
│   ├── README.md                        # Package documentation (new)
│   └── CHANGELOG.md                     # Version changelog (new)
```

---

## Document 1: SDK v2 Package README

**File**: `packages/agentic-sdk-v2/README.md`

```markdown
# @arcaai/vox

ARCAAI Agentic SDK v2 for medical consultation workflows. This SDK provides React hooks for managing medical consultations, audio processing (STT, VAD, noise filtering), context management, and summary generation.

## Installation

```bash
npm install @arcaai/vox
# or
pnpm add @arcaai/vox
```

## Quick Start

```tsx
import { AgenticProvider, useArcaSessionManager } from '@arcaai/vox';

const config = {
  apiBaseUrl: 'https://api.arcaai.com',
  apiKey: 'your-api-key',
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}

function ConsultationPage() {
  const { consultation, status, actions } = useArcaSessionManager();

  const handleStart = async () => {
    await actions.create({
      patientId: 'patient-123',
      appointmentDate: '2026-01-11',
      doctorId: 'doctor-456',
    });
  };

  return (
    <div>
      {!consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <p>Active: {consultation.id}</p>
      )}
    </div>
  );
}
```

## Core Concepts

### Session Management

Consultations are identified by `patientId + appointmentDate`:

- **New-Visit**: First consultation for a patient on a given date
- **Re-Visit**: Subsequent consultations linked to the new-visit (e.g., specialist referral)

```tsx
const { consultation, relatedConsultations, actions } = useArcaSessionManager();

// Create new-visit
await actions.create({ patientId, appointmentDate, doctorId });

// Start re-visit (links to parent)
await actions.startRevisit({ parentConsultationId, doctorId });

// Check visit type
import { isNewVisit, isRevisit } from '@arcaai/vox';
if (isNewVisit(consultation)) { /* first of the day */ }
```

### Context Sharing

All consultations in a chain share context:

```tsx
const { context, sharedContext, actions } = useArcaContext();

// Add context items
await actions.addCaseNote({ content: 'Patient reports...' });
await actions.addTranscription(text, { segments });

// Get shared context from linked consultations
const shared = await actions.getSharedContext();
```

## Available Hooks

| Hook | Purpose |
|------|---------|
| `useArcaSessionManager` | Consultation lifecycle management |
| `useArcaAudio` | Audio capture with STT, VAD, noise filtering |
| `useArcaContext` | Context items (case notes, transcriptions) |
| `useArcaSummary` | Summary and pre-summary generation |
| `useArcaSettings` | User preferences |

### Hook Return Pattern

All hooks follow a standardized pattern:

```typescript
const {
  data,           // Main data (consultation, context, etc.)
  status,         // { isLoading: boolean, error: Error | null }
  actions,        // Available methods
} = useHook();
```

## Audio Processing

```tsx
import { useArcaAudio } from '@arcaai/vox';

function AudioCapture() {
  const { track, status, actions } = useArcaAudio({
    enableNoiseFilter: true,
    enableVAD: true,
    sttProvider: 'auto',
    onTranscription: (result) => {
      console.log(result.text, result.isFinal);
    },
  });

  return (
    <div>
      <p>Level: {Math.round(status.level * 100)}%</p>
      {status.isCapturing ? (
        <button onClick={actions.stopCapture}>Stop</button>
      ) : (
        <button onClick={actions.startCapture}>Start</button>
      )}
    </div>
  );
}
```

## Summary Generation

```tsx
import { useArcaSummary } from '@arcaai/vox';

function SummaryPanel() {
  const { summaries, dnaStyle, status, actions } = useArcaSummary();

  const handleGenerate = async () => {
    await actions.generateSummary({
      dnaStyleId: dnaStyle?.id,
      includeNER: true,
    });
  };

  return (
    <div>
      <button onClick={handleGenerate} disabled={status.isGenerating}>
        Generate Summary
      </button>
      {summaries.map((s) => <p key={s.id}>{s.content}</p>)}
    </div>
  );
}
```

## API Reference

See [API Reference](./docs/api-reference.md) for complete type definitions.

## Migration from v1

See [Migration Guide](./docs/migration-guide.md) for upgrading from SDK v1.

## Requirements

- React 18+ or 19+
- Modern browser with Web Audio API support
- API key from ARCAAI

## Related Packages

- `@arcaai/room` - Audio track and processor pipeline
- `@arcaai/noise-filter` - RNNoise-based noise filtering
- `@arcaai/stt` - Speech-to-text (local and backend)
- `@arcaai/vad` - Voice activity detection

## License

MIT
```

---

## Document 2: Migration Guide

**File**: `docs/implementation/SDK-200-Agentic-SDK-V2/migration-guide.md`

```markdown
# SDK v1 to v2 Migration Guide

This guide helps you migrate from `@arcaai/agentic-sdk` (v1) to `@arcaai/vox`.

## Overview of Changes

### Architecture Changes

| Aspect | v1 | v2 |
|--------|----|----|
| Package structure | Monolithic | Modular (room, stt, vad, noise-filter) |
| State management | Scattered useState | Centralized Zustand store |
| Provider | `AgenticSDK.getInstance()` | `<AgenticProvider>` |
| Hook returns | Inconsistent (tuples, objects) | Standardized `{ data, status, actions }` |

### Session Management Changes

| Aspect | v1 | v2 |
|--------|----|----|
| Session identifier | Complex multi-field | `patientId + appointmentDate` |
| Visit types | Not clearly defined | `new-visit` and `re-visit` (derived) |
| Multi-doctor | Not supported | Full support via re-visits |
| Context sharing | Manual | Automatic via consultation chain |

## Step-by-Step Migration

### Step 1: Install New Package

```bash
# Remove v1
npm uninstall @arcaai/agentic-sdk

# Install v2
npm install @arcaai/vox
```

### Step 2: Update Provider

**Before (v1):**
```tsx
import { AgenticSDK } from '@arcaai/agentic-sdk';

// Initialize singleton
const sdk = AgenticSDK.getInstance({
  apiKey: 'your-key',
  apiUrl: 'https://api.arcaai.com',
});

function App() {
  return <YourApp />;
}
```

**After (v2):**
```tsx
import { AgenticProvider } from '@arcaai/vox';

const config = {
  apiKey: 'your-key',
  apiBaseUrl: 'https://api.arcaai.com',
};

function App() {
  return (
    <AgenticProvider config={config}>
      <YourApp />
    </AgenticProvider>
  );
}
```

### Step 3: Update useArcaSessionManager

**Before (v1):**
```tsx
import { useArcaSessionManager } from '@arcaai/agentic-sdk';

const {
  session,
  isLoading,
  error,
  createSession,
  loadSession,
  endSession,
} = useArcaSessionManager({
  doctorId: 'doctor-123',
  doctorName: 'Dr. Smith',
  patientId: 'patient-456',
  patientName: 'John Doe',
});

// Create session
await createSession({ metadata: {} });
```

**After (v2):**
```tsx
import { useArcaSessionManager } from '@arcaai/vox';

const { consultation, status, actions } = useArcaSessionManager();

// Create consultation (new-visit)
await actions.create({
  patientId: 'patient-456',
  appointmentDate: '2026-01-11',  // Required: YYYY-MM-DD
  doctorId: 'doctor-123',
  doctorName: 'Dr. Smith',
});

// Access status
if (status.isLoading) { /* ... */ }
if (status.error) { /* ... */ }

// End consultation
await actions.end();
```

### Step 4: Update Audio Capture (Merged Hooks)

**Before (v1):**
```tsx
import {
  useAudioCapture,
  useArcaSpeechToText,
  useArcaaiVAD,
} from '@arcaai/agentic-sdk';

const { startRecording, stopRecording, audioLevel } = useAudioCapture();
const { transcription, isTranscribing } = useArcaSpeechToText({
  onTranscription: handleTranscription,
});
const { isSpeaking } = useArcaaiVAD();
```

**After (v2):**
```tsx
import { useArcaAudio } from '@arcaai/vox';

const { track, status, actions } = useArcaAudio({
  enableNoiseFilter: true,
  enableVAD: true,
  sttProvider: 'auto',
  onTranscription: (result) => {
    // result.text, result.isFinal, result.segments
  },
  onVAD: (event) => {
    // event.type: 'speech-start' | 'speech-end'
  },
});

// Audio level
status.level;

// Start/stop
await actions.startCapture();
await actions.stopCapture();

// Mute/unmute
actions.mute();
actions.unmute();
```

### Step 5: Update Context Management (New Hook)

**Before (v1):**
```tsx
// Context was not well-structured in v1
// Manual JSONB updates to session
```

**After (v2):**
```tsx
import { useArcaContext } from '@arcaai/vox';

const { context, sharedContext, status, actions } = useArcaContext();

// Add case note
await actions.addCaseNote({ content: 'Patient reports...' });

// Add transcription
await actions.addTranscription(text, { segments });

// Add custom context type
await actions.addContext({
  type: 'lab_result',
  content: 'BP: 120/80',
  source: 'SYSTEM',
});

// Get shared context from linked consultations
const shared = await actions.getSharedContext();

// Get NER entities
const ner = await actions.getNERData();
```

### Step 6: Update Summary Generation (Split Hook)

**Before (v1):**
```tsx
import { useSMR } from '@arcaai/agentic-sdk';

const {
  generateSummary,
  summary,
  isGenerating,
  // ... 12 more properties
} = useSMR();
```

**After (v2):**
```tsx
import { useArcaSummary } from '@arcaai/vox';

const { summaries, dnaStyle, status, actions } = useArcaSummary();

// Generate pre-summary from case notes
await actions.generatePreSummary({ dnaStyleId: dnaStyle?.id });

// Generate final summary
await actions.generateSummary({
  transcription: optionalOverride,
  dnaStyleId: dnaStyle?.id,
  includeNER: true,
});

// Update summary
await actions.updateSummary(summaryId, newContent);

// Analyze DNA writing style
await actions.analyzeDNA(sampleTexts);
```

### Step 7: Update TTS (Separate Package)

**Before (v1):**
```tsx
import { useArcaTextToSpeech } from '@arcaai/agentic-sdk';

const [speak, { isSpeaking }] = useArcaTextToSpeech();
await speak('Hello');
```

**After (v2):**
TTS is now in a separate package `@arcaai/tts` (to be implemented).

## Hook Comparison Summary

| v1 Hook | v2 Hook | Notes |
|---------|---------|-------|
| `useArcaSessionManager` | `useArcaSessionManager` | Simplified, consultation-centric |
| `useAudioCapture` | `useArcaAudio` | Merged with STT, VAD |
| `useArcaSpeechToText` | `useArcaAudio` | Merged |
| `useArcaaiVAD` | `useArcaAudio` | Merged |
| `useSMR` | `useArcaContext` + `useArcaSummary` | Split by concern |
| `useArcaDNA` | `useArcaSummary` | Integrated |
| N/A | `useArcaSettings` | New hook |

## Breaking Changes

1. **Provider Required**: Must wrap app in `<AgenticProvider>`
2. **appointmentDate Required**: Consultations require date for session identification
3. **Tuple Returns Removed**: All hooks return objects now
4. **Merged Audio Hooks**: Single hook for all audio processing
5. **Context API**: New structured context management

## TypeScript Changes

All types are exported from the main package:

```tsx
import type {
  Consultation,
  ContextItem,
  MedicalEntity,
  TranscriptionResult,
  Summary,
} from '@arcaai/vox';
```

## Support

If you encounter migration issues, please file an issue or contact support.
```

---

## Document 3: API Reference

**File**: `docs/implementation/SDK-200-Agentic-SDK-V2/api-reference.md`

```markdown
# SDK v2 API Reference

## Backend API Endpoints

### Consultation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations` | Create new-visit consultation |
| POST | `/consultations/:id/revisit` | Start re-visit |
| GET | `/consultations?patientId=&date=` | Find by patient and date |
| GET | `/consultations/:id` | Get consultation with context |
| GET | `/consultations/:id/chain` | Get consultation chain |
| PATCH | `/consultations/:id` | Update consultation |
| POST | `/consultations/:id/end` | End consultation |

### Context Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/context` | Add context item |
| GET | `/consultations/:id/context` | Get context items |
| GET | `/consultations/:id/context/shared` | Get shared context |
| PATCH | `/consultations/:id/context/:itemId` | Update context |

### Summary Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/summary/pre-summary` | Generate pre-summary |
| POST | `/consultations/:id/summary` | Generate summary |
| PATCH | `/consultations/:id/summary/:summaryId` | Update summary |
| GET | `/consultations/:id/entities` | Get NER entities |

## TypeScript Types

### Consultation

```typescript
interface Consultation {
  id: string;
  sessionId: string;
  patientId: string;
  appointmentDate: string;  // YYYY-MM-DD
  doctorId: string;
  doctorName?: string;
  parentConsultationId?: string;
  status: string;
  department?: string;
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### ContextItem

```typescript
interface ContextItem {
  id: string;
  consultationId: string;
  type: string;
  content: string;
  structuredData?: Record<string, unknown>;
  source: 'USER' | 'SYSTEM' | 'TRANSCRIPTION' | 'AI';
  contentVersion: number;
  createdAt: string;
  updatedAt: string;
}
```

### MedicalEntity

```typescript
interface MedicalEntity {
  id: string;
  entityType: string;
  text: string;
  normalizedText?: string;
  codes?: {
    icd10?: string[];
    snomed?: string[];
    rxnorm?: string[];
  };
  confidence: number;
  startOffset: number;
  endOffset: number;
}
```

### Summary

```typescript
interface Summary {
  id: string;
  contextItemId: string;
  content: string;
  llmProvider: string;
  modelName: string;
  processingTimeMs?: number;
  dnaStyleId?: string;
  createdAt: string;
}
```

### Hook Types

```typescript
interface HookStatus {
  isLoading: boolean;
  error: Error | null;
}

interface SessionManagerActions {
  create: (input: CreateConsultationInput) => Promise<Consultation>;
  startRevisit: (input: StartRevisitInput) => Promise<Consultation>;
  update: (updates: UpdateConsultationInput) => Promise<void>;
  load: (id: string) => Promise<Consultation>;
  findByPatientDate: (patientId: string, date: string) => Promise<Consultation[]>;
  end: () => Promise<void>;
}

interface ContextActions {
  addCaseNote: (note: CaseNoteInput) => Promise<ContextItem>;
  addTranscription: (text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  addContext: (input: AddContextInput) => Promise<ContextItem>;
  updateContext: (id: string, content: string) => Promise<void>;
  getSharedContext: () => Promise<ContextItem[]>;
  getNERData: (contextId?: string) => Promise<NERData>;
  clearContext: () => void;
}

interface SummaryActions {
  generatePreSummary: (options?: PreSummaryOptions) => Promise<PreSummary>;
  generateSummary: (options?: SummaryOptions) => Promise<Summary>;
  updateSummary: (id: string, content: string) => Promise<void>;
  analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
  getDNAStyle: (userId: string) => Promise<DNAStyle | null>;
}

interface AudioActions {
  startCapture: () => Promise<void>;
  stopCapture: () => Promise<void>;
  mute: () => void;
  unmute: () => void;
  setNoiseFilter: (enabled: boolean) => void;
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `CONSULTATION_NOT_FOUND` | Consultation with given ID not found |
| `CONSULTATION_EXISTS` | New-visit already exists for patient+date |
| `INVALID_REVISIT_PARENT` | Cannot create re-visit from re-visit |
| `CONTEXT_NOT_FOUND` | Context item not found |
| `SUMMARY_GENERATION_FAILED` | SMR service error |
| `AUDIO_NOT_SUPPORTED` | Browser doesn't support Web Audio |
| `STT_INITIALIZATION_FAILED` | Failed to initialize STT |
```

---

## Document 4: Update Main README

**File**: `docs/implementation/SDK-200-Agentic-SDK-V2/README.md` (update)

Add implementation summary section after the analysis is complete.

```markdown
## Implementation Summary

**Status**: Completed

### What Was Implemented

#### Phase 1: Database (Prisma)
- Created `Consultation`, `ContextItem`, `MedicalEntity`, `Summary` models
- Added relations to existing `Session` and `Tenant` models
- Database migration applied successfully

#### Phase 2: Domain Layer
- Generated entities, factories, mappers, repositories using `@arcaai/tools`
- Added custom methods for consultation chain queries
- Registered in `CoreDatabaseModule`

#### Phase 3: API Layer
- Created `ConsultationController`, `ContextController`, `SummaryController`
- Implemented services with full CRUD operations
- Added API key authentication guards
- Swagger documentation complete

#### Phase 4: SDK Package
- Created `@arcaai/vox` package
- Implemented 5 hooks with standardized return pattern
- Zustand store for state management
- Integration with `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`

#### Phase 5: Examples
- 6 comprehensive examples created
- Demonstrates full consultation workflow

#### Phase 6: Documentation
- Package README
- Migration guide from v1
- API reference

### Files Created

| Category | File Count | Key Files |
|----------|------------|-----------|
| Database | 1 | `consultation.prisma` |
| Domain | 16 | Entities, factories, mappers, repositories |
| Application | 12 | Services, DTOs, mappers |
| API | 4 | Controllers, module |
| SDK | 15 | Types, hooks, store, provider |
| Examples | 6 | Usage examples |
| Docs | 4 | README, migration, API reference |

### Testing

- [ ] Unit tests for domain entities
- [ ] Unit tests for services
- [ ] Integration tests for API endpoints
- [ ] E2E tests for SDK hooks
```

---

## Validation Checklist

- [ ] Package README created with quick start guide
- [ ] Migration guide covers all v1 to v2 changes
- [ ] API reference documents all endpoints and types
- [ ] Main README updated with implementation summary
- [ ] All code examples are syntactically correct
- [ ] Links between documents are valid

---

## Final Steps

After documentation is complete:

1. Review all documents for accuracy
2. Test code examples in documentation
3. Update CHANGELOG.md with v2.0.0 release notes
4. Tag release in git
5. Publish package to npm
