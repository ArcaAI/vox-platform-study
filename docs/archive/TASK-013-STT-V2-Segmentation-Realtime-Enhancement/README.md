# TASK-013: STT-V2 Segmentation & Near-Real-Time Enhancement

- **Ticket Number**: TASK-013
- **Created Date**: 2026-02-09
- **Last Updated**: 2026-02-09
- **Status**: In Progress

---

## Requirement Analysis

### Description

Enhance STT-V2 audio segmentation and transcription pipeline to meet two distinct operating modes:

1. **Diarization Disabled**: Audio stream must be split into segments using a sliding window under 30 seconds and transcribed to produce near-real-time transcript output.
2. **Diarization Enabled**: Only voice-detected (VAD) audio segments are considered; those segments must be further split into smaller sub-segments using a sliding window under 30 seconds, then transcribed for real-time transcript output.

### Business Context

- Medical consultations can be 10–60+ minutes long; users need incremental transcription feedback, not batch results after the entire file is processed
- Current TTFW (Time To First Word) equals total processing time (~495s for a 640s file), which is unacceptable for near-real-time use
- Text duplication at chunk boundaries degrades transcript quality and downstream NLP processing
- VAD segments longer than 30s are not explicitly sub-split, relying instead on the inference engine's internal chunking — this conflates two distinct concerns

### Acceptance Criteria

1. **Sliding window segmentation** applies to all audio (diarization disabled) or to each VAD segment (diarization enabled) with configurable chunk length (default 15s, max 30s)
2. **VAD segments > chunk_length_s** are explicitly sub-split into overlapping sub-windows before transcription
3. **Chunk overlap de-duplication** eliminates repeated phrases at chunk boundaries
4. **TTFW metric** measures actual time from pipeline start to first transcribed word (not total inference time)
5. **Per-chunk callback** enables callers to receive partial results as each chunk completes
6. **Per-segment results** are included in output metadata for downstream consumers
7. **Word timestamps** use actual Whisper offset tokens instead of proportional estimation
8. **Processed audio upload** is wired into the batch worker when VAD/diarization is enabled
9. All existing tests pass; new unit tests cover all changes

---

## Current State Evaluation

### Existing Architecture

| Component | File | Current Behavior |
|-----------|------|-----------------|
| `_run_optimum_onnx_inference` | `batch_service.py:943-1121` | Sliding window chunking for audio > chunk_length_s, but no overlap dedup |
| `_run_per_segment_inference` | `batch_service.py:485-602` | Per-VAD-segment ASR, but does NOT sub-split long segments |
| `_optimum_single_pass` | `batch_service.py:1123-1182` | Single-pass for short audio, proportional word timestamps |
| TTFW computation | `batch_service.py:170` | Computed after ALL inference, equals total time |
| `transcribe_file` worker | `workers/transcribe_file.py` | No processed audio upload |
| Word timestamps | `batch_service.py:1086-1097` | Proportionally distributed, not actual |

### Key Issues

1. **Text duplication**: Stride overlap (4s left + 2s right) causes repeated phrases — no dedup logic exists
2. **No sub-splitting**: `_run_per_segment_inference` passes full segment to `_run_inference`, which internally chunks but without explicit control
3. **TTFW misleading**: Always equals total inference time
4. **No incremental output**: All results accumulated, returned as batch
5. **Estimated timestamps**: Word positions are evenly distributed, not from Whisper tokens

### E2E Evidence

- **640s EN audio (VAD disabled)**: TTFW = 494.92s (should be ~15-30s for first chunk)
- **107s ML audio (VAD disabled)**: TTFW = 108.76s (same as total)
- **EN output text**: Visible phrase duplication throughout transcript

---

## Implementation Plan

### Phase 1: Fix Critical Issues (Accuracy)

#### 1.1 — VAD Segment Sub-Splitting

Add explicit sliding window sub-splitting in `_run_per_segment_inference` for VAD segments longer than `chunk_length_s`.

**Files**: `batch_service.py`
**Approach**: Before calling `_run_inference` on a segment, check if `segment.duration > chunk_length_s`. If so, split into overlapping sub-windows and transcribe each, then merge with dedup.

#### 1.2 — Chunk Overlap De-Duplication

Implement text de-duplication at chunk boundaries to eliminate repeated phrases caused by stride overlap.

