# Agentic SDK V2 — Migration Guide

Migrate from `@arcaai/agentic-sdk` (v1) to `@arcaai/vox` (v2).

## Overview of Changes

| Aspect | v1 (`@arcaai/agentic-sdk`) | v2 (`@arcaai/vox`) |
|--------|----------------------------|---------------------|
| Package | Monolithic bundle | Modular with split entry points |
| State | Scattered `useState` | Centralized Zustand store |
| Provider | `AgenticSDK.getInstance()` singleton | `<AgenticProvider>` React context |
| Hooks | Multiple hooks with inconsistent returns | Unified `useArca()` hook |
| Audio | Separate `useAudioCapture` + `useSTT` + `useVAD` | Single `audio` interface |
| Session ID | Complex multi-field | `patientId + appointmentDate` |
| Config | Per-hook options | Single configuration object |
| Multi-doctor | Not supported | New-visit / re-visit with context sharing |
| Bundle (full) | ~4 MB | ~5.5 MB (more features) |
| Bundle (core) | N/A | ~200 KB |
| Bundle (plugins) | N/A | ~5.3 MB |

---

## Step-by-Step Migration

### Step 1: Install the New Package

```bash
npm uninstall @arcaai/agentic-sdk
npm install @arcaai/vox
```

### Step 2: Replace the Provider

**v1:**

```tsx
import { AgenticSDK } from '@arcaai/agentic-sdk';

const sdk = AgenticSDK.getInstance({
  apiKey: 'your-key',
  apiUrl: 'https://api.arcaai.com',
});

function App() {
  return <YourApp />;
}
```

**v2:**

```tsx
import { AgenticProvider } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-key',
  },
  audio: {
    noiseFilter: { enabled: true },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en-US' },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <YourApp />
    </AgenticProvider>
  );
}
```

### Step 3: Replace Session Management

**v1:**

```tsx
import { useArcaSessionManager } from '@arcaai/agentic-sdk';

const {
  session, isLoading, error,
  createSession, endSession,
} = useArcaSessionManager({
  doctorId: 'doctor-123',
  patientId: 'patient-456',
});

await createSession({ metadata: {} });
```

**v2:**

```tsx
import { useArca } from '@arcaai/vox';

const { session } = useArca();

await session.open({
  patientId: 'patient-456',
  appointmentDate: '2026-01-28',
});
```

The `open()` method uses a get-or-create pattern. `doctorId` is derived from the authenticated user. `appointmentDate` defaults to today if not provided.

### Step 4: Replace Audio Hooks

**v1** (three separate hooks):

```tsx
import { useAudioCapture, useArcaSpeechToText, useArcaaiVAD } from '@arcaai/agentic-sdk';

const { startRecording, stopRecording, audioLevel, isRecording } = useAudioCapture();
const { transcription, isTranscribing } = useArcaSpeechToText({ onTranscription: (text, isFinal) => {} });
const { isSpeaking } = useArcaaiVAD();
```

**v2** (single unified interface):

```tsx
import { useArca } from '@arcaai/vox';

const { audio } = useArca();

await audio.start();       // startRecording
await audio.stop();        // stopRecording
audio.level;               // audioLevel
audio.isCapturing;         // isRecording
audio.currentTranscript;   // transcription
audio.isSpeaking;          // isSpeaking

audio.plugins.noiseFilter.isActive;
audio.plugins.vad.isActive;
audio.plugins.stt.isActive;

audio.toggleNoiseFilter();
audio.mute();
audio.unmute();
```

### Step 5: Replace Context Management

**v1** (manual metadata):

```tsx
const { updateSession } = useArcaSessionManager();

await updateSession({
  metadata: {
    ...session.metadata,
    caseNotes: [...(session.metadata.caseNotes || []), newNote],
  },
});
```

**v2** (dedicated API):

```tsx
const { context } = useArca();

await context.addCaseNote('Patient reports headache...');
await context.addTranscription('Doctor said to take medication.');
const shared = await context.loadSharedContext();
const entities = await context.extractEntities();
```

### Step 6: Replace Summary Generation

**v1:**

```tsx
import { useSMR } from '@arcaai/agentic-sdk';

const { generateSummary, summary, isGenerating, analyzeDNA } = useSMR();
await generateSummary({ includeNER: true });
```

**v2:**

