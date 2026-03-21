# STT Service V2

High-availability Speech-to-Text service with multi-model ASR, real-time streaming, voice activity detection, and speaker diarization for the HOPE platform.

## Overview

STT V2 is a Python service that provides speech-to-text capabilities through two primary modes: **batch file transcription** (via Dramatiq job queue) and **live streaming transcription** (via Redis Streams with the API Gateway proxying WebSocket connections). It supports multiple ASR engines, intelligent voice activity detection, and speaker identification backed by a vector database.

Key capabilities:

- **Multi-model ASR** — Whisper (ONNX), NVIDIA NeMo Parakeet, and Azure Speech Service
- **Live streaming** — Real-time transcription via Redis Streams, with per-session VAD state and speaker identification
- **Batch transcription** — Asynchronous file processing through Dramatiq workers
- **Voice Activity Detection** — Silero VAD v5 (ONNX) with per-session LSTM state for streaming
- **Speaker diarization** — Pyannote embedding extraction (512-dim) with Qdrant vector similarity matching
- **LRU model caching** — Configurable cache with TTL to avoid reloading models between requests
- **Pipeline-driven configuration** — YAML-defined pipelines stored in PostgreSQL, selecting models, preprocessing, inference, and postprocessing settings

## Architecture

```
┌─────────────────────────┐
│    API Gateway (NestJS)  │
│    - Auth/RBAC           │
│    - WebSocket proxy     │
│    - Job management      │
└───────────┬──────────────┘
            │
    ┌───────┴───────┐
    │ Dramatiq/Redis│
    └───────┬───────┘
            │
┌───────────┴──────────────────────────────────────┐
│    STT Service V2                                 │
│    ┌───────────────┐  ┌─────────────────────┐     │
│    │ Transcription │  │ Speaker Diarize      │     │
│    │ + VAD (Silero)│  │ (Pyannote + Qdrant)  │     │
│    └──────┬────────┘  └────────┬─────────────┘     │
│           │                    │                    │
│    ┌──────┴────────────────────┴───────┐            │
│    │ Model Loading (HF, ONNX, Azure)   │            │
│    └───────────────────────────────────┘            │
└──────────────────────────────────────────────────── ┘
            │                 │
     ┌──────┴──────┐   ┌──────┴──────┐
     │ PostgreSQL  │   │   Qdrant    │
     │ (read-only) │   │ (vectors)   │
     └─────────────┘   └─────────────┘
```

### Multi-Model ASR

The service abstracts ASR behind a pluggable loader interface. Each pipeline YAML references one or more models by slug (database lookup) or inline definition (HuggingFace ID + engine). Supported engines:

| Engine | Model Source | Runtime | Best For |
|--------|-------------|---------|----------|
| Whisper (ONNX) | HuggingFace / onnx-community | ONNX Runtime + HF Optimum | Fast CPU/GPU inference, offline |
| NeMo Parakeet | HuggingFace / NVIDIA NGC | PyTorch | High-accuracy, CUDA GPUs |
| Azure Speech | Azure Cloud API | REST / WebSocket | Cloud-hosted, no GPU needed |

Model loaders reside in `stt_v2/models/` and share a common `BaseLoader` interface. The LRU cache (`models/cache.py`) holds loaded models in memory with configurable `max_models` and `ttl_seconds`, evicting least-recently-used entries when the cache is full.

### VAD Pipeline

Silero VAD v5 runs as an ONNX session and serves two modes:

- **Batch mode** — Processes an entire audio buffer and returns a list of `SpeechSegment` objects with start/end times and speech probability.
- **Streaming mode** — Maintains per-session LSTM hidden state (`shape [2, 1, 128]`) that persists across audio chunks within a session. The `VADSessionManager` tracks each session's ONNX state, samples processed, and pending speech segments.

Adjacent speech segments within a configurable gap threshold are merged before inference to reduce the number of Whisper `generate()` calls (each incurring encoder overhead).

### Speaker Diarization with Qdrant

Diarization uses a two-stage approach:

