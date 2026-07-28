# STT Service

**Owner**: Platform / Speech · **Introduced**: STT-001 · **Last verified**: 2026-07-21

High-availability Speech-to-Text service with multi-model support for the HOPE platform.

## Overview

STT is a Python FastAPI service (port **8861**) that provides:

- **Live streaming transcription** via WebSocket (through API Gateway)
- **Batch file transcription** via Dramatiq job queue
- **Multi-engine ASR** via a `(kind, name)` processor registry (TASK-505): Whisper
  (`faster_whisper`, `onnx`/`onnx_optimum`, `whisper_cpp`/GGUF), NVIDIA NeMo
  (`nemo` Parakeet + `parakeet_cpp`/ggml), Azure Speech (`azure_speech`), and
  Azure AI Foundry (`azure_foundry`, MAI). Engines self-declare their
  `(device, compute, mode)` capability matrix so a pipeline fails fast at load
  time, not at first inference.
- **Pipeline schema v2** (TASK-505): YAML pipelines carry declarable
  normalize/resample/denoise/endpoint/segment-merge stages and a
  `provider :: model[@rev]` model shorthand; v2 fields also parse under v1.x
  (forward-tolerant). Registry keys — never import paths — appear in YAML, so
  tenant-editable configs cannot execute arbitrary code.
- **Voice Activity Detection (VAD)**: Silero VAD v5 (ONNX) with per-session streaming state
- **Speaker Diarization**: pluggable embedding extraction (default
  `pyannote/wespeaker-voxceleb-resnet34-LM`, 256-dim; SpeechBrain **ECAPA-TDNN**,
  192-dim, selected by a `speechbrain/*` model id — TASK-505 D1 cutover) with
  in-memory, session-scoped speaker tracking, plus an optional self-hosted
  **Streaming Sortformer** frame-level backend for the live 2-speaker loop
  (`DiarizationConfig.backend == "sortformer"`, GPU-only; degrades to "no labels"
  until weights + NeMo runtime are staged)
- **On-first-request model loading with idle-TTL eviction** (TASK-529 lifecycle)
- **Read-only database access** for pipeline configurations and speaker voice profiles

> **Speaker identity & persistence (TASK-330 note).** Speaker diarization is
> **in-memory and session-scoped**: within a consultation a `SpeakerTracker`
> assigns and matches speakers with no external vector store. **Cross-session**
> speaker identity is persisted via **PostgreSQL voice profiles** — at session
> start `diarization.preseed.preseed_speaker()` loads the doctor's stored voice
> embedding and registers it so segments are labelled with the real display name.
>
> The earlier **Qdrant-backed speaker store was removed by design** during the
> diarization refactor (commit `feat(diarization): implement speaker tracking and
> embedding extraction`). Any provisioned `stt_speaker_embeddings` Qdrant
> collection is **legacy/unused** by STT — the absence of a `core/vectorstore`
> module is **intentional, not a regression**.

## Architecture

```
┌─────────────────────────┐
│    API Gateway (NestJS) │
│    - Auth/RBAC          │
│    - WebSocket proxy    │
│    - Job management     │
└───────────┬─────────────┘
            │
    ┌───────┴───────┐
    │ Dramatiq/Redis│
    └───────┬───────┘
            │
┌───────────┴──────────────────────────────────────┐
│    STT Service                                │
│    ┌───────────────┐  ┌─────────────────────┐    │
│    │ Transcription │  │ Speaker Diarize     │    │
│    │ + VAD (Silero │  │ (Pyannote, in-mem)  │    │
│    └──────┬────────┘  └────────┬────────────┘    │
│           │                    │                 │
│    ┌──────┴────────────────────┴───────┐         │
│    │ Model Loading (HF, ONNX, Azure)   │         │
│    └───────────────────────────────────┘         │
└──────────────────────────────────────────────────┘
            │                 │
     ┌──────┴──────┐   ┌──────┴──────┐
     │ PostgreSQL  │   │   MinIO     │
     │ (read-only) │   │ (audio blob)│
     └─────────────┘   └─────────────┘
```

## Quick Start

### Prerequisites

