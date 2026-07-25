# Design: STT Service V2 Architecture

| Field | Value |
|-------|-------|
| **Ticket** | STT-001 |
| **Created** | 2026-02-02 |
| **Last Updated** | 2026-02-02 |
| **Status** | In Progress |
| **Author** | HOPE Team |

## Summary

This document defines the architecture for a new high-availability Python STT (Speech-to-Text) service (`stt`) designed to handle live audio streaming and batch transcription. The service supports multiple ASR model formats (SafeTensor/Transformers, ONNX, NVIDIA NeMo) with an LRU caching strategy, communicates with the API Gateway via Dramatiq job queues, and maintains read-only database access for configuration while delegating all writes to the API Gateway.

## Design Decisions Summary

| # | Decision Area | Choice | Rationale |
|---|---------------|--------|-----------|
| 1 | Task Queue | **Dramatiq + Redis** | Best performance (4.35s for 20K jobs), ML workload optimized |
| 2 | Architecture | **Single FastAPI app** | WebSocket + REST + Dramatiq workers in one codebase |
| 3 | Model Loading | **LRU cache with TTL** | Balanced memory usage and inference latency |
| 4 | Pipeline Storage | **Dedicated Prisma model** | `AsrPipeline` with YAML config, models referenced by slug |
| 5 | Model Source | **HuggingFace-first** | Quick start with community models, MLFlow/GitHub later |
| 6 | Audio Storage | **Hybrid (date + context)** | `{tenant}/{date}/{context}/{id}.ext` for flexibility |
| 7 | API Communication | **Dramatiq through Redis** | Fully async, resilient job processing |
| 8 | WebSocket Flow | **WS through API Gateway** | Proxy to STT, maintains single entry point |
| 9 | Database Access | **Read direct, write via API** | Fast config reads, validated writes through gateway |
| 10 | Project Structure | **Domain-driven** | Clear boundaries: transcription, pipeline, storage, models |
| 11 | Streaming Protocol | **Unified Dramatiq** | Simpler architecture, accepts ~100-300ms streaming latency |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL CLIENTS                                │
│                    (Web App, Mobile, SDK - via Internet)                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY (NestJS)                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ REST APIs   │  │ WebSocket   │  │ Auth/RBAC   │  │ Dramatiq Producer   │ │
│  │ (public)    │  │ Handler     │  │ Middleware  │  │ (enqueue to Redis)  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────┐│
│  │ OWNS: Pipeline CRUD, AiModel CRUD, TranscriptionJob create,             ││
│  │       ContextItem writes, AudioRecording writes, Media writes           ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                │                           │
                │ HTTP (internal)           │ Redis (Dramatiq jobs)
                ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         STT SERVICE V2 (FastAPI)                            │
│                         INTERNAL ONLY - NO INTERNET ACCESS                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         CORE LAYER                                    │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │ Config      │  │ Database    │  │ Redis       │  │ MinIO       │  │   │
│  │  │ (Settings)  │  │ (Read-only) │  │ (Messaging) │  │ (Storage)   │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌───────────┐  │
│  │ TRANSCRIPTION  │  │ PIPELINE       │  │ STORAGE        │  │ MODELS    │  │
│  │ Domain         │  │ Domain         │  │ Domain         │  │ Domain    │  │
│  │ - Streaming    │  │ - Config Read  │  │ - Audio Blobs  │  │ - LRU     │  │
│  │ - Batch Jobs   │  │ - YAML Parse   │  │ - Path Resolve │  │   Cache   │  │
│  │ - Workers      │  │ - Loaders      │  │ - Lifecycle    │  │ - Loaders │  │
│  └────────────────┘  └────────────────┘  └────────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                │                           │
                ▼                           ▼
