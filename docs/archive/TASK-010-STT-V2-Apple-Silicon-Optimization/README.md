# TASK-010: STT-V2 Apple Silicon Performance Optimization

- **Ticket**: TASK-010
- **Created**: 2026-02-08
- **Last Updated**: 2026-02-08
- **Status**: Completed
- **Parent**: TASK-007 (STT-V2 Worker Architecture Refactor)

## Requirement Analysis

Performance review of the stt-v2 transcription pipeline identified that on Apple Silicon (M1/M2/M3/M4), the system runs almost entirely on CPU despite having GPU, Neural Engine, and Metal Performance Shaders available. The primary ASR inference engine (Whisper via ONNX Optimum) explicitly falls back to `CPUExecutionProvider`, PyTorch models default to float32 instead of float16, ONNX thread counts are hardcoded to 4 regardless of core count, and MPS memory is never cleaned up on model unload.

### Problem Statement

1. **Optimum ONNX Whisper ignores CoreML**: The `_load_with_optimum()` method in `onnx_loader.py` forces `CPUExecutionProvider` on all non-CUDA platforms, completely bypassing CoreML even though Apple Silicon can leverage GPU + Neural Engine via CoreML.
2. **float32 default on MPS**: `_get_torch_dtype()` in `base_loader.py` only enables float16 for CUDA. MPS supports float16 natively and is ~2x faster with it.
3. **ONNX thread count hardcoded to 4**: `intra_op_num_threads` and `inter_op_num_threads` are hardcoded to 4 in `onnx_loader.py`, under-utilizing M2/M3/M4 Pro/Max/Ultra chips with 8-16 cores.
4. **CoreML session options not configured**: When CoreML is auto-detected in the standard ONNX loader, no CoreML-specific options (`MLComputeUnits`, `ModelFormat`) are passed, leaving performance on the table.
5. **No MPS memory cleanup**: `huggingface_loader.py` only clears CUDA cache on model unload; MPS memory pool is never released.

### Business Context

- The development team uses Apple Silicon Macs (M2/M3/M4) for local development and testing
- Local inference speed directly impacts developer iteration time
- Some deployment scenarios target Apple Silicon hardware
- Medical consultation audio files range from 5-60 minutes; faster inference means faster results

### Acceptance Criteria

- [ ] Optimum ONNX loader detects and uses CoreML execution provider on macOS
- [ ] CoreML sessions are configured with `MLComputeUnits=ALL` and `ModelFormat=MLProgram`
- [ ] PyTorch models use float16 automatically when running on MPS
- [ ] ONNX thread count is configurable via `ONNX_NUM_THREADS` env var and defaults to `0` (ONNX Runtime auto-sizes to physical core count)
- [ ] MPS memory cache is cleared on model unload
- [ ] Standard ONNX loader passes CoreML-specific provider options
- [ ] Existing CUDA and CPU paths are unaffected (no regressions)
- [ ] All changes are behind platform detection guards (no impact on Linux/Windows)
- [ ] Unit tests cover platform-specific logic with mocked backends

## Current State Evaluation

### Architecture Review

The stt-v2 service has a clean model loader abstraction (`BaseModelLoader` -> `ONNXLoader`, `HuggingFaceLoader`, etc.) that makes it straightforward to add platform-specific optimizations without restructuring the codebase.

### Components Affected

| Component | File | Issue |
|-----------|------|-------|
| ONNX Loader (Optimum) | `src/stt_v2/models/onnx_loader.py` | Forces CPU on Apple Silicon |
| ONNX Loader (Standard) | `src/stt_v2/models/onnx_loader.py` | No CoreML options |
| Base Loader | `src/stt_v2/models/base_loader.py` | float32 on MPS |
| HuggingFace Loader | `src/stt_v2/models/huggingface_loader.py` | No MPS cache cleanup |
| Base Loader (cleanup) | `src/stt_v2/models/base_loader.py` | No `cleanup_accelerator_memory()` utility |
| Platform Detection | `src/stt_v2/core/platform.py` | Already supports MPS detection (good) |
| Settings | `src/stt_v2/core/config/settings.py` | Needs ONNX_NUM_THREADS env var |