- **Python 3.11+**
- **conda** (Anaconda or Miniconda — recommended for managing PyTorch + native deps)
- **Docker** (for infrastructure: PostgreSQL, Redis, MinIO)
- **FFmpeg 6.x** (required by torchcodec/pyannote.audio; installed via conda)

### Infrastructure Services

Start the infrastructure services from the **monorepo root**:

```bash
# Core services: PostgreSQL, Redis, MinIO
docker compose -f infrastructure/docker/docker-compose.yml up -d

# Extended services: Vault (+ Qdrant, which is NOT used by STT diarization — see Overview note)
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml up -d
```

Verify services are healthy:

| Service    | Port                       | Health Check                            |
| ---------- | -------------------------- | --------------------------------------- |
| PostgreSQL | 5432                       | `pg_isready -U postgres`                |
| Redis      | 6379                       | `redis-cli ping`                        |
| MinIO      | 9000 (API), 9001 (Console) | http://localhost:9000/minio/health/live |
| Vault      | 8200                       | http://localhost:8200/v1/sys/health     |

### Conda Environment Setup

STT uses a **conda environment** for all development platforms. This is required because
PyTorch, torchaudio, and pyannote.audio have native binary dependencies that conda manages
correctly across Apple Silicon (MPS), Linux (CUDA), and CPU-only environments.

#### Step 1: Create the conda environment

```bash
# Create environment with Python 3.11
conda create -n arcaenv python=3.11 -y
conda activate arcaenv
```

#### Step 2: Install FFmpeg (required for pyannote.audio / torchcodec)

```bash
# FFmpeg 6.x is required — torchcodec links against libavutil.58
# Do NOT use FFmpeg 7+ or 8+ (incompatible library versions)
conda install -c conda-forge 'ffmpeg>=6,<7' -y
```

#### Step 3: Install Python dependencies

```bash
cd apps/stt

# Install the package in editable mode with ML + dev + test dependencies
pip install -e ".[ml,dev,test]"
```

#### Step 4: Verify the environment

```bash
python -c "
import torch; print(f'torch {torch.__version__} | MPS: {torch.backends.mps.is_available()} | CUDA: {torch.cuda.is_available()}')
import torchaudio; print(f'torchaudio {torchaudio.__version__}')
import pyannote.audio; print(f'pyannote.audio {pyannote.audio.__version__}')
import azure.cognitiveservices.speech as s; print(f'azure-speech {s.__version__}')
import onnxruntime; print(f'onnxruntime {onnxruntime.__version__} | providers: {onnxruntime.get_available_providers()}')
print('All imports OK')
"
```

Expected output on Apple Silicon:

```
torch 2.8.0 | MPS: True | CUDA: False
torchaudio 2.8.0
pyannote.audio 4.0.3
azure-speech 1.48.1
onnxruntime 1.23.2 | providers: ['CoreMLExecutionProvider', 'AzureExecutionProvider', 'CPUExecutionProvider']
All imports OK
```

> **IMPORTANT — Dependency Version Constraints**
>
> `pyannote.audio 4.x` hard-pins `torch==2.8.0` and `torchaudio==2.8.0`.
> Do **NOT** upgrade torch past 2.8.x until pyannote releases a compatible version.
> torch 2.8.0 has full MPS (Apple Silicon) and CUDA support.
>
> See `pyproject.toml` `[project.optional-dependencies]` for the full constraint rationale.

#### Platform-Specific Notes

**Apple Silicon (M1/M2/M3/M4)**

The conda activation script automatically sets `DYLD_LIBRARY_PATH` so that torchcodec
(a pyannote.audio dependency) can find the FFmpeg shared libraries installed by conda.
This is configured in `$CONDA_PREFIX/etc/conda/activate.d/env_vars.sh`.

If you see a `torchcodec: Could not load libtorchcodec` warning, run:

```bash
# Manual fix (normally done automatically by conda activate)
export DYLD_LIBRARY_PATH="$CONDA_PREFIX/lib:$DYLD_LIBRARY_PATH"
```

**Linux with NVIDIA CUDA**

