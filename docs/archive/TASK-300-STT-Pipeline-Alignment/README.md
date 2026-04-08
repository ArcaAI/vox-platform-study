# TASK-300: Align STT-v2 Pipelines to Canonical Order

| Field | Value |
|-------|-------|
| Ticket | TASK-300 |
| Created | 2026-04-01 |
| Updated | 2026-04-01 |
| Status | Completed |
| Type | refactor |

---

## 1. Requirement Analysis

### Description

Both STT-v2 batch and streaming transcription pipelines deviate from the canonical pipeline order. This task aligns them strictly to the following sequence, fixing all identified gaps. Every code block must be annotated with a comment indicating its pipeline step.

### Target Pipeline Order

```
Preprocessor (normalize, resample)
  -> 1. Noise Suppression (RNNoise)
  -> 2. VAD (Silero)
  -> 3. Speaker Embedding (pyannote) -- SEPARATE step before ASR
  -> 4. ASR Transcription
  -> 5. Speaker Diarization
  -> 6. Store Audio to MinIO -- BEFORE postprocessor
  -> Postprocessor (timestamps, punctuation)
```

### Business Context

Pipeline ordering consistency ensures:
- Noise suppression improves VAD accuracy (denoise before VAD)
- Speaker embeddings are available before ASR for downstream consumers
- Audio artifacts are stored before any post-processing for auditability
- Punctuation restoration improves streaming transcript quality

### Acceptance Criteria

1. Both pipelines execute steps in exact order: Preprocessor -> Denoise -> VAD -> Embedding -> ASR -> Diarization -> MinIO -> Postprocessor
2. All 5 streaming gaps (S1-S5) and 2 batch gaps (B1-B2) resolved
3. All new and existing tests pass
4. Each pipeline step annotated with a comment (e.g., `# Step 1: Noise Suppression (RNNoise)`)
5. Full TDD: red-green-refactor for each step

---

## 2. Current State Evaluation

### Batch Pipeline (batch_service.py, preprocessing.py, transcribe_file.py)

| Step | Expected | Actual | Status |
|------|----------|--------|--------|
| Preprocessor | normalize, resample | normalize -> denoise -> resample | OK |
| 1. Noise Suppression | RNNoise | RNNoise at 48kHz inside preprocessor | OK |
| 2. VAD | Silero | Silero (pipeline model first, singleton fallback) | OK |
| 3. Speaker Embedding | Separate step before ASR | Combined inside `diarize_segments()` Phase 2, runs AFTER ASR | **MISMATCH (B1)** |
| 4. ASR Transcription | After embedding | After VAD | OK |
| 5. Speaker Diarization | After ASR | After ASR, includes embedding internally | OK |
| 6. Store Audio to MinIO | Before postprocessor | After postprocessor in transcribe_file.py | **MISMATCH (B2)** |
| Postprocessor | timestamps, punctuation | timestamps, punctuation | OK |

### Streaming Pipeline (session_manager.py, preprocessor.py, inference.py)

| Step | Expected | Actual | Status |
|------|----------|--------|--------|
| Preprocessor | normalize, resample | int16->float32 only | **MISSING (S1)** |
| 1. Noise Suppression | RNNoise | Not implemented | **MISSING (S2)** |
| 2. VAD | Silero per-frame | Silero per-frame (512 samples/32ms) | OK |
| 3. Speaker Embedding | Separate step before ASR | Combined with diarization in `_identify_speaker()` | **MISMATCH (S3)** |
| 4. ASR Transcription | After embedding | Per-utterance ASR | OK |
| 5. Speaker Diarization | After ASR | Per-utterance `_identify_speaker()` after ASR | OK |
| 6. Store Audio to MinIO | Before postprocessor | Only at session finalization + periodic snapshots | **DIFFERENT (S4)** |
| Postprocessor | timestamps, punctuation | Timestamps from ASR, no punctuation | **MISSING (S5)** |

### Gap Summary

| Gap | Pipeline | Severity | Description |
|-----|----------|----------|-------------|
| B1 | Batch | Medium | Speaker embedding combined inside diarization, not separate before ASR |
| B2 | Batch | Low | MinIO storage after postprocessor instead of before |
| S1 | Streaming | Medium | No normalize/resample in StreamingPreprocessor |
| S2 | Streaming | High | No RNNoise noise suppression in streaming |
| S3 | Streaming | Medium | Embedding combined with diarization |
| S4 | Streaming | Low | MinIO storage deferred to finalization |
| S5 | Streaming | Medium | No punctuation restoration in streaming |