┌───────────────────────┐    ┌───────────────────────┐    ┌───────────────────┐
│    PostgreSQL         │    │       Redis           │    │      MinIO        │
│  (read-only access)   │    │  (Dramatiq broker,    │    │  (Audio blobs)    │
│                       │    │   job results)        │    │                   │
└───────────────────────┘    └───────────────────────┘    └───────────────────┘
```

## Responsibility Matrix

| Responsibility | API Gateway (NestJS) | STT Service (FastAPI) |
|----------------|:-------------------:|:---------------------:|
| **AsrPipeline** CRUD | ✅ Owns | ❌ Read-only |
| **AiModel** CRUD | ✅ Owns | ❌ Read-only |
| **TranscriptionJob** create | ✅ Owns | ❌ |
| **TranscriptionJob** status update | ✅ (via internal API) | ❌ (calls API) |
| **GlobalSetting** CRUD | ✅ Owns | ❌ Read-only |
| **ContextItem** writes | ✅ Owns | ❌ (calls API) |
| **AudioRecording** writes | ✅ Owns | ❌ (calls API) |
| **Media** writes | ✅ Owns | ❌ (calls API) |
| Model download/caching | ❌ | ✅ Owns |
| Transcription execution | ❌ | ✅ Owns |
| Pipeline YAML validation | ✅ Owns | ❌ |

## Project Structure

```
apps/stt/
├── pyproject.toml                    # uv/poetry config, dependencies
├── README.md
├── docker/
│   ├── Dockerfile
│   └── docker-compose.dev.yml
├── src/
│   ├── __init__.py
│   ├── main.py                       # FastAPI app entrypoint
│   │
│   ├── core/                         # Shared infrastructure
│   │   ├── config/
│   │   │   ├── settings.py           # Pydantic settings (env vars)
│   │   │   └── constants.py
│   │   ├── database/
│   │   │   ├── connection.py         # SQLAlchemy async engine (read-only)
│   │   │   └── models.py             # SQLAlchemy models
│   │   ├── messaging/
│   │   │   ├── broker.py             # Dramatiq Redis broker setup
│   │   │   ├── middleware.py         # Retry, logging, job status
│   │   │   └── results.py            # Result backend config
│   │   ├── storage/
│   │   │   └── minio_client.py       # MinIO S3 client wrapper
│   │   ├── api_client/
│   │   │   └── gateway.py            # HTTP client to API Gateway
│   │   ├── exceptions.py             # Custom exception hierarchy
│   │   └── logging/
│   │       └── structured.py         # JSON structured logging
│   │
│   ├── transcription/                # Domain: Speech-to-Text
│   │   ├── api/
│   │   │   ├── routes.py             # REST endpoints (job status)
│   │   │   └── schemas.py            # Pydantic request/response
│   │   ├── services/
│   │   │   ├── streaming.py          # Live transcription logic
│   │   │   └── batch.py              # File transcription logic
│   │   ├── workers/
│   │   │   ├── transcribe_file.py    # Dramatiq actor: batch
│   │   │   └── transcribe_stream.py  # Dramatiq actor: streaming
│   │   └── dto/
│   │       └── transcription.py
│   │
│   ├── pipeline/                     # Domain: ASR Pipeline Management
│   │   ├── services/
│   │   │   ├── config_reader.py      # Read pipeline from DB
│   │   │   └── yaml_parser.py        # Parse YAML config
│   │   ├── loaders/
│   │   │   ├── base.py               # Abstract loader interface
│   │   │   ├── huggingface.py        # Transformers/SafeTensor
│   │   │   ├── onnx.py               # ONNX Runtime
│   │   │   └── nemo.py               # NVIDIA NeMo
│   │   └── dto/
│   │       └── pipeline.py
│   │
│   ├── storage/                      # Domain: Audio Blob Management
│   │   ├── services/
│   │   │   ├── blob.py               # MinIO operations
│   │   │   ├── path_resolver.py      # Hybrid path generation
│   │   │   └── lifecycle.py          # Retention, cleanup
│   │   └── dto/
│   │       └── audio.py
│   │
│   ├── models/                       # Domain: AI Model Management
│   │   ├── services/
│   │   │   ├── cache.py              # LRU model cache with TTL
│   │   │   ├── downloader.py         # HuggingFace Hub download
│   │   │   └── registry_reader.py    # Read model metadata from DB
│   │   └── dto/
│   │       └── model.py
│   │
│   └── health/                       # Health checks
│       ├── api/
│       │   └── routes.py             # /health, /ready, /live
│       └── services/
│           └── checker.py            # Dependency health checks
│
└── tests/
    ├── conftest.py
    ├── unit/
    ├── integration/
    └── e2e/
