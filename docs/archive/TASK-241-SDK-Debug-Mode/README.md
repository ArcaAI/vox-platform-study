# TASK-241: SDK Debug Mode for Audio Pipeline

- **Ticket**: TASK-241
- **Type**: Feature
- **Created**: 2026-03-08
- **Updated**: 2026-03-08
- **Status**: Completed (with UI toggle and documentation)

---

## Requirement Analysis

### Description

Add a unified debug mode to `@arcaai/vox` and all plugin packages (`@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/room`) that, when enabled, logs audio pipeline configuration and structured transcript JSON to the console.

### Business Context

Developers integrating the SDK need visibility into the audio pipeline's runtime behavior for troubleshooting transcription issues, verifying configuration, and validating that audio processing stages are correctly configured.

### Acceptance Criteria

1. Setting `debug: true` on `AgenticConfig` activates verbose debug logging across all audio plugins.
2. Each plugin package accepts its own `debugMode?: boolean` for standalone use.
3. On pipeline start, a consolidated configuration dump is logged to the console.
4. Each final transcription result (local and backend) is logged as structured JSON with specified precision.
5. Debug output uses `[ARCAAI:DEBUG]` prefix for easy filtering.
6. Existing behavior is unchanged when debug mode is off.

---

## Current State Evaluation

### Existing Infrastructure

- `AgenticConfig` already had a `debug?: boolean` flag used for SDKLogger verbosity.
- `SDKLogger` provided structured logging with multiple transports but no transcript-level debug output.
- `BaseProcessor` in `@arcaai/room` served as the base class for all audio processors.
- No per-package debug mode existed.

### Dependencies

- `@arcaai/room` → base package all plugins depend on
- `@arcaai/noise-filter` → depends on `@arcaai/room`
- `@arcaai/vad` → depends on `@arcaai/room`
- `@arcaai/stt` → depends on `@arcaai/room`
- `@arcaai/vox` → orchestrates all plugins via `PluginManager` and `TranscriptionPipeline`

---

## Implementation Plan

### Design Decisions

1. **Extend existing `debug` flag** — `AgenticConfig.debug: true` activates transcript JSON logging and config dumps.
2. **Both per-package and SDK-level control** — Each plugin accepts `debugMode?: boolean`. When used via the SDK, `debug: true` propagates automatically. Standalone usage works independently.
3. **Console-only output** — Debug logs go to `console.log` with `[ARCAAI:DEBUG]` prefix, decoupled from SDKLogger transports.

### Propagation Chain

```
AgenticConfig.debug → AgenticProvider → PluginManager._debugMode
  → TranscriptionPipelineConfig.debugMode → TranscriptionPipeline
    → createNoiseFilter({ debugMode })
    → createVAD({ debugMode })
    → createSTT({ debugMode })
  → SttV2WebSocketClient({ debugMode })
```

### Transcript JSON Format

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

- Times: 3 decimal places
- Inference: 4 decimal places
- Confidence: 3 decimal places
- `words` array only present when word-level timestamps are enabled

---

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `packages/room/src/utils/debugLogger.ts` | Shared debug logging utility with `debugLog`, `debugLogConfig`, `debugLogTranscript` functions and `DebugTranscriptEntry` interface |
| `packages/room/src/__tests__/debugLogger.test.ts` | Unit tests for debug logger utility (10 tests) |
| `apps/ui-playground/src/components/debug-toggle.tsx` | Debug mode toggle button for the header (Bug/BugOff icons, tooltip, wired to playground store) |

### Files Modified