---

## 3. Implementation Plan

### Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| New `diarize_with_embeddings()` on `SpeakerIdentifier` | Backward-compatible: existing `diarize_segments()` still works. New method accepts precomputed embeddings and only does Qdrant lookup (Phase 3). |
| New `identify_with_embedding()` on `SpeakerIdentifier` | Single-segment variant for streaming: skips extraction, only does Qdrant search. |
| New `StreamingDenoiser` class in `streaming/denoiser.py` | Persistent RNNoise session + 48kHz ring buffer is complex enough to warrant its own testable unit. |
| Embedding attached to `AudioUtterance` | Avoids parallel data structures; embedding travels with utterance through queue. |
| Causal peak-tracking normalization | Streaming cannot look ahead. Exponential decay tracks peak amplitude in real-time. |
| Modified snapshot loop for processed audio | Less disruptive than per-utterance MinIO uploads. Async, handles failures gracefully. |

### Phase A: Interface Foundations

#### A1 -- `SpeakerIdentifier` interface extension

**File**: `apps/stt-v2/src/stt_v2/diarization/speaker_identifier.py` (MODIFY)

Add two new methods:

1. `diarize_with_embeddings(embeddings, segments, tenant_id, ...) -> DiarizationResult`
   - Accepts precomputed `list[SpeakerEmbedding | None]`
   - Performs **only** Phase 3: Qdrant lookup + match/register per embedding
   - Same match/register logic as existing Phase 3 in `diarize_segments()`
   - Existing `diarize_segments()` refactored to: Phase 1 (classify) -> Phase 2 (extract_batch) -> delegate to `diarize_with_embeddings()` for Phase 3

2. `identify_with_embedding(embedding, tenant_id, ...) -> SpeakerIdentification`
   - Single-segment variant for streaming
   - Accepts one `SpeakerEmbedding`, does Qdrant search only
   - Same logic as `identify_speaker()` Phase 2+3 but skips Phase 1 (extraction)

**Tests** (TDD):
- `tests/unit/test_speaker_identifier_precomputed.py`
  - `test_diarize_with_embeddings_known_speaker` -- mock Qdrant returns match
  - `test_diarize_with_embeddings_new_speaker` -- mock Qdrant returns no match, auto-register
  - `test_diarize_with_embeddings_max_speakers_enforced` -- limit reached, unknown assigned
  - `test_diarize_with_embeddings_none_embedding_skipped`
  - `test_identify_with_embedding_known_speaker`
  - `test_identify_with_embedding_no_match_auto_register`
  - `test_diarize_segments_delegates_to_new_method` -- regression, same results

#### A2 -- New `StreamingDenoiser` class

**File**: `apps/stt-v2/src/stt_v2/streaming/denoiser.py` (CREATE)

Persistent RNNoise session with 48kHz ring buffer for frame-by-frame streaming.

Design:
- `__init__(input_sr=16000, strength=1.0)` -- sample rate and blend strength
- `initialize() -> bool` -- creates `pyrnnoise.RNNoise` instance, returns False if unavailable
- `process(frame_16k: np.ndarray) -> np.ndarray` -- denoise one frame:
  1. Upsample 16kHz -> 48kHz (3x linear interpolation)
  2. Append to 48kHz ring buffer
  3. Drain complete 480-sample chunks through RNNoise
  4. Downsample denoised output 48kHz -> 16kHz
  5. Blend with original based on `strength`
- `reset()` -- clear ring buffer, recreate RNNoise instance

Latency analysis:
- 512 samples at 16kHz = 32ms audio
- Upsample to 48kHz = 1536 samples
- 1536 / 480 = 3.2 RNNoise frames (process 3, carry 96 samples)
- RNNoise per frame: ~0.1ms on CPU
- Total added latency: ~1-2ms compute, 0 additional frame delay

**Tests** (TDD):
- `tests/unit/streaming/test_streaming_denoiser.py`
  - `test_process_returns_correct_size_frame`
  - `test_strength_zero_passthrough`
  - `test_strength_one_full_denoise`
  - `test_ring_buffer_drains_across_multiple_calls`
  - `test_graceful_fallback_pyrnnoise_missing`
  - `test_initialize_returns_false_without_pyrnnoise`
  - `test_reset_clears_state`

