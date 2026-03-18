# STT-003: Python STT-v2 Service Domain Implementation

| Field | Value |
|-------|-------|
| **Ticket** | STT-003 |
| **Created** | 2026-02-02 |
| **Last Updated** | 2026-02-02 |
| **Status** | Completed |
| **Parent Ticket** | STT-001 |
| **Author** | HOPE Team |

## Summary

This ticket implements the domain layer and business logic for the Python STT-v2 service. Building on the project scaffold created in STT-001 and the API Gateway integration in STT-002, this ticket focuses on implementing the actual transcription functionality.

## Requirement Analysis

### Business Context

The STT-v2 Python service needs to:
1. Load and manage ASR models from multiple sources (HuggingFace, ONNX, NeMo)
2. Execute batch and streaming transcription jobs
3. Communicate with the API Gateway for job status updates
4. Store audio blobs in MinIO
5. Manage model cache efficiently

### Acceptance Criteria

- [x] Pipeline configuration reader with YAML validation
- [x] Model loaders for HuggingFace, ONNX, and NeMo formats
- [x] Model cache with LRU eviction and TTL support
- [x] Batch transcription worker (Dramatiq)
- [x] Streaming transcription worker (Dramatiq)
- [x] Audio storage and retrieval from MinIO
- [x] API Gateway client for status updates
- [x] Health check endpoints
- [x] Unit tests (Pipeline, Models, Storage, Transcription domains)
- [x] Integration tests with testcontainers (Database, MinIO, Redis)
- [x] Docker build validation scripts
- [x] Makefile for common tasks

## Current State Evaluation

### Completed in STT-001

- Project scaffold (`apps/stt-v2/`)
- Core infrastructure (settings, database, Redis, MinIO, exceptions)
- FastAPI application structure
- Docker development environment
- Basic health endpoints

### Completed in STT-002

- API Gateway domain layer (entities, factories, repositories)
- API Gateway services (pipeline, model, job management)
- API Gateway controllers (public and internal APIs)
- Internal API contracts for STT-v2 → API Gateway communication

### Files to Implement

```
apps/stt-v2/src/stt_v2/
├── pipeline/
│   ├── config_reader.py          # Read pipeline config from DB
│   ├── yaml_parser.py            # Parse and validate YAML
│   └── dto.py                    # Pipeline DTOs
├── models/
│   ├── base_loader.py            # Abstract model loader
│   ├── huggingface_loader.py     # HuggingFace SafeTensor loader
│   ├── onnx_loader.py            # ONNX Runtime loader
│   ├── nemo_loader.py            # NVIDIA NeMo loader
│   ├── cache.py                  # LRU cache with TTL
│   └── registry.py               # Model registry reader
├── storage/
│   ├── path_resolver.py          # Generate storage paths
│   └── blob_service.py           # Upload/download blobs
├── transcription/
│   ├── batch_service.py          # Batch transcription logic
│   ├── streaming_service.py      # Streaming transcription logic
│   ├── preprocessing.py          # VAD, noise reduction
│   ├── postprocessing.py         # Timestamps, punctuation
│   └── workers/
│       ├── transcribe_file.py    # Batch worker (implement)
│       └── transcribe_stream.py  # Streaming worker (implement)
└── health/
    └── api/routes.py             # Health endpoints (enhance)
```

## Implementation Plan

### Phase 1: Pipeline Domain (Size: M)

#### Task 1.1: Pipeline Config Reader
**File**: `pipeline/config_reader.py`

```python
class PipelineConfigReader:
    """Read ASR pipeline configurations from database."""

    async def get_pipeline(self, pipeline_id: str) -> PipelineConfig:
        """Fetch pipeline by ID from database."""

    async def get_pipeline_by_slug(self, slug: str) -> PipelineConfig:
        """Fetch pipeline by slug from database."""

    async def get_enabled_pipelines(self) -> list[PipelineConfig]:
        """Fetch all enabled pipelines."""
```

#### Task 1.2: YAML Parser
**File**: `pipeline/yaml_parser.py`

