# TASK-007: STT-V2 Worker Architecture Refactor

- **Ticket**: TASK-007
- **Created**: 2026-02-07
- **Last Updated**: 2026-02-07
- **Status**: Completed

## Requirement Analysis

Refactor the STT-V2 service to support 100+ concurrent real-time transcription users with production-grade:

1. **Worker Architecture** — All AI inference must run in workers with process-pool isolation for CPU/GPU workloads
2. **Fixed ASR Engines** — Whisper (ONNX via HuggingFace), NeMo Parakeet (HuggingFace), Azure Speech (API key per pipeline)
3. **Voice Activity Detection** — Silero VAD v5 using ONNX for streaming and batch, per-session state management
4. **Speaker Diarization** — Pyannote embedding extraction with Qdrant vector storage, multi-tenant support
5. **Extensibility** — Future support for self-hosted MLFlow model registry and MLFlow Serve + KServe inference

### Acceptance Criteria

- Worker processes scale to handle 100+ concurrent streaming sessions
- VAD uses Silero v5 ONNX with proper state isolation per session
- Speaker embeddings stored in Qdrant with tenant-scoped queries
- ASR engines limited to: whisper/onnx, nemo/parakeet, azure speech
- Pipeline YAML supports diarization configuration
- All new modules have comprehensive tests

## Current State Evaluation

### Existing Architecture
- **Workers**: Dramatiq with Redis broker, `stt_batch` and `stt_streaming` queues
- **Models**: Multi-format support (HuggingFace, ONNX, NeMo, Azure Speech) via `BaseModelLoader` + `ModelCache`
- **VAD**: Generic implementation in `preprocessing.py` supporting Silero VAD via `get_speech_timestamps` (PyTorch, not ONNX)
- **Diarization**: `ModelTaskType.SPEAKER_DIARIZATION` enum exists; Azure captures `speaker_id` — no dedicated diarization pipeline
- **Qdrant**: Infrastructure exists (docker-compose, init script for `stt_speaker_embeddings` collection with 512-dim vectors)

### Gaps Identified
1. No process-pool isolation for ML inference (threads share GIL)
2. VAD uses PyTorch JIT instead of ONNX (1.7x slower)
3. No per-session VAD state management for streaming
4. No pyannote embedding extraction service
5. No Qdrant client in stt-v2 codebase
6. Worker scaling not optimized for 100+ concurrent users
7. No diarization config in pipeline YAML/DTOs

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Worker Process Pool Architecture
- Add `concurrent.futures.ProcessPoolExecutor` for CPU-bound inference
- Separate Dramatiq queues: `stt_batch`, `stt_streaming`, `stt_vad`, `stt_diarization`
- Configure worker processes: `processes=CPU_cores`, `threads=2` for CPU inference
- GPU isolation via `CUDA_VISIBLE_DEVICES` per process

#### 1.2 Settings & Configuration Updates
- Add Qdrant connection settings
- Add VAD-specific settings (Silero model path, threshold, etc.)
- Add diarization settings (pyannote model, similarity threshold)
- Add worker pool sizing configuration
- Add future-proof MLFlow settings (disabled by default)

### Phase 2: VAD — Silero v5 ONNX

#### 2.1 Dedicated VAD Service Module
- New `stt_v2/vad/` package with:
  - `silero_service.py` — Silero VAD v5 ONNX wrapper with per-session state
  - `dto.py` — VAD-specific DTOs (SpeechSegment, VADSessionState)
  - `session_manager.py` — Session state lifecycle management
- ONNX Runtime with single-thread CPU execution
- Support both batch (full file) and streaming (chunk-by-chunk) modes

### Phase 3: Diarization — Pyannote + Qdrant

#### 3.1 Qdrant Client Module
- New `stt_v2/core/vectorstore/` package with:
  - `client.py` — Async Qdrant client singleton with connection pooling
  - `speaker_store.py` — Multi-tenant speaker embedding CRUD
- Single collection with `is_tenant=True` payload index
- HNSW config: `m=0`, `payload_m=16`, `ef_construct=200` for 512-dim cosine

#### 3.2 Speaker Diarization Service
- New `stt_v2/diarization/` package with:
  - `embedding_service.py` — Pyannote embedding extraction
  - `speaker_identifier.py` — Speaker lookup/registration via Qdrant
  - `dto.py` — Diarization DTOs (SpeakerEmbedding, SpeakerIdentification)

### Phase 4: Pipeline & ASR Refinement

#### 4.1 Pipeline DTO Updates
- Add `DiarizationConfig` to `PipelineSpec`
- Add `ModelRefs.diarization` optional field
- Add `AiModelSource.MLFLOW` (reserved, not implemented)
- Constrain ASR to: ONNX (whisper), NEMO (parakeet), AZURE_SPEECH

#### 4.2 ASR Engine Hardening
- Ensure ONNX loader fetches from HuggingFace
- Ensure NeMo loader fetches Parakeet models from HuggingFace
- Azure Speech uses per-pipeline API key (already supported via `compute_type` field)

### Phase 5: Integration & Testing

#### 5.1 Batch Transcription Flow
- Update `BatchTranscriptionService` to orchestrate: VAD → ASR → Diarization → Result