---

### Phase B: Batch Pipeline Reordering

#### B1 -- Separate embedding from diarization in `batch_service.py`

**File**: `apps/stt-v2/src/stt_v2/transcription/batch_service.py` (MODIFY)

Current order in `transcribe()`:
```
Step 1: Load models
Step 2: Preprocess (normalize, denoise, resample, VAD)
Step 3: ASR inference
Step 4: Diarization (embed + identify combined)
Step 5: Postprocess
```

New order:
```
Step 1: Load models
Step 2: Preprocess (normalize, denoise, resample, VAD)
Step 2b: Extract speaker embeddings from VAD segments  <-- NEW
Step 3: ASR inference
Step 4: Diarization (identify only, using precomputed embeddings)  <-- MODIFIED
Step 5: Store to MinIO  <-- MOVED (see B2)
Step 6: Postprocess
```

Changes:
1. Add new Step 2b between preprocessing and ASR:
   - If diarization enabled + tenant_id present + VAD segments available:
   - Split VAD segments at 5s max window (new static helper `_split_vad_segments_for_embedding()`)
   - Collect audio arrays for each split segment
   - Call `EmbeddingService.extract_batch()` to get embeddings
   - Store embeddings + segment metadata for Step 4
   - Track `timing.embedding_seconds`

2. Modify Step 4 to use precomputed embeddings:
   - Call `identifier.diarize_with_embeddings()` instead of `_run_diarization()`
   - Project speaker IDs onto ASR segments by time overlap

3. Add helper: `_split_vad_segments_for_embedding(segments, max_window_s=5.0)`
   - Splits long VAD segments into <= 5s chunks for embedding quality

4. Add `embedding_seconds` field to `TimingMetrics` dataclass in `transcription/dto.py`

**Tests** (TDD):
- `tests/unit/transcription/test_batch_embedding_separation.py`
  - `test_split_vad_segments_short_segments_unchanged`
  - `test_split_vad_segments_long_segment_split_at_5s`
  - `test_split_vad_segments_non_speech_skipped`
  - `test_transcribe_extracts_embeddings_before_asr` -- mock services, verify call order
  - `test_transcribe_no_diarization_skips_embedding`

#### B2 -- Move MinIO storage before postprocessor

**File**: `apps/stt-v2/src/stt_v2/transcription/batch_service.py` (MODIFY)
**File**: `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py` (MODIFY)

The key insight: `batch_service.transcribe()` must return an intermediate result that allows the worker to upload BEFORE postprocessing.

Approach: Split the `transcribe()` method's steps so that MinIO upload can happen between diarization and postprocessing. Add an optional `blob_service` parameter to `transcribe()`, or restructure the return to provide raw results.

**Option chosen**: Add MinIO upload step inside `batch_service.transcribe()` between diarization and postprocessing. Pass `BlobService` and upload params as optional kwargs.

In `transcribe()`:
```python
# Step 5 (was not present): Store Audio to MinIO
if blob_service and tenant_id:
    # Upload processed audio (post-denoise, post-VAD)
    # Upload raw transcript snapshot (pre-postprocessing)

# Step 6 (was Step 5): Postprocess
result = self._postprocess(raw_result, spec.postprocessing, ...)
```

In `transcribe_file.py`:
- Pass `blob_service` to `batch_service.transcribe()`
- Move audio upload initialization earlier
- Keep final transcript upload after postprocessing (the final formatted transcript is still useful)

**Tests** (TDD):
- `tests/unit/transcription/test_batch_minio_ordering.py`
  - `test_minio_upload_called_before_postprocess` -- mock blob_service, verify call order
  - `test_minio_upload_skipped_when_no_blob_service`
  - `test_final_transcript_still_uploaded_after_postprocess`

---

### Phase C: Streaming Preprocessor Redesign

#### S1 -- Add normalize + resample to `StreamingPreprocessor`

**File**: `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` (MODIFY)

Add new `__init__` parameters:
- `target_sample_rate: int = 16000` -- from `PreprocessingConfig.target_sample_rate`
- `normalize: bool = False` -- from `PreprocessingConfig.normalize`
- `denoiser: StreamingDenoiser | None = None` -- wired from S2

