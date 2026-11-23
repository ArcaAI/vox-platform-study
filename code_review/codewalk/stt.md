# STT (Speech-to-Text) Service - API Documentation

## Service Overview

**Path**: `apps/stt/src/stt/`
**Entry Point**: `stt/main.py` → `create_app()` → `main()`
**Port**: 8861 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- Real-time streaming transcription via WebSocket/Redis Streams
- Batch file transcription via REST API
- Multi-model ASR support (faster-whisper, whisper.cpp, Parakeet, Azure, OpenAI, Sarvam)
- Voice Activity Detection (Silero VAD)
- Speaker Diarization (Pyannote, SpeechBrain)
- Voice Profile Extraction (enrollment)
- Model caching with TTL-based eviction

### Infrastructure Dependencies
| Dependency | Purpose | Client |
|------------|---------|--------|
| PostgreSQL | Pipeline configs, tenant data (disabled by default TASK-861) | SQLAlchemy async |
| Redis | Session management, streaming streams, caching, pub/sub | redis.asyncio |
| MinIO (S3) | Audio file storage, model artifacts | MinIO Python SDK |
| API Gateway | Config resolution, service registration, auth validation | httpx |

---

## API Endpoints Summary

### Health & Internal (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed component health (always 200) |
| GET | `/health/live` | `liveness_check()` | K8s liveness probe |
| GET | `/health/ready` | `readiness_check()` | K8s readiness probe |
| GET | `/health/startup` | `startup_check()` | K8s startup probe |
| GET | `/live` | `liveness_check_legacy()` | Legacy liveness alias |
| GET | `/ready` | `readiness_check_legacy()` | Legacy readiness alias |

### Internal Endpoints (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/internal/streaming/language-modes` | `get_language_modes()` | Language-mode catalog |
| POST | `/internal/streaming/sessions` | `create_streaming_session()` | Create streaming session |
| GET | `/internal/streaming/sessions/active` | `list_active_streaming_sessions()` | List active sessions |
| GET | `/internal/streaming/sessions/{session_id}` | `get_streaming_session()` | Get session status |
| DELETE | `/internal/streaming/sessions/{session_id}` | `delete_streaming_session()` | Remove/finalize session |
| POST | `/internal/streaming/sessions/{session_id}/end` | `end_active_streaming_session()` | End active session |
| POST | `/internal/streaming/sessions/{session_id}/switch` | `switch_streaming_session()` | Manual engine switch |
| GET | `/internal/streaming/availability` | `get_streaming_availability()` | Capacity check |
| POST | `/internal/streaming/drain` | `begin_streaming_drain()` | Mark worker draining |
| POST | `/internal/voice-profile/extract` | `extract_voice_embedding()` | Extract speaker embedding |

### Public Endpoints (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/transcribe` | `transcribe_audio()` | Batch file transcription |
| POST | `/api/v1/pipelines/validate` | `validate_pipeline_yaml()` | Validate pipeline YAML |

### Internal Admin Endpoints (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/internal/cache/stats` | `get_cache_stats()` | Model cache statistics |
| POST | `/internal/cache/clear` | `clear_cache()` | Clear model cache |
| GET | `/internal/cache/model/{slug}` | `get_cached_model_info()` | Specific model info |
| GET | `/internal/pipelines/loaded` | `get_loaded_pipelines()` | Pipelines with loaded models |
| GET | `/internal/sessions` | `get_streaming_sessions()` | Active streaming sessions |
| GET | `/internal/streaming/status` | `get_streaming_status()` | Streaming module status |
| POST | `/internal/sessions/cleanup` | `cleanup_sessions()` | Cleanup expired sessions |

---

## Detailed API Documentation

### 1. Streaming Session Management

#### POST /internal/streaming/sessions - Create Streaming Session
**File**: `stt/streaming/api/routes.py:108`
**Handler**: `create_streaming_session(request: CreateStreamingSessionRequest) -> StreamingSessionResponse`

**Implementation Chain**:
```
create_streaming_session() [routes.py:108]
  → mgr.create_session() [session_manager.py:1100+]
    → _assemble_session_runtime() [session_manager.py:757]
      → _load_vad_service() [session_manager.py:1100+]
      → StreamingPreprocessor() [preprocessor.py]
      → _load_asr_pipeline() [session_manager.py:1200+]
        → get_model_cache().get_or_load() [models/cache.py]
      → _get_pipeline_embedding_service() [session_manager.py:877]
      → SpeakerIdentifier() [diarization/speaker_identifier.py]
      → StreamingInferenceWorker() [inference.py]
    → mgr.capacity_guard.acquire() [capacity_guard.py]
    → Redis: IngestionConsumer, ControlListener, ResultPublisher [redis_streams.py]
```