```

## Data Model

### New Prisma Schema (`packages/database/src/prisma/db_main/stt.prisma`)

```prisma
// =============================================================================
// ASR PIPELINE DEFINITION
// Models are referenced by slug in configYaml, no FK relationships
// =============================================================================

model AsrPipeline {
    // Meta fields (BaseEntity pattern)
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String? @default("50000000-0000-0000-0000-000000000000")

    // Core fields
    name        String
    slug        String
    description String?

    // Pipeline configuration (YAML stored as text)
    configYaml  String   @db.Text

    // Resource status + Audit
    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy               String?
    createdAt               DateTime @default(now())
    updatedAt               DateTime @updatedAt

    tags String[] @default([])

    // Relations
    TranscriptionJobs TranscriptionJob[]

    @@unique([tenantId, slug], name: "AsrPipeline_tenant_slug_unique")
    @@index([tenantId], name: "AsrPipeline_tenantId_idx")
    @@index([resourceStatus], name: "AsrPipeline_status_idx")
    @@schema("core")
}

// =============================================================================
// AI MODEL REGISTRY (Standalone - no FK to pipelines)
// =============================================================================

model AiModel {
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    tenantId String? @default("50000000-0000-0000-0000-000000000000")

    name        String
    slug        String              // Referenced in pipeline YAML
    description String?

    category    ModelCategory       // AUDIO
    taskType    ModelTaskType       // AUTOMATIC_SPEECH_RECOGNITION, etc.
    modelType   ModelType           // BASE_MODEL, FINETUNED_MODEL, etc.

    source      AiModelSource       // HUGGINGFACE, GITHUB, MLFLOW, LOCAL
    sourceUri   String
    sourceRevision String?

    format      AiModelFormat       // SAFETENSOR, ONNX, NEMO, PYTORCH

    memorySizeMb   Int?
    computeType    String?

    downloadStatus  AiModelDownloadStatus @default(NOT_DOWNLOADED)
    localPath       String?
    downloadedAt    DateTime?
    fileSizeMb      Int?
    checksum        String?

    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy               String?
    createdAt               DateTime @default(now())
    updatedAt               DateTime @updatedAt

    tags String[] @default([])

    @@unique([tenantId, slug], name: "AiModel_tenant_slug_unique")
    @@index([tenantId], name: "AiModel_tenantId_idx")
    @@index([taskType], name: "AiModel_taskType_idx")
    @@index([format], name: "AiModel_format_idx")
    @@index([resourceStatus], name: "AiModel_status_idx")
    @@schema("core")
}

// =============================================================================
// TRANSCRIPTION JOB
// =============================================================================

model TranscriptionJob {
    metaData Json?  @map("_metadata") @db.JsonB
    id       String @id @default(uuid(7))

    tenantId String @default("50000000-0000-0000-0000-000000000000")

    jobType     TranscriptionJobType  // BATCH, STREAMING

    consultationId  String?
    contextItemId   String?
    mediaId         String?

    pipelineId      String
    Pipeline        AsrPipeline @relation(fields: [pipelineId], references: [id])

    status          TranscriptionJobStatus @default(QUEUED)
    progress        Int                    @default(0)

    queuedAt        DateTime  @default(now())
    startedAt       DateTime?
    completedAt     DateTime?

    resultText      String?   @db.Text
    resultMetadata  Json?     @db.JsonB

    errorMessage    String?
    errorCode       String?
    retryCount      Int       @default(0)
    maxRetries      Int       @default(3)

    workerId        String?

    createdBy       String?   @default("60000000-0000-0000-0000-000000000000")
    createdAt       DateTime  @default(now())
    updatedAt       DateTime  @updatedAt

    @@index([tenantId], name: "TranscriptionJob_tenantId_idx")
    @@index([status], name: "TranscriptionJob_status_idx")
    @@index([pipelineId], name: "TranscriptionJob_pipelineId_idx")
    @@index([consultationId], name: "TranscriptionJob_consultationId_idx")
    @@index([tenantId, status, createdAt], name: "TranscriptionJob_tenant_status_created_idx")
    @@schema("core")
}
```

### New Enums (add to `enums.prisma`)

```prisma
enum AiModelSource {
    HUGGINGFACE
    GITHUB
    MLFLOW
    LOCAL
    @@schema("core")
}