Add causal normalization method:
```python
def _normalize_frame(self, frame: np.ndarray) -> np.ndarray:
    """Peak-tracking normalization with exponential decay (causal)."""
    frame_peak = float(np.abs(frame).max()) if len(frame) > 0 else 0.0
    if frame_peak > self._peak_tracker:
        self._peak_tracker = frame_peak  # fast attack
    else:
        self._peak_tracker *= self._peak_decay  # slow decay
    if self._peak_tracker > 1e-6:
        return frame / self._peak_tracker
    return frame
```

Add resample method:
```python
def _resample_frame(self, frame: np.ndarray) -> np.ndarray:
    """Resample single frame from sample_rate to target_sample_rate."""
    if self.sample_rate == self._target_sr:
        return frame
    ratio = self._target_sr / self.sample_rate
    n_out = int(len(frame) * ratio)
    indices = np.linspace(0, len(frame) - 1, n_out)
    return np.interp(indices, np.arange(len(frame)), frame).astype(np.float32)
```

Modify `feed()` inner loop to apply stages in order:
```python
frame_f32 = frame_int16.astype(np.float32) / 32768.0
# Preprocessor: Normalize
if self._normalize:
    frame_f32 = self._normalize_frame(frame_f32)
# Step 1: Noise Suppression (RNNoise)
if self._denoiser is not None:
    frame_f32 = self._denoiser.process(frame_f32)
# Preprocessor: Resample
frame_f32 = self._resample_frame(frame_f32)
# Step 2: VAD (Silero)
prob = self._run_vad(frame_f32)
```

Also update `__init__` state:
- `self._peak_tracker = 0.0001`
- `self._peak_decay = 0.9997`
- `self._processed_samples: list[np.ndarray] = []` -- for S4

Wire in `session_manager.py` `create_session()`:
```python
preprocessor = StreamingPreprocessor(
    session_id=session_id,
    sample_rate=sample_rate,
    target_sample_rate=pipeline_config.preprocessing.target_sample_rate if pipeline_config else sample_rate,
    normalize=pipeline_config.preprocessing.normalize if pipeline_config else False,
    denoiser=denoiser,  # from S2
    vad_service=vad_service,
    **vad_kwargs,
)
```

**Tests** (TDD):
- `tests/unit/streaming/test_preprocessor_normalize_resample.py`
  - `test_normalize_frame_silence_no_crash`
  - `test_normalize_frame_loud_signal_normalized`
  - `test_normalize_frame_peak_decay`
  - `test_resample_frame_identity_no_change`
  - `test_resample_frame_8k_to_16k`
  - `test_feed_applies_normalize_before_vad`
  - `test_feed_applies_resample_before_vad`
  - `test_feed_without_normalize_no_change`

#### S2 -- Wire StreamingDenoiser into preprocessor

**File**: `apps/stt-v2/src/stt_v2/streaming/session_manager.py` (MODIFY)

In `create_session()`, after loading VAD:
```python
# Step 1: Noise Suppression setup
denoiser = None
denoise_enabled = (
    (pipeline_config and pipeline_config.preprocessing.denoise.enabled)
    or self._profile.denoise_enabled_default
)
if denoise_enabled:
    from stt_v2.streaming.denoiser import StreamingDenoiser
    strength = (
        pipeline_config.preprocessing.denoise.strength
        if pipeline_config
        else 1.0
    )
    denoiser = StreamingDenoiser(input_sr=sample_rate, strength=strength)
    if not denoiser.initialize():
        denoiser = None  # pyrnnoise unavailable, degrade gracefully
```

**Tests** (TDD):
- `tests/unit/streaming/test_session_manager_denoise_wiring.py`
  - `test_create_session_denoise_enabled_wires_denoiser`
  - `test_create_session_denoise_disabled_no_denoiser`
  - `test_create_session_pyrnnoise_missing_degrades_gracefully`

---

### Phase D: Streaming Pipeline Completion

#### S3 -- Separate embedding before ASR in streaming inference

**File**: `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` (MODIFY) -- add `embedding` field to `AudioUtterance`
**File**: `apps/stt-v2/src/stt_v2/streaming/inference.py` (MODIFY) -- restructure `process_utterance()`

Add to `AudioUtterance`:
```python
embedding: Any = None  # SpeakerEmbedding | None
```