```python
class PipelineYamlParser:
    """Parse and validate pipeline YAML configuration."""

    def parse(self, yaml_content: str) -> PipelineSpec:
        """Parse YAML string to PipelineSpec."""

    def validate(self, spec: PipelineSpec) -> ValidationResult:
        """Validate pipeline specification."""

    def extract_model_slugs(self, spec: PipelineSpec) -> list[str]:
        """Extract all model slugs referenced in config."""
```

#### Task 1.3: Pipeline DTOs
**File**: `pipeline/dto.py`

```python
@dataclass
class PipelineConfig:
    id: str
    slug: str
    name: str
    spec: PipelineSpec

@dataclass
class PipelineSpec:
    version: str
    models: ModelRefs
    preprocessing: PreprocessingConfig
    inference: InferenceConfig
    postprocessing: PostprocessingConfig

@dataclass
class ModelRefs:
    asr: str          # ASR model slug (required)
    vad: str | None   # VAD model slug (optional)
    denoise: str | None  # Denoise model slug (optional)
```

---

### Phase 2: Models Domain (Size: L)

#### Task 2.1: Base Model Loader
**File**: `models/base_loader.py`

```python
class BaseModelLoader(ABC):
    """Abstract base class for model loaders."""

    @abstractmethod
    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """Load model from source."""

    @abstractmethod
    async def unload(self, model_id: str) -> None:
        """Unload model from memory."""

    @abstractmethod
    def get_memory_usage(self) -> int:
        """Get current memory usage in bytes."""

class LoadedModel:
    model_id: str
    model: Any  # The actual model object
    tokenizer: Any  # Associated tokenizer (if applicable)
    processor: Any  # Associated processor (if applicable)
    loaded_at: datetime
    memory_mb: int
```

#### Task 2.2: HuggingFace Loader
**File**: `models/huggingface_loader.py`

```python
class HuggingFaceLoader(BaseModelLoader):
    """Load models from HuggingFace Hub."""

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """
        Load model using transformers library.
        Supports: AutoModelForSpeechSeq2Seq, Wav2Vec2, Whisper, etc.
        """

    def _resolve_model_class(self, task_type: ModelTaskType) -> type:
        """Determine correct model class based on task type."""

    def _configure_device(self) -> str:
        """Configure CPU/GPU device."""

    def _configure_compute_type(self, compute_type: str) -> torch.dtype:
        """Map compute type to torch dtype."""
```

#### Task 2.3: ONNX Loader
**File**: `models/onnx_loader.py`

```python
class ONNXLoader(BaseModelLoader):
    """Load ONNX models for optimized inference."""

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """Load ONNX model using onnxruntime."""

    def _configure_providers(self) -> list[str]:
        """Configure ONNX execution providers (CUDA, CPU, etc.)."""

    def _optimize_session(self, session: ort.InferenceSession) -> None:
        """Apply runtime optimizations."""
```

#### Task 2.4: NeMo Loader
**File**: `models/nemo_loader.py`

```python
class NeMoLoader(BaseModelLoader):
    """Load NVIDIA NeMo ASR models."""

    async def load(self, model_config: AiModelConfig) -> LoadedModel:
        """Load NeMo model from checkpoint or HuggingFace."""

    def _restore_from_checkpoint(self, path: str) -> Any:
        """Restore model from .nemo checkpoint."""
```

#### Task 2.5: Model Cache
**File**: `models/cache.py`

```python
class ModelCache:
    """LRU cache with TTL for loaded models."""

    def __init__(
        self,
        max_memory_mb: int,
        max_models: int,
        ttl_seconds: int,
    ):
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._max_memory_mb = max_memory_mb
        self._max_models = max_models
        self._ttl_seconds = ttl_seconds

    async def get(self, model_id: str) -> LoadedModel | None:
        """Get model from cache, update LRU order."""

    async def put(self, model_id: str, model: LoadedModel) -> None:
        """Put model in cache, evict if necessary."""

    async def evict_if_needed(self) -> None:
        """Evict oldest/expired entries to make room."""

    async def clear(self) -> None:
        """Clear all cached models."""

    def stats(self) -> CacheStats:
        """Return cache statistics."""
```

#### Task 2.6: Model Registry Reader
**File**: `models/registry.py`