1. **Embedding extraction** — Pyannote's embedding model extracts 512-dimensional speaker vectors from speech segments.
2. **Speaker identification** — The `SpeakerIdentifier` queries Qdrant for the nearest vector. If cosine similarity exceeds the threshold, the speaker is matched; otherwise, a new speaker profile is auto-registered.

Qdrant stores speaker embeddings in a cosine-distance collection (`stt_speaker_embeddings`), enabling sub-millisecond nearest-neighbor lookups across potentially thousands of speaker profiles.

### Streaming vs Batch

| Aspect | Streaming | Batch |
|--------|-----------|-------|
| Transport | Redis Streams (audio in, results out) | Dramatiq job queue |
| Entry point | API Gateway WebSocket → `POST /internal/streaming/sessions` | `POST /api/v1/transcribe` or Dramatiq actor |
| VAD state | Per-session LSTM state in memory | Full-buffer single pass |
| Latency | Real-time (~30ms frame intervals) | End-to-end file processing |
| Session management | Capacity guard, heartbeat, auto-reaping | Job timeout and retry |

### Dramatiq Job Queue

Batch transcription jobs flow through Redis-backed Dramatiq queues (`stt_batch`, `default`). Workers are configured with tunable thread counts, timeouts, and retry limits. Each worker process initializes VAD, Qdrant, and diarization services on startup and cleans them up on graceful shutdown.

### Model Caching

An in-memory LRU cache holds loaded model instances (weights, tokenizer, processor). Cache statistics (hits, misses, evictions, memory usage) are exposed via the `/internal/cache/stats` endpoint. Pipeline preloading at startup eliminates cold-start latency by reading `PRELOAD_PIPELINES` from configuration.

## Tech Stack

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Framework | FastAPI + Uvicorn | 0.134.0 / 0.41.0 | Async HTTP/WebSocket server |
| ML Runtime | PyTorch, ONNX Runtime, HF Optimum | 2.8.0 / ≥1.23 / ≥2.1 | Model inference |
| ASR Models | Whisper ONNX, NeMo Parakeet, Azure Speech | — | Speech recognition |
| VAD | Silero VAD v5 (ONNX) | — | Voice activity detection |
| Diarization | pyannote.audio | 4.0.4 | Speaker embedding extraction |
| Video/Audio codec | PyAV (conda) | 13.1.0 | FFmpeg 6.1.2 bindings (transformers dep) |
| Vector Store | Qdrant | — | Speaker embedding similarity search |
| Task Queue | Dramatiq + Redis | — | Async batch job processing |
| Database | PostgreSQL (SQLAlchemy async) | — | Pipeline configuration storage |
| Object Storage | MinIO | — | Audio file storage |
| Observability | Prometheus, OpenTelemetry, structlog | — | Metrics, tracing, structured logging |
| Noise Suppression | pyrnnoise (RNNoise) | — | Audio preprocessing |
| Conda-managed | numpy, scipy, ffmpeg, av, libiconv | 2.4.2 / 1.17.1 / 6.1.2 / 13.1.0 / 1.18 | Native libs (avoid pip symbol conflicts) |

## Getting Started

### Prerequisites

- **Python 3.11+**
- **conda** (Anaconda or Miniconda) — required for managing PyTorch + native dependencies
- **Docker** — for infrastructure services (PostgreSQL, Redis, MinIO, Qdrant)
- **FFmpeg 6.x** — installed via conda (required by torchcodec/pyannote.audio; **not** 7+ or 8+)

### Infrastructure Services

Start infrastructure from the monorepo root:

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d

docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml up -d
```

| Service | Port | Health Check |
|---------|------|-------------|
| PostgreSQL | 5432 | `pg_isready -U postgres` |
| Redis | 6379 | `redis-cli ping` |
| MinIO | 9000 (API), 9001 (Console) | `http://localhost:9000/minio/health/live` |
| Qdrant | 6333 (HTTP), 6334 (gRPC) | `http://localhost:6333/healthz` |

### Conda Environment Setup

The recommended approach is to use the shared setup script from the monorepo root:

