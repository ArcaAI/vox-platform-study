# TASK-241: Fix Missing Speaker Information in Transcript

| Field       | Value                                          |
|-------------|------------------------------------------------|
| Ticket      | TASK-241                                       |
| Type        | Bugfix                                         |
| Created     | 2026-03-08                                     |
| Updated     | 2026-03-08                                     |
| Status      | Completed                                      |

---

## Requirement Analysis

### Description

When diarization is enabled, speaker information (`speakerId`) is never displayed in the transcript UI. The diarization engine (both local `LocalSpeakerDiarizer` and backend stt-v2) correctly produces speaker IDs, but the data is silently dropped at multiple points in the pipeline before reaching the UI.

### Business Context

Speaker identification is essential for medical consultation transcripts where distinguishing between doctor and patient speech is required for accurate summarization and clinical documentation.

### Acceptance Criteria

- [x] Speaker IDs from local diarization (`@arcaai/stt` `LocalSpeakerDiarizer`) appear in the transcript
- [x] Speaker IDs from backend streaming (stt-v2 via Redis) appear in the transcript
- [x] Speaker labels are stored in the SDK's `transcriptSegments` store
- [x] Speaker IDs are included in context API payloads
- [x] The `useRealtimeTranscription` hook maps speaker IDs to transcript entries

---

## Current State Evaluation

### Root Cause

5 breaks in the data flow where `speakerId` / `speaker_id` is silently dropped:

1. **Backend bridge** (`StreamingTranscriptMessage`) -- missing `speakerId` field; `readResultStream()` does not read `speaker_id` from Redis
2. **SDK WS types** (`WsTranscriptResult`) -- missing `speakerId` field
3. **SDK local types** (vox `TranscriptionResult`) -- missing `speakerId` field
4. **SDK hook** (`useArcaAudio.onTranscription`) -- never builds `TranscriptSegment`s or calls `store.addTranscriptSegment()`
5. **Realtime hook** (`useRealtimeTranscription`) -- never maps speaker from WS results to `TranscriptEntry`

### What Already Worked (No Changes Needed)

- `@arcaai/stt` `LocalSpeakerDiarizer` -- correctly produces `speakerId`
- `@arcaai/stt` `MessageHandler` -- correctly maps backend `speaker_id` to `speakerId`
- `TranscriptionPipeline.handleSTTEvent` -- passes through raw data object
- `PluginManager.setupPipelineEventHandlers` -- forwards results as-is
- `transcript-panel.tsx` (ui-playground local STT path) -- already reads `result.speakerId`
- `audio-store.ts` (ui-playground) -- `TranscriptEntry` already has `speaker?: string`
- `agenticStore.ts` -- already has `transcriptSegments`, `addTranscriptSegment`

---

## Implementation Summary

### Layer 1: Backend Bridge -- Propagate `speaker_id` from Redis to WebSocket

| File | Change |
|------|--------|
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | Added `speakerId?: string` and `speakerConfidence?: number` to `StreamingTranscriptMessage` |
| `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | Map `data.speaker_id` and `data.speaker_confidence` from Redis entry into emitted `StreamingTranscriptMessage` |

### Layer 2: SDK Types -- Add `speakerId` to vox types

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/types/audio.ts` | Added `speakerId?: string` to `TranscriptionResult` |
| `packages/agentic-sdk-v2/src/types/stt-v2.ts` | Added `speakerId?: string` and `speakerConfidence?: number` to `WsTranscriptResult` |

### Layer 3: SDK Hook -- Wire speaker info to store and context API

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | On final transcription: build `TranscriptSegment` with `speakerLabel` from `result.speakerId` and call `store.addTranscriptSegment()`. Include `speakerId` in `structuredData` sent to context API. |

### Layer 4: Realtime Transcription Hook -- Map speaker from WS results

| File | Change |
|------|--------|
| `apps/ui-playground/src/hooks/use-realtime-transcription.ts` | Map `result.speakerId` to `entry.speaker` in the `wsClient.onTranscript` callback |

### Layer 5: SDK WebSocket Client -- Verified passthrough

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Updated protocol doc comment. No functional change needed -- `JSON.parse` preserves all fields and the type guard passes optional fields through. |

### Follow-up Fix: Backend live-transcription root causes

