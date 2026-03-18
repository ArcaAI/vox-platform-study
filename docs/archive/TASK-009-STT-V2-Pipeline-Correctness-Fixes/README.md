# TASK-009: STT-V2 Transcription Pipeline Correctness & Latency Metrics

- **Ticket**: TASK-009
- **Created**: 2026-02-08
- **Last Updated**: 2026-02-08
- **Status**: Completed
- **Parent**: TASK-007 (STT-V2 Worker Architecture Refactor), TASK-008 (VAD & Diarization Fixes)

## Requirement Analysis

Code review of the STT-V2 transcription pipeline (TASK-007/008 deliverables) identified **4 critical issues** and **2 important recommendations** that prevent the pipeline from meeting its stated design goals. The pipeline must follow a specific processing order, handle audio sample rates correctly for each model, process ASR per-segment when VAD is enabled, and collect latency metrics for observability.

### Problem Statement

1. **Pipeline Order**: Denoising runs *after* VAD in `preprocessing.py`. RNNoise should operate on the full audio *before* VAD so that speech boundary detection works on cleaner audio.
2. **RNNoise Sample Rate**: The `_apply_denoise()` implementation treats the denoise model as a generic PyTorch model. RNNoise specifically requires **48 kHz** input (480 samples per 10ms frame). The current pipeline resamples to 16 kHz *before* denoising, which is incorrect.
3. **Full-Audio ASR**: In `batch_service.py`, `_run_inference()` receives the *entire* `processed.samples` array, not individual VAD segments. When VAD is enabled, the user requirement is to transcribe each detected speech segment independently for better accuracy and per-segment timing.
4. **No Latency Metrics**: Only total `processing_time_seconds` is captured. There is no Time To First Word (TTFW), per-pipeline-step breakdown, or per-segment latency when diarization is enabled.
5. **Wasted VAD Fallback**: In `batch_service.py`, the VAD fallback for diarization computes `vad_result.segments` but discards the result — diarization still uses less accurate ASR segments from `raw_result.segments`.
6. **E2E Test Gaps**: Tests only verify total `processing_time_seconds` but lack assertions for the new latency metrics.

### Acceptance Criteria

- [ ] Preprocessing order is: Load → Resample to 16kHz → Mono → Normalize → **Denoise (48kHz round-trip)** → **VAD**
- [ ] RNNoise denoising upsamples to 48kHz, processes via `pyrnnoise`, and downsamples back to target_sample_rate
- [ ] When VAD produces segments, ASR runs per-segment and results are combined into a single `RawTranscription`
- [ ] `TranscriptionResult.metadata` contains `timing` dict with: `ttfw_seconds`, `preprocessing_seconds`, `inference_seconds`, `diarization_seconds`, per-segment latency array
- [ ] VAD fallback segments in diarization step are actually used (not discarded)
- [ ] E2E tests verify timing metrics exist and are within reasonable bounds
- [ ] `pyrnnoise` added to `[ml]` dependencies in `pyproject.toml`
- [ ] All existing unit tests continue to pass (810+)
- [ ] New unit tests cover: denoise pipeline order, RNNoise sample rate handling, per-segment ASR, timing metrics

---

## Current State Evaluation

### What Works Correctly
- VAD model priority (pipeline-defined first, Silero fallback) — fixed in TASK-008
- Pipeline YAML parsing for `models.diarization` — fixed in TASK-008
- Batch embedding extraction with in-memory tensors — fixed in TASK-008
- `max_speakers` enforcement — fixed in TASK-008
- VAD end-padding — fixed in TASK-008
- MinIO storage for raw audio, processed audio, and transcripts — working
- E2E test infrastructure (test MinIO, Qdrant, model loading) — working

### What's Broken or Missing

| # | Issue | Severity | Module | Line(s) |
|---|-------|----------|--------|---------|
| 1 | Denoise runs AFTER VAD (should be before) | Critical | `preprocessing.py` | L72–86 |
| 2 | RNNoise requires 48kHz but receives 16kHz | Critical | `preprocessing.py` | L302–342 |
| 3 | ASR runs on full audio instead of per-segment | Critical | `batch_service.py` | L127–135 |
| 4 | No TTFW or per-step timing metrics | Critical | `batch_service.py` | L93, L190 |
| 5 | VAD fallback result discarded in diarization | Important | `batch_service.py` | L144–163 |
| 6 | E2E tests lack timing metric assertions | Important | `test_real_data_transcription.py` | All test methods |