```bash
# Full setup with Apple Silicon ML extras
pnpm py:setup:apple

# Or manually:
./scripts/setup-python-env.sh --apple
```

For manual setup:

```bash
conda create -n arcaenv python=3.11 -y
conda activate arcaenv

# Conda-managed native packages (MUST be installed before pip)
conda install -c conda-forge 'ffmpeg>=6.1,<7' 'av>=13.1,<14' 'numpy>=2.4' 'scipy>=1.17' 'libiconv>=1.18' -y
pip install 'omegaconf>=2.3.0'

cd apps/stt-v2

# Full install with ML + dev + test dependencies
pip install -e ".[ml,dev,test]"
```

> **Important**: `numpy`, `scipy`, `av`, and `ffmpeg` MUST be installed via conda (not pip) to avoid native library symbol conflicts on macOS. The pip wheels for these packages link against macOS Accelerate/system libiconv, which conflicts with conda's libopenblas/libiconv.

Verify the environment:

```bash
python -c "
import torch; print(f'torch {torch.__version__} | MPS: {torch.backends.mps.is_available()} | CUDA: {torch.cuda.is_available()}')
import torchaudio; print(f'torchaudio {torchaudio.__version__}')
import torchcodec; print(f'torchcodec {torchcodec.__version__}')
import pyannote.audio; print(f'pyannote.audio {pyannote.audio.__version__}')
import av; print(f'av {av.__version__} (FFmpeg {av.ffmpeg_version_info})')
import onnxruntime; print(f'onnxruntime {onnxruntime.__version__} | providers: {onnxruntime.get_available_providers()}')
from transformers import pipeline; print('transformers.pipeline OK')
print('All imports OK')
"
```

**Platform variants:**

| Platform | Install command |
|----------|----------------|
| Apple Silicon (MPS) | `pip install -e ".[ml,dev,test]"` |
| Linux with CUDA | `pip install -e ".[ml-gpu,dev,test]"` |
| NeMo Parakeet (CUDA required) | `pip install -e ".[ml-gpu,nemo,dev,test]"` |
| CPU-only (CI/CD) | `pip install -e ".[dev,test]"` |

> **Important**: `pyannote.audio >=3.3` hard-pins `torch==2.8.0` and `torchaudio==2.8.0`. Do not upgrade past 2.8.x until a compatible pyannote release is available. NeMo Parakeet (`nemo_toolkit[asr]>=2.6.0`) is a separate optional extra and requires CUDA.

### Running Locally

```bash
conda activate arcaenv

# Terminal 1: FastAPI server (with hot reload)
uvicorn stt_v2.main:app --host 0.0.0.0 --port 8861 --reload

# Terminal 2: Dramatiq workers
python -m stt_v2.worker
```

Alternative via console script entrypoints:

```bash
stt-v2          # Start the FastAPI server
stt-v2-worker   # Start Dramatiq workers
```

## Configuration

All configuration is loaded from environment variables via Pydantic Settings. See the [Configuration Guide](configuration.md) for the complete reference.

Key variable groups:

| Group | Examples |
|-------|---------|
| Core service | `DATABASE_URL`, `REDIS_URL`, `MINIO_ENDPOINT` |
| ASR engines | `AZURE_SPEECH_KEY`, `HUGGINGFACE_TOKEN`, `HUGGINGFACE_CACHE_DIR` |
| Qdrant | `QDRANT_URL`, `QDRANT_COLLECTION_SPEAKERS`, `QDRANT_POOL_SIZE` |
| VAD | `VAD_THRESHOLD`, `VAD_MIN_SPEECH_DURATION_MS`, `VAD_SAMPLE_RATE` |
| Diarization | `DIARIZATION_HF_MODEL_ID`, `DIARIZATION_SIMILARITY_THRESHOLD` |
| Workers | `WORKER_THREADS`, `WORKER_TIMEOUT_MS`, `INFERENCE_POOL_SIZE` |
| Streaming | `STREAMING_MAX_CONCURRENT`, `STREAMING_SESSION_TIMEOUT_S` |

## API Reference

See the [API Reference](api-reference.md) for complete endpoint documentation.