Restructure `process_utterance()` to strict pipeline order:
```python
async def process_utterance(self, session_id, utterance) -> SegmentResult:
    # Step 3: Speaker Embedding (pyannote) -- BEFORE ASR
    embedding = await self._extract_embedding(utterance)

    # Step 4: ASR Transcription
    inference_out = await self._run_inference(utterance)
    text = self._sanitize_text(inference_out.text)
    word_timestamps = self._offset_word_timestamps(...)

    # Step 5: Speaker Diarization (Qdrant lookup with precomputed embedding)
    speaker_id, confidence = await self._identify_with_embedding(embedding, text)

    result = SegmentResult(text=text, ...)
    # ... assign speaker ...

    # Step 6: Store Audio to MinIO
    # (handled by snapshot loop with processed audio buffer -- see S4)

    # Postprocessor: Punctuation restoration
    if text.strip():
        text = await self._apply_punctuation(text)
        result.text = text

    # Publish to Redis
    if self._publisher:
        await self._publisher.publish(result)
    return result
```

New methods:
- `_extract_embedding(utterance) -> SpeakerEmbedding | None`
  - Guard: diarization disabled, no tenant_id, duration too short -> return None
  - Call `get_embedding_service().extract_from_samples()` with 5s max window
- `_identify_with_embedding(embedding, text) -> (str|None, float|None)`
  - Guard: no embedding, empty text -> return None
  - Call `get_speaker_identifier().identify_with_embedding()`

Remove old `_identify_speaker()` method.

**Tests** (TDD):
- `tests/unit/streaming/test_inference_embedding_separation.py`
  - `test_extract_embedding_called_before_asr` -- verify call order via mock
  - `test_extract_embedding_diarization_disabled_returns_none`
  - `test_extract_embedding_short_utterance_returns_none`
  - `test_identify_with_embedding_known_speaker`
  - `test_identify_with_embedding_no_embedding_returns_none`
  - `test_process_utterance_full_pipeline_order` -- verify: embed -> asr -> diarize -> punctuate

#### S4 -- Upload processed audio via snapshot loop

**File**: `apps/stt-v2/src/stt_v2/streaming/session.py` (MODIFY)
**File**: `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` (MODIFY)
**File**: `apps/stt-v2/src/stt_v2/streaming/session_manager.py` (MODIFY)

Add to `StreamSession`:
```python
self.processed_audio_buffer: bytearray = bytearray()
self._denoise_active: bool = False
```

Add to `StreamingPreprocessor`:
```python
def drain_processed_samples(self) -> bytes:
    """Drain accumulated denoised samples as int16 PCM bytes."""
    if not self._processed_samples:
        return b""
    samples = np.concatenate(self._processed_samples)
    self._processed_samples.clear()
    return (samples * 32767).clip(-32768, 32767).astype(np.int16).tobytes()

@property
def has_denoiser(self) -> bool:
    return self._denoiser is not None
```

In `feed()`, after denoise + resample, before VAD:
```python
if self._denoiser is not None:
    self._processed_samples.append(frame_f32.copy())
```

In `_make_frame_handler`:
```python
if preprocessor is not None:
    utterances = await preprocessor.feed(frame.data)
    # Step 6: Collect processed audio for MinIO upload
    if preprocessor.has_denoiser:
        processed_pcm = preprocessor.drain_processed_samples()
        session.processed_audio_buffer.extend(processed_pcm)
        session._denoise_active = True
```

In `_upload_snapshot`:
- Prefer `session.processed_audio_buffer` when `session._denoise_active`
- Track separate offset for processed buffer

In `_finalize_session`:
- Use processed buffer for `encode_wav()` when denoise was active

**Tests** (TDD):
- `tests/unit/streaming/test_preprocessor_processed_buffer.py`
  - `test_drain_processed_samples_returns_pcm_bytes`
  - `test_drain_processed_samples_empty_returns_empty`
  - `test_has_denoiser_true_when_denoiser_set`
- `tests/unit/streaming/test_snapshot_processed_audio.py`
  - `test_snapshot_uses_processed_buffer_when_denoise_active`
  - `test_snapshot_uses_raw_buffer_when_denoise_inactive`

#### S5 -- Add punctuation restoration to streaming