---

## Implementation Plan

### Phase 1: Preprocessing Pipeline Correctness

#### Task 1.1 — Add `pyrnnoise` dependency

**Files**:
- Modify: `apps/stt-v2/pyproject.toml`

**What to do**:

1. Add `pyrnnoise` to the `[ml]` optional dependency group:

```python
ml = [
    # ... existing deps ...
    # RNNoise noise suppression (requires 48kHz, 480-sample frames)
    "pyrnnoise>=0.4.0",
]
```

**Verification**: `pip install -e ".[ml]"` succeeds, `from pyrnnoise import RNNoise` works.

---

#### Task 1.2 — Rewrite `_apply_denoise()` for RNNoise with 48kHz round-trip

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/preprocessing.py`

**Current code** (lines 302–342):

```python
async def _apply_denoise(self, samples, denoise_model, strength):
    # Treats as generic PyTorch model — incorrect for RNNoise
    audio_tensor = torch.from_numpy(samples).float().unsqueeze(0).unsqueeze(0)
    denoised = model(audio_tensor)
    ...
```

**New implementation**:

```python
async def _apply_denoise(
    self,
    samples: np.ndarray,
    sample_rate: int,
    strength: float,
) -> np.ndarray:
    """Apply RNNoise noise suppression.

    RNNoise operates exclusively at 48 kHz with 480-sample frames (10ms).
    This method:
    1. Upsamples from current sample_rate → 48000 Hz
    2. Applies pyrnnoise denoising frame-by-frame
    3. Downsamples 48000 Hz → original sample_rate
    4. Blends denoised with original based on strength parameter

    Args:
        samples: Float32 mono audio at ``sample_rate``.
        sample_rate: Current sample rate (typically 16000).
        strength: Denoise strength 0.0 (bypass) to 1.0 (full denoise).

    Returns:
        Denoised audio at the original ``sample_rate``.
    """
    if strength <= 0.0:
        return samples

    try:
        from pyrnnoise import RNNoise

        # Step 1: Upsample to 48kHz (RNNoise requirement)
        if sample_rate != 48000:
            samples_48k = self._resample(samples, sample_rate, 48000)
        else:
            samples_48k = samples

        # Step 2: Apply RNNoise
        denoiser = RNNoise(sample_rate=48000)
        # pyrnnoise expects shape [channels, samples] for denoise_chunk
        audio_chunk = samples_48k.reshape(1, -1)  # (1, N) for mono
        denoised_48k_parts = []
        for _speech_prob in denoiser.denoise_chunk(audio_chunk):
            pass  # generator consumes frames internally
        # Use denoise_chunk which processes the full array
        denoised_48k = np.zeros_like(samples_48k)
        denoiser2 = RNNoise(sample_rate=48000)
        idx = 0
        for speech_prob in denoiser2.denoise_chunk(audio_chunk):
            # denoise_chunk yields speech probability per frame
            # The denoised output is written back into the chunk in-place
            pass
        denoised_48k = audio_chunk.flatten()

        # Step 3: Downsample back to original sample rate
        if sample_rate != 48000:
            denoised = self._resample(denoised_48k, 48000, sample_rate)
        else:
            denoised = denoised_48k

        # Ensure same length as input
        if len(denoised) != len(samples):
            min_len = min(len(denoised), len(samples))
            denoised = denoised[:min_len]
            samples = samples[:min_len]

        # Step 4: Blend based on strength
        if strength < 1.0:
            denoised = strength * denoised + (1.0 - strength) * samples

        return denoised.astype(np.float32)

    except ImportError:
        logger.warning(
            "pyrnnoise not installed — skipping denoising. "
            "Install with: pip install pyrnnoise"
        )
        return samples
    except Exception as e:
        logger.warning("RNNoise denoising failed: %s, returning original audio", e)
        return samples