### Summary

**Public endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/transcribe` | Batch transcribe an audio file |
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check (all dependencies) |
| `GET` | `/live` | Simple liveness probe |
| `GET` | `/metrics` | Prometheus metrics |

**Internal endpoints** (called by API Gateway or admin):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/internal/streaming/sessions` | Create streaming session |
| `GET` | `/internal/streaming/sessions/{id}` | Get session status |
| `DELETE` | `/internal/streaming/sessions/{id}` | Finalize/remove session |
| `GET` | `/internal/streaming/availability` | Check streaming capacity |
| `GET` | `/internal/cache/stats` | Model cache statistics |
| `POST` | `/internal/cache/clear` | Clear model cache |
| `GET` | `/internal/cache/model/{slug}` | Specific model info |
| `GET` | `/internal/pipelines/loaded` | Pipelines with cached models |
| `GET` | `/internal/sessions` | Active streaming sessions |
| `GET` | `/internal/streaming/status` | Full streaming module status |
| `POST` | `/internal/sessions/cleanup` | Clean up expired sessions |

## Testing

STT V2 uses a platform-aware testing infrastructure supporting CPU, GPU (CUDA), and Apple Silicon (MPS).

### Running Tests

```bash
conda activate arcaenv
cd apps/stt-v2

# All tests
conda run -n arcaenv pytest tests/ -v

# By layer
conda run -n arcaenv pytest tests/unit/ -v
conda run -n arcaenv pytest tests/integration/ -v    # requires Docker infrastructure
conda run -n arcaenv pytest tests/e2e/ -v             # requires real audio data

# With coverage
conda run -n arcaenv pytest tests/ --cov=stt_v2 --cov-report=html -v
```

From the monorepo root:

```bash
pnpm py:stt-v2:test:unit
pnpm py:stt-v2:test:cov
```

### Test Markers

| Marker | Description |
|--------|-------------|
| `@pytest.mark.cpu` | CPU-only tests |
| `@pytest.mark.gpu` | Tests requiring any GPU (CUDA or MPS) |
| `@pytest.mark.cuda` | Tests requiring NVIDIA CUDA |
| `@pytest.mark.mps` | Tests requiring Apple Silicon MPS |
| `@pytest.mark.apple_silicon` | Tests specific to Apple Silicon platform |
| `@pytest.mark.ml` | Tests requiring ML dependencies (torch, etc.) |
| `@pytest.mark.slow` | Long-running tests (model loading) |
| `@pytest.mark.integration` | Integration tests (require containers) |

```bash
conda run -n arcaenv pytest tests/unit -m "cpu"
conda run -n arcaenv pytest tests/unit -m "not slow"
TEST_PLATFORM=cuda conda run -n arcaenv pytest tests/unit -m "gpu or cuda"
```

### Test Infrastructure

Integration and E2E tests use isolated service ports:

| Service | Dev Port | Test Port |
|---------|----------|-----------|
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| MinIO | 9000 | 9002 |

```bash
pnpm docker:test:up    # Start test services
pnpm docker:test:down  # Stop test services
```

### Code Quality

```bash
black src tests && isort src tests   # Format
ruff check src tests                 # Lint
mypy src                             # Type check
```

## Deployment

### Docker

A multi-stage Dockerfile is provided at `docker/Dockerfile`. Build and run:

```bash
docker build -f docker/Dockerfile -t stt-v2:latest .

docker run -d \
  --name stt-v2 \
  -p 8861:8861 \
  --env-file .env \
  --gpus all \
  stt-v2:latest
```

### Worker Scaling

Worker processes are scaled independently of the FastAPI server:

- **CPU inference**: one Dramatiq process per CPU core, 2-4 threads each
- **GPU inference**: one process per GPU, threads limited by VRAM
- VAD and diarization models are loaded once per worker process

### Qdrant Collection Initialization

The speaker embeddings collection is created automatically by the Docker init container. To recreate manually:

```bash
curl -X PUT http://localhost:6333/collections/stt_speaker_embeddings \
  -H 'Content-Type: application/json' \
  -d '{"vectors": {"size": 512, "distance": "Cosine"}}'
```