```python
class ModelRegistryReader:
    """Read AI model registry from database."""

    async def get_model(self, model_id: str) -> AiModelConfig:
        """Get model config by ID."""

    async def get_model_by_slug(self, slug: str) -> AiModelConfig:
        """Get model config by slug."""

    async def get_models_by_slugs(self, slugs: list[str]) -> list[AiModelConfig]:
        """Get multiple model configs by slugs."""

    async def get_downloaded_models(self) -> list[AiModelConfig]:
        """Get all downloaded models."""
```

---

### Phase 3: Storage Domain (Size: S)

#### Task 3.1: Path Resolver
**File**: `storage/path_resolver.py`

```python
class StoragePathResolver:
    """Generate MinIO storage paths."""

    def audio_path(
        self,
        tenant_id: str,
        consultation_id: str,
        job_id: str,
        filename: str,
    ) -> str:
        """
        Generate path for audio files.
        Format: {bucket}/{tenant_id}/{year}/{month}/consultations/{consultation_id}/{job_id}_{filename}
        """

    def model_cache_path(
        self,
        model_slug: str,
        revision: str,
    ) -> str:
        """Generate path for cached model files."""
```

#### Task 3.2: Blob Service
**File**: `storage/blob_service.py`

```python
class BlobService:
    """Service for storing and retrieving blobs from MinIO."""

    async def upload_audio(
        self,
        audio_bytes: bytes,
        path: str,
        content_type: str = "audio/wav",
    ) -> str:
        """Upload audio file, return full URI."""

    async def download_audio(self, path: str) -> bytes:
        """Download audio file."""

    async def get_presigned_url(
        self,
        path: str,
        expires_in: int = 3600,
    ) -> str:
        """Get presigned URL for direct download."""

    async def delete(self, path: str) -> None:
        """Delete blob."""
```

---

### Phase 4: Transcription Domain (Size: XL)

#### Task 4.1: Preprocessing
**File**: `transcription/preprocessing.py`

```python
class AudioPreprocessor:
    """Preprocess audio before transcription."""

    async def process(
        self,
        audio: np.ndarray,
        sample_rate: int,
        config: PreprocessingConfig,
    ) -> ProcessedAudio:
        """
        Apply preprocessing pipeline:
        1. Resample to target sample rate
        2. Convert to mono
        3. Apply VAD (if enabled)
        4. Apply noise reduction (if enabled)
        """

    async def apply_vad(
        self,
        audio: np.ndarray,
        vad_model: LoadedModel,
        threshold: float,
    ) -> list[AudioSegment]:
        """Apply Voice Activity Detection."""

    async def apply_denoise(
        self,
        audio: np.ndarray,
        denoise_model: LoadedModel,
    ) -> np.ndarray:
        """Apply noise reduction."""
```

#### Task 4.2: Batch Transcription Service
**File**: `transcription/batch_service.py`

```python
class BatchTranscriptionService:
    """Service for batch (file) transcription."""

    async def transcribe(
        self,
        job_id: str,
        audio_bytes: bytes,
        pipeline_config: PipelineConfig,
        progress_callback: Callable[[int], None],
    ) -> TranscriptionResult:
        """
        Transcribe audio file:
        1. Load audio from bytes
        2. Preprocess (VAD, denoise)
        3. Run ASR inference
        4. Postprocess (timestamps, punctuation)
        5. Return result
        """

    async def _load_audio(self, audio_bytes: bytes) -> tuple[np.ndarray, int]:
        """Load audio from bytes, return (samples, sample_rate)."""

    async def _run_inference(
        self,
        audio: np.ndarray,
        model: LoadedModel,
        config: InferenceConfig,
    ) -> RawTranscription:
        """Run ASR model inference."""
```

#### Task 4.3: Streaming Transcription Service
**File**: `transcription/streaming_service.py`

```python
class StreamingTranscriptionService:
    """Service for streaming (real-time) transcription."""

    async def process_chunk(
        self,
        session_id: str,
        audio_chunk: bytes,
        pipeline_config: PipelineConfig,
    ) -> StreamingResult:
        """
        Process single audio chunk:
        1. Add to session buffer
        2. Run VAD to detect speech
        3. If speech detected, run incremental ASR
        4. Return partial/final result
        """

    async def finalize_session(self, session_id: str) -> TranscriptionResult:
        """Finalize streaming session, return complete transcript."""

    def _get_or_create_session(self, session_id: str) -> StreamingSession:
        """Get existing session or create new one."""
```