**Data Integration**:
- **Redis**: Session metadata (`stt:session:{id}`), audio stream (`stt:audio:{id}`), control stream (`stt:control:{id}`)
- **Model Cache**: Loads ASR model (faster-whisper/whisper.cpp/etc.) from HuggingFace cache or MinIO
- **MinIO**: Audio bucket for session recordings (`hope-audio` default)
- **PostgreSQL**: Pipeline config resolution (via gateway, DB disabled by default)
- **In-Memory**: SessionManager holds session state, inference queues, workers

**Key Functions Called**:
- `SessionManager.create_session()` - Main orchestration
- `_assemble_session_runtime()` - Builds VAD, preprocessor, ASR, diarization, inference worker
- `_load_asr_pipeline()` - Loads model via ModelCache, handles cloud ASR overrides
- `CapacityGuard.acquire()` - Enforces max concurrent streams

#### GET /internal/streaming/sessions/{session_id} - Get Session Status
**File**: `stt/streaming/api/routes.py:257`
**Handler**: `get_streaming_session(session_id: str) -> StreamingSessionResponse`

**Implementation Chain**:
```
get_streaming_session() [routes.py:257]
  → mgr.get_session(session_id) [session_manager.py:1300+]
  → _resolve_active_pipeline() [routes.py:51]
```

**Data Integration**: In-memory session lookup only

#### DELETE /internal/streaming/sessions/{session_id} - Remove/Finalize Session
**File**: `stt/streaming/api/routes.py:296`
**Handler**: `delete_streaming_session(session_id: str, response: Response) -> StreamingSessionTeardownResponse | None`

**Implementation Chain**:
```
delete_streaming_session() [routes.py:296]
  → mgr.claim_teardown_summary() [session_manager.py:1800+]  (if already gone)
  → mgr.end_session(session_id) [session_manager.py:1500+]
    → _finalize_session() [session_manager.py:1600+]
      → Persist transcript to MinIO
      → POST to API Gateway /internal/transcriptions/stream
      → Release capacity slot
      → Cleanup Redis streams
```

**Data Integration**:
- **MinIO**: Persist final transcript, raw/processed audio
- **API Gateway**: POST transcript to `/internal/transcriptions/stream` for ledger
- **Redis**: Cleanup session streams, metadata
- **In-Memory**: Release capacity guard slot, remove session objects

#### POST /internal/streaming/sessions/{session_id}/switch - Manual Engine Switch
**File**: `stt/streaming/api/routes.py:389`
**Handler**: `switch_streaming_session(session_id: str, request: SwitchProviderRequest) -> SwitchProviderResponse`

**Implementation Chain**:
```
switch_streaming_session() [routes.py:389]
  → mgr.request_switch(session_id, target) [session_manager.py:1400+]
    → EngineSwitchController.request_switch() [engine_switch.py]
      → XADD SWITCH_TO_FALLBACK control message [redis_streams.py]
```

**Data Integration**:
- **Redis Streams**: Publishes control message to session's control stream
- **In-Memory**: EngineSwitchController manages swap state

#### GET /internal/streaming/availability - Capacity Check
**File**: `stt/streaming/api/routes.py:430`
**Handler**: `get_streaming_availability() -> StreamingAvailabilityResponse`

**Implementation Chain**:
```
get_streaming_availability() [routes.py:430]
  → mgr.capacity_guard.available_slots [capacity_guard.py]
```

**Data Integration**: In-memory capacity guard only

#### POST /internal/streaming/drain - Begin Draining
**File**: `stt/streaming/api/routes.py:472`
**Handler**: `begin_streaming_drain() -> dict`

**Implementation Chain**:
```
begin_streaming_drain() [routes.py:472]
  → mgr.begin_drain() [session_manager.py:622]
    → Sets _draining = True
    → /health/ready starts returning 503
```

**Data Integration**: In-memory flag only; K8s readiness probe removes pod from Service

---

### 2. Batch Transcription

#### POST /api/v1/transcribe - Transcribe Audio File
**File**: `stt/transcription/api/routes.py:70`
**Handler**: `transcribe_audio(file, pipeline_id, tenant_id, consultation_id, language) -> TranscriptionResponse`

**Implementation Chain**:
```
transcribe_audio() [routes.py:70]
  → get_pipeline_reader().get_pipeline() [pipeline/config_reader.py]
    → PostgreSQL query (if DB enabled)
  → get_batch_service().transcribe() [transcription/batch_service.py]
    → BatchTranscriptionService.transcribe() [batch_service.py:100+]
      → audio_decode.decode_audio() [transcription/audio_decode.py]
      → preprocessing.prepare_audio() [transcription/preprocessing.py]
      → ASR model inference (via ModelCache)
      → diarization (if enabled)
      → postprocessing (punctuation, disfluency, overlap)
      → segment_merger.merge_segments() [transcription/segment_merger.py]
      → Persist to MinIO (raw_audio, processed_audio, transcript)
      → POST to API Gateway /internal/transcriptions/batch
```

