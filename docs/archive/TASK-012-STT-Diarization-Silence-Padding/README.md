# TASK-012: STT Diarization Silence Padding

- **Ticket Number**: TASK-012
- **Created Date**: 2026-02-09
- **Last Updated**: 2026-02-09
- **Status**: Completed

---

## Requirement Analysis

### Description

When diarization is enabled in the STT pipeline, add 500ms of silence padding to the beginning and end of each VAD-detected speech segment when merging all segments into the final audio before storing it to object storage (MinIO/S3).

### Business Context

- Diarization-enabled pipelines produce processed audio that is stored for playback and audit
- Currently, VAD speech segments are concatenated directly with no gap, creating unnatural transitions between speaker turns
- Adding silence padding between segments improves:
  - Audio playback quality with natural breathing room between speech
  - Downstream speaker diarization accuracy with cleaner segment boundaries
  - Human review experience when listening to processed recordings

### Acceptance Criteria

1. When diarization is **enabled**, `get_vad_merged_wav_bytes()` inserts 500ms silence before and after each speech segment
2. When diarization is **disabled**, existing behavior is preserved (no silence padding)
3. The silence padding duration is configurable via `DiarizationConfig.segment_silence_padding_ms`
4. Default padding value is 500ms
5. Passing `silence_padding_ms=0` produces identical output to current behavior
6. Unit tests cover all padding scenarios

---

## Current State Evaluation

### Existing Implementation

| Component | File | Role |
|-----------|------|------|
| `ProcessedAudio.get_vad_merged_wav_bytes()` | `apps/stt/src/stt/transcription/dto.py:80-117` | Merges VAD segments into WAV for storage |
| `DiarizationConfig` | `apps/stt/src/stt/pipeline/dto.py:272-285` | Diarization configuration dataclass |
| `BatchTranscriptionService.transcribe()` | `apps/stt/src/stt/transcription/batch_service.py` | Orchestrates full pipeline including diarization check |
| `BlobService.upload_processed_audio()` | `apps/stt/src/stt/storage/blob_service.py:73-119` | Stores merged audio to MinIO |

### Current Merging Behavior

`get_vad_merged_wav_bytes()` extracts speech segments from the full audio array and concatenates them directly via `np.concatenate(merged_parts)` with **zero padding** between segments.

### Existing Padding Mechanisms

- `speech_pad_ms` (30ms default): Applied at VAD detection time for onset/offset capture — unrelated to merge-for-storage
- `_merge_segments()` gap threshold (0.3s): Merges adjacent segments with small gaps — does not add silence

---

## Implementation Plan

### Design Decision

The `silence_padding_ms` parameter is added to `get_vad_merged_wav_bytes()` as an optional argument (default: 0 for backward compatibility). The **caller** decides whether to pass the padding based on `DiarizationConfig.enabled` and `DiarizationConfig.segment_silence_padding_ms`. This keeps the DTO method a pure audio utility without coupling it to pipeline configuration.

### Changes

| # | File | Change |
|---|------|--------|
| 1 | `apps/stt/src/stt/pipeline/dto.py` | Add `segment_silence_padding_ms: int = 500` to `DiarizationConfig` |
| 2 | `apps/stt/src/stt/transcription/dto.py` | Add `silence_padding_ms` param to `get_vad_merged_wav_bytes()` |
| 3 | `apps/stt/tests/unit/test_transcription_dto.py` | Add unit tests for silence padding |
| 4 | E2E test callers | Pass padding when diarization is enabled |

---

## Implementation Summary

### What Was Implemented

When diarization is enabled in a pipeline, 500ms of silence (configurable) is now inserted before and after each VAD speech segment when merging segments into the processed audio for storage. This provides natural gaps between speaker turns, improving playback quality and downstream processing.

### Files Modified

| File | Change |
|------|--------|
| `apps/stt/src/stt/pipeline/dto.py` | Added `segment_silence_padding_ms: int = 500` to `DiarizationConfig` |
| `apps/stt/src/stt/transcription/dto.py` | Added `silence_padding_ms` parameter to `get_vad_merged_wav_bytes()` with silence insertion logic |
| `apps/stt/tests/unit/test_transcription_dto.py` | Added 12 unit tests in `TestVadMergedWavSilencePadding` class |
| `apps/stt/tests/unit/test_pipeline_dto_updates.py` | Added 4 unit tests in `TestDiarizationConfigSilencePadding` class |
| `apps/stt/tests/e2e/test_real_data_transcription.py` | Updated 2 call sites to pass `silence_padding_ms` when diarization is enabled |

### Key Design Decisions

1. **Caller-driven padding**: The `get_vad_merged_wav_bytes()` method accepts `silence_padding_ms` as a parameter (default: 0). The caller checks `diarization.enabled` and passes the value from `DiarizationConfig.segment_silence_padding_ms`. This keeps the DTO method a pure audio utility without coupling to pipeline config.

2. **Backward compatible**: Default `silence_padding_ms=0` preserves existing behaviour exactly. No existing callers break.

3. **Config on DiarizationConfig**: The padding setting lives on `DiarizationConfig` (not `VadConfig`) because it's a diarization-specific enhancement.

### Testing Performed

- 948 unit tests passed, 4 skipped (expected ML-only skips)
- 16 new tests added covering: default/zero padding, single/multiple segments, custom values, edge cases (no VAD, empty segments, non-speech only, 8kHz sample rate), silence region verification

---

## Change History

*(No changes yet — initial implementation.)*