```

**Key design decisions**:
- The `denoise_model` parameter is **no longer needed** — RNNoise is loaded via `pyrnnoise.RNNoise()`, not via the model cache. The model reference in pipeline YAML (`nickolay/rnnoise`) serves as a declaration that denoising is enabled; the actual library is `pyrnnoise`.
- Resample uses the existing `self._resample()` (librosa-based), which is battle-tested.
- Strength blending preserved for user control.

**Important note on pyrnnoise API**: The `pyrnnoise` library's `denoise_chunk()` method processes audio in-place. The exact API usage will be verified during implementation against the installed version. The plan above shows the intent; the final code may adjust based on the actual `pyrnnoise` API.

---

#### Task 1.3 — Reorder preprocessing: Denoise BEFORE VAD

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/preprocessing.py`

**Current order** (lines 50–97):

```
1. Load audio from bytes
2. Convert to mono
3. Resample to target_sample_rate (16kHz)
4. Normalize
5. VAD (if enabled)          ← wrong position
6. Denoise (if enabled)      ← wrong position
```

**New order**:

```
1. Load audio from bytes
2. Convert to mono
3. Resample to target_sample_rate (16kHz)
4. Normalize
5. Denoise (if enabled)      ← MOVED UP: clean audio before VAD
6. VAD (if enabled)          ← MOVED DOWN: detect speech on clean audio
```

**Updated `process()` method signature change**:
- The `_apply_denoise()` no longer takes a `denoise_model` parameter — it uses `pyrnnoise` directly.
- The method now receives `sample_rate` so it can handle the 48kHz round-trip internally.

```python
async def process(
    self,
    audio_bytes: bytes,
    config: PreprocessingConfig,
    vad_model: LoadedModel | None = None,
    denoise_model: LoadedModel | None = None,  # kept for backward compat, ignored internally
) -> ProcessedAudio:
    samples, original_sr = self._load_audio(audio_bytes)
    was_resampled = False
    was_normalized = False

    # Convert to mono
    if len(samples.shape) > 1:
        samples = samples.mean(axis=1)

    # Resample to target
    if original_sr != config.target_sample_rate:
        samples = self._resample(samples, original_sr, config.target_sample_rate)
        was_resampled = True

    # Normalize
    if config.normalize:
        samples = self._normalize(samples)
        was_normalized = True

    duration = len(samples) / config.target_sample_rate

    # *** Denoise FIRST (operates at 48kHz internally) ***
    denoise_applied = False
    if config.denoise.enabled:
        samples = await self._apply_denoise(
            samples, config.target_sample_rate, config.denoise.strength
        )
        denoise_applied = True

    # *** VAD SECOND (operates on clean audio) ***
    segments: list[AudioSegment] = []
    vad_applied = False
    if config.vad.enabled:
        segments, vad_applied = await self._apply_vad_smart(
            samples, config.target_sample_rate, config.vad, vad_model
        )

    return ProcessedAudio(
        samples=samples,
        sample_rate=config.target_sample_rate,
        duration_seconds=duration,
        segments=segments,
        was_resampled=was_resampled,
        was_normalized=was_normalized,
        vad_applied=vad_applied,
        denoise_applied=denoise_applied,
    )
```

**Verification**: Run `pytest tests/unit/ -v -k "preprocess or batch_service"` — all pass.

---

### Phase 2: Per-Segment ASR Inference

#### Task 2.1 — Add per-segment ASR dispatch to `BatchTranscriptionService`

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/batch_service.py`

**Current code** (lines 127–135):

```python
# Step 3: Run ASR inference
raw_result = await self._run_inference(
    processed.samples,      # ← full audio
    processed.sample_rate,
    asr_model,
    spec.inference,
    progress_callback=...,
)
```

**New implementation**:

When VAD produced segments, transcribe each segment independently and merge results. When VAD is not enabled (or produced no segments), fall back to the existing full-audio approach.

```python
# Step 3: Run ASR inference
logger.info(f"[{job_id}] Running ASR inference...")
inference_start = time.time()

if processed.vad_applied and processed.segments:
    # Per-segment ASR — transcribe each speech segment independently
    raw_result = await self._run_per_segment_inference(
        processed.samples,
        processed.sample_rate,
        processed.segments,
        asr_model,
        spec.inference,
        job_id=job_id,
        progress_callback=lambda p: update_progress(35 + int(p * 0.4)),
    )