**Data Integration**:
- **MinIO**: Stores raw audio, processed audio, transcript JSON
- **PostgreSQL**: Pipeline config lookup (via PipelineReader)
- **Model Cache**: Loads ASR, VAD, diarization models
- **API Gateway**: POSTs result to `/internal/transcriptions/batch` for ledger
- **In-Memory**: Processing buffers, timing metrics

**Key Functions**:
- `BatchTranscriptionService.transcribe()` - Main batch processing
- `audio_decode.decode_audio()` - Multi-format audio decoding (libsndfile → ffmpeg fallback)
- `preprocessing.prepare_audio()` - Resample, normalize, VAD
- `segment_merger.merge_segments()` - Merge ASR + diarization segments

#### POST /api/v1/pipelines/validate - Validate Pipeline YAML
**File**: `stt/transcription/api/routes.py:288`
**Handler**: `validate_pipeline_yaml(request: PipelineValidateRequest) -> PipelineValidateResponse`

**Implementation Chain**:
```
validate_pipeline_yaml() [routes.py:288]
  → get_yaml_parser().parse() [pipeline/yaml_parser.py]
  → parser.validate() [pipeline/yaml_parser.py]
```

**Data Integration**: In-memory YAML parsing only; no external dependencies

---

### 3. Voice Profile Extraction

#### POST /internal/voice-profile/extract - Extract Speaker Embedding
**File**: `stt/voice_profile/api/routes.py:39`
**Handler**: `extract_voice_embedding(files, model_slug, model_source_uri, min_similarity) -> ExtractionResponse`

**Implementation Chain**:
```
extract_voice_embedding() [routes.py:39]
  → create_embedding_service(hf_model_id=model_source_uri) [diarization/embedding_service.py]
    → EmbeddingService.initialize() [embedding_service.py]
  → get_vad_service().initialize() [vad/silero_service.py]
  → audio_decode.decode_audio() [transcription/audio_decode.py]
  → ExtractionService.extract() [voice_profile/extraction_service.py]
    → VAD to find speech segments
    → EmbeddingService.embed() per segment
    → Average embeddings with similarity check
```

**Data Integration**:
- **Model Cache**: Embedding model (ECAPA-TDNN) loaded via HF
- **In-Memory**: Audio processing, embedding computation
- **No Persistence**: Returns embedding to gateway; gateway stores in DB

---

### 4. Health Endpoints

#### GET /health - Detailed Health Check
**File**: `stt/health/api/routes.py:86`
**Handler**: `health_check() -> dict`

**Implementation Chain**:
```
health_check() [routes.py:86]
  → _check_database() [routes.py:261] → SQLAlchemy SELECT 1
  → _check_minio() [routes.py:300] → MinIO health_check()
  → _check_redis() [routes.py:323] → Redis ping()
  → _check_streaming() [routes.py:362] → SessionManager status
  → _check_processors() [routes.py:393] → asr_processor_health() [processors/binding.py]
  → get_effective_config_client().diagnostics() [core/effective_config.py]
```

**Data Integration**: Checks all infrastructure dependencies

#### GET /health/ready - Readiness Probe
**File**: `stt/health/api/routes.py:208`
**Handler**: `readiness_check() -> JSONResponse | dict`

**Implementation Chain**:
```
readiness_check() [routes.py:208]
  → _check_database(), _check_minio(), _check_redis()
  → mgr.is_draining [session_manager.py:612]
```

**Data Integration**: Same as health but fails fast on unhealthy deps or draining

---

### 5. Model Cache Admin Endpoints

#### GET /internal/cache/stats
**File**: `stt/health/api/routes.py:426`
**Handler**: `get_cache_stats() -> dict`

**Implementation Chain**:
```
get_cache_stats() [routes.py:426]
  → get_model_cache().stats() [models/cache.py]
```

#### POST /internal/cache/clear
**File**: `stt/health/api/routes.py:460`
**Handler**: `clear_cache() -> dict`

**Implementation Chain**:
```
clear_cache() [routes.py:460]
  → clear_model_cache() [models/cache.py]
```

#### GET /internal/cache/model/{slug}
**File**: `stt/health/api/routes.py:485`
**Handler**: `get_cached_model_info(slug: str) -> dict`

**Implementation Chain**:
```
get_cached_model_info() [routes.py:485]
  → get_model_cache().get(slug) [models/cache.py]
```

---

## Data Flow Summary