```bash
# Use the ml-gpu extras instead of ml
pip install -e ".[ml-gpu,dev,test]"

# Verify CUDA is available
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

**CPU-only (CI/CD, lightweight development)**

```bash
# Install without ML dependencies
pip install -e ".[dev,test]"

# Tests will auto-skip ML-dependent tests
```

### Configuration

`pnpm setup:dev` creates `.env.dev` for you (from the consolidated `.env.sample` at the repo root — TASK-583), only if it doesn't already exist. Manually: `cp .env.sample .env.dev`.

#### Core Service Configuration

| Variable           | Description                  | Default                                                      |
| ------------------ | ---------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`     | PostgreSQL connection string | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` |
| `REDIS_URL`        | Redis connection string      | `redis://localhost:6379/0`                                   |
| `MINIO_ENDPOINT`   | MinIO endpoint               | `localhost:9000`                                             |
| `MINIO_ACCESS_KEY` | MinIO access key             | `minio_admin`                                                |
| `MINIO_SECRET_KEY` | MinIO secret key             | `minio_admin`                                                |
| `API_GATEWAY_URL`  | Internal API Gateway URL     | `http://localhost:8868/api/v1`                                      |
| `API_GATEWAY_KEY`  | Internal service auth key    | -                                                            |

#### ASR Engine Configuration

| Variable                | Description                              | Default            |
| ----------------------- | ---------------------------------------- | ------------------ |
| `AZURE_SPEECH_KEY`      | Azure Speech subscription key            | -                  |
| `AZURE_SPEECH_REGION`   | Azure Speech region                      | -                  |
| `HUGGINGFACE_TOKEN`     | HuggingFace API token (for gated models) | -                  |
| `HUGGINGFACE_CACHE_DIR` | Model download cache directory           | `/models/hf-cache` |

#### Voice Activity Detection (Silero VAD v5)

| Variable                      | Description                                          | Default |
| ----------------------------- | ---------------------------------------------------- | ------- |
| `VAD_MODEL_PATH`              | Path to Silero ONNX model (auto-downloaded if empty) | -       |
| `VAD_THRESHOLD`               | Speech probability threshold (0.0–1.0)               | `0.5`   |
| `VAD_MIN_SPEECH_DURATION_MS`  | Min speech segment length                            | `250`   |
| `VAD_MIN_SILENCE_DURATION_MS` | Min silence to end speech                            | `500`   |
| `VAD_SPEECH_PAD_MS`           | Padding before speech onset                          | `30`    |
| `VAD_SAMPLE_RATE`             | VAD input sample rate                                | `16000` |

#### Speaker Diarization (Pyannote)

| Variable                           | Description                          | Default                                     |
| ---------------------------------- | ------------------------------------ | ------------------------------------------- |
| `DIARIZATION_HF_MODEL_ID`          | Speaker-embedding model (a `speechbrain/*` id selects the ECAPA-TDNN service) | `pyannote/wespeaker-voxceleb-resnet34-LM` |
| `DIARIZATION_SIMILARITY_THRESHOLD` | Speaker matching threshold (0.0–1.0) | `0.7`                                       |
| `DIARIZATION_DEVICE`               | Inference device (auto, cuda, cpu)   | `auto`                                      |
| `VOICE_PROFILE_EMBEDDING_DIM`      | Embedding dimension — must match the `UserVoiceProfile.embedding` column (256 = wespeaker; 192 = ECAPA-TDNN) | `256`   |

#### Punctuation Restoration (Cadence)

| Variable                     | Description                                       | Default   |
| ---------------------------- | ------------------------------------------------- | --------- |
| `PUNCTUATION_ENABLED`        | Global kill-switch for Cadence punctuation        | `false`   |
| `PUNCTUATION_MODEL_NAME`     | `Cadence` (1B) or `Cadence-Fast` (270M)           | `Cadence` |
| `PUNCTUATION_MODEL_CACHE_DIR`| Weights cache dir (empty = HF default cache)      | -         |
| `PUNCTUATION_DEVICE`         | Inference device (`cpu`, `cuda`, `auto`)          | `auto`    |
| `PUNCTUATION_MAX_LENGTH`     | Max sequence length / sliding window width        | `300`     |

