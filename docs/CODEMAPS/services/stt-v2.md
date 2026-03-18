# STT V2 Codemap

**Last Updated:** 2026-03-14  
**Language:** Python 3.11+ / FastAPI  
**Port:** 8861 (development)  
**Entry Point:** [src/stt_v2/main.py](../../../apps/stt-v2/src/stt_v2/main.py)

---

## 📋 Purpose

High-availability Speech-to-Text (ASR) service with multi-model support. Transcribes audio streams and files with voice activity detection, speaker diarization, and configurable model selection. Integrates with API Gateway via Dramatiq job queue.

---

## 🗂️ Directory Structure

```
apps/stt-v2/src/stt_v2/
├── main.py                    # FastAPI app entry point
├── worker.py                  # Dramatiq worker processes
├── __init__.py                # Package init
│
├── core/                      # Configuration & initialization
│   ├── config.py              # Settings loader (pydantic)
│   ├── logging.py             # Structured logging setup
│   └── deps.py                # FastAPI dependency injection
│
├── models/                    # ML model management
│   ├── model_registry.py      # Model factory • caching • loading
│   ├── asr_models.py          # ASR model wrappers (Whisper, NeMo, Azure)
│   ├── vad_model.py           # VAD loading (Silero v5 ONNX)
│   └── embedding_model.py     # Speaker embedding (Pyannote)
│
├── transcription/             # ASR pipeline
│   ├── transcriber.py         # Main transcription orchestrator
│   ├── whisper_processor.py   # Whisper ONNX ASR
│   ├── nemo_processor.py      # NVIDIA NeMo Parakeet ASR
│   ├── azure_processor.py     # Azure Speech Service client
│   └── fallback_chain.py      # Multi-model fallback strategy
│
├── vad/                       # Voice Activity Detection
│   ├── silero_vad.py          # Silero VAD v5 processor
│   ├── vad_processor.py       # VAD state management
│   └── detection_result.py    # VAD output models
│
├── diarization/               # Speaker identification
│   ├── speaker_diarizer.py    # Diarization orchestrator
│   ├── pyannote_embedder.py   # Speaker embedding extraction
│   ├── vector_store.py        # Integration with Qdrant
│   └── clustering.py          # Speaker clustering logic
│
├── embedding/                 # Vector management
│   ├── qdrant_client.py       # Qdrant vector DB interface
│   ├── embedding_store.py     # Embedding persistence
│   └── similarity.py          # Vector similarity search
│
├── streaming/                 # Real-time streaming
│   ├── stream_processor.py    # WebSocket streaming (via API Gateway)
│   ├── audio_buffer.py        # Buffering & accumulation
│   └── stream_handler.py      # Connection lifecycle
│
├── pipeline/                  # Processing orchestration
│   ├── transcription_pipeline.py # Async processing flow
│   ├── job_handler.py         # Dramatiq job processing
│   └── error_handling.py      # Retry strategies
│
├── storage/                   # External storage
│   ├── minio_client.py        # MinIO object storage
│   ├── audio_storage.py       # Audio file management
│   └── result_storage.py      # Result persistence
│
├── health/                    # Monitoring & health checks
│   ├── health_check.py        # Liveness/readiness probes
│   ├── model_health.py        # Model availability checker
│   └── dependency_checker.py  # External service status
│
├── routes/                    # FastAPI endpoints
│   ├── health.py              # GET /health, /health/ready
│   ├── transcription.py       # POST /transcribe (batch)
│   ├── streaming.py           # WebSocket /stream (via proxy)
│   └── models.py              # GET /models (available models)
│
└── schemas/                   # Request/response models (Pydantic)
    ├── transcription.py       # Transcription requests/responses
    ├── audio.py               # Audio metadata models
    └── error.py               # Error response models
```

---

## 🔄 Request Flow: Batch Transcription

```
┌─────────────────────────────────────────────────────────────┐
│  API Gateway receives POST /stt-v2/transcribe               │
│  • Validates input (audio format, file size)                │
│  • Stores audio in MinIO                                    │
│  • Creates Dramatiq job                                     │
│  • Returns job ID to client                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ Job enqueued to Redis
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Dramatiq Worker picks up job                               │
│  (STT V2 worker process)                                    │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
    ┌──────────────────────────────┐
    │  Load audio from MinIO       │
    │  Decode to PCM               │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  VAD Processing              │
    │  (Silero VAD v5 ONNX)        │
    │  → Detect speech regions     │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Select ASR Model            │
    │  • Try primary model         │
    │  • Fallback if needed        │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Transcription               │
    │  • Whisper ONNX              │
    │  • NeMo Parakeet             │
    │  • Azure Speech              │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Diarization (optional)      │
    │  • Extract speaker embeddings│
    │  • Query Qdrant for speaker  │
    │  • Cluster speakers          │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Format result               │
    │  • Add speaker labels        │
    │  • Timestamps for segments   │
    │  • Store in MinIO            │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Notify API Gateway          │
    │  (callback / webhook)        │
    └──────────────────────────────┘
```