### Evidence: Current Performance Bottlenecks

#### E1: Optimum ONNX Forces CPU

```python
# onnx_loader.py lines 393-403
requested_device = self._get_device(model_config.compute_type or "auto")
if requested_device == "cuda":
    provider = "CUDAExecutionProvider"
    device = "cuda"
else:
    # MPS / CPU / anything else → use CPU for ONNX Runtime
    provider = "CPUExecutionProvider"
    device = "cpu"
```

**Impact**: Primary Whisper ASR inference runs on CPU only. CoreML could dispatch to GPU + Neural Engine for 2-5x speedup.

#### E2: float32 on MPS

```python
# base_loader.py lines 126-133
mapping = {
    ...
    "auto": torch.float16 if torch.cuda.is_available() else torch.float32,
}
```

**Impact**: All PyTorch models (Transformers Whisper, Wav2Vec2) run at float32 on MPS. Float16 is ~2x faster on Apple GPU.

#### E3: Hardcoded Thread Count

```python
# onnx_loader.py lines 77-78
session_options.intra_op_num_threads = 4
session_options.inter_op_num_threads = 4
```

**Impact**: M2 Max (12 cores), M3 Max (14-16 cores), M4 Max (16 cores) are all limited to 4 threads. Per ONNX Runtime docs, the best practice is `intra_op_num_threads = 0` (auto), which lets the runtime auto-size to physical core count with proper thread affinity.

#### E4: No CoreML Provider Options

```python
# onnx_loader.py lines 80-85 (standard loader)
session = ort.InferenceSession(
    model_path,
    sess_options=session_options,
    providers=providers,  # CoreML auto-detected, but no options passed
)
```

**Impact**: CoreML runs with defaults instead of `MLComputeUnits=ALL` (CPU+GPU+ANE).

#### E5: Missing MPS Cache Cleanup

```python
# huggingface_loader.py lines 228-229
if torch.cuda.is_available():
    torch.cuda.empty_cache()
# No MPS equivalent
```

**Impact**: MPS memory pool grows over model load/unload cycles, potentially causing OOM.

### What's Already Working Well

- **Platform detection** (`platform.py`) correctly identifies CPU/CUDA/MPS
- **Diarization service** already uses MPS when available (`embedding_service.py:296-309`)
- **Silero VAD on CPU** is the correct choice (LSTM instability on M4 MPS)
- **Loader abstraction** makes per-platform optimizations clean to implement

## Implementation Plan

See [planning.md](./planning.md) for the detailed task-by-task implementation plan.

### High-Level Scope

| Item | Description | Files Modified | Estimated Speedup |
|------|-------------|----------------|-------------------|
| 1 | CoreML for Optimum ONNX + standard loader options | `onnx_loader.py` | 2-5x |
| 2 | float16 on MPS for PyTorch models | `base_loader.py` | ~2x |
| 3 | Configurable ONNX thread count (default: 0/auto) | `onnx_loader.py`, `settings.py`, `.env.example` | 20-50% |
| 4 | MPS memory cleanup on unload | `base_loader.py`, `huggingface_loader.py`, `onnx_loader.py` | Prevents OOM |

### Out of Scope (Future)

- MLX Whisper integration (separate task, requires new loader + pyproject.toml changes)
- torchaudio MPS resampling in preprocessing (depends on torch 2.8 MPS stability)
- `torch.compile()` with MPS backend (experimental, needs benchmarking first)
- bfloat16 support on M3+ chips (requires M3+ detection logic)

### Testing Strategy

- Unit tests with mocked `torch.backends.mps`, `onnxruntime.get_available_providers()`
- Platform detection guards ensure no regressions on Linux/CUDA
- E2E tests run on Apple Silicon Macs to validate real speedup

### Deployment Considerations