`PUNCTUATION_ENABLED` defaults to `false`: the production Whisper pipelines
already emit punctuation/casing, and `cadence-punctuation 1.1.0` cannot load
under the pinned transformers 5.x. With the flag off the Cadence model is never
loaded, keeping the boot log free of its `FATAL` traceback.

**Precedence**: the global flag wins over per-pipeline YAML
`postprocessing.punctuation.enabled: true`. When the kill-switch is off (or the
model fails to load at startup), pipelines that request punctuation get their
text passed through unchanged and the service logs a one-time warning at the
first suppressed call. Enable the flag only with a transformers/cadence
combination that is known to load the model.

#### Worker & Inference

| Variable              | Description                         | Default           |
| --------------------- | ----------------------------------- | ----------------- |
| `WORKER_THREADS`          | Dramatiq worker threads per process     | `4`               |
| `WORKER_POLL_TIMEOUT_MS`  | Consumer poll max-backoff in ms          | `1000`            |
| `WORKER_MAX_RETRIES`      | Max retry attempts                       | `3`               |
| `INFERENCE_POOL_SIZE` | ProcessPoolExecutor size (0 = auto) | `0`               |

#### Future / Reserved

| Variable                | Description                | Default |
| ----------------------- | -------------------------- | ------- |
| `MLFLOW_TRACKING_URI`   | MLFlow tracking server URI | -       |
| `MLFLOW_MODEL_REGISTRY` | MLFlow model registry URI  | -       |

### Running the Service

**Prerequisites**: Ensure the conda environment is activated and all infrastructure containers are running.

```bash
# Activate the environment
conda activate arcaenv

# Terminal 1: Start the FastAPI server (with hot reload)
uvicorn stt.main:app --host 0.0.0.0 --port 8861 --reload

# Terminal 2: Start Dramatiq workers
python -m stt.worker
```

**Alternative methods (if entrypoints are installed):**

```bash
# Start server via console_scripts entrypoint
stt

# Start workers via console_scripts entrypoint
stt-worker
```

> The worker process initializes VAD and diarization services on startup
> and cleans them up on graceful shutdown (SIGTERM/SIGINT).

## Project Structure

```
apps/stt/
├── src/
│   └── stt/
│       ├── main.py              # FastAPI entrypoint
│       ├── worker.py            # Dramatiq worker entrypoint (init/cleanup for all services)
│       ├── core/                # Shared infrastructure
│       │   ├── config/          # Settings (Pydantic), constants
│       │   ├── database/        # SQLAlchemy (read-only)
│       │   ├── messaging/       # Dramatiq broker setup
│       │   ├── storage/         # MinIO client
│       │   ├── api_client/      # API Gateway client
│       │   └── exceptions.py    # Custom exceptions (DiarizationError, AudioProcessingError, etc.)
│       ├── transcription/       # Transcription domain (batch_service, preprocessing)
│       ├── pipeline/            # Pipeline domain (YAML parser, DTOs with DiarizationConfig)
│       ├── vad/                 # Voice Activity Detection (Silero VAD v5 ONNX)
│       │   ├── silero_service.py   # ONNX session management, batch + streaming inference
│       │   ├── session_manager.py  # Per-session state for streaming VAD
│       │   └── dto.py              # SpeechSegment, VADResult, VADSessionState
│       ├── processors/          # (kind, name) processor registry + ASR engine specs/adapters (TASK-505)
│       │   ├── registry.py           # Lazy (kind,name)→ProcessorSpec registry, hardware-binding resolver
│       │   ├── base.py               # Capability / HardwareBinding / ProcessorSpec, closed STAGE_KINDS
│       │   ├── asr_capabilities.py   # Import-cheap ASR engine capability declarations
│       │   └── asr_engines.py        # Delegation adapters (batch + streaming dispatch)
│       ├── diarization/         # Speaker Diarization (pluggable embeddings + in-memory tracking)
│       │   ├── embedding_service.py   # Factory: pyannote (wespeaker) or SpeechBrain ECAPA-TDNN by model id
│       │   ├── pyannote_embedding.py  # Pyannote/wespeaker embedding extraction (256-dim default)
│       │   ├── speechbrain_embedding.py # SpeechBrain ECAPA-TDNN embedding extraction (192-dim)
│       │   ├── streaming_sortformer.py # Self-hosted NeMo Streaming Sortformer (live 2-speaker, GPU, gated)
│       │   ├── speaker_tracker.py     # In-memory, session-scoped speaker store
│       │   ├── speaker_identifier.py  # Session-scoped identify + register (no external I/O)
│       │   ├── preseed.py             # Pre-seed tracker from DB voice profile (cross-session identity)
│       │   └── dto.py                 # DiarizedSegment, DiarizationResult, SpeakerIdentification
│       ├── models/              # AI model loaders (HF, ONNX, Azure Speech, NeMo, parakeet.cpp, Azure Foundry)
│       ├── storage/             # Audio storage domain
│       └── health/              # Health checks
├── tests/
│   ├── unit/                    # Fast tests, mocked dependencies
│   ├── integration/             # Cross-module tests, mocked external services
│   └── e2e/                     # Real-data tests with actual audio files
├── docker/
│   ├── Dockerfile
│   └── docker-compose.dev.yml
└── pyproject.toml               # Dependencies, pytest config, tooling
```

