# STT V2 Configuration Guide

All configuration is managed through environment variables, loaded via Pydantic Settings with `.env` file support. The service follows the 12-factor app methodology.

## Environment File Setup

```bash
cd apps/stt-v2
cp .env.example .env.dev
# Edit .env.dev with your values
```

The settings class (`stt_v2.core.config.settings.Settings`) reads from the `.env` file automatically and normalizes values (e.g., case-insensitive log levels, Prisma-style `postgres://` URLs converted to `postgresql+asyncpg://`).

---

## Environment Variables

### Application

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `APP_NAME` | string | `stt-v2` | Service name |
| `APP_VERSION` | string | `2.0.0` | Service version |
| `DEBUG` | boolean | `false` | Enable debug mode (Swagger UI, hot reload) |
| `HOST` | string | `0.0.0.0` | Bind address |
| `PORT` | integer | `8861` | Bind port |
| `LOG_LEVEL` | string | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `CORS_ORIGINS` | list | `["*"]` | Allowed CORS origins |

### Database (Read-Only)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DATABASE_URL` | string | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` | PostgreSQL connection string |
| `DATABASE_POOL_SIZE` | integer | `5` | Connection pool size |
| `DATABASE_MAX_OVERFLOW` | integer | `10` | Max pool overflow connections |

> The URL validator accepts `postgres://`, `postgresql://`, and `postgresql+asyncpg://` prefixes and normalizes them to asyncpg format.

### Redis (Dramatiq Broker)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_URL` | string | `redis://localhost:6379/0` | Redis connection string |

### MinIO (Object Storage)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MINIO_ENDPOINT` | string | `localhost:9000` | MinIO server endpoint |
| `MINIO_ACCESS_KEY` | string | `minioadmin` | Access key |
| `MINIO_SECRET_KEY` | string | `minioadmin` | Secret key |
| `MINIO_SECURE` | boolean | `false` | Use TLS |
| `MINIO_AUDIO_BUCKET` | string | `hope-audio` | Bucket for audio files |
| `MINIO_CHUNK_BUCKET` | string | `hope-audio-chunks` | Bucket for audio chunks |

### API Gateway (Internal Communication)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `API_GATEWAY_URL` | string | `http://localhost:8868/api/v1` | Internal API Gateway URL |
| `API_GATEWAY_KEY` | string | *(empty)* | Service authentication key |
| `API_GATEWAY_TIMEOUT` | integer | `30` | Request timeout in seconds |

### ASR Engine — HuggingFace

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HUGGINGFACE_CACHE_DIR` | string | `/models/hf-cache` | Model download cache directory |
| `HUGGINGFACE_TOKEN` | string | *(none)* | HuggingFace API token (required for gated models) |

### ASR Engine — Azure Speech

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `AZURE_SPEECH_KEY` | string | *(none)* | Azure Cognitive Services subscription key |
| `AZURE_SPEECH_REGION` | string | *(none)* | Azure region (e.g. `eastus`, `westeurope`) |

### Qdrant (Speaker Diarization Vector Store)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `QDRANT_URL` | string | `http://localhost:6333` | Qdrant HTTP API endpoint |
| `QDRANT_API_KEY` | string | *(none)* | API key (optional for development) |
| `QDRANT_COLLECTION_SPEAKERS` | string | `stt_speaker_embeddings` | Collection for speaker embedding vectors |
| `QDRANT_POOL_SIZE` | integer | `20` | Connection pool size |
| `QDRANT_TIMEOUT` | integer | `30` | Client timeout in seconds |

### Voice Activity Detection (Silero VAD v5)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VAD_MODEL_PATH` | string | *(none)* | Path to Silero ONNX model (auto-downloaded if empty) |
| `VAD_THRESHOLD` | float | `0.5` | Speech probability threshold (0.0–1.0) |
| `VAD_MIN_SPEECH_DURATION_MS` | integer | `250` | Minimum speech segment length in ms |
| `VAD_MIN_SILENCE_DURATION_MS` | integer | `500` | Minimum silence to end a speech segment in ms |
| `VAD_SPEECH_PAD_MS` | integer | `30` | Padding added before speech onset in ms |
| `VAD_SAMPLE_RATE` | integer | `16000` | Input sample rate (`16000` or `8000`) |

### Speaker Diarization (Pyannote)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DIARIZATION_HF_MODEL_ID` | string | `pyannote/embedding` | HuggingFace model for speaker embeddings |
| `DIARIZATION_SIMILARITY_THRESHOLD` | float | `0.7` | Cosine similarity threshold for speaker matching (0.0–1.0) |
| `DIARIZATION_DEVICE` | string | `auto` | Inference device: `auto`, `cuda`, `cpu` |

