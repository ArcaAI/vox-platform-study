# STT-001: Implementation Planning

| Field | Value |
|-------|-------|
| **Ticket** | STT-001 |
| **Created** | 2026-02-02 |
| **Last Updated** | 2026-02-02 |
| **Status** | In Progress |

## Implementation Phases

### Phase 1: Foundation (Database & Project Setup)

#### 1.1 Database Schema Changes
- [x] Add new enums to `enums.prisma`
  - `AiModelSource`
  - `AiModelFormat`
  - `AiModelDownloadStatus`
  - `TranscriptionJobType`
  - `TranscriptionJobStatus`
- [x] Create `stt.prisma` with models
  - `AsrPipeline`
  - `AiModel`
  - `TranscriptionJob`
- [ ] Generate and review migration
- [ ] Test migration locally

#### 1.2 Project Scaffold
- [x] Create `apps/stt-v2/` directory structure
- [x] Set up `pyproject.toml` with dependencies
- [ ] Configure conda environment
- [x] Set up Docker development environment
- [x] Configure pytest and coverage

#### 1.3 Core Infrastructure
- [x] Implement settings module (Pydantic settings)
- [x] Implement SQLAlchemy async database connection (read-only)
- [x] Implement Redis client for Dramatiq
- [x] Implement MinIO client wrapper
- [x] Implement API Gateway HTTP client
- [ ] Implement structured logging
- [x] Implement custom exception hierarchy

### Phase 2: Domain Implementation

#### 2.1 Pipeline Domain
- [ ] Implement `PipelineConfigReader` (read from DB)
- [ ] Implement YAML parser with validation
- [ ] Implement pipeline DTO classes

#### 2.2 Models Domain
- [ ] Implement `BaseModelLoader` abstract class
- [ ] Implement `HuggingFaceLoader`
- [ ] Implement `ONNXLoader`
- [ ] Implement `NeMoLoader`
- [ ] Implement `ModelCache` (LRU + TTL)
- [ ] Implement model registry reader

#### 2.3 Storage Domain
- [ ] Implement path resolver (hybrid strategy)
- [ ] Implement blob service (upload, download, delete)
- [ ] Implement lifecycle management

#### 2.4 Transcription Domain
- [ ] Implement batch transcription service
- [ ] Implement streaming transcription service
- [ ] Implement preprocessing pipeline (VAD, denoise)
- [ ] Implement postprocessing (timestamps, punctuation)

### Phase 3: Workers & Messaging

#### 3.1 Dramatiq Setup
- [ ] Configure Dramatiq broker with Redis
- [ ] Implement retry middleware
- [ ] Implement job status middleware
- [ ] Implement logging middleware

#### 3.2 Workers
- [ ] Implement `transcribe_file` worker (batch)
- [ ] Implement `transcribe_stream` worker (streaming chunks)
- [ ] Implement worker health monitoring

### Phase 4: API & Integration

#### 4.1 Health Endpoints
- [ ] Implement `/health` endpoint
- [ ] Implement `/ready` endpoint
- [ ] Implement `/metrics` endpoint (Prometheus)

#### 4.2 Internal Endpoints
- [ ] Implement `/internal/cache/stats`
- [ ] Implement `/internal/cache/clear`
- [ ] Implement `/internal/pipelines/loaded`

#### 4.3 API Gateway Integration
- [x] Add internal STT endpoints to API Gateway (STT-002 complete)
  - `POST /internal/stt/transcripts` ✅
  - `POST /internal/stt/audio-records` ✅
  - `PATCH /internal/stt/jobs/:id/start` ✅
  - `PATCH /internal/stt/jobs/:id/progress` ✅
  - `PATCH /internal/stt/jobs/:id/complete` ✅
  - `PATCH /internal/stt/jobs/:id/fail` ✅
- [x] Add STT domain services to API Gateway (STT-002 complete)
- [x] Add pipeline management APIs (STT-002 complete)
  - `POST /api/v1/pipelines`
  - `GET /api/v1/pipelines`
  - `GET /api/v1/pipelines/:id`
  - `PATCH /api/v1/pipelines/:id`
  - `DELETE /api/v1/pipelines/:id`
