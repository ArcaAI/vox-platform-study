# TASK-237: Multi-Source Audio Pipeline Refactor

| Field | Value |
|---|---|
| **Ticket** | TASK-237 |
| **Created** | 2026-03-08 |
| **Updated** | 2026-03-08 |
| **Status** | Completed |
| **Type** | Refactor |
| **Packages** | `@arcaai/room`, `@arcaai/vox`, `ui-playground` |

## Requirement Analysis

### Description

Comprehensive refactor of the audio pipeline across `@arcaai/room`, `@arcaai/vox`, and `ui-playground` to implement proper multi-source audio mixing, fix critical data flow disconnects, enforce browser compatibility requirements, and address all identified issues from the code review.

### Business Context

The audio pipeline had several critical issues preventing multi-source audio mixing from working end-to-end:
- Mixed audio streams were produced but never consumed by transcription
- Processing config toggles (noise filter, VAD) updated UI state but never reached the actual audio pipeline
- AudioContext and MediaStream resources leaked on repeated start/stop cycles
- No browser compatibility enforcement despite significant cross-browser differences

### Acceptance Criteria

1. Multi-source audio mixing works end-to-end (capture -> mix -> process -> transcribe)
2. Processing config toggles actually affect the audio pipeline
3. Browser compatibility is detected and enforced with user-facing warnings
4. Firefox gracefully degrades to single-mic mode
5. No AudioContext or MediaStream resource leaks
6. All existing tests pass, new tests cover all changes

## Current State Evaluation

### Issues Identified (Code Review)

| ID | Severity | Issue |
|---|---|---|
| C1 | Critical | Mixed stream produced by AudioMixerPanel but never consumed by transcription |
| C2 | Critical | Processing config toggles update store but don't affect pipeline |
| C3 | Critical | TranscriptionPipeline only accepts single MediaStreamTrack |
| C4 | Critical | useArcaAudio creates new AudioContext/MediaStream on every call without cleanup |
| I1 | Important | AudioContextManager singleton ignores options after first creation |
| I2 | Important | AudioMixerPanel creates own AudioContext at hardcoded 16kHz |
| I3 | Important | muteAudio only updates Zustand state, not actual MediaStreamTrack |
| I4 | Important | useAudioTrack has stale cleanup closure |
| I5 | Important | clearSources doesn't stop active MediaStream tracks |
| I6 | Important | VAD threshold UI missing despite store support |
| S12 | Suggestion | webAudioMix option exists but unused |
| S13 | Suggestion | useDevices recomputes filtered arrays on every render |
| S15 | Suggestion | smoothingTimeConstant set on time-domain analysis (no effect) |
| B1 | Blocker | Firefox concurrent mic process limit |
| BC1-5 | Caveat | Various iOS Safari and Safari limitations |

## Implementation Summary

### Phase 1: Browser Compatibility Foundation (Tasks 1-3)

**New files:**
- `packages/room/src/utils/browserCompatibility.ts` — Browser detection, minimum version enforcement, capability assessment
- `packages/room/src/hooks/useBrowserCapabilities.ts` — React hook wrapping browser capabilities
- `packages/room/src/__tests__/browserCompatibility.test.ts` — 31 tests
- `packages/room/src/__tests__/useBrowserCapabilities.test.ts` — 7 tests
- `apps/ui-playground/src/features/audio/components/browser-compatibility-banner.tsx` — UI banner for browser warnings

**Modified files:**
- `packages/room/src/types/index.ts` — Added `BrowserCapabilities`, `BrowserLimitation`, `BrowserName` types
- `packages/room/src/utils/index.ts` — Barrel exports
- `packages/room/src/hooks/index.ts` — Barrel exports
- `packages/room/src/index.ts` — Barrel exports
- `apps/ui-playground/src/features/audio/components/audio-workspace.tsx` — Renders banner
- `apps/ui-playground/src/features/audio/components/audio-source-panel.tsx` — Disables multi-mic on Firefox

### Phase 2: AudioMixer Class (Tasks 4-6)

**New files:**
- `packages/room/src/core/AudioMixer.ts` — Multi-source mixer using GainNode summation with 1/sqrt(N) normalization
- `packages/room/src/hooks/useAudioMixer.ts` — React hook for AudioMixer lifecycle
- `packages/room/src/__tests__/AudioMixer.test.ts` — 15 tests