### Model Cache

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MODEL_CACHE_MAX_MODELS` | integer | `5` | Maximum models in the LRU cache |
| `MODEL_CACHE_TTL_SECONDS` | integer | `3600` | Cache entry TTL (1 hour) |

### Worker & Inference

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WORKER_THREADS` | integer | `4` | Dramatiq worker threads per process |
| `WORKER_CONCURRENCY` | integer | `4` | Alias for worker threads |
| `WORKER_TIMEOUT_MS` | integer | `600000` | Job timeout in ms (10 minutes) |
| `WORKER_MAX_RETRIES` | integer | `3` | Maximum job retry attempts |
| `INFERENCE_POOL_SIZE` | integer | `0` | ProcessPoolExecutor size for ML inference (0 = auto: CPU cores) |

### Threading

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ONNX_NUM_THREADS` | integer | `0` | ONNX Runtime intra-op threads (0 = auto, recommended) |
| `TORCH_NUM_THREADS` | integer | `0` | PyTorch intra-op threads (0 = auto: physical CPU cores). In K8s, match this to CPU request/limit. |
| `TORCH_NUM_INTEROP_THREADS` | integer | `1` | PyTorch inter-op threads. Default 1 is optimal for single-request inference. |

### Model Preloading

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PRELOAD_PIPELINES` | string | *(empty)* | Comma-separated pipeline slugs to preload at startup. Eliminates cold-start latency. Example: `turbo-whisper-large-v3,production-whisper-large-v3` |

### Transcription

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `TRANSCRIPTION_TIMEOUT_SECONDS` | integer | `300` | Maximum transcription job timeout |
| `TRANSCRIPTION_CHUNK_LENGTH_S` | integer | `15` | Audio chunk length for Whisper inference. `30` for max accuracy, `10` for ultra-low latency. |
| `TRANSCRIPTION_STRIDE_LENGTH_S` | string | `4,2` | Left and right chunk overlap (seconds), comma-separated |
| `SEGMENT_MERGE_GAP_THRESHOLD_S` | float | `2.0` | Max gap between VAD segments that allows merging. Set to `0` to disable. |

### Streaming

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `STREAMING_MAX_CONCURRENT` | integer | `0` | Max concurrent streaming sessions (0 = auto from hardware profile) |
| `STREAMING_MAX_BATCH_SIZE` | integer | `0` | Max batch size for GPU batch scheduler (0 = auto) |
| `STREAMING_BATCH_WAIT_MS` | integer | `0` | Max wait before dispatching incomplete batch (0 = auto) |
| `STREAMING_EMBEDDING_DEVICE` | string | `auto` | Device for speaker embeddings during streaming |
| `STREAMING_MULTI_GPU_STRATEGY` | string | `auto` | Multi-GPU strategy: `auto`, `replicate`, `split`, `none` |
| `STREAMING_SESSION_PERSIST_INTERVAL_S` | float | `5.0` | How often to persist session metadata to Redis |
| `STREAMING_SESSION_TIMEOUT_S` | integer | `60` | Inactivity timeout before auto-finalization |
| `STREAMING_AUDIO_IDLE_TIMEOUT_S` | integer | `300` | No-audio timeout before auto-stop (5 min) |
| `STREAMING_REAPER_INTERVAL_S` | integer | `300` | Interval between background reaper scans |
| `STREAMING_WORKER_HEARTBEAT_S` | integer | `10` | Worker heartbeat interval |
| `STREAMING_WORKER_HEARTBEAT_TTL_S` | integer | `30` | Heartbeat key TTL in Redis |
| `STREAMING_AUDIO_STREAM_MAXLEN` | integer | `2000` | Redis stream MAXLEN per session (~60s at 30ms/frame) |
| `STREAMING_RESULT_STREAM_EXPIRE_S` | integer | `3600` | Result stream TTL after session close (1 hour) |
| `STREAMING_SESSION_METADATA_EXPIRE_S` | integer | `86400` | Session metadata TTL after close (24 hours) |

### Real-Time Event Publishing

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PUBSUB_CHANNEL_PREFIX` | string | `stt:transcription:` | Redis Pub/Sub channel prefix for events |
| `PUBSUB_ENABLED` | boolean | `true` | Enable Redis Pub/Sub publishing |

### Reserved (Future)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MLFLOW_TRACKING_URI` | string | *(none)* | MLFlow tracking server URI |
| `MLFLOW_MODEL_REGISTRY` | string | *(none)* | MLFlow model registry URI |