**Files**: `batch_service.py`
**Approach**: Compare trailing words of chunk N with leading words of chunk N+1. Remove overlapping words using longest common subsequence matching.

#### 1.3 — Fix TTFW Metric

Compute TTFW from pipeline start to when the first chunk/segment produces text.

**Files**: `batch_service.py`
**Approach**: Record `first_word_time` when first non-empty chunk result is produced, use that for `timing.ttfw_seconds`.

### Phase 2: Enable Near-Real-Time Output

#### 2.1 — Per-Chunk Callback

Add an optional `chunk_callback` parameter to emit partial results as each chunk completes transcription.

**Files**: `batch_service.py`, `dto.py`
**Approach**: Define `ChunkResult` dataclass; pass callback through inference methods; call it after each chunk.

#### 2.2 — Per-Segment Results in Metadata

Include per-segment transcription details in the output metadata for downstream consumers.

**Files**: `batch_service.py`

### Phase 3: Quality Improvements

#### 3.1 — Word Timestamp Accuracy

Use `processor.decode(output_offsets=True)` for per-chunk decoding to get actual Whisper timestamp tokens.

**Files**: `batch_service.py`

#### 3.2 — Processed Audio Upload

Wire `get_vad_merged_wav_bytes()` into `transcribe_file` worker when VAD/diarization is active.

**Files**: `workers/transcribe_file.py`

---

## Implementation Summary

### What Was Implemented

All three phases have been completed, addressing both diarization-disabled and diarization-enabled paths to meet the near-real-time transcription requirements.

### Files Modified

| File | Change |
|------|--------|
| `apps/stt-v2/src/stt_v2/transcription/dto.py` | Added `ChunkTranscriptionResult` dataclass for per-chunk partial results |
| `apps/stt-v2/src/stt_v2/transcription/batch_service.py` | Major refactoring: added `_dedup_overlap()`, sub-splitting for long VAD segments, `chunk_callback`/`first_word_hook` plumbing, TTFW fix, `output_offsets` for word timestamps, per-segment results in metadata |
| `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py` | Wired `upload_processed_audio()` when VAD/diarization is enabled |
| `apps/stt-v2/tests/unit/test_batch_service.py` | Added 23 new unit tests: `TestDedupOverlap` (11), `TestChunkCallbackAndTTFW` (3), `TestPerSegmentSubSplitting` (3), `TestChunkTranscriptionResult` (3), updated 2 existing tests for dedup compatibility |
| `apps/stt-v2/tests/e2e/test_real_data_transcription.py` | Updated `_run_transcription` to capture chunk results via `chunk_callback` |

### Key Design Decisions

1. **Sub-splitting in `_run_per_segment_inference`**: When a VAD segment exceeds `chunk_length_s`, it is explicitly split into overlapping sub-windows using the same stride configuration as the full-audio chunked path. This ensures consistent behavior between diarization-enabled and diarization-disabled paths.

2. **Dedup via longest suffix-prefix match**: `_dedup_overlap()` compares the trailing words of chunk N with leading words of chunk N+1 (case-insensitive, punctuation-insensitive). This eliminates the text duplication caused by stride overlap without requiring alignment with audio boundaries.

3. **TTFW measured at first non-empty text**: Instead of recording TTFW after all inference completes, a `first_word_hook` closure fires exactly once when the first chunk produces text. This gives a meaningful TTFW metric (e.g., ~15s instead of ~495s for a 640s file).

4. **Caller-driven callbacks**: `chunk_callback` and `first_word_hook` are optional parameters, preserving full backward compatibility. Existing callers that don't pass these callbacks see no behavior change.

5. **Word timestamps via `output_offsets`**: The `_optimum_single_pass` and `_run_optimum_onnx_inference` methods now attempt `processor.decode(output_offsets=True)` first for actual Whisper timestamp tokens, falling back to proportional estimation only when offsets are unavailable.

6. **Processed audio upload**: The `transcribe_file` worker now uploads VAD-merged audio (with diarization silence padding when applicable) to MinIO alongside the transcript, using the existing `upload_processed_audio` method.

### Testing Performed

- **968 passed, 4 skipped** (expected ML-only skips)
- 23 new unit tests added
- 2 existing tests updated for dedup compatibility
- E2E test infrastructure updated to capture chunk results

---

## Change History

*(No changes yet — initial implementation.)*