else:
    # Full-audio ASR (no VAD or no segments detected)
    raw_result = await self._run_inference(
        processed.samples,
        processed.sample_rate,
        asr_model,
        spec.inference,
        progress_callback=lambda p: update_progress(35 + int(p * 0.4)),
    )

inference_elapsed = time.time() - inference_start
```

**New method** — `_run_per_segment_inference()`:

```python
async def _run_per_segment_inference(
    self,
    samples: np.ndarray,
    sample_rate: int,
    segments: list["AudioSegment"],
    model: LoadedModel,
    config: Any,
    job_id: str = "",
    progress_callback: Callable[[float], None] | None = None,
) -> RawTranscription:
    """Run ASR inference on each VAD speech segment independently.

    Slices the audio for each speech segment, runs inference on each,
    collects per-segment timing, and merges all results into a single
    RawTranscription with correct global timestamps.

    Args:
        samples: Full audio as float32 numpy array.
        sample_rate: Sample rate.
        segments: VAD-detected speech segments.
        model: ASR model.
        config: Inference configuration.
        job_id: Job ID for logging.
        progress_callback: Progress reporter (0.0–1.0).

    Returns:
        Merged RawTranscription with per-segment results.
    """
    all_segments: list[dict[str, Any]] = []
    all_word_timestamps: list[dict[str, Any]] = []
    all_text_parts: list[str] = []
    segment_latencies: list[dict[str, Any]] = []
    detected_language: str | None = None
    detected_lang_prob: float | None = None

    speech_segments = [s for s in segments if s.is_speech]
    total = len(speech_segments)

    for idx, seg in enumerate(speech_segments):
        start_sample = int(seg.start_time * sample_rate)
        end_sample = int(seg.end_time * sample_rate)
        segment_audio = samples[start_sample:end_sample]

        if len(segment_audio) < sample_rate // 4:
            # Skip segments shorter than 0.25 seconds
            continue

        seg_start_time = time.time()

        try:
            seg_result = await self._run_inference(
                segment_audio, sample_rate, model, config
            )
        except Exception as e:
            logger.warning(
                "[%s] ASR failed for segment [%.1f–%.1f]: %s",
                job_id, seg.start_time, seg.end_time, e,
            )
            continue

        seg_elapsed = time.time() - seg_start_time

        # Record per-segment latency
        segment_latencies.append({
            "segment_index": idx,
            "start_time": seg.start_time,
            "end_time": seg.end_time,
            "duration_s": seg.duration,
            "inference_time_s": round(seg_elapsed, 4),
        })

        if seg_result.text.strip():
            all_text_parts.append(seg_result.text.strip())

        # Offset timestamps to global audio timeline
        time_offset = seg.start_time
        for s in seg_result.segments:
            if isinstance(s, dict):
                s["start"] = s.get("start", 0.0) + time_offset
                s["end"] = s.get("end", 0.0) + time_offset
                all_segments.append(s)

        for wt in seg_result.word_timestamps:
            if isinstance(wt, dict):
                wt["start"] = wt.get("start", wt.get("start_time", 0.0)) + time_offset
                wt["end"] = wt.get("end", wt.get("end_time", 0.0)) + time_offset
                wt["start_time"] = wt["start"]
                wt["end_time"] = wt["end"]
                all_word_timestamps.append(wt)

        # Use language from first segment that reports it
        if detected_language is None and seg_result.language:
            detected_language = seg_result.language
            detected_lang_prob = seg_result.language_probability

        if progress_callback:
            progress_callback((idx + 1) / total)

    merged_text = " ".join(all_text_parts)

    result = RawTranscription(
        text=merged_text,
        language=detected_language,
        language_probability=detected_lang_prob,
        segments=all_segments,
        word_timestamps=all_word_timestamps,
    )

    # Stash per-segment latencies in model_output for later retrieval
    result.model_output = {"segment_latencies": segment_latencies}

    return result
```

**Key design decisions**:
- Each segment's timestamps are offset by `seg.start_time` to maintain global timeline consistency.
- Language detection uses the first segment's result (Whisper auto-detects per run).
- Per-segment latency is stashed in `result.model_output` for the timing metrics collection in Phase 3.
- Progress callback still works linearly across segments.

**Verification**: Run `pytest tests/unit/test_batch_service.py -v` — all pass.

---

### Phase 3: Timing Metrics & Latency Collection

#### Task 3.1 — Add timing metrics to `TranscriptionResult`

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/dto.py`