**File**: `apps/stt-v2/src/stt_v2/streaming/inference.py` (MODIFY)
**File**: `apps/stt-v2/src/stt_v2/streaming/session_manager.py` (MODIFY)

Add `punctuation_config` parameter to `StreamingInferenceWorker.__init__()`:
```python
def __init__(self, ..., punctuation_config: PunctuationConfig | None = None):
    self._punctuation_config = punctuation_config
    self._punctuation_model = None  # lazy-loaded
```

Add `_apply_punctuation` method:
```python
async def _apply_punctuation(self, text: str) -> str:
    """Postprocessor: Punctuation restoration."""
    if not self._punctuation_config or not self._punctuation_config.enabled:
        return text
    if not text.strip():
        return text
    try:
        if self._punctuation_model is None:
            from deepmultilingualpunctuation import PunctuationModel
            model_id = self._punctuation_config.model or "kredor/punctuate-all"
            self._punctuation_model = PunctuationModel(model=model_id)
        result = await asyncio.to_thread(
            self._punctuation_model.restore_punctuation, text
        )
        return result
    except Exception as exc:
        logger.warning("Punctuation restoration failed", error=str(exc))
        return text
```

Wire in `session_manager.py` `create_session()`:
```python
punctuation_config = (
    pipeline_config.postprocessing.punctuation
    if pipeline_config and pipeline_config.postprocessing.punctuation.enabled
    else None
)
inference_worker = StreamingInferenceWorker(
    ...,
    punctuation_config=punctuation_config,
)
```

**Tests** (TDD):
- `tests/unit/streaming/test_inference_punctuation.py`
  - `test_apply_punctuation_enabled_restores_punctuation` -- mock PunctuationModel
  - `test_apply_punctuation_disabled_returns_unchanged`
  - `test_apply_punctuation_empty_text_returns_empty`
  - `test_apply_punctuation_model_failure_returns_original`
  - `test_apply_punctuation_lazy_loads_model`

---

## 4. File Change Summary

### Files to Modify

| File | Operation | Gap(s) | Description |
|------|-----------|--------|-------------|
| `apps/stt-v2/src/stt_v2/diarization/speaker_identifier.py` | MODIFY | A1 (B1, S3) | Add `diarize_with_embeddings()`, `identify_with_embedding()`; refactor `diarize_segments()` |
| `apps/stt-v2/src/stt_v2/transcription/batch_service.py` | MODIFY | B1, B2 | Add Step 2b (embedding extraction), reorder Step 5/6 (MinIO before postprocess) |
| `apps/stt-v2/src/stt_v2/transcription/workers/transcribe_file.py` | MODIFY | B2 | Restructure upload timing |
| `apps/stt-v2/src/stt_v2/transcription/dto.py` | MODIFY | B1 | Add `embedding_seconds` to `TimingMetrics` |
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | MODIFY | S1, S2, S4 | Add normalize, resample, denoiser integration, processed buffer |
| `apps/stt-v2/src/stt_v2/streaming/inference.py` | MODIFY | S3, S5 | Restructure `process_utterance()` order; add embedding + punctuation |
| `apps/stt-v2/src/stt_v2/streaming/session.py` | MODIFY | S4 | Add `processed_audio_buffer`, `_denoise_active` |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | MODIFY | S2, S4, S5 | Wire denoiser, processed audio buffer, punctuation config |

### Files to Create

| File | Gap(s) | Description |
|------|--------|-------------|
| `apps/stt-v2/src/stt_v2/streaming/denoiser.py` | A2 (S2) | `StreamingDenoiser` -- persistent RNNoise session with 48kHz ring buffer |

### New Test Files

| Test File | Framework | Gap(s) |
|-----------|-----------|--------|
| `tests/unit/test_speaker_identifier_precomputed.py` | pytest | A1 |
| `tests/unit/streaming/test_streaming_denoiser.py` | pytest | A2 |
| `tests/unit/transcription/test_batch_embedding_separation.py` | pytest | B1 |
| `tests/unit/transcription/test_batch_minio_ordering.py` | pytest | B2 |
| `tests/unit/streaming/test_preprocessor_normalize_resample.py` | pytest | S1 |
| `tests/unit/streaming/test_session_manager_denoise_wiring.py` | pytest | S2 |
| `tests/unit/streaming/test_inference_embedding_separation.py` | pytest | S3 |
| `tests/unit/streaming/test_preprocessor_processed_buffer.py` | pytest | S4 |
| `tests/unit/streaming/test_snapshot_processed_audio.py` | pytest | S4 |
| `tests/unit/streaming/test_inference_punctuation.py` | pytest | S5 |