| File | Changes |
|------|---------|
| `packages/room/src/utils/index.ts` | Export debug logger functions and types |
| `packages/room/src/index.ts` | Export debug logger from package barrel |
| `packages/room/src/processors/BaseProcessor.ts` | Added `protected debugMode: boolean` field and optional `debugMode` constructor parameter |
| `packages/noise-filter/src/types/index.ts` | Added `debugMode?: boolean` to `NoiseFilterOptions` |
| `packages/noise-filter/src/processors/NoiseFilterProcessor.ts` | Pass `debugMode` to `BaseProcessor`, log config on init when enabled |
| `packages/vad/src/types/index.ts` | Added `debugMode?: boolean` to `VADOptions` |
| `packages/vad/src/processors/VADProcessor.ts` | Pass `debugMode` to `BaseProcessor`, log config on init when enabled |
| `packages/stt/src/types/index.ts` | Added `debugMode?: boolean` to `STTOptions` |
| `packages/stt/src/core/STTProcessor.ts` | Pass `debugMode` to `BaseProcessor`, log config on init, log transcript JSON on each final result with segment counter |
| `packages/agentic-sdk-v2/src/types/pipeline.ts` | Added `debugMode?: boolean` to `TranscriptionPipelineConfig` |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | Import `debugLogConfig`, propagate `debugMode` to all plugin factories, log consolidated config at pipeline start |
| `packages/agentic-sdk-v2/src/core/PluginManager.ts` | Added `_debugMode` field, accept `debugMode` in constructor, set `debugMode` on pipeline config |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | Pass `cfg.debug` to `PluginManager` constructor |
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Added `_debugMode` and `debugSegmentCounter` fields, accept `debugMode` in constructor, log transcript JSON for backend path |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | Added 4 debug mode tests |
| `packages/agentic-sdk-v2/vitest.config.mts` | Added `@arcaai/room` source alias for test resolution |
| `apps/ui-playground/src/components/layout/header.tsx` | Added `DebugToggle` import and placement next to `ThemeSwitch` |

### Test Results

- `debugLogger.test.ts`: **10/10 passed** — format correctness, precision, words inclusion/omission
- `SttV2WebSocketClient.test.ts`: **60/60 passed** — including 4 new debug mode tests (final logging, no-debug, non-final skip, segment counter increment)
- `BaseProcessor.test.ts`: **31/31 passed** — existing tests unaffected by `debugMode` addition

### API Changes

No breaking changes. All new parameters are optional with `false` defaults.

### Usage

```tsx
<AgenticProvider config={{
  api: { baseUrl: 'https://api.example.com' },
  debug: true,
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true, sensitivity: 0.5 },
    stt: { enabled: true, provider: 'local', returnTimestamps: 'word', diarization: true },
  },
}}>
  <App />
</AgenticProvider>
```

Standalone plugin usage:

```typescript
const stt = new STTProcessor({
  debugMode: true,
  features: { provider: 'local', modelId: 'base', returnTimestamps: 'word' },
});
```

---

### UI-Playground Debug Toggle

The ui-playground app exposes the debug mode toggle in the global header, next to the theme switch:

- **Component**: `apps/ui-playground/src/components/debug-toggle.tsx` — `DebugToggle` button using `Bug`/`BugOff` icons from lucide-react
- **Placement**: Header bar (`apps/ui-playground/src/components/layout/header.tsx`), visible on all authenticated pages including `/` (index) and `/playground/overview`
- **State**: Backed by `usePlaygroundStore().debugMode` (Zustand, persisted to localStorage)
- **Wiring**: `SDKProvider` already reads `debugMode` from the store and passes it as `debug` to `AgenticConfig`, so the toggle takes effect immediately

### Documentation Updated

| Document | Changes |
|----------|---------|
| `knowledge/agentic-sdk-v2/README.md` | Added `debug: true` to Quick Start, new "Debug Mode" section |
| `knowledge/agentic-sdk-v2/api-reference.md` | Added "Debug Mode" subsection with transcript JSON schema, updated `SttV2WebSocketClient` constructor |
| `knowledge/agentic-sdk-v2/streaming.md` | Added `debugMode` to `SttV2WebSocketClient` example |
| `knowledge/agentic-sdk-v2/migration-guide.md` | Updated debug FAQ with audio pipeline debug details |
| `knowledge/agentic-sdk-v2/examples.md` | Added "Debug Mode" example section |
| `packages/agentic-sdk-v2/README.md` | Added `debug: true` to Quick Start, new "Debug Mode" section |
| `packages/room/README.md` | Added "Debug Mode Support" subsection, updated Custom VAD example |
| `packages/stt/README.md` | Added `debugMode` to STTOptions, new "Debug Mode" section |
| `packages/vad/README.md` | Added `debugMode` to VADOptions, new "Debug Mode" section |
| `packages/noise-filter/README.md` | Added `debugMode` to NoiseFilterOptions, new "Debug Mode" section |

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-08 | Initial implementation of SDK debug mode | See Implementation Summary |
| 2026-03-08 | Added debug toggle to ui-playground header, updated all documentation (11 docs) | `apps/ui-playground/src/components/debug-toggle.tsx` (new), `apps/ui-playground/src/components/layout/header.tsx`, knowledge docs (5), package READMEs (5) |