**What to do**:

Add a `TimingMetrics` dataclass and include it in `TranscriptionResult.metadata`:

```python
@dataclass
class TimingMetrics:
    """Pipeline timing breakdown for observability."""

    # Time To First Word — from audio input to first transcribed word
    ttfw_seconds: float = 0.0

    # Per-pipeline-step breakdown
    model_loading_seconds: float = 0.0
    preprocessing_seconds: float = 0.0
    inference_seconds: float = 0.0
    diarization_seconds: float = 0.0
    postprocessing_seconds: float = 0.0

    # Total end-to-end (should equal processing_time_seconds)
    total_seconds: float = 0.0

    # Per-segment latency (populated when VAD + per-segment ASR is used)
    segment_latencies: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ttfw_seconds": round(self.ttfw_seconds, 4),
            "model_loading_seconds": round(self.model_loading_seconds, 4),
            "preprocessing_seconds": round(self.preprocessing_seconds, 4),
            "inference_seconds": round(self.inference_seconds, 4),
            "diarization_seconds": round(self.diarization_seconds, 4),
            "postprocessing_seconds": round(self.postprocessing_seconds, 4),
            "total_seconds": round(self.total_seconds, 4),
            "segment_latencies": self.segment_latencies,
        }
```

Update `TranscriptionResult.to_dict()` to include timing if present:

```python
# In to_dict():
if "timing" in self.metadata and hasattr(self.metadata["timing"], "to_dict"):
    result["timing"] = self.metadata["timing"].to_dict()
```

---

#### Task 3.2 — Instrument `BatchTranscriptionService.transcribe()` with timing

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/batch_service.py`

**What to do**:

Add `time.time()` instrumentation around each pipeline step:

```python
async def transcribe(self, ...) -> TranscriptionResult:
    start_time = time.time()
    timing = TimingMetrics()

    # Step 1: Load models
    model_start = time.time()
    models = await self._load_models(pipeline_config)
    timing.model_loading_seconds = time.time() - model_start

    # Step 2: Preprocess
    preprocess_start = time.time()
    processed = await preprocessor.process(...)
    timing.preprocessing_seconds = time.time() - preprocess_start

    # Step 3: ASR inference
    inference_start = time.time()
    raw_result = await self._run_inference(...) or self._run_per_segment_inference(...)
    timing.inference_seconds = time.time() - inference_start

    # Compute TTFW — time from start to first transcribed word
    if raw_result.word_timestamps:
        timing.ttfw_seconds = time.time() - start_time
    elif raw_result.text:
        timing.ttfw_seconds = time.time() - start_time

    # Extract per-segment latencies if available
    if hasattr(raw_result, 'model_output') and isinstance(raw_result.model_output, dict):
        timing.segment_latencies = raw_result.model_output.get("segment_latencies", [])

    # Step 4: Diarization
    diarization_start = time.time()
    # ... diarization code ...
    timing.diarization_seconds = time.time() - diarization_start

    # Step 5: Postprocess
    postprocess_start = time.time()
    result = self._postprocess(...)
    timing.postprocessing_seconds = time.time() - postprocess_start

    # Finalize timing
    timing.total_seconds = time.time() - start_time
    result.metadata["timing"] = timing

    return result
```

**Verification**: Run `pytest tests/unit/test_batch_service.py -v` — all pass.

---

### Phase 4: Wire VAD Fallback into Diarization

#### Task 4.1 — Use VAD fallback segments in diarization

**Files**:
- Modify: `apps/stt-v2/src/stt_v2/transcription/batch_service.py`

**Current code** (lines 144–163):

```python
if not processed.vad_applied:
    # ... Silero VAD fallback runs but vad_result.segments is DISCARDED
    vad_result = vad_svc.detect_speech(...)
    # ... vad_result never used
```

**New implementation**:

Convert the VAD fallback segments into the format expected by `_run_diarization` and pass them:

```python
# Step 4: Speaker diarization
diarization_meta: dict[str, Any] = {}
diarization_start = time.time()