**Modified files:**
- `packages/room/src/core/AudioContextManager.ts` — Options mismatch warning
- `packages/room/src/core/index.ts` — Barrel exports
- `packages/room/src/index.ts` — Barrel exports

### Phase 3: Wire Mixed Stream to Transcription (Tasks 7-10)

**Modified files:**
- `apps/ui-playground/src/features/audio/components/audio-mixer-panel.tsx` — Uses AudioMixer class, 48kHz sample rate
- `apps/ui-playground/src/features/audio/components/transcript-panel.tsx` — Wires mixedStream to both Backend WS and Local AI transcription; wires processing config
- `apps/ui-playground/src/hooks/use-realtime-transcription.ts` — Added `stream` option to bypass getUserMedia

### Phase 4: Fix @arcaai/vox SDK (Tasks 11-12)

**Modified files:**
- `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` — Uses AudioContextManager, stores stream refs, mute/unmute actually toggles track.enabled
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` — Added `activeStream`, `activeAudioContext` state and actions

### Phase 5: Fix @arcaai/room (Tasks 13-16)

**Modified files:**
- `packages/room/src/hooks/useAudioTrack.ts` — Uses trackRef to prevent stale closures, stops existing track before creating new one
- `packages/room/src/hooks/useDevices.ts` — Wrapped filter operations in useMemo
- `packages/room/src/core/Room.ts` — Implements webAudioMix option with AudioMixer, added getMixer()
- `packages/room/src/core/AudioTrack.ts` — Removed ineffective smoothingTimeConstant

### Phase 6: Fix ui-playground Store and UI (Tasks 17-19)

**Modified files:**
- `apps/ui-playground/src/store/audio-store.ts` — clearSources/reset stop mixedStream tracks; setMixedStream stops old stream
- `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx` — Added VAD threshold slider
- `apps/ui-playground/src/features/audio/components/transcript-panel.tsx` — Syncs isCapturing to store

### Phase 7: Tests (Tasks 20-23)

**Modified files:**
- `packages/room/src/__tests__/Room.test.ts` — 3 new tests for AudioMixer integration
- `packages/room/src/__tests__/AudioContextManager.test.ts` — 3 new tests for options warning
- `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.test.ts` — 4 new tests for activeStream/activeAudioContext
- `apps/ui-playground/src/store/__tests__/audio-store.test.ts` — 7 new tests for track cleanup and VAD threshold

**New files:**
- `apps/ui-playground/src/features/audio/components/__tests__/browser-compatibility-banner.test.tsx` — 4 tests

### Phase 8: Documentation and Exports (Task 24)

- Verified all barrel exports are complete
- Created this documentation

## Browser Compatibility Matrix

| Browser | Min Version | Multi-Mic | AudioWorklet | Persistent Permissions | Background Audio |
|---|---|---|---|---|---|
| Chrome | 91+ | Yes | Yes | Yes | Yes |
| Edge | 91+ | Yes | Yes | Yes | Yes |
| Firefox | 120+ | **No** (degraded) | Yes | Yes | Yes |
| Safari | 16.4+ | Yes | Yes | **No** (session-only) | Yes |
| iOS Safari | 16.4+ | Yes | **Unreliable** (17-18) | **No** | **No** |

## Architecture

```
Capture Layer          Mixing Layer (AudioMixer)       Processing Pipeline
┌──────────┐          ┌─────────────────────┐         ┌──────────────────┐
│ Mic 1    │──────────│ GainNode 1          │         │                  │
│ Mic 2    │──────────│ GainNode 2          │─────────│ NoiseFilter      │
│ Mic N    │──────────│ GainNode N          │  single │ (RNNoise WASM)   │
└──────────┘          │                     │  mixed  │        │         │
                      │ MasterGain 1/√N     │  track  │ VAD (Silero v5)  │
                      │ MediaStreamDest     │         │        │         │
                      └─────────────────────┘         │ STT (Whisper/WS) │
                                                      │        │         │
                                                      │ Transcript Panel │
                                                      └──────────────────┘
```

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-03-08 | Initial implementation — all 24 tasks across 8 phases | See Implementation Summary above |