- All changes are opt-in via platform detection (no config changes needed)
- `ONNX_NUM_THREADS` env var provides manual override escape hatch
- CoreML provider requires `onnxruntime>=1.23.0` (already specified in pyproject.toml)
- CoreML compiles ONNX models on first load (slow); `ModelCacheDirectory` caches compiled models for subsequent loads
- No new dependencies required

### Key Best Practices Applied (from Official Docs)

1. **ONNX Runtime CoreML EP**: Use tuple-based provider format with string option values. Set `MLComputeUnits=ALL`, `ModelFormat=MLProgram`, `RequireStaticInputShapes=0`. Use `ModelCacheDirectory` to cache compiled models.
2. **PyTorch MPS**: Cleanup order must be `del model` -> `gc.collect()` -> `torch.mps.empty_cache()`. Keep LSTM-based models (Silero VAD) on CPU due to known MPS LSTM memory leak.
3. **ONNX Threading**: Use `intra_op_num_threads=0` (auto) as official recommended default. Only set `inter_op_num_threads` if using `ORT_PARALLEL` execution mode.
4. **Optimum API**: `provider` (string) and `provider_options` (dict) are separate parameters to `from_pretrained()`. Do not conflate them.

## Critical Discovery: Long-Audio Transcription Bug (Separate Ticket Required)

During Apple Silicon performance review, testing with the 640-second English
conversation (`20260206_52886591770369502_en.wav`) revealed that the transcription
output is fundamentally broken — only ~30 seconds are transcribed regardless of
audio length, and all word timestamps are `0.0`. This affects **all** pipeline
configurations (basic and full), not just Apple Silicon.

### Symptoms