if spec.diarization.enabled and tenant_id:
    # Collect segments for diarization
    diarization_segments = raw_result.segments  # Default: ASR segments

    if processed.vad_applied and processed.segments:
        # Convert VAD AudioSegments to diarization-compatible dicts
        diarization_segments = [
            {
                "start": seg.start_time,
                "end": seg.end_time,
                "text": "",  # VAD segments don't have text
                "is_speech": seg.is_speech,
            }
            for seg in processed.segments
            if seg.is_speech
        ]
    elif not processed.vad_applied:
        # VAD was not applied — run Silero fallback for diarization
        logger.warning(f"[{job_id}] Running Silero VAD fallback for diarization...")
        try:
            from ..vad.silero_service import get_vad_service
            vad_svc = get_vad_service()
            if not vad_svc.is_loaded:
                await vad_svc.initialize()
            vad_result = vad_svc.detect_speech(
                processed.samples, processed.sample_rate
            )
            # USE the fallback segments
            diarization_segments = [
                {
                    "start": s.start_time,
                    "end": s.end_time,
                    "text": "",
                    "is_speech": True,
                }
                for s in vad_result.segments
            ]
            logger.info(
                f"[{job_id}] Silero VAD fallback: {len(diarization_segments)} segments"
            )
        except Exception as e:
            logger.warning(f"[{job_id}] VAD fallback failed: {e}")

    logger.info(f"[{job_id}] Running speaker diarization...")
    try:
        diarization_meta = await self._run_diarization(
            processed.samples,
            processed.sample_rate,
            RawTranscription(text="", segments=diarization_segments),
            tenant_id,
            consultation_id,
            spec.diarization,
            pipeline_config,
        )
    except Exception as e:
        logger.warning(f"[{job_id}] Diarization failed (non-fatal): {e}")

timing.diarization_seconds = time.time() - diarization_start
```

**Verification**: Run `pytest tests/unit/test_batch_service.py -v` — all pass.

---

### Phase 5: E2E Test Enhancements

#### Task 5.1 — Add timing metrics assertions to all e2e tests

**Files**:
- Modify: `apps/stt-v2/tests/e2e/test_real_data_transcription.py`

**What to do**:

After each transcription call, verify timing metrics exist:

```python
# --- Assertions: timing metrics ---
timing = result.metadata.get("timing")
assert timing is not None, "Timing metrics should be present"

if hasattr(timing, 'to_dict'):
    timing_dict = timing.to_dict()
else:
    timing_dict = timing

assert timing_dict["preprocessing_seconds"] > 0, "Preprocessing time should be positive"
assert timing_dict["inference_seconds"] > 0, "Inference time should be positive"
assert timing_dict["total_seconds"] > 0, "Total time should be positive"
assert timing_dict["model_loading_seconds"] >= 0, "Model loading time should be non-negative"

# TTFW should be reasonable (< total time)
if timing_dict["ttfw_seconds"] > 0:
    assert timing_dict["ttfw_seconds"] <= timing_dict["total_seconds"], (
        "TTFW should not exceed total processing time"
    )

# For full pipeline tests (VAD enabled):
if vad_enabled and timing_dict.get("segment_latencies"):
    for seg_lat in timing_dict["segment_latencies"]:
        assert seg_lat["inference_time_s"] > 0, "Segment inference time should be positive"
        assert seg_lat["duration_s"] > 0, "Segment duration should be positive"
    logger.info(
        f"Per-segment latencies: {len(timing_dict['segment_latencies'])} segments, "
        f"avg inference: {sum(s['inference_time_s'] for s in timing_dict['segment_latencies']) / len(timing_dict['segment_latencies']):.3f}s"
    )

# For diarization tests:
if diarization_enabled:
    assert timing_dict["diarization_seconds"] >= 0, (
        "Diarization time should be non-negative"
    )