## API Endpoints

Health lives under the `/api/v1` prefix; internal, transcription, streaming, and
voice-profile routers mount their own prefixes. Browsers reach transcription and
streaming only through the API Gateway.

| Method | Endpoint                          | Description                     |
| ------ | --------------------------------- | ------------------------------- |
| `GET`  | `/api/v1/health` `/health/live` `/health/ready` | Health / liveness / readiness |
| `GET`  | `/api/v1/ready` `/api/v1/live`    | Readiness / liveness aliases    |
| `GET`  | `/metrics`                        | Prometheus metrics              |
| `GET`  | `/internal/cache/stats`           | Model cache statistics          |
| `POST` | `/internal/cache/clear`           | Clear model cache               |
| `GET`  | `/internal/cache/model/{slug}`    | Per-model cache entry           |
| `GET`  | `/internal/pipelines/loaded`      | Loaded pipeline inventory       |
| `GET`  | `/internal/sessions`              | Streaming session inventory     |
| `GET`  | `/internal/streaming/status`      | Streaming subsystem status      |
| `POST` | `/internal/sessions/cleanup`      | Reap stale streaming sessions   |

## Development

### Running Tests

STT uses a **platform-aware testing infrastructure** that supports CPU, GPU (NVIDIA CUDA), and Apple Silicon (MPS) environments.

#### Running with conda

```bash
conda activate arcaenv
cd apps/stt

# Run all tests
conda run -n arcaenv pytest tests/ -v

# Run unit tests only
conda run -n arcaenv pytest tests/unit/ -v

# Run integration tests (requires Docker infrastructure running)
conda run -n arcaenv pytest tests/integration/ -v

# Run E2E tests (requires real audio test data)
conda run -n arcaenv pytest tests/e2e/ -v

# Run with coverage
conda run -n arcaenv pytest tests/ --cov=stt --cov-report=html -v
```

#### From monorepo root (pnpm scripts)

```bash
pnpm stt:test:unit       # Unit tests
pnpm stt:test:cov        # With coverage
```

> **Note**: Tests marked with `@requires_torch` will be skipped if PyTorch is not installed.
> Use the full `.[ml,dev,test]` install to run all ML tests.

#### Test Markers

Tests are marked with platform-specific markers for selective execution:

| Marker                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `@pytest.mark.cpu`         | CPU-only tests                                |
| `@pytest.mark.gpu`         | Tests requiring any GPU (CUDA or MPS)         |
| `@pytest.mark.cuda`        | Tests requiring NVIDIA CUDA                   |
| `@pytest.mark.mps`         | Tests requiring Apple Silicon MPS             |
| `@pytest.mark.ml`          | Tests requiring ML dependencies (torch, etc.) |
| `@pytest.mark.slow`        | Long-running tests (model loading, etc.)      |
| `@pytest.mark.integration` | Integration tests (require containers)        |