enum AiModelFormat {
    SAFETENSOR
    ONNX
    NEMO
    PYTORCH
    @@schema("core")
}

enum AiModelDownloadStatus {
    NOT_DOWNLOADED
    DOWNLOADING
    DOWNLOADED
    DOWNLOAD_FAILED
    @@schema("core")
}

enum TranscriptionJobType {
    BATCH
    STREAMING
    @@schema("core")
}

enum TranscriptionJobStatus {
    QUEUED
    PROCESSING
    COMPLETED
    FAILED
    CANCELLED
    DEAD
    @@schema("core")
}
```

### GlobalSetting Usage (Configuration Only)

| namespace | name | key | Example Value | Purpose |
|-----------|------|-----|---------------|---------|
| `stt.config` | `model_cache` | `max_models` | `5` | Max models in LRU cache |
| `stt.config` | `model_cache` | `ttl_seconds` | `3600` | Cache TTL |
| `stt.config` | `workers` | `concurrency` | `4` | Dramatiq worker count |
| `stt.config` | `storage` | `chunk_bucket` | `hope-audio-chunks` | MinIO bucket |
| `stt.config` | `huggingface` | `cache_dir` | `/models/hf-cache` | HF cache directory |
| `stt.config` | `api_gateway` | `base_url` | `http://api:8868/api/v1` | Internal API URL |
| `stt.config` | `api_gateway` | `internal_key` | `xxx...` | Internal service auth |

## Pipeline YAML Schema

### Version 1.0 (Slug References)

```yaml
# AsrPipeline.configYaml - Version 1.0
version: "1.0"

# Models referenced by slug (from AiModel table)
models:
  asr: "whisper-large-v3"           # Required - slug from AiModel table
  vad: "silero-vad-v4"              # Optional
  denoise: "deepfilternet-v3"       # Optional

preprocessing:
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
  noise_reduction:
    enabled: true
  audio:
    sample_rate: 16000
    channels: 1
    normalize: true

inference:
  batch_size: 16
  compute_type: float16             # float32 | float16 | int8
  device: auto                      # auto | cuda | cpu
  chunk_length_s: 30
  stride_length_s: 5

postprocessing:
  punctuation: true
  capitalize: true
  word_timestamps: true

resources:
  max_memory_mb: 4096
  timeout_seconds: 300
```

### Version 1.1 (Inline Model Definitions)

Version 1.1 supports **inline model definitions** where administrators can specify HuggingFace model IDs and inference engines directly, without pre-registering models in the database.

```yaml
# AsrPipeline.configYaml - Version 1.1 (Best Practice Example)
version: "1.1"

models:
  # Inline ASR model definition with engine specification
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"                   # onnx | safetensor | pytorch | nemo
    revision: "main"                 # Git revision (optional)
    compute_type: "float16"          # Override compute type (optional)

  # Inline VAD model with version
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"                  # Model version tag

  # Inline noise suppression model
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

  # Or use slug reference (backward compatible)
  # denoise: "deepfilternet-v3"

preprocessing:
  vad:
    enabled: true
    threshold: 0.45
    min_speech_duration_ms: 200
    min_silence_duration_ms: 150
    padding_ms: 50
  denoise:
    enabled: true
    strength: 0.7
  target_sample_rate: 16000
  normalize: true

inference:
  batch_size: 8
  compute_type: float16
  device: auto
  num_workers: 4
  beam_size: 5
  temperature: 0.0
  language: null                     # null = auto-detect

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false

resources:
  max_memory_mb: 4096
  timeout_seconds: 120
```

### Supported Engine Types

| Engine | Description | Use Case |
|--------|-------------|----------|
| `onnx` | ONNX Runtime / Optimum | Fast inference, ONNX-community models |
| `safetensor` | HuggingFace Transformers | Standard HuggingFace models |
| `pytorch` | PyTorch native | Custom PyTorch models |
| `nemo` | NVIDIA NeMo | NeMo ASR models (Parakeet, etc.) |
| `ctranslate2` | CTranslate2 | Faster-whisper models |

### Best Practice Pipeline Examples

The following pre-configured pipelines are available:

| Slug | Use Case | Models |
|------|----------|--------|
| `best-practice-realtime` | Real-time streaming | Silero VAD v6 + RNNoise + Whisper ONNX Turbo |
| `best-practice-batch` | High-quality batch | Silero VAD v6 + DeepFilterNet + Whisper ONNX |
| `production-whisper-large-v3` | Production | Silero VAD v4 + DeepFilterNet + Whisper Large V3 |
| `turbo-whisper-large-v3` | Fast streaming | Silero VAD v4 + Whisper Large V3 Turbo |

## Data Flows

### Live Streaming Transcription

1. Client connects via WebSocket to API Gateway
2. API Gateway authenticates and proxies to STT service
3. Audio chunks received → enqueued to Dramatiq
4. STT worker processes chunk (VAD → ASR inference)
5. Partial transcript returned via Redis pub/sub → API Gateway → Client
6. On session end: merge chunks, store final audio to MinIO
7. Create ContextItem/AudioRecording via API Gateway internal endpoint

### Batch File Transcription

1. Client uploads audio file via API Gateway
2. API Gateway stores file in MinIO, creates Media record
3. Client requests transcription → API creates TranscriptionJob, enqueues to Dramatiq
4. STT worker: downloads audio → loads pipeline → preprocesses → ASR inference
5. Worker calls API Gateway internal endpoint to create ContextItem (TRANSCRIPT)
6. Job status updated to COMPLETED

## Audio Storage Path Convention

```
{bucket}/{tenant_id}/{year}/{month}/{context_type}/{entity_id}/{file_id}.{ext}

Examples:
- hope-audio/tenant-123/2026/02/consultations/consult-456/audio-789.wav
- hope-audio/tenant-123/2026/02/streaming/session-abc/chunks/chunk-001.webm
- hope-audio/tenant-123/2026/02/uploads/media-xyz.mp3
```

## Model Loading (LRU Cache)

- **Max models**: Configurable (default: 5)
- **TTL**: Configurable (default: 3600 seconds)
- **Eviction**: LRU when at capacity, TTL expiry check on access
- **Loaders**: `HuggingFaceLoader`, `ONNXLoader`, `NeMoLoader`

## Error Handling

| Category | Examples | Retry | Max Retries |
|----------|----------|:-----:|:-----------:|
| Transient | Network timeout, Redis down | Yes | 3 |
| Model Loading | Download failed, OOM | Yes | 1 |
| Audio Processing | Corrupt file, unsupported format | No | - |
| Configuration | Invalid YAML, model not found | No | - |

## STT Service APIs (Minimal)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Liveness probe |
| `GET` | `/ready` | Readiness check (DB, Redis, MinIO) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/internal/cache/stats` | Model cache statistics |
| `POST` | `/internal/cache/clear` | Clear model cache (admin) |

## Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Framework | FastAPI | Latest |
| Python | Python | 3.11+ |
| Task Queue | Dramatiq | Latest |
| Message Broker | Redis | 8 |
| Database | PostgreSQL | 17 |
| ORM | SQLAlchemy (async) | 2.x |
| Object Storage | MinIO | Latest |
| ASR (HuggingFace) | Transformers | Latest |
| ASR (ONNX) | ONNX Runtime | Latest |
| ASR (NeMo) | NVIDIA NeMo | 2.x |
| Package Manager | uv | Latest |

## Testing Strategy

| Category | Coverage Target | Tools |
|----------|-----------------|-------|
| Unit Tests | 80%+ | pytest, pytest-asyncio |
| Integration Tests | Key flows | pytest, testcontainers |
| E2E Tests | Critical paths | pytest, httpx |

## Open Questions

1. **GPU Allocation**: How should workers be assigned to specific GPUs in multi-GPU environments?
2. **Model Versioning**: Should we track model versions in `AiModel` or rely on `sourceRevision`?
3. **Streaming Latency**: Is 100-300ms acceptable for live captioning, or should we revisit direct WebSocket processing?
4. **Multi-language**: Priority for non-English language support?

## Next Steps

1. Create detailed implementation plan (`planning.md`)
2. Implement Prisma schema changes
3. Set up `stt` project scaffold
4. Implement core infrastructure (DB, Redis, MinIO clients)
5. Implement model loaders (HuggingFace first)
6. Implement Dramatiq workers
7. Integration testing with API Gateway