```

Add timing metrics to the markdown report and JSON export.

---

#### Task 5.2 — Update markdown report with timing breakdown

**Files**:
- Modify: `apps/stt-v2/tests/e2e/test_real_data_transcription.py`

**What to do**:

In `_write_markdown_report()`, add a Timing Breakdown section:

```python
# Timing breakdown
timing = result.metadata.get("timing")
if timing:
    timing_dict = timing.to_dict() if hasattr(timing, 'to_dict') else timing
    lines.extend([
        "## Timing Breakdown",
        "",
        "| Step | Duration (s) |",
        "|---|---|",
        f"| **Model Loading** | {timing_dict.get('model_loading_seconds', 0):.4f} |",
        f"| **Preprocessing** | {timing_dict.get('preprocessing_seconds', 0):.4f} |",
        f"| **ASR Inference** | {timing_dict.get('inference_seconds', 0):.4f} |",
        f"| **Diarization** | {timing_dict.get('diarization_seconds', 0):.4f} |",
        f"| **Postprocessing** | {timing_dict.get('postprocessing_seconds', 0):.4f} |",
        f"| **Total** | {timing_dict.get('total_seconds', 0):.4f} |",
        f"| **TTFW** | {timing_dict.get('ttfw_seconds', 0):.4f} |",
        "",
    ])

    # Per-segment latency table
    seg_lats = timing_dict.get("segment_latencies", [])
    if seg_lats:
        lines.extend([
            "### Per-Segment ASR Latency",
            "",
            "| Segment | Start (s) | End (s) | Duration (s) | Inference (s) |",
            "|---|---|---|---|---|",
        ])
        for sl in seg_lats:
            lines.append(
                f"| {sl['segment_index']} | {sl['start_time']:.3f} | "
                f"{sl['end_time']:.3f} | {sl['duration_s']:.3f} | "
                f"{sl['inference_time_s']:.4f} |"
            )
        lines.append("")
```

---

### Phase 6: Test Verification

#### Task 6.1 — Run full test suite

**What to do**:
1. Run `pytest tests/unit/ -v --tb=short` — all 810+ tests pass
2. Run `pytest tests/e2e/test_real_data_transcription.py -v -s` — all 4 e2e tests pass with timing metrics
3. Verify markdown reports include timing breakdown
4. Verify JSON exports include timing metrics

---

## Task Summary and Dependency Graph

```
Phase 1 — Preprocessing Pipeline Correctness (sequential)
  ├── Task 1.1: Add pyrnnoise dependency
  ├── Task 1.2: Rewrite _apply_denoise() for RNNoise 48kHz ──── needs 1.1
  └── Task 1.3: Reorder preprocessing: Denoise → VAD ──────── needs 1.2

Phase 2 — Per-Segment ASR (independent of Phase 1)
  └── Task 2.1: Per-segment ASR dispatch + merged results

Phase 3 — Timing Metrics (needs Phase 2 complete)
  ├── Task 3.1: Add TimingMetrics DTO ──────────────────────── independent
  └── Task 3.2: Instrument batch_service with timing ────────── needs 2.1, 3.1

Phase 4 — VAD Fallback Wiring (independent)
  └── Task 4.1: Use VAD fallback segments in diarization

Phase 5 — E2E Tests (needs all phases complete)
  ├── Task 5.1: Add timing assertions to e2e tests
  └── Task 5.2: Update markdown report with timing

Phase 6 — Verification (needs all)
  └── Task 6.1: Full regression test run