Example usage:

```bash
# Run only CPU tests
conda run -n arcaenv pytest tests/unit -m "cpu"

# Run tests excluding slow ones
conda run -n arcaenv pytest tests/unit -m "not slow"

# Run GPU tests only
TEST_PLATFORM=cuda conda run -n arcaenv pytest tests/unit -m "gpu or cuda"
```

#### Test Infrastructure

Integration and E2E tests use the monorepo's centralized test infrastructure:

```bash
# Start test services (from monorepo root)
pnpm infra:test:up

# Stop test services
pnpm infra:test:down
```

Test service ports (isolated from development):

- PostgreSQL: `5433` (test) vs `5432` (dev)
- Redis: `6380` (test) vs `6379` (dev)
- MinIO: `9002` (test) vs `9000` (dev)

#### CI/CD Pipeline

STT tests run in **GitLab CI** as the `test-stt` job (`.gitlab/ci/test.yml`)
on a CPU (`ubuntu`) runner — unit tests plus the non-integration/non-e2e suite.
The `@pytest.mark.gpu` / `.cuda` / `.mps` markers are for **local** selective runs
on GPU/Apple-Silicon hosts; CI does not provision GPU or macOS runners.

### Code Quality

```bash
conda activate arcaenv

# Format code (black; ruff owns import order via --select I — isort is NOT used)
make format          # or: black src tests && ruff check --fix --select I src tests

# Lint
make lint            # or: ruff check src tests

# Type check
make type-check      # or: mypy src

# All quality checks at once
make quality         # lint + format-check + type-check
```

## Troubleshooting

### `torchcodec: Could not load libtorchcodec` or missing FFmpeg libs

`pyannote.audio` depends on `torchcodec`, which links against FFmpeg 6.x shared libraries
(`libavutil.58`, `libavcodec.60`, etc.). These must be on the dynamic linker path.

**Fix:**

```bash
# Ensure FFmpeg 6.x is installed (not 7 or 8)
conda install -c conda-forge 'ffmpeg>=6,<7' -y

# If the conda activation script is missing, create it:
mkdir -p "$CONDA_PREFIX/etc/conda/activate.d"
cat > "$CONDA_PREFIX/etc/conda/activate.d/env_vars.sh" << 'EOF'
#!/bin/sh
export OLD_DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$CONDA_PREFIX/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
EOF

mkdir -p "$CONDA_PREFIX/etc/conda/deactivate.d"
cat > "$CONDA_PREFIX/etc/conda/deactivate.d/env_vars.sh" << 'EOF'
#!/bin/sh
export DYLD_LIBRARY_PATH="$OLD_DYLD_LIBRARY_PATH"
unset OLD_DYLD_LIBRARY_PATH
EOF

# Reactivate environment
conda deactivate && conda activate arcaenv
```

### `pyannote.audio` wants to downgrade torch

`pyannote.audio 4.x` hard-pins `torch==2.8.0`. If pip tries to downgrade or upgrade torch:

```bash
# Install the exact pinned versions
pip install torch==2.8.0 torchaudio==2.8.0

# Then install pyannote
pip install 'pyannote.audio>=3.3.0'
```

Do NOT upgrade torch past 2.8.x while using pyannote.audio 4.x.

### `ModuleNotFoundError: No module named 'azure'`

`azure-cognitiveservices-speech` is a core dependency (not optional).
If you see import errors for it, your base install is incomplete:

```bash
pip install -e "."
```

### Tests fail with `ModuleNotFoundError` for `pyannote`, `torch`, `soundfile`, etc.

These are ML-only dependencies (in the `[ml]` extra). Unit tests mock them and should work
without them, but integration/E2E tests need the full stack:

```bash
pip install -e ".[ml,dev,test]"
```

### Speaker diarization does not persist across sessions

This is expected. STT speaker diarization is **in-memory and session-scoped**
(see the Overview note). Cross-session speaker identity comes from **PostgreSQL
voice profiles** via `diarization.preseed.preseed_speaker()`, not from Qdrant. The
legacy `stt_speaker_embeddings` Qdrant collection is no longer read or written by
STT, so a missing collection is **not** an STT error.