- **640-second audio → only 6 sentences** (~30s of content) from the beginning
- **All `word_timestamps` have `start_time: 0.0, end_time: 0.0`**
- **`segments: []`** and **`segment_latencies: []`** always empty
- Identical broken output across both "basic" (test #3) and "full" (test #4) pipelines
- Reproducible across 4+ test runs (all output files in `tests/e2e/output/` show same issue)

### Root Causes Identified

#### Bug 1: No long-form audio chunking in Optimum ONNX inference

`_run_optimum_onnx_inference()` in `batch_service.py:894-965` passes the entire
audio to `processor()` + `onnx_model.generate()` as a single call. Whisper has a
**30-second context window**. The `WhisperFeatureExtractor` creates log-mel features
for only the first 30 seconds and silently truncates the rest.

**Fix required**: Implement chunked long-form inference using either:
- `chunk_length_s=30` with `stride_length_s` in a pipeline approach, or
- Manual sliding-window chunking over the mel spectrogram, or
- Per-segment inference via VAD (but VAD also appears broken — see Bug 3)

#### Bug 2: Word timestamp format mismatch

`_run_optimum_onnx_inference()` calls `processor.decode(output_offsets=True)` which
returns Whisper's offset format:
```python
[{"text": " What...", "timestamp": (0.0, 2.5)}]
```

But `_postprocess()` at line 1014-1018 expects keys `"start"/"start_time"` and
`"end"/"end_time"`. The `"timestamp"` tuple is never extracted, so all timestamps
default to `0.0`.

#### Bug 3: VAD returns no segments for long audio (full pipeline also broken)

Test #4 (full pipeline with VAD) produces `segment_latencies: []`, meaning the
code took the full-audio path (line 156-163) instead of per-segment path (line
145-155). This implies `processed.vad_applied` is `False` or `processed.segments`
is empty, meaning VAD silently failed or returned no segments on this audio.

### Impact

- **All ONNX Optimum transcription of audio > 30 seconds is silently truncated**
- **All word timestamps are always `0.0`** (never populated correctly)
- These bugs exist independently of Apple Silicon — they affect all platforms

### Resolution

This was addressed in **[TASK-011: STT-V2 Long-Audio Transcription & Timestamp Fixes](../TASK-011-STT-V2-Long-Audio-Transcription-Fixes/README.md)** which:

1. Implemented chunked long-form inference for Optimum ONNX (15 s default chunks with 2.5 s stride overlap)
2. Fixed word timestamp extraction by normalizing Whisper's `{"timestamp": (start, end)}` tuple format
3. Populated segment-level data from chunked inference
4. Added 15 unit tests covering the fixes

TASK-011 has **higher priority** than TASK-010 — optimizing inference speed is meaningless if the inference itself produces wrong results.

## Implementation Summary

All four optimization tasks have been implemented and verified:

### Files Modified

| File | Changes |
|------|---------|
| `apps/stt-v2/src/stt_v2/models/onnx_loader.py` | Added `_is_coreml_available()` detection helper; added `_resolve_num_threads()` for dynamic thread count; updated `_load_with_optimum()` to use CoreML with provider options (`MLComputeUnits=ALL`, `ModelFormat=MLProgram`, `ModelCacheDirectory`); refactored `_get_providers()` to return tuple-based format with CoreML options; replaced hardcoded `intra_op_num_threads=4` with configurable auto-sizing; updated `unload()` to use `cleanup_accelerator_memory()` |
| `apps/stt-v2/src/stt_v2/models/base_loader.py` | Updated `_get_torch_dtype()` to return float16 for MPS (in addition to CUDA); added `cleanup_accelerator_memory()` utility function that handles CUDA, MPS, and CPU backends |
| `apps/stt-v2/src/stt_v2/models/huggingface_loader.py` | Updated `unload()` to use `cleanup_accelerator_memory()` instead of CUDA-only cache clearing |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | Added `onnx_num_threads` setting (default: 0 = auto) |
| `apps/stt-v2/.env.example` | Added `ONNX_NUM_THREADS=0` with documentation on auto-sizing, Apple Silicon, and manual override |

### New Test Files

| File | Tests | Coverage |
|------|-------|----------|
| `apps/stt-v2/tests/unit/test_onnx_loader.py` | 12 tests | CoreML detection, Optimum CoreML selection/fallback/CUDA priority, `_get_providers()` tuple format, thread count resolution, MPS unload cleanup |
| `apps/stt-v2/tests/unit/test_base_loader.py` | 10 tests | float16 auto-detection (MPS/CUDA/CPU), explicit type override, `cleanup_accelerator_memory()` on CUDA/MPS/CPU/missing-torch |
| `apps/stt-v2/tests/unit/test_huggingface_loader.py` | 3 tests | Unload calls cleanup, component deletion, error handling |

### Test Results

- **937 total tests passed**, 4 skipped (ML-specific requiring full GPU stack)
- **25 new tests** added for TASK-010 enhancements
- Zero regressions across the entire test suite

### Key Implementation Details

**Task 1 — CoreML EP**: Both the Optimum loader (`_load_with_optimum`) and standard ONNX loader (`_get_providers`) now detect CoreML availability and configure it with `MLComputeUnits=ALL`, `ModelFormat=MLProgram`, `RequireStaticInputShapes=0`, and a `ModelCacheDirectory` to avoid slow re-compilation. CUDA takes priority when available.

**Task 2 — float16 on MPS**: The `_auto_dtype()` helper inside `_get_torch_dtype()` checks for MPS availability (via `torch.backends.mps.is_available()`) and returns float16, providing ~2x inference speedup for all PyTorch models on Apple Silicon.

**Task 3 — Dynamic Threads**: Replaced hardcoded `intra_op_num_threads=4` / `inter_op_num_threads=4` with `_resolve_num_threads()` which reads from `ONNX_NUM_THREADS` (default 0 = auto-size to physical core count). Removed `inter_op_num_threads` override since Whisper uses sequential execution mode.

**Task 4 — MPS Memory Cleanup**: Added `cleanup_accelerator_memory()` module-level function in `base_loader.py` that safely clears CUDA or MPS memory pools. Called from both `HuggingFaceLoader.unload()` and `ONNXLoader.unload()` after `gc.collect()`, following the correct cleanup order: `del model` -> `gc.collect()` -> `empty_cache()`.

## Change History

*No subsequent changes yet.*