- [x] Add AI model management APIs (STT-002 complete)
  - `POST /api/v1/ai-models`
  - `GET /api/v1/ai-models`
  - `GET /api/v1/ai-models/:id`
  - `PATCH /api/v1/ai-models/:id`
  - `DELETE /api/v1/ai-models/:id`
- [x] Add transcription job APIs (STT-002 complete)
  - `POST /api/v1/transcription-jobs`
  - `GET /api/v1/transcription-jobs`
  - `GET /api/v1/transcription-jobs/:id`
  - `PATCH /api/v1/transcription-jobs/:id/cancel`

### Phase 5: Testing

#### 5.1 Unit Tests
- [ ] Pipeline domain tests
- [ ] Models domain tests (cache, loaders)
- [ ] Storage domain tests
- [ ] Transcription domain tests
- [ ] Core infrastructure tests

#### 5.2 Integration Tests
- [ ] Database read tests
- [ ] Redis/Dramatiq tests
- [ ] MinIO storage tests
- [ ] Full transcription flow tests

#### 5.3 E2E Tests
- [ ] Batch transcription end-to-end
- [ ] Streaming transcription end-to-end

### Phase 6: Deployment & Documentation

#### 6.1 Docker & Infrastructure
- [ ] Create production Dockerfile
- [ ] Update docker-compose for local development
- [ ] Configure Kubernetes manifests (if applicable)
- [ ] Set up CI/CD pipeline

#### 6.2 Documentation
- [ ] Update technical architecture docs
- [ ] Create API documentation
- [ ] Create deployment guide
- [ ] Create troubleshooting guide

---

## Dependencies

### Python Packages (Core)

```toml
[project]
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",
    "pydantic>=2.5.0",
    "pydantic-settings>=2.1.0",
    "sqlalchemy[asyncio]>=2.0.25",
    "asyncpg>=0.29.0",
    "dramatiq[redis]>=1.15.0",
    "redis>=5.0.0",
    "minio>=7.2.0",
    "httpx>=0.26.0",
    "structlog>=24.1.0",
    "pyyaml>=6.0.0",
]
```

### Python Packages (ML/ASR)

```toml
[project.optional-dependencies]
ml = [
    "torch>=2.1.0",
    "transformers>=4.36.0",
    "accelerate>=0.25.0",
    "safetensors>=0.4.0",
    "onnxruntime-gpu>=1.16.0",  # or onnxruntime for CPU
    "nemo_toolkit[asr]>=1.22.0",
    "huggingface_hub>=0.20.0",
    "soundfile>=0.12.0",
    "librosa>=0.10.0",
    "numpy>=1.24.0",
]
```

### Python Packages (Development)

```toml
[project.optional-dependencies]
dev = [
    "pytest>=7.4.0",
    "pytest-asyncio>=0.23.0",
    "pytest-cov>=4.1.0",
    "testcontainers>=3.7.0",
    "ruff>=0.1.0",
    "mypy>=1.8.0",
    "black>=24.1.0",
]
```

---

## Estimated Effort

| Phase | Tasks | Estimated Days |
|-------|-------|----------------|
| Phase 1: Foundation | Database, Scaffold, Core | 3-4 days |
| Phase 2: Domains | Pipeline, Models, Storage, Transcription | 5-7 days |
| Phase 3: Workers | Dramatiq, Workers | 2-3 days |
| Phase 4: API | Health, Internal, Gateway Integration | 3-4 days |
| Phase 5: Testing | Unit, Integration, E2E | 3-4 days |
| Phase 6: Deployment | Docker, CI/CD, Docs | 2-3 days |
| **Total** | | **18-25 days** |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Model loading OOM | Implement memory monitoring, enforce `max_memory_mb` limits |
| Dramatiq job loss | Enable Redis persistence, implement dead letter queue |
| HuggingFace rate limits | Use local cache, implement retry with backoff |
| NVIDIA NeMo complexity | Start with HuggingFace, add NeMo support incrementally |
| API Gateway coupling | Define clear internal API contracts, version endpoints |

---

## Success Criteria

- [ ] All unit tests passing with 80%+ coverage
- [ ] Integration tests passing with testcontainers
- [ ] Batch transcription completes within timeout
- [ ] Streaming latency < 500ms per chunk
- [ ] Model cache eviction working correctly
- [ ] Graceful shutdown handling in-progress jobs
- [ ] Health checks reporting accurate dependency status
- [ ] Documentation complete and reviewed