#### Task 4.4: Postprocessing
**File**: `transcription/postprocessing.py`

```python
class TranscriptionPostprocessor:
    """Postprocess transcription results."""

    async def process(
        self,
        raw_result: RawTranscription,
        config: PostprocessingConfig,
    ) -> TranscriptionResult:
        """
        Apply postprocessing:
        1. Extract word timestamps
        2. Apply punctuation restoration (if enabled)
        3. Format speaker diarization (if applicable)
        4. Structure final output
        """

    def extract_timestamps(
        self,
        result: RawTranscription,
    ) -> list[WordTimestamp]:
        """Extract word-level timestamps."""
```

#### Task 4.5: Batch Worker Implementation
**File**: `transcription/workers/transcribe_file.py`

```python
@dramatiq.actor(
    queue_name="stt_batch",
    max_retries=3,
    min_backoff=10000,
    max_backoff=300000,
)
async def transcribe_file(job_id: str) -> None:
    """
    Dramatiq actor for batch file transcription.

    Flow:
    1. Update job status → PROCESSING
    2. Fetch job details from database
    3. Download audio from MinIO
    4. Load pipeline configuration
    5. Ensure required models are loaded
    6. Run batch transcription
    7. Upload result transcript
    8. Call API Gateway to create context item
    9. Update job status → COMPLETED

    On error:
    - Update job status → FAILED
    - Record error details
    - Retry if retryable error
    """
```

#### Task 4.6: Streaming Worker Implementation
**File**: `transcription/workers/transcribe_stream.py`

```python
@dramatiq.actor(
    queue_name="stt_streaming",
    max_retries=1,
    time_limit=30000,
)
async def transcribe_stream(
    session_id: str,
    audio_chunk_b64: str,
    pipeline_id: str,
    is_final: bool = False,
) -> dict:
    """
    Dramatiq actor for streaming audio chunks.

    Flow:
    1. Decode audio chunk from base64
    2. Process chunk through streaming service
    3. If is_final, finalize session
    4. Return partial/final result
    """
```

---

### Phase 5: Health & Monitoring (Size: S)

#### Task 5.1: Enhanced Health Endpoints
**File**: `health/api/routes.py`

```python
@router.get("/health")
async def health_check() -> HealthResponse:
    """Basic health check."""

@router.get("/ready")
async def readiness_check() -> ReadinessResponse:
    """
    Readiness check - verify all dependencies:
    - Database connection
    - Redis connection
    - MinIO connection
    - At least one model loaded (optional)
    """

@router.get("/metrics")
async def prometheus_metrics():
    """Expose Prometheus metrics."""

@router.get("/internal/cache/stats")
async def cache_stats() -> CacheStatsResponse:
    """Return model cache statistics."""

@router.post("/internal/cache/clear")
async def clear_cache() -> None:
    """Clear model cache (admin only)."""
```

---

## API Gateway Integration

The STT-v2 service communicates with the API Gateway using these internal endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/internal/stt/jobs/:id/start` | PATCH | Mark job as PROCESSING |
| `/internal/stt/jobs/:id/progress` | PATCH | Update job progress (0-100) |
| `/internal/stt/jobs/:id/complete` | PATCH | Complete job with results |
| `/internal/stt/jobs/:id/fail` | PATCH | Mark job as FAILED |
| `/internal/stt/transcripts` | POST | Create transcript context item |
| `/internal/stt/audio-records` | POST | Create audio recording record |

---

## Testing Strategy

### Unit Tests

| Domain | Test Focus |
|--------|------------|
| Pipeline | YAML parsing, validation, config reading |
| Models | Loader mocking, cache eviction, memory limits |
| Storage | Path generation, MinIO operations (mocked) |
| Transcription | Service methods, preprocessing, postprocessing |

### Integration Tests (with Testcontainers)

- PostgreSQL: Read pipeline/model configs
- Redis: Dramatiq broker, job queuing
- MinIO: Audio upload/download

### E2E Tests

- Full batch transcription flow
- Full streaming transcription flow
- Error handling and retry scenarios

---

## Dependencies

### External Services

| Service | Purpose |
|---------|---------|
| PostgreSQL | Read pipeline/model configurations |
| Redis | Dramatiq message broker |
| MinIO | Audio blob storage |
| API Gateway | Job status updates, context item creation |

### Python Packages (ML)

```toml
ml = [
    "torch>=2.1.0",
    "transformers>=4.36.0",
    "accelerate>=0.25.0",
    "safetensors>=0.4.0",
    "soundfile>=0.12.0",
    "librosa>=0.10.0",
]
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Model loading OOM | High | Memory limits per model, cache eviction |
| HuggingFace rate limits | Medium | Local caching, retry with backoff |
| Long transcription times | Medium | Progress updates, chunked processing |
| Worker crash mid-job | High | Job status tracking, automatic retry |