```tsx
const { summary } = useArca();

await summary.generatePreSummary({ dnaStyleId: summary.dnaStyle?.id });
await summary.generateSummary({ dnaStyleId: summary.dnaStyle?.id, includeNER: true });
await summary.analyzeDNA(['Sample text...']);
```

---

## Hook Mapping Reference

| v1 Hook | v2 Equivalent | Notes |
|---------|---------------|-------|
| `useArcaSessionManager` | `useArca().session` | Uses get-or-create `open()` model |
| `useAudioCapture` | `useArca().audio` | Merged with STT and VAD |
| `useArcaSpeechToText` | `useArca().audio` | Access via `audio.currentTranscript` |
| `useArcaaiVAD` | `useArca().audio` | Access via `audio.isSpeaking` |
| `useSMR` | `useArca().summary` + `useArca().context` | Split by concern |
| `useArcaDNA` | `useDnaStyle()` | Separate hook for DNA style management |
| `useArcaTextToSpeech` | — | Planned as separate `@arcaai/tts` package |
| N/A | `useArca().pipelines` | **New**: Pipeline control |
| N/A | `useArca().withRetry` | **New**: Retriable API wrapper |
| N/A | `useArcaSession()` | **New**: Lightweight session-only hook |
| N/A | `useArcaConfig()` | **New**: Runtime config access |
| N/A | `useDnaStyle()` | **New**: DNA writing style management |
| N/A | `usePrompts()` | **New**: Prompt template management |
| N/A | `useDepartments()` | **New**: Department management |

---

## Breaking Changes

### 1. Provider is Required

All components using SDK hooks must be descendants of `<AgenticProvider>`.

### 2. Session Uses Get-or-Create Pattern

```tsx
// v1: explicit create/end lifecycle
await createSession({ patientId: 'p1', doctorId: 'd1' });
await endSession();

// v2: get-or-create via open() — no pause/resume/end
await session.open({ patientId: 'p1', appointmentDate: '2026-01-28' });
// doctorId comes from authenticated user, appointmentDate defaults to today
```

### 3. Tuple Returns Removed

All hooks return objects. No more `const [action, state] = useHook()` patterns.

### 4. Audio Hooks Merged

Three hooks → one `audio` interface. All audio state and controls are accessed through `useArca().audio`.

### 5. Context API Replaced

Manual metadata management is replaced with a structured `context` API that supports typed items, shared context across consultation chains, and medical entity extraction.

### 6. Singleton Removed

`AgenticSDK.getInstance()` no longer exists. State is managed by Zustand inside the React context tree.

---

## TypeScript Migration

All types are exported from the main package:

```tsx
import type {
  AgenticConfig,
  Consultation,
  OpenSessionInput,
  CreateConsultationInput,
  StartRevisitInput,
  ContextItem,
  MedicalEntity,
  AudioPluginStates,
  TranscriptionResult,
  SummaryResponse,
  DNAStyle,
  UseArcaReturn,
  UseArcaSession,
  UseArcaAudio,
  UseArcaContext,
  UseArcaSummary,
} from '@arcaai/vox';
```

Type guards for visit types:

```tsx
import { isNewVisit, isRevisit } from '@arcaai/vox';
```

---

## FAQ

**Can I use v1 and v2 together?**
No. The packages may conflict. Complete the migration before removing v1.

**What happened to `useArcaTextToSpeech`?**
TTS is planned for a separate `@arcaai/tts` package. Use the Web Speech API or a third-party TTS solution in the interim.

**How do I handle the larger bundle size?**
Use split entry points: `@arcaai/vox/core` (~200 KB) for admin pages, `@arcaai/vox` (~5.5 MB) for consultation pages. Combine with `next/dynamic` for lazy loading.

**Where did the singleton pattern go?**
Replaced with React Context. The Zustand store provides centralized state without a singleton.

**How do I debug SDK issues?**

```typescript
const config = {
  api: { /* ... */ },
  debug: true,
  logging: {
    level: 'debug',
    console: { enabled: true, prettyPrint: true },
  },
};
```

The `debug: true` flag also activates audio pipeline debug mode, which logs:
- Consolidated pipeline configuration at startup
- Structured transcript JSON for every final transcription result (local and backend)

All debug output uses the `[ARCAAI:DEBUG]` prefix for easy filtering in the browser console. This is separate from the `logging` configuration which controls SDKLogger transports.

**Is there backwards compatibility?**
No. v2 is a complete rewrite. Follow this guide to migrate all v1 usage.