### Streaming Transcription Flow
```
API Gateway → POST /internal/streaming/sessions
    → SessionManager.create_session()
        → CapacityGuard.acquire()
        → _assemble_session_runtime()
            → ModelCache.get_or_load() → HuggingFace/MinIO
            → VAD (Silero) init
            → ASR Pipeline init (faster-whisper/whisper.cpp/Parakeet/Cloud)
            → Diarization (Pyannote/SpeechBrain) init
            → StreamingPreprocessor init
            → StreamingInferenceWorker init
            → Redis: IngestionConsumer, ControlListener, ResultPublisher
        → Returns session_id, pipeline_id, active_engine
    → API Gateway → WebSocket to client
    → Client → Audio frames → Redis Stream (stt:audio:{session_id})
    → IngestionConsumer → Preprocessor → VAD → Utterance detection
    → StreamingInferenceWorker → ASR inference → Partial/Final results
    → ResultPublisher → Redis Stream (stt:result:{session_id})
    → API Gateway → WebSocket to client
    → DELETE /internal/streaming/sessions/{session_id}
    → SessionManager.end_session()
        → Flush tail, drain queue
        → Persist transcript to MinIO
        → POST to API Gateway /internal/transcriptions/stream
        → Release capacity, cleanup Redis
```

### Batch Transcription Flow
```
Client → POST /api/v1/transcribe (multipart)
    → transcribe_audio()
        → PipelineReader.get_pipeline() → PostgreSQL
        → BatchTranscriptionService.transcribe()
            → audio_decode.decode_audio() → libsndfile/ffmpeg
            → preprocessing.prepare_audio() → resample, VAD
            → ModelCache.get_or_load() → ASR model
            → ASR inference (full file)
            → Diarization (if enabled)
            → Postprocessing (punctuation, disfluency, etc.)
            → segment_merger.merge_segments()
            → MinIO: upload raw_audio, processed_audio, transcript
            → POST to API Gateway /internal/transcriptions/batch
    → Returns TranscriptionResponse
```

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `stt/main.py` | FastAPI app factory, lifespan, middleware, router registration |
| `stt/streaming/api/routes.py` | Streaming session management endpoints |
| `stt/streaming/session_manager.py` | Session lifecycle, runtime assembly, recovery |
| `stt/streaming/inference.py` | Per-utterance ASR inference worker |
| `stt/streaming/preprocessor.py` | Audio preprocessing, VAD, utterance segmentation |
| `stt/streaming/engine_switch.py` | Mid-session engine failover logic |
| `stt/streaming/redis_streams.py` | Redis Streams consumers/publishers |
| `stt/transcription/api/routes.py` | Batch transcription endpoints |
| `stt/transcription/batch_service.py` | Batch transcription orchestration |
| `stt/transcription/audio_decode.py` | Multi-format audio decoding |
| `stt/transcription/preprocessing.py` | Audio preparation for batch |
| `stt/transcription/segment_merger.py` | Merge ASR + diarization segments |
| `stt/models/cache.py` | Model cache with TTL, LRU, memory limits |
| `stt/models/*_loader.py` | Model loaders (faster-whisper, whisper.cpp, cloud, etc.) |
| `stt/diarization/*` | Speaker diarization (embedding, segmentation, identification) |
| `stt/vad/silero_service.py` | Silero VAD service |
| `stt/punctuation/service.py` | Cadence punctuation |
| `stt/core/config/settings.py` | Configuration management |
| `stt/core/database/connection.py` | PostgreSQL connection |
| `stt/core/storage/minio_client.py` | MinIO client |
| `stt/core/messaging/broker.py` | Dramatiq broker (background jobs) |
| `stt/health/api/routes.py` | Health checks, internal admin endpoints |
| `stt/voice_profile/api/routes.py` | Voice profile extraction |
| `stt/pipeline/config_reader.py` | Pipeline config from DB |
| `stt/pipeline/yaml_parser.py` | Pipeline YAML validation |
| `stt/pipeline/spec.py` | Resolved spec bundle (TASK-861) |

---

## Configuration Keys (Control Plane)

| Key | Description | Default |
|-----|-------------|---------|
| `stt.warmDefaultAsrOnBoot` | Warm default ASR model at boot | `false` |
| `stt.modelCache.ttlSeconds` | Model cache TTL | `3600` |
| `stt.streaming.maxConcurrentStreams` | Max concurrent sessions | Profile-based |
| `stt.streaming.sessionTimeoutS` | Session idle timeout | `60` |
| `stt.streaming.audioIdleTimeoutS` | Audio idle timeout (reaper) | `300` |
| `stt.database.enabled` | Enable PostgreSQL reads | `false` |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `stt-streaming-session-create.html` - Session creation flow
- `stt-streaming-transcription.html` - Real-time transcription flow
- `stt-batch-transcribe.html` - Batch transcription flow
- `stt-voice-profile-extract.html` - Voice profile extraction
- `stt-engine-switch.html` - Mid-session engine switch
- `stt-health-check.html` - Health check flow