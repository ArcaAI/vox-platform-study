# Agentic SDK V2 (`@arcaai/vox`)

A comprehensive React SDK for medical consultation workflows with real-time audio processing, speech-to-text, voice activity detection, and AI-powered summarization.

## Overview

The ARCAAI Agentic SDK v2 is a complete rewrite designed around three principles: a **unified API** surface through a single `useArca()` hook, **configuration-driven plugin** enablement, and **modular entry points** for optimal bundle sizes. Heavy ML inference runs off the main thread in WebWorkers, keeping the UI responsive during real-time audio capture with noise filtering, VAD, and STT.

### Key Features

| Feature | Description |
|---------|-------------|
| Session Management | Consultation lifecycle with new-visit / re-visit support |
| Audio Processing | Real-time capture with RNNoise noise cancellation |
| Voice Activity Detection | Silero VAD v5 for accurate speech detection |
| Speech-to-Text | Whisper-based local and backend STT via WebWorker |
| Context Management | Case notes, transcriptions, medical entity extraction |
| Summary Generation | AI-powered medical summary with DNA writing style |
| Cross-Tab Sync | Session sharing across browser tabs via localStorage + SharedWorker |
| Multi-Tenant | Built-in organization-level isolation |

## Architecture

### Package Structure and Bundle Sizes

The SDK ships three entry points to allow fine-grained control over bundle size:

| Entry Point | Import Path | Size | Contents |
|-------------|-------------|------|----------|
| Full SDK | `@arcaai/vox` | ~5.5 MB | Core + all audio plugins |
| Core Only | `@arcaai/vox/core` | ~200 KB | Session, context, summary (no audio) |
| Plugins Only | `@arcaai/vox/plugins` | ~5.3 MB | Audio hooks and pipeline wrappers |

### Internal Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        AgenticProvider                            │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ AgenticClient  │  │ PluginManager  │  │ Personalization    │  │
│  │   (HTTP API)   │  │ (Audio Plugins)│  │   Manager          │  │
│  └────────────────┘  └────────────────┘  └────────────────────┘  │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ ModelRegistry  │  │ SessionCoord.  │  │ LifecycleManager   │  │
│  │  (ML Models)   │  │ (Cross-Tab)    │  │  (Shutdown)        │  │
│  └────────────────┘  └────────────────┘  └────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Zustand Store                            │  │
│  │  Session | Audio | Context | Summary | Lifecycle | Pipes   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Audio Processing Pipelines                       │
│                                                                   │
│  Transcription Pipeline (Sequential)                              │
│  Audio → [NoiseFilter] → [VAD] → [STT] → Transcription           │
│                                                                   │
│  Knowledge Pipeline (Parallel)                                    │
│  Transcription ──┬──► [NER] (auto)                                │
│                  ├──► [SpellCheck] (manual)                       │
│                  └──► [Summarization] (manual)                    │
└──────────────────────────────────────────────────────────────────┘
```

### Plugin System

The SDK orchestrates several independent plugin packages through `PluginManager`:

| Package | Purpose | Size |
|---------|---------|------|
| [`@arcaai/room`](../room/README.md) | Audio track management, AudioContext, ProcessorPipeline | ~67 KB |
| [`@arcaai/noise-filter`](../noise-filter/README.md) | RNNoise WASM noise cancellation | ~35 KB |
| [`@arcaai/vad`](../vad/README.md) | Silero VAD v5 + ONNX Runtime | ~2 MB |
| `@arcaai/stt` | Whisper STT with WebWorker | ~65 KB + worker |
| [`@arcaai/med-ner`](../med-ner/README.md) | Medical NER via Transformers.js (optional) | ~300 MB models |

Plugins follow a common lifecycle: **Created → Pending → Active → Destroyed**, with an **Error** state reachable from Pending or Active. All implement the `TrackProcessor` interface from `@arcaai/room`.

### State Management

All SDK state lives in a centralized **Zustand** store, partitioned into slices:

| Slice | Responsibility |
|-------|---------------|
| Session | Active consultation, related consultations, loading/error |
| Audio | Capture state, mute, level, speaking, current transcript, plugin states |
| Context | Context items, transcriptions, case notes, entities, shared context |
| Summary | Summaries, DNA style, generation state |

Zustand selectors enable targeted re-renders — components subscribe only to the store slices they need.

### Event System

The SDK uses `eventemitter3` for internal event propagation. Pipeline events, processor data events (VAD, STT, NER), and lifecycle transitions all flow through typed event emitters, surfaced to consumers via the `useArca()` hook's reactive state.

## Installation

```bash
npm install @arcaai/vox