---

## Pipeline YAML Configuration

Pipeline configurations are stored in PostgreSQL and define the full transcription pipeline. They can reference models by database slug or inline HuggingFace definition.

### Structure

```yaml
version: "1.0"

models:
  asr: "whisper-large-v3-turbo"          # Database slug reference
  vad: "silero-vad-v5"                    # Database slug reference
  diarization:                            # Inline model definition
    hf_model_id: "pyannote/embedding"
    engine: "pytorch"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 100
    padding_ms: 30
  denoise:
    enabled: false
    strength: 0.5

inference:
  batch_size: 16
  compute_type: "auto"                    # auto, float16, float32, int8
  device: "auto"                          # auto, cuda, cpu
  num_workers: 4
  beam_size: 5
  temperature: 0.0
  language: null                          # null = auto-detect
  code_switching: false

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
    model: null
  remove_disfluencies: false
  lowercase: false

diarization:
  enabled: true
  similarity_threshold: 0.7
  max_speakers: 0                         # 0 = unlimited
  auto_register_speakers: true
  min_segment_duration_s: 1.0
  segment_silence_padding_ms: 100
```

### Model References

Models can be specified in two ways:

**Slug reference** — looks up the model in the `AiModel` database table:

```yaml
models:
  asr: "whisper-large-v3-turbo"
```

**Inline definition** — specifies the HuggingFace model ID and engine directly:

```yaml
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: "onnx"
    revision: "main"
    quantization: "q4"
    subfolder: "onnx"
```

Inline definition fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hf_model_id` | string | Yes | HuggingFace model ID |
| `engine` | string | Yes | Engine: `onnx`, `safetensor`, `pytorch`, `nemo`, `azure_speech`, `ctranslate2`, `optimum`. Aliases: `hf`/`huggingface`/`transformers` → `safetensor`, `ct2` → `ctranslate2`, `azure` → `azure_speech` |
| `revision` | string | No | Git revision/branch |
| `version` | string | No | Model version (e.g. `v6.0` for Silero) |
| `compute_type` | string | No | Override: `float16`, `float32`, `int8` |
| `device` | string | No | Override: `auto`, `cuda`, `cpu`, `mps` |
| `quantization` | string | No | ONNX quantization variant: `fp16`, `int8`, `uint8`, `q4`, `q4f16`, `bnb4`, `quantized` |
| `subfolder` | string | No | Subfolder within the HF repo (e.g. `onnx`) |

### Supported Model Formats

| Format | Constant | Description |
|--------|----------|-------------|
| SafeTensors | `SAFETENSOR` | HuggingFace default format |
| ONNX | `ONNX` | ONNX Runtime inference |
| ONNX Optimum | `ONNX_OPTIMUM` | HF Optimum multi-file ONNX (Whisper) |
| PyTorch | `PYTORCH` | Native PyTorch |
| NeMo | `NEMO` | NVIDIA NeMo toolkit |
| CTranslate2 | `CTRANSLATE2` | faster-whisper format |
| Azure Speech | `AZURE_SPEECH` | Cloud API (no local model) |

### Model Task Types

| Task | Description |
|------|-------------|
| `AUTOMATIC_SPEECH_RECOGNITION` | Primary ASR model |
| `VOICE_ACTIVITY_DETECTION` | VAD model |
| `AUDIO_DENOISING` | Noise suppression |
| `AUDIO_TO_AUDIO` | Audio preprocessing |
| `SPEAKER_DIARIZATION` | Speaker identification |

---

## Environment-Specific Recommendations

### Development

```bash
DEBUG=true
LOG_LEVEL=DEBUG
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope
REDIS_URL=redis://localhost:6379/0
QDRANT_URL=http://localhost:6333
PRELOAD_PIPELINES=
```

### Production

```bash
DEBUG=false
LOG_LEVEL=INFO
WORKER_THREADS=2
TORCH_NUM_THREADS=8            # Match K8s CPU limit
ONNX_NUM_THREADS=0             # Auto-detect
MODEL_CACHE_MAX_MODELS=3
PRELOAD_PIPELINES=production-whisper-large-v3
STREAMING_MAX_CONCURRENT=50
PUBSUB_ENABLED=true
```

### CI/CD (CPU-only)

```bash
DEBUG=false
LOG_LEVEL=WARNING
WORKER_THREADS=1
VAD_THRESHOLD=0.5
```