```

**Estimated effort**: ~3-4 hours total

| Phase | Tasks | Priority | Effort |
|-------|-------|----------|--------|
| Phase 1 | 3 tasks | Critical | ~60 min |
| Phase 2 | 1 task | Critical | ~45 min |
| Phase 3 | 2 tasks | Critical | ~30 min |
| Phase 4 | 1 task | Important | ~15 min |
| Phase 5 | 2 tasks | Important | ~30 min |
| Phase 6 | 1 task | Required | ~10 min |

---

## Implementation Summary

All 10 tasks across 6 phases completed. **854 unit tests pass (0 failures, 4 skipped for ML deps).**

### Files Modified

| File | Changes |
|------|---------|
| `pyproject.toml` | Added `pyrnnoise>=0.4.0` to `[ml]` dependencies |
| `src/stt_v2/transcription/preprocessing.py` | **Reordered pipeline**: Denoise → VAD (was VAD → Denoise). Rewrote `_apply_denoise()` for RNNoise via `pyrnnoise` with 48 kHz up/downsample round-trip. Removed `denoise_model` parameter dependency (uses `pyrnnoise` directly). |
| `src/stt_v2/transcription/dto.py` | Added `TimingMetrics` dataclass with TTFW, per-step breakdown, and per-segment latency fields. Updated `TranscriptionResult.to_dict()` to serialize `TimingMetrics` objects. |
| `src/stt_v2/transcription/batch_service.py` | Added `_run_per_segment_inference()` for per-segment ASR when VAD is active. Instrumented `transcribe()` with `time.time()` around each pipeline step. Wired VAD fallback segments into diarization (no longer discarded). Populated `TimingMetrics` in `result.metadata["timing"]`. |
| `tests/e2e/test_real_data_transcription.py` | Added `_assert_timing_metrics()` helper. All 4 test methods now assert timing metrics (TTFW, per-step, per-segment latency). Markdown reports include Timing Breakdown section with per-segment ASR latency table. |

### Key Behavioral Changes

1. **Preprocessing order fixed**: Denoise now runs *before* both resample and VAD. The target-rate resample is deferred until after denoising to avoid redundant resampling steps.
2. **RNNoise 48 kHz — minimal resampling**: Audio is upsampled from its original rate to 48 kHz for `pyrnnoise`, denoised frame-by-frame (480 samples/10 ms), and the output stays at 48 kHz. A single final resample converts to `target_sample_rate` (e.g. 16 kHz). This results in 2 resamples when denoise is on (original→48k→target) vs 3 in the previous implementation (original→target→48k→target).
3. **Per-segment ASR**: When VAD produces segments, each speech segment is transcribed independently with correct global timestamp offsets — improves accuracy and enables per-segment latency collection
4. **TTFW metric**: Time To First Word is now measured from pipeline start to the moment the first transcribed word is available
5. **Per-step timing**: Model loading, preprocessing, inference, diarization, and postprocessing each have individual timing measurements stored in `result.metadata["timing"]`
6. **Per-segment latency**: When VAD + per-segment ASR is active, each segment's inference time is recorded and accessible
7. **VAD fallback wired**: When diarization is enabled but VAD was not applied, the Silero fallback segments are now actually passed to the diarization step (instead of being discarded)
8. **E2E test coverage**: All 4 e2e tests now verify timing metrics exist and are within reasonable bounds
9. **Markdown reports enhanced**: Reports now include a Timing Breakdown table and per-segment ASR latency table

### Acceptance Criteria Status

- [x] Preprocessing order is: Load → Mono → Normalize → Denoise (original→48kHz) → Resample to 16kHz → VAD
- [x] RNNoise denoising upsamples to 48kHz, processes via `pyrnnoise`; output stays at 48kHz for single final resample
- [x] When VAD produces segments, ASR runs per-segment and results are combined
- [x] `TranscriptionResult.metadata` contains `timing` dict with TTFW, per-step, per-segment latency
- [x] VAD fallback segments in diarization step are actually used
- [x] E2E tests verify timing metrics exist and are within reasonable bounds
- [x] `pyrnnoise` added to `[ml]` dependencies
- [x] All existing unit tests continue to pass (854 passed)

---

## Change History

### 2026-02-08 — Initial Documentation

- Created implementation plan based on code review findings
- Identified 4 critical issues and 2 important recommendations
- Prepared 10 tasks across 6 phases

### 2026-02-08 — Implementation Completed (All Phases)

- Implemented all 10 tasks across Phases 1–6
- 854 unit tests passing, 0 failures, 4 skipped (ML-specific)
- Added `pyrnnoise>=0.4.0` dependency for RNNoise noise suppression
- Pipeline order corrected: Denoise → VAD
- Per-segment ASR with global timestamp offsets
- Full timing metrics instrumentation (TTFW, per-step, per-segment)
- VAD fallback segments now used by diarization
- E2E test timing assertions and markdown report enhancements

### 2026-02-08 — Resample Order Optimization

- Deferred target-rate resample until *after* denoising to eliminate redundant
  resampling steps (was: original→16k→48k→16k = 3 resamples; now:
  original→48k→16k = 2 resamples when denoise is active)
- `_apply_denoise()` now returns `(samples, output_sr)` tuple — output stays
  at 48 kHz so the caller performs a single final resample
- Normalize moved before denoise (operates on original-rate audio)
- All 854 unit tests still pass