### Files Unchanged (Reference Only)

| File | Reason |
|------|--------|
| `apps/stt-v2/src/stt_v2/transcription/preprocessing.py` | Reference implementation for RNNoise -- no changes |
| `apps/stt-v2/src/stt_v2/diarization/embedding_service.py` | Already has `extract_from_samples()`, `extract_batch()` -- no changes |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py` | `PreprocessingConfig`, `PunctuationConfig` already defined -- no changes |
| `apps/stt-v2/src/stt_v2/streaming/execution_profile.py` | `denoise_enabled_default` already exists -- no changes |

---

## 5. Implementation Order

| Order | Phase | Gap | Description | Dependencies |
|-------|-------|-----|-------------|--------------|
| 1 | A1 | B1, S3 | `SpeakerIdentifier` interface extensions | None |
| 2 | A2 | S2 | `StreamingDenoiser` class | None |
| 3 | B2 | B2 | Move MinIO storage before postprocessor (batch) | None |
| 4 | B1 | B1 | Separate embedding step in batch | A1 |
| 5 | S1 | S1 | Add normalize + resample to streaming preprocessor | None |
| 6 | S2 | S2 | Wire StreamingDenoiser into session_manager | A2, S1 |
| 7 | S3 | S3 | Separate embedding in streaming inference | A1 |
| 8 | S4 | S4 | Processed audio buffer + snapshot loop | S1, S2 |
| 9 | S5 | S5 | Punctuation restoration in streaming | None (logically last) |

---

## 6. Risks and Mitigation

| Risk | Severity | Mitigation |
|------|----------|------------|
| Streaming RNNoise latency too high for real-time | Medium | Feature flag via `denoise_enabled_default`. CPU profile already disables. Measured: ~1-2ms compute per 32ms frame = <10% overhead. |
| Embedding quality degrades on VAD-only segments | Medium | 5s max-window split ensures speaker-homogeneous windows. A/B test against current results. |
| pyrnnoise not installed on all environments | Low | Graceful fallback: `StreamingDenoiser.initialize()` returns False, denoiser set to None. |
| Punctuation model adds latency to streaming | Low | Lazy-loaded, runs in `asyncio.to_thread()`. Expected ~10-30ms per utterance. |
| `processed_audio_buffer` doubles memory for streaming sessions | Low | 30-min session at 16kHz mono = ~57MB additional. Within existing `_max_audio_buffer_bytes` budget. |
| Resample artifacts at frame boundaries | Low | Linear interpolation is sufficient for VAD/ASR input quality. Higher-quality resampler (`soxr`) can be used if needed. |

---

## 7. Verification Criteria

Per-phase verification gates:

| Phase | Verification |
|-------|-------------|
| A1 | `pytest tests/unit/test_speaker_identifier_precomputed.py` passes. Existing `test_diarization.py` still passes (regression). |
| A2 | `pytest tests/unit/streaming/test_streaming_denoiser.py` passes. |
| B1 | `pytest tests/unit/transcription/test_batch_embedding_separation.py` passes. Existing `test_preprocessing.py` still passes. |
| B2 | `pytest tests/unit/transcription/test_batch_minio_ordering.py` passes. Existing `test_transcribe_file_pubsub.py` still passes. |
| S1 | `pytest tests/unit/streaming/test_preprocessor_normalize_resample.py` passes. Existing streaming preprocessor tests still pass. |
| S2 | `pytest tests/unit/streaming/test_session_manager_denoise_wiring.py` passes. |
| S3 | `pytest tests/unit/streaming/test_inference_embedding_separation.py` passes. Existing `test_streaming_inference.py` still passes. |
| S4 | `pytest tests/unit/streaming/test_preprocessor_processed_buffer.py && pytest tests/unit/streaming/test_snapshot_processed_audio.py` passes. |
| S5 | `pytest tests/unit/streaming/test_inference_punctuation.py` passes. |
| Final | Full test suite: `cd apps/stt-v2 && python -m pytest tests/` passes. |

---

## Implementation Summary

_To be filled after implementation._

## Change History

_To be filled after subsequent fixes._