### Database errors in tests (`type "core.ModelCategory" does not exist`)

This indicates the PostgreSQL schema is not initialized. Run migrations from the monorepo root:

```bash
pnpm db:migrate:deploy    # → pnpm --filter @arcaai/database db:migrate:deploy
```

### HuggingFace gated model access

Pyannote models on HuggingFace are gated. You need to:

1. Create a HuggingFace account at https://huggingface.co
2. Accept the model license at https://huggingface.co/pyannote/embedding
3. Create an access token at https://huggingface.co/settings/tokens
4. Set the token in your environment:

```bash
export HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Supported ASR Engines

Registry name → runtime, from `processors/asr_capabilities.py`. Engine names are
`AiModelFormat` values lowercased, so YAML engine strings and registry keys are
one vocabulary.

| Registry name           | Model Source              | Runtime          | Best For                          |
| ----------------------- | ------------------------- | ---------------- | --------------------------------- |
| `faster_whisper`        | HuggingFace               | CTranslate2      | Fast CPU/CUDA Whisper, batch+stream |
| `onnx` / `onnx_optimum` | HuggingFace               | ONNX Runtime     | Offline CPU/GPU (optimum adds streaming) |
| `whisper_cpp`           | GGUF (whisper-large-v3-turbo) | ggml (pywhispercpp) | CPU/Metal/CUDA offline (TASK-507) |
| `safetensor`            | HuggingFace               | PyTorch/Transformers | CUDA/MPS/CPU HF models          |
| `nemo`                  | HuggingFace / NVIDIA NGC  | PyTorch (NeMo)   | High-accuracy Parakeet, CUDA GPUs |
| `parakeet_cpp`          | ggml quantized            | ggml             | CPU/Metal/CUDA Parakeet (TASK-505 P3) |
| `azure_speech`          | Azure Cloud API           | REST/WebSocket   | Cloud-hosted, no GPU              |
| `azure_foundry`         | Azure AI Foundry (MAI)    | Cloud (batch)    | Cloud batch preview (TASK-505 P3) |
| `sarvam`                | Sarvam Cloud API          | REST             | Indic languages + English, BYOK (TASK-567) |
| `openai`                | OpenAI Cloud API          | REST             | `gpt-4o-transcribe` family, BYOK (TASK-567) |

### Per-tenant BYOK + fallback (TASK-567)

`azure_speech`, `sarvam`, and `openai` accept an optional per-tenant credential
override (`provider_overrides`, keyed by `azure-speech`/`sarvam`/`openai`) instead
of the env-only keys above — the gateway resolves a tenant's
`TenantSttProviderCredential` rows and injects the decrypted override into the
streaming session-create request (in-memory only, never persisted/logged) or the
Dramatiq batch worker pulls it via `GET /internal/stt/provider-overrides`. A
tenant may also configure a `fallbackPipelineId`: `SessionManager`'s
`EngineSwitchController` swaps the live session's ASR engine to that pipeline
one-way on a classified outage (auth/quota immediately, transient after N
consecutive failures) or on a manual `POST
/internal/streaming/sessions/{id}/switch`, publishing a `status`/
`provider_switched` result on the session's result stream; `transcribe_file`
re-dispatches once on the fallback within the same Dramatiq attempt for batch
jobs. See `docs/implementation/TASK-567-Tenant-STT-Fallback-Provider-BYOK/README.md`.

## Documentation

- [Architecture Design](../../docs/implementation/STT-001-STT-Service-Architecture/README.md)
- [Architecture Planning](../../docs/implementation/STT-001-STT-Service-Architecture/planning.md)
- [Worker Architecture Refactor](../../docs/implementation/TASK-007-STT-Worker-Architecture-Refactor/README.md)
- [Azure Speech ASR Engine](../../docs/implementation/TASK-006-Azure-Speech-ASR-Engine-STT/README.md)
- [E2E Test Coverage](../../docs/implementation/TASK-005-STT-Real-Data-E2E-Tests/README.md)

## License

MIT License - ARCA AI Team