## Observability

### Health Checks

| Endpoint | Purpose | Use |
|----------|---------|-----|
| `GET /health` | Liveness probe | Kubernetes `livenessProbe` |
| `GET /live` | Minimal liveness | Lightweight process check |
| `GET /ready` | Readiness probe | Checks DB, Redis, MinIO connectivity |

The readiness check returns per-component health with latency and status (`healthy`, `degraded`, `unhealthy`). Streaming status is reported informationally but does not block readiness.

### Metrics

Prometheus metrics are exposed at `GET /metrics` via `prometheus-fastapi-instrumentator`. Additional custom metrics:

- Request duration histograms by endpoint
- Model cache hit/miss rates
- Active streaming session counts
- Worker job processing times

### Tracing

OpenTelemetry instrumentation covers FastAPI, httpx, and logging. Traces export via OTLP gRPC to any compatible collector (Jaeger, Tempo, etc.).

### Structured Logging

All logging uses `structlog` with JSON output and contextual fields (job_id, session_id, tenant_id). Log levels are configurable via `LOG_LEVEL`.

## Troubleshooting

### `torchcodec: Could not load libtorchcodec`

torchcodec links against FFmpeg 6.x shared libraries (libavutil.58). Ensure FFmpeg 6 (not 7 or 8) is installed via conda:

```bash
conda install -n arcaenv -c conda-forge 'ffmpeg>=6.1,<7' -y
export DYLD_LIBRARY_PATH="$CONDA_PREFIX/lib:$DYLD_LIBRARY_PATH"
```

### `ImportError: Symbol not found: _iconv` or `_libiconv`

This occurs when pip-installed packages (av, numpy, scipy) link against macOS system libraries instead of conda's. Fix by ensuring these are installed via conda:

```bash
conda install -n arcaenv -c conda-forge 'ffmpeg>=6.1,<7' 'av>=13.1,<14' 'numpy>=2.4' 'scipy>=1.17' 'libiconv>=1.18' -y
```

If pip has overwritten conda's numpy/scipy, remove them and reinstall:

```bash
conda run -n arcaenv pip uninstall numpy scipy av -y
conda install -n arcaenv -c conda-forge numpy scipy 'av>=13.1,<14' --force-reinstall -y
```

### `No module named 'omegaconf'`

Required by pyannote.audio for model config loading. Install it:

```bash
conda run -n arcaenv pip install 'omegaconf>=2.3.0'
```

### `pyannote.audio` wants to downgrade torch

Install the exact pinned versions before pyannote. Pyannote.audio >=3.3 internally pins torch 2.8.x:

```bash
pip install torch==2.8.0 torchaudio==2.8.0
pip install 'pyannote.audio>=3.3.0'
```

### Qdrant collection not found

Re-run the init container or create manually:

```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml up qdrant-init --force-recreate
```

### Database schema errors in tests

Run migrations from the monorepo root:

```bash
pnpm --filter @hope/database db:migrate:deploy
```

### HuggingFace gated model access

Pyannote models require accepting the license on HuggingFace:

1. Accept the license at `https://huggingface.co/pyannote/embedding`
2. Create an access token at `https://huggingface.co/settings/tokens`
3. Set `HUGGINGFACE_TOKEN=hf_xxxxxxxx` in your environment

### Module import errors

| Error | Fix |
|-------|-----|
| `No module named 'azure'` or `qdrant_client` | Run `pip install -e "."` (core dependencies) |
| `No module named 'pyannote'`, `torch`, `soundfile` | Run `pip install -e ".[ml,dev,test]"` (ML extras) |
| `No module named 'nemo_toolkit'` or `nemo` | Run `pip install -e ".[ml-gpu,nemo]"` (NeMo extra, requires CUDA) |

## Related Documentation

- [NLP Service](../nlp/README.md) — Natural language processing service
- [API Reference](api-reference.md) — Complete endpoint documentation
- [Configuration Guide](configuration.md) — Environment variables and pipeline YAML