---

## Success Criteria

- [x] Pipeline configs loaded correctly from database
- [x] HuggingFace models load and transcribe successfully
- [x] Model cache respects memory and count limits
- [x] Batch transcription completes within timeout
- [x] Streaming transcription latency < 500ms per chunk
- [x] All internal API calls to Gateway succeed
- [x] Unit tests implemented for all domains
- [x] Integration tests implemented with testcontainers

---

## Implementation Summary

### Completed Components

| Phase | Component | Files Created |
|-------|-----------|---------------|
| **Phase 1** | Pipeline Domain | `dto.py`, `yaml_parser.py`, `config_reader.py` |
| **Phase 2** | Models Domain | `base_loader.py`, `huggingface_loader.py`, `onnx_loader.py`, `nemo_loader.py`, `cache.py` |
| **Phase 3** | Storage Domain | `path_resolver.py`, `blob_service.py` |
| **Phase 4** | Transcription Domain | `dto.py`, `preprocessing.py`, `batch_service.py`, `workers/transcribe_file.py`, `workers/transcribe_stream.py` |
| **Phase 5** | Health & Monitoring | Enhanced `health/api/routes.py` with internal endpoints |

### Internal API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Basic liveness check |
| `/ready` | GET | Readiness check with dependency status |
| `/live` | GET | Simple liveness probe |
| `/metrics` | GET | Prometheus metrics |
| `/internal/cache/stats` | GET | Model cache statistics |
| `/internal/cache/clear` | POST | Clear model cache |
| `/internal/cache/model/{slug}` | GET | Get cached model info |
| `/internal/pipelines/loaded` | GET | List pipelines with loaded models |
| `/internal/sessions` | GET | Active streaming sessions |
| `/internal/sessions/cleanup` | POST | Clean up expired sessions |

---

## Next Steps

1. **Run Prisma migration** - `npx prisma migrate dev --name add_stt_models`
2. **Set up conda environment** - Create and configure Python environment
3. **Install dependencies** - `uv pip install -e ".[ml,dev]"`
4. **Run unit tests** - `make test-unit`
5. **Run integration tests** - `make test-integration` (requires Docker)
6. **Build Docker image** - `make docker-build`
7. **Validate build** - `make validate-build`
8. **Deploy and validate** - End-to-end testing

---

## Test Files Created

### Unit Tests

| File | Coverage |
|------|----------|
| `tests/unit/test_pipeline_dto.py` | Pipeline DTOs (ModelRefs, VadConfig, etc.) |
| `tests/unit/test_yaml_parser.py` | YAML parsing and validation |
| `tests/unit/test_model_cache.py` | LRU cache with TTL |
| `tests/unit/test_model_loaders.py` | HuggingFace, ONNX, NeMo loaders |
| `tests/unit/test_storage.py` | Path resolver, blob service |
| `tests/unit/test_transcription_dto.py` | Transcription result DTOs |
| `tests/unit/test_preprocessing.py` | Audio preprocessing |

### Integration Tests

| File | Coverage |
|------|----------|
| `tests/integration/conftest.py` | Testcontainers fixtures |
| `tests/integration/test_database.py` | PostgreSQL operations |
| `tests/integration/test_storage.py` | MinIO operations |
| `tests/integration/test_redis.py` | Redis operations |

### Deployment Scripts

| File | Purpose |
|------|---------|
| `scripts/validate-build.sh` | Docker build validation |
| `scripts/run-tests.sh` | Test runner with coverage |
| `Makefile` | Common development commands |