#### 5.2 Streaming Transcription Flow
- Update `transcribe_stream` actor to use per-session VAD state
- Integrate speaker identification into streaming chunks

## Implementation Summary

*(Updated as implementation progresses)*

### Files Created
- `src/stt_v2/vad/__init__.py`
- `src/stt_v2/vad/dto.py`
- `src/stt_v2/vad/silero_service.py`
- `src/stt_v2/vad/session_manager.py`
- `src/stt_v2/core/vectorstore/__init__.py`
- `src/stt_v2/core/vectorstore/client.py`
- `src/stt_v2/core/vectorstore/speaker_store.py`
- `src/stt_v2/diarization/__init__.py`
- `src/stt_v2/diarization/dto.py`
- `src/stt_v2/diarization/embedding_service.py`
- `src/stt_v2/diarization/speaker_identifier.py`

### Files Modified
- `src/stt_v2/core/config/settings.py` — Qdrant, VAD, diarization, worker pool settings
- `src/stt_v2/pipeline/dto.py` — DiarizationConfig, ModelRefs.diarization, MLFlow source
- `src/stt_v2/pipeline/yaml_parser.py` — Parse diarization config from pipeline YAML
- `src/stt_v2/transcription/preprocessing.py` — Delegate VAD to new silero_service
- `src/stt_v2/transcription/batch_service.py` — Integrate diarization into transcription flow
- `src/stt_v2/worker.py` — Process pool init, VAD/Qdrant/diarization lifecycle
- `pyproject.toml` — New dependencies (qdrant-client, silero-vad/onnx, pyannote.audio, torchaudio, azure-speech)

### Test Files Created/Modified
- `tests/unit/test_vad_silero.py` — VAD service + session manager unit tests with edge cases
- `tests/unit/test_vectorstore.py` — Qdrant speaker store unit tests with multi-tenant filtering
- `tests/unit/test_diarization.py` — Speaker identifier + embedding extraction tests
- `tests/unit/test_settings.py` — Expanded settings tests for new config fields
- `tests/unit/test_worker.py` — Worker init/cleanup lifecycle tests
- `tests/unit/test_batch_service.py` — Diarization integration in batch pipeline
- `tests/integration/test_new_services_integration.py` — Cross-module integration tests (VAD+preprocessing, diarization+vectorstore, batch pipeline)
- `tests/e2e/test_real_data_transcription.py` — Updated E2E tests with VAD and diarization flows

### Test Results (Final)
- **813 passed**, 4 skipped, 0 failures
- 4 errors related to pre-existing database schema setup (unrelated to this task)

## Change History

### Update 1: Dependency Resolution — Apple Silicon (2026-02-07)

**Issue**: `pyannote.audio 4.x` hard-pins `torch==2.8.0` and `torchaudio==2.8.0`, which conflicted
with the previously installed `torch 2.10.0`. Additionally, `torchcodec` (a transitive dependency
of pyannote.audio) could not find FFmpeg shared libraries on macOS.

**Root Cause**:
1. `pyannote.audio` internally requires exact `torch==2.8.0` — any higher or lower version causes
   installation failures or runtime incompatibility
2. `torchcodec` links against FFmpeg 6.x libraries (`libavutil.58`, `libavcodec.60`), but conda's
   default FFmpeg was v8.0.1 (incompatible library versions)
3. macOS `DYLD_LIBRARY_PATH` was not set, so `torchcodec` could not find FFmpeg in `$CONDA_PREFIX/lib`

**Changes Made**:
1. `pyproject.toml`: Pinned `torch>=2.8.0,<2.9.0` and `torchaudio>=2.8.0,<2.9.0` in both `[ml]`
   and `[ml-gpu]` dependency groups with clear comments about the pyannote constraint
2. `pyproject.toml`: Added `torchaudio` as an explicit dependency (previously only pulled transitively)
3. `pyproject.toml`: Extended `[tool.mypy.overrides]` to include `torchaudio`, `pyannote.*`,
   `qdrant_client.*`, `azure.*`, `speechbrain.*` for `ignore_missing_imports`
4. FFmpeg: Installed `ffmpeg>=6,<7` via `conda install -c conda-forge`
5. Created conda activation script at `$CONDA_PREFIX/etc/conda/activate.d/env_vars.sh` to export
   `DYLD_LIBRARY_PATH=$CONDA_PREFIX/lib` for torchcodec library loading
6. Created corresponding deactivation script at `$CONDA_PREFIX/etc/conda/deactivate.d/env_vars.sh`

**Files Modified**:
- `pyproject.toml` (dependency pins + mypy overrides)
- `$CONDA_PREFIX/etc/conda/activate.d/env_vars.sh` (new — environment-local)
- `$CONDA_PREFIX/etc/conda/deactivate.d/env_vars.sh` (new — environment-local)

**Developer Impact**: All developers using the `stt-v2` conda environment must:
1. Install `ffmpeg>=6,<7` via conda-forge
2. Ensure the activation script exists (or manually export `DYLD_LIBRARY_PATH`)
3. Not upgrade torch past 2.8.x until pyannote.audio releases a compatible version

See `apps/stt-v2/README.md` Troubleshooting section for full setup instructions.