# Optional: Medical NER
npm install @arcaai/med-ner

# Optional: Highlight.io observability
npm install highlight.run
```

### Peer Dependencies

| Dependency | Version |
|------------|---------|
| `react` | `^18.3.0 \|\| ^19.0.4` |
| `react-dom` | `^18.3.0 \|\| ^19.0.4` |

React version constraints address CVE-2025-55182. The SDK is client-side only and includes `"use client"` directives.

### Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `zustand` | `^5.0.0` | Centralized state management |
| `eventemitter3` | `^5.0.1` | Type-safe event emitter |
| `diff` | `^8.0.2` | Text diffing utilities |

## Quick Start

### 1. Wrap your app with the provider

```tsx
import { AgenticProvider } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  debug: true,
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en-US' },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}
```

### 2. Use the unified hook

```tsx
import { useArca } from '@arcaai/vox';

function ConsultationPage() {
  const { session, audio, context, summary, isReady } = useArca();

  const handleStart = async () => {
    await session.open({
      patientId: 'patient-123',
      appointmentDate: '2026-01-28',
    });
    await audio.start();
  };

  const handleStop = async () => {
    await audio.stop();
  };

  if (!isReady) return <div>Loading SDK...</div>;

  return (
    <div>
      {!session.consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <>
          <p>Audio Level: {audio.level}%</p>
          <p>Speaking: {audio.isSpeaking ? 'Yes' : 'No'}</p>
          {audio.currentTranscript && <p>{audio.currentTranscript}...</p>}

          <h2>Transcriptions ({context.transcriptions.length})</h2>
          {context.transcriptions.map((t) => (
            <p key={t.id}>{t.content}</p>
          ))}

          <button onClick={handleStop}>End Consultation</button>
        </>
      )}
    </div>
  );
}
```

## Tech Stack

| Technology | Role |
|------------|------|
| React 18/19 | UI framework |
| Zustand 5 | State management |
| eventemitter3 | Event system |
| TypeScript | Type safety |
| tsup | Bundling (CJS + ESM) |
| Vitest | Unit testing |
| Playwright | E2E testing |
| Web Audio API | Audio processing |
| WebWorker | Off-thread ML inference |
| WebSocket | Streaming STT |

## Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome 113+ | Full | WebGPU + AudioWorklet |
| Firefox 100+ | Full | WASM-only STT |
| Safari 17.4+ | Full | AudioWorklet supported |
| Safari < 17.4 | Partial | No AudioWorklet — fallback modes |
| Edge 113+ | Full | Chromium-based |

Audio capture requires HTTPS (or localhost) and a user gesture to start.

## Streaming Core Classes

The SDK includes dedicated classes for real-time streaming, independent of the plugin-based audio pipeline:

| Class | Purpose | Protocol |
|-------|---------|----------|
| `SttV2WebSocketClient` | Live audio → real-time transcription | WebSocket (binary PCM) |
| `SSEClient` | Job progress, file transcription results | Server-Sent Events |
| `StreamingSessionManager` | Session lifecycle (create, close, WS URL) | HTTP REST |
| `FileTranscriptionService` | Upload audio file, get job ID + stream URL | HTTP REST + SSE |
| `SharedConnectionManager` | Cross-tab WS/SSE sharing via SharedWorker | SharedWorker / fallback |

### Streaming React Hooks

| Hook | Purpose |
|------|---------|
| `useConsultationJob` | Track async job status with SSE streaming + polling fallback |
| `useSharedConnection` | Access `SharedConnectionManager` instance and tab count |
| `useSharedSSE` | Subscribe to SSE via shared connection |
| `useSharedWS` | Subscribe to WebSocket via shared connection |

See [Streaming Architecture](./streaming.md) for complete protocol documentation, authentication patterns, and code examples.

## Debug Mode

Enable verbose audio pipeline logging by setting `debug: true` in the configuration:

```tsx
const config = {
  api: { baseUrl: '...', apiKey: '...' },
  debug: true,
  audio: { /* ... */ },
};
```

When active, the SDK logs to the browser console with `[ARCAAI:DEBUG]` prefix:
- **Pipeline configuration dump** at startup (noise filter, VAD, STT settings, microphone source)
- **Structured transcript JSON** for every final transcription result (local and backend), with precise numeric formatting

See [API Reference — Debug Mode](./api-reference.md#debug-mode) for the full transcript JSON schema.

## Related Documentation

- [API Reference](./api-reference.md)
- [Streaming Architecture](./streaming.md)
- [Examples](./examples.md)
- [Migration Guide](./migration-guide.md)