| File | Change |
|------|--------|
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | Replaced "always speech" fallback with energy-based fallback VAD when Silero VAD is unavailable, preventing single giant utterances and degenerate looping transcripts |
| `apps/stt-v2/src/stt_v2/streaming/inference.py` | Added lightweight transcript sanitization for pathological `>>` spam / repeated loops and enabled per-utterance speaker identification when diarization is enabled |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Wired tenant/session/context and effective diarization config into `StreamingInferenceWorker`; added optional session-level diarization override |
| `apps/stt-v2/src/stt_v2/streaming/api/schemas.py` | Added optional `diarization` in internal create-session request |
| `apps/stt-v2/src/stt_v2/streaming/api/routes.py` | Passed `diarization` override through to session manager |
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | Added `diarization?: boolean` to create-session DTO |
| `packages/applications/src/services/stt/streaming/streamingSession.service.ts` | Forwarded `diarization` to stt-v2 internal API |
| `apps/api/src/modules/streaming/transcription-job.controller.ts` | Accepted and forwarded `diarization` in `POST /audio/transcription-jobs/stream/session` |
| `packages/agentic-sdk-v2/src/types/stt-v2.ts` | Added `diarization?: boolean` to SDK create-session request type |
| `apps/ui-playground/src/hooks/use-realtime-transcription.ts` | Forwarded diarization flag to session creation and added transcript sanitation + duplicate-final suppression |
| `apps/ui-playground/src/features/audio/components/transcript-panel.tsx` | Wired UI `diarizationEnabled` toggle into backend WebSocket start options |

### Data Flow After Fix

```
stt-v2 Python (SegmentResult.speaker_id)
  → Redis XADD (speaker_id field)
  → StreamingAudioBridge.readResultStream() [reads speaker_id → speakerId]
  → StreamingTranscriptMessage { speakerId }
  → SttWsGateway (JSON.stringify forwards all fields)
  → SttV2WebSocketClient.handleMessage() [JSON.parse preserves speakerId]
  → WsTranscriptResult { speakerId }
  → useRealtimeTranscription [maps to entry.speaker]
  → TranscriptEntry { speaker } → UI Badge

@arcaai/stt LocalSpeakerDiarizer.assignSpeaker()
  → TranscriptionResult { speakerId }
  → TranscriptionPipeline.handleSTTEvent() [passes through]
  → PluginManager.onTranscription [forwards as-is]
  → useArcaAudio.onTranscription [builds TranscriptSegment with speakerLabel]
  → store.addTranscriptSegment() → UI
```

---

## Files Changed

| File | Purpose |
|------|---------|
| `packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts` | Added speaker fields to `StreamingTranscriptMessage` |
| `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | Map `speaker_id` from Redis to `speakerId` in bridge output |
| `packages/agentic-sdk-v2/src/types/audio.ts` | Added `speakerId` to vox `TranscriptionResult` |
| `packages/agentic-sdk-v2/src/types/stt-v2.ts` | Added `speakerId` and `speakerConfidence` to `WsTranscriptResult` |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | Build `TranscriptSegment` with speaker label; include `speakerId` in context API |
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Normalize transcript payloads (camelCase/snake_case) and preserve speaker fields in realtime callback |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | Added regression test for snake_case transcript normalization (`speaker_id`/`is_final`) |
| `packages/stt/src/providers/LocalSpeakerDiarizer.ts` | Increased default similarity threshold to reduce over-merging into a single speaker profile in local realtime mode |
| `apps/ui-playground/src/hooks/use-realtime-transcription.ts` | Map `result.speakerId` to `entry.speaker` |

---

## Change History

| Date       | Description | Files Modified |
|------------|-------------|----------------|
| 2026-03-08 | Initial fix: wire speaker information through all 5 break points | 7 files (see above) |
| 2026-03-08 | Follow-up fix: wire backend diarization toggle end-to-end and prevent pathological repeated transcript output in live WebSocket mode | 11 files (streaming preprocessor/inference/session manager + API/SDK/UI wiring) |
| 2026-03-08 | Reliability hardening: persist diarization override in session metadata, emit fallback speaker marker when diarization is enabled but no match is found, and normalize WS transcript naming variants | `session_manager.py`, `schemas.py`, `inference.py`, `SttV2WebSocketClient.ts`, `SttV2WebSocketClient.test.ts` |
| 2026-03-08 | Local diarizer tuning: reduce false speaker merges by tightening browser-only similarity threshold (helps two-person conversations split beyond `speaker-1`) | `LocalSpeakerDiarizer.ts` |
| 2026-03-08 | Batch diarization + browser speaker profile persistence: forward `diarization` and `code_switching` overrides for file jobs, preserve speaker metadata in SSE chunk payloads, map speaker labels in live/job transcript UI, and persist speaker voice features locally in browser storage | `transcription-job.controller.ts`, `transcriptionRealtime.service.ts`, `transcription-events.ts`, `routes.py`, `batch_service.py`, `FileTranscriptionService.ts`, `SttV2WebSocketClient.ts`, `use-realtime-transcription.ts`, `use-file-transcription.ts`, `batch.tsx`, `transcript-panel.tsx`, `speaker-profiles.ts`, `LocalSTTProvider.ts`, `LocalSpeakerDiarizer.ts` |