---

## 🔌 Key Components

### Transcription Module
**Purpose**: ASR orchestration with multi-model fallback

```python
class TranscriptionPipeline:
    async def transcribe(
        audio_path: str,
        model: str = "whisper",
        language: str = "en",
        diarize: bool = False
    ) -> TranscriptionResult:
        # 1. Load audio → PCM
        # 2. VAD filtering (optional)
        # 3. Select model
        # 4. ASR inference
        # 5. Optional: diarization
        # 6. Return result
```

### VAD Module
**Purpose**: Voice Activity Detection (Silero VAD v5 ONNX)

```python
class SileroVAD:
    async def detect(
        audio: np.ndarray,
        sample_rate: int = 16000
    ) -> List[Tuple[float, float]]:
        # Returns list of (start_sec, end_sec) for speech regions
```

### Diarization Module
**Purpose**: Speaker identification via embeddings

```python
class SpeakerDiarizer:
    async def diarize(
        audio: np.ndarray,
        embeddings: List[np.ndarray]
    ) -> List[SpeakerSegment]:
        # Returns segments with speaker labels
```

### Models
**Supported ASR Models**:
- **Whisper** (OpenAI) — ONNX optimized
- **NeMo Parakeet** (NVIDIA) — Real-time focus
- **Azure Speech** — Fallback/cloud option

**Model Loading**:
- LRU cache with configurable TTL
- Lazy loading on first use
- Fallback chain if model unavailable

---

## 🔗 External Dependencies

### Python Libraries
- `fastapi>=0.133.0` — Web framework
- `uvicorn[standard]>=0.41.0` — ASGI server
- `httpx>=0.28.1` — Async HTTP client
- `pydantic>=2.12.5` — Data validation
- `aiofiles>=25.1.0` — Async file I/O
- `asyncpg>=0.31.0` — Async PostgreSQL
- `sqlalchemy[asyncio]>=2.0.47` — ORM (read-only)
- `pyannote.audio>=3.3.0` — Speaker embedding
- `silero-vad>=5.1` — Voice detection
- `minio>=7.2.20` — Object storage
- `dramatiq[redis]>=2.0.0` — Job queue
- `pydantic-settings>=2.13.1` — Config management

### ML Models (HuggingFace / ONNX)
- Whisper ONNX (OpenAI)
- NeMo Parakeet (NVIDIA)
- Silero VAD v5 ONNX
- Pyannote speaker embedding

### Microservices
- **API Gateway** (NestJS) — Job submission, WebSocket proxy
- **PostgreSQL** — Read-only config store
- **Redis** (Dramatiq) — Job queue
- **MinIO** — Audio file storage
- **Qdrant** — Speaker embedding vectors

---

## ⚙️ Configuration

**Environment Variables**:

```bash
# FastAPI
HOST=0.0.0.0
PORT=8861

# Database (read-only)
DATABASE_URL=postgresql+asyncpg://...

# Redis (Dramatiq)
REDIS_HOST=localhost
REDIS_PORT=6379

# MinIO
MINIO_URL=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=audio-uploads

# Qdrant
QDRANT_URL=http://localhost:6333

# Model Selection
PRIMARY_ASR_MODEL=whisper       # whisper | nemo | azure
ENABLE_DIARIZATION=true
ENABLE_VAD_FILTERING=true

# Model Cache
MODEL_CACHE_TTL=3600            # seconds
MAX_CACHED_MODELS=3

# Azure Speech (if enabled)
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus
```

---

## 🧪 Testing

**Unit Tests**:
```bash
pytest tests/ -v
```

**Integration Tests**:
```bash
pytest tests/integration/ -v
```

**Load Testing** (k6):
```bash
k6 run tests/load/transcription.js
```

**Liveness Probe**:
```bash
GET http://localhost:8861/health
```

**Readiness Probe**:
```bash
GET http://localhost:8861/health/ready
```

---

## 🔐 Security Considerations

- **No auth** on STT endpoints (auth handled by API Gateway)
- **Input validation** on audio format/size
- **Rate limiting** via API Gateway
- **Secrets** stored in environment (Vault)
- **Storage isolation** — separate MinIO buckets per tenant

---

## 📊 Observability

### Logging
- Structured JSON logs (Python logging + JSON formatter)
- Context: job_id, tenant_id, duration
- Log levels: DEBUG, INFO, WARNING, ERROR

### Metrics (Prometheus-compatible)
- `stt_transcription_duration_seconds`
- `stt_model_load_duration_seconds`
- `stt_queue_length`
- `stt_errors_total`

### Health Checks
- Model availability
- Database connectivity
- Redis connectivity
- MinIO connectivity
- Qdrant connectivity

---

## 🔗 Related Codemaps

- [API Gateway](./api-gateway.md) — Service consumer, job orchestration
- [Database Package](../packages/database.md) — Configuration schema
- [Room Package](../packages/room.md) — Audio processing framework
- [VAD Package](../packages/vad.md) — Voice Activity Detection

---

**Status**: ✅ Current | STT V2 active in development
