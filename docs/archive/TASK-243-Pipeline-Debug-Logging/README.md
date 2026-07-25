# TASK-243: Fix Audio Pipeline Debug Logging Metadata

**Ticket**: TASK-243
**Created**: 2026-03-09
**Updated**: 2026-03-09
**Status**: Completed
**Type**: bugfix / refactor

---

## Requirement Analysis

### Description

Fix debug logging across the audio pipeline (`@arcaai/vad`, `@arcaai/stt`, `@arcaai/room`, `@arcaai/vox`) so that when debug mode is enabled, the structured transcript output correctly captures and attributes metadata at the right pipeline stage.

### Target Debug Output Schema

```json
{
  "segment": 9,
  "speaker": "speaker-1",
  "start": 0,
  "end": 3.5,
  "duration": 3.5,
  "inference": 0.2562,
  "words": [
    { "word": " than", "confidence": 0, "start": 0.58, "end": 1.04 }
  ]
}
```

### Field Ownership

| Field | Captured At | Description |
|-------|------------|-------------|
| `segment` | VAD step | Sequential segment number assigned when VAD detects speech end |
| `speaker` | Diarization step | Speaker ID from local diarizer or backend |
| `start` | VAD step | Start time in seconds relative to the whole audio stream |
| `end` | VAD step | End time in seconds relative to the whole audio stream |
| `duration` | Computed | `end - start` in seconds |
| `inference` | STT step | Inference time in seconds |
| `words[].start` | STT step | Word start time relative to current segment start |
| `words[].end` | STT step | Word end time relative to current segment start |
| `words[].confidence` | STT step | Per-word confidence (0 when unavailable) |

### Acceptance Criteria

1. VAD assigns a `segmentNumber` to each speech-end payload
2. VAD computes stream-relative `start`/`end` in seconds (not wall-clock)
3. VAD metadata flows through TranscriptionPipeline to STT
4. STT debug logging uses VAD-provided `start`/`end` for the entry
5. Word timestamps remain segment-relative (from Whisper)
6. Duration is consistently in seconds across the pipeline
7. `useArcaAudio` uses actual timing from results, not `Date.now()`

---

## Implementation Plan

### Task 1: Add `segmentNumber` and stream-relative timing to VAD

**Files**:
- Modify: `packages/vad/src/types/index.ts`
- Modify: `packages/vad/src/processors/VADProcessor.ts`

### Task 2: Expand `VADEvent` to carry VAD metadata

**Files**:
- Modify: `packages/agentic-sdk-v2/src/types/audio.ts`

### Task 3: Pass VAD metadata through TranscriptionPipeline

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`

### Task 4: Update STTProcessor to use VAD metadata in debug logging

**Files**:
- Modify: `packages/stt/src/core/STTProcessor.ts`
- Modify: `packages/stt/src/types/index.ts`

### Task 5: Fix SttWebSocketClient debug logging

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`

### Task 6: Fix `useArcaAudio` TranscriptSegment timing

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`

---

## Implementation Summary

### What Was Built

Fixed the audio pipeline debug logging so that when debug mode is enabled, the structured transcript output correctly captures metadata at the right pipeline stage, matching the target schema.

### Changes by Package

**`@arcaai/vad` (packages/vad/)**
- Added `segmentNumber`, `streamStartSec`, `streamEndSec`, `durationSec` to `VADSpeechEndPayload`
- VADProcessor now tracks `streamStartWallClock` (set at init) and computes stream-relative timing
- Segment number assigned from `stats.speechSegmentsDetected` (1-based)
- Duration standardized to seconds (`durationSec`)

**`@arcaai/vox` (packages/agentic-sdk-v2/)**
- Expanded `VADEvent` type with `segmentNumber`, `streamStartSec`, `streamEndSec`, `durationSec`
- Added `vadSegmentNumber`, `vadStreamStartSec`, `vadStreamEndSec`, `vadDurationSec`, `latencyMs`, `duration` to SDK `TranscriptionResult`
- `TranscriptionPipeline.handleVADEvent` now extracts and forwards all VAD metadata
- Pipeline enriches transcription results with VAD metadata before emitting
- Added pipeline-level `logDebugTranscript()` that produces the target debug schema
- Fixed `useArcaAudio` to use `vadStreamStartSec`/`vadStreamEndSec` for `TranscriptSegment` timing

**`@arcaai/stt` (packages/stt/)**
- Fixed `LocalSTTProvider.transcribeSegment` to include `latencyMs` and `duration` in result

### Files Modified

| File | Change |
|------|--------|
| `packages/vad/src/types/index.ts` | Added `segmentNumber`, `streamStartSec`, `streamEndSec`, `durationSec` to `VADSpeechEndPayload` |
| `packages/vad/src/processors/VADProcessor.ts` | Track `streamStartWallClock`, compute stream-relative timing, assign segment number |
| `packages/vad/src/__tests__/types.test.ts` | Updated tests for new payload shape |
| `packages/vad/e2e/fixtures/index.html` | Updated display for new fields |
| `packages/vad/README.md` | Updated code example |
| `packages/agentic-sdk-v2/src/types/audio.ts` | Expanded `VADEvent` and `TranscriptionResult` types |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | Forward VAD metadata, enrich results, add pipeline debug logging |
| `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts` | Documented inference=0 limitation |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | Use VAD timing for TranscriptSegment |
| `packages/stt/src/providers/LocalSTTProvider.ts` | Include `latencyMs` and `duration` in transcribeSegment result |

### Verification

- `@arcaai/vad`: 174 tests passing
- `@arcaai/stt`: 269 tests passing
- `@arcaai/vox`: 2507 tests passing
- All three packages build successfully

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-09 | Initial implementation | See tasks above |
