# STT V2 API Reference

Complete API documentation for the STT Service V2, covering REST endpoints, streaming session management, and Redis Streams wire formats.

## Base URL

```
Development: http://localhost:8861
Production:  Accessed via the API Gateway (NestJS)
```

Interactive documentation is available at `/docs` (Swagger UI) and `/redoc` when running in debug mode.

---

## Health & Monitoring

### GET /health — Liveness Check

Returns basic service information. Suitable for Kubernetes `livenessProbe`.

**Response `200 OK`:**

```json
{
  "status": "ok",
  "service": "stt-v2",
  "version": "2.0.0",
  "timestamp": "2026-02-19T10:00:00.000000"
}
```

### GET /live — Minimal Liveness

Ultra-lightweight check that the process is alive.

**Response `200 OK`:**

```json
{
  "status": "ok"
}
```

### GET /ready — Readiness Check

Verifies all infrastructure dependencies (database, Redis, MinIO) are reachable. Returns per-component health with latency. Streaming status is informational only.

**Response `200 OK`:**

```json
{
  "status": "healthy",
  "service": "stt-v2",
  "version": "2.0.0",
  "uptime_seconds": 3600.5,
  "components": [
    {
      "name": "database",
      "status": "healthy",
      "latency_ms": 1.23,
      "message": null
    },
    {
      "name": "minio",
      "status": "healthy",
      "latency_ms": 2.45,
      "message": null
    },
    {
      "name": "redis",
      "status": "healthy",
      "latency_ms": 0.87,
      "message": null
    },
    {
      "name": "streaming",
      "status": "healthy",
      "latency_ms": 0,
      "active_sessions": 3,
      "max_concurrent": 50,
      "worker_id": "worker-abc123"
    }
  ],
  "timestamp": "2026-02-19T10:00:00.000000"
}
```

**Overall status values:** `healthy`, `degraded`, `unhealthy`

### GET /metrics — Prometheus Metrics

Returns Prometheus-formatted metrics for scraping.

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="POST",handler="/api/v1/transcribe",status="2xx"} 42
...
```

---

## Batch Transcription

### POST /api/v1/transcribe — Transcribe Audio File

Upload an audio file and receive a complete transcription result with text, timestamps, VAD segments, timing breakdown, and optional speaker labels.

**Content-Type:** `multipart/form-data`

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | Audio file (max 100 MB) |
| `pipeline_id` | string | Yes | Pipeline UUID or slug |
| `tenant_id` | string | Yes | Tenant identifier |
| `consultation_id` | string | No | Optional consultation context |
| `language` | string | No | Language hint — ISO 639-1 (e.g. `en`, `ml`) or BCP-47 (e.g. `en-US`) |
| `code_switching` | boolean | No | Enable multilingual code-switching (overrides pipeline default) |

**Example request:**

```bash
curl -X POST http://localhost:8861/api/v1/transcribe \
  -F "file=@recording.wav" \
  -F "pipeline_id=turbo-whisper-large-v3" \
  -F "tenant_id=tenant-001" \
  -F "language=en"
```

**Response `200 OK`:**

```json
{
  "text": "The patient reports chest pain radiating to the left arm.",
  "language": "en",
  "language_probability": 0.98,
  "duration_seconds": 12.5,
  "processing_time_seconds": 3.2,
  "word_timestamps": [
    {
      "word": "The",
      "start_time": 0.0,
      "end_time": 0.15,
      "confidence": 0.99
    },
    {
      "word": "patient",
      "start_time": 0.16,
      "end_time": 0.52,
      "confidence": 0.98
    }
  ],
  "sentence_timestamps": [
    {
      "text": "The patient reports chest pain radiating to the left arm.",
      "start_time": 0.0,
      "end_time": 4.8
    }
  ],
  "segments": [
    {
      "start_time": 0.0,
      "end_time": 5.2,
      "duration": 5.2,
      "is_speech": true,
      "confidence": 0.95
    },
    {
      "start_time": 5.2,
      "end_time": 7.0,
      "duration": 1.8,
      "is_speech": false,
      "confidence": 0.92
    }
  ],
  "timing": {
    "ttfw_seconds": 0.8,
    "model_loading_seconds": 0.0,
    "preprocessing_seconds": 0.3,
    "inference_seconds": 2.1,
    "diarization_seconds": 0.5,
    "postprocessing_seconds": 0.1,
    "total_seconds": 3.2
  },
  "metadata": {
    "pipeline_slug": "turbo-whisper-large-v3",
    "engine": "ONNX_OPTIMUM",
    "vad_applied": true,
    "diarization_applied": true,
    "speakers_detected": 2
  },
  "raw_audio_uri": "minio://hope-audio/tenant-001/raw/abc123.wav",
  "processed_audio_uri": "minio://hope-audio/tenant-001/processed/abc123.wav",
  "transcript_uri": "minio://hope-audio/tenant-001/transcripts/abc123.json"
}
```

**Response Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Full transcribed text |
| `language` | string \| null | Detected or specified language |
| `language_probability` | float \| null | Language detection confidence |
| `duration_seconds` | float | Audio file duration |
| `processing_time_seconds` | float | Total processing wall time |
| `word_timestamps` | array | Per-word timing with confidence |
| `sentence_timestamps` | array | Per-sentence timing |
| `segments` | array | VAD speech/silence segments |
| `timing` | object \| null | Pipeline stage timing breakdown |
| `metadata` | object | Pipeline, engine, and processing metadata |
| `raw_audio_uri` | string \| null | MinIO URI for raw audio |
| `processed_audio_uri` | string \| null | MinIO URI for processed audio |
| `transcript_uri` | string \| null | MinIO URI for JSON transcript |

**Error Responses:**

| Status | Error Code | Description |
|--------|-----------|-------------|
| `400` | `EMPTY_FILE` | Uploaded file is empty |
| `400` | `INVALID_LANGUAGE` | Unrecognized language code |
| `404` | `PIPELINE_NOT_FOUND` | Pipeline slug/UUID not found or not enabled |
| `413` | `FILE_TOO_LARGE` | File exceeds 100 MB limit |
| `500` | `TRANSCRIPTION_ERROR` | Transcription processing failed |

Error response format:

```json
{
  "error_code": "PIPELINE_NOT_FOUND",
  "message": "Pipeline 'invalid-slug' not found or not enabled",
  "details": {}
}
```

---

## Streaming Session Management

These internal endpoints are called by the API Gateway to manage streaming session lifecycle. They are **not** exposed to end-users.

### POST /internal/streaming/sessions — Create Session

Create a new streaming session before the API Gateway accepts a WebSocket connection.

**Request Body:**

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "tenant_id": "tenant-001",
  "pipeline_id": "turbo-whisper-large-v3",
  "consultation_id": "consult-456",
  "sample_rate": 16000,
  "microphone_id": "mic-01",
  "language": "en",
  "code_switching": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `session_id` | string | Yes | — | Unique session UUID |
| `tenant_id` | string | Yes | — | Tenant identifier |
| `pipeline_id` | string | Yes | — | Pipeline UUID or slug |
| `consultation_id` | string | No | null | Consultation context |
| `sample_rate` | integer | No | 16000 | Audio sample rate in Hz |
| `microphone_id` | string | No | null | Microphone device identifier |
| `language` | string | No | null | Language hint (null = auto-detect) |
| `code_switching` | boolean | No | null | Enable multilingual code-switching |

**Response `201 Created`:**

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "reason": null,
  "max_concurrent": 50,
  "current_active": 12
}
```

**Response `503 Service Unavailable`** (at capacity):

Returns with `Retry-After: 5` header when no slots are available.

### GET /internal/streaming/sessions/{session_id} — Get Session Status

**Response `200 OK`:**

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "reason": null,
  "max_concurrent": 50,
  "current_active": 12
}
```

Session status values: `active`, `finalizing`, `closed`

### DELETE /internal/streaming/sessions/{session_id} — Remove Session

Finalizes the session if still active and removes it. Returns `204 No Content` on success.

### GET /internal/streaming/availability — Check Capacity

Lightweight capacity check for the API Gateway to call before creating a session.

**Response `200 OK`:**

```json
{
  "available": true,
  "status": "ready",
  "max_concurrent": 50,
  "current_active": 12,
  "available_slots": 38
}
```

Status values: `ready`, `not_initialized`, `at_capacity`

---

## Internal Admin Endpoints

### GET /internal/cache/stats — Model Cache Statistics

```json
{
  "total_models": 2,
  "total_memory_mb": 3200,
  "max_models": 5,
  "max_memory_mb": 10000,
  "hits": 150,
  "misses": 3,
  "evictions": 1,
  "hit_rate": 0.9804,
  "models": [
    {
      "slug": "whisper-large-v3-turbo-q4",
      "memory_mb": 1600,
      "device": "cpu",
      "format": "ONNX_OPTIMUM",
      "age_seconds": 7200.0,
      "idle_seconds": 60.0,
      "access_count": 42
    }
  ],
  "timestamp": "2026-02-19T10:00:00"
}
```

### POST /internal/cache/clear — Clear Model Cache

Unloads all cached models and frees memory.

```json
{
  "status": "ok",
  "models_cleared": 2,
  "timestamp": "2026-02-19T10:00:00"
}
```

### GET /internal/cache/model/{slug} — Specific Model Info

```json
{
  "slug": "whisper-large-v3-turbo-q4",
  "id": "model-uuid",
  "format": "ONNX_OPTIMUM",
  "device": "cpu",
  "memory_mb": 1600,
  "loaded_at": "2026-02-19T08:00:00",
  "has_tokenizer": true,
  "has_processor": true,
  "extra": {}
}
```

### GET /internal/pipelines/loaded — Pipelines with Cached Models

```json
{
  "total_pipelines": 3,
  "ready_pipelines": 2,
  "pipelines": [
    {
      "id": "pipeline-uuid",
      "slug": "turbo-whisper-large-v3",
      "name": "Turbo Whisper Large V3",
      "required_models": ["whisper-large-v3-turbo-q4"],
      "is_ready": true,
      "missing_models": []
    }
  ],
  "timestamp": "2026-02-19T10:00:00"
}
```

### GET /internal/sessions — Active Streaming Sessions

```json
{
  "status": "running",
  "active_sessions": 3,
  "sessions": [
    {
      "session_id": "sess-001",
      "tenant_id": "tenant-001",
      "status": "active",
      "source": "streaming"
    }
  ],
  "timestamp": "2026-02-19T10:00:00"
}
```

### GET /internal/streaming/status — Streaming Module Status

Returns execution profile, capacity details, and session information.

### POST /internal/sessions/cleanup — Clean Up Expired Sessions

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_age_seconds` | integer | 3600 | Maximum session age before cleanup |

```json
{
  "status": "ok",
  "sessions_cleaned": 2,
  "max_age_seconds": 3600,
  "timestamp": "2026-02-19T10:00:00"
}
```

---

## Redis Streams Wire Format

Streaming transcription communicates between the API Gateway and STT V2 through Redis Streams. These are the wire formats for each stream type.

### Audio Stream — `stt:audio:{session_id}`

Written by the API Gateway, consumed by the STT V2 ingestion process.

| Field | Type | Description |
|-------|------|-------------|
| `seq` | string (int) | Monotonic sequence number |
| `sr` | string (int) | Sample rate (e.g. `16000`) |
| `enc` | string | Audio encoding: `pcm_s16le` or `pcm_f32le` |
| `ch` | string (int) | Channels (`1` = mono) |
| `data` | bytes | Raw audio bytes (binary, not base64) |
| `final` | string | `"1"` if last frame, `"0"` otherwise |
| `ts` | string (float) | Client-side timestamp (epoch seconds) |

### Result Stream — `stt:result:{session_id}`

Written by STT V2, consumed by the API Gateway for WebSocket relay.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"segment"` |
| `text` | string | Transcribed text for this utterance |
| `speaker_id` | string | Speaker identifier (empty if no diarization) |
| `speaker_confidence` | string (float) | Speaker match confidence (0.0-1.0) |
| `start_time` | string (float) | Segment start time in seconds |
| `end_time` | string (float) | Segment end time in seconds |
| `is_final` | string | `"1"` if final utterance, `"0"` for interim |

### Control Stream — `stt:control:{session_id}`

Sent by the API Gateway or admin to control session lifecycle.

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Control action: `finalize`, `pause`, `resume`, `cancel` |

### Session Metadata — `stt:session:{session_id}` (Redis Hash)

Tier 1 session state persisted to survive process restarts. Ephemeral state (RNNoise, VAD LSTM, ring buffer) is rebuilt by replaying the last ~2 seconds from the audio stream.

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session UUID |
| `tenant_id` | string | Tenant identifier |
| `pipeline_id` | string | Pipeline UUID or slug |
| `consultation_id` | string | Consultation context (empty if none) |
| `microphone_id` | string | Microphone device identifier (empty if none) |
| `status` | string | `active`, `finalizing`, `closed` |
| `created_at` | string | ISO-8601 timestamp |
| `last_activity` | string | ISO-8601 timestamp |
| `total_samples_received` | string (int) | Total audio samples ingested |
| `total_duration_seconds` | string (float) | Total audio duration |
| `utterance_count` | string (int) | Number of transcribed utterances |
| `last_seq` | string (int) | Last processed audio frame sequence (starts at `-1`) |
| `sample_rate` | string (int) | Audio sample rate |
| `pipeline_config_json` | string | Serialized preprocessing configuration JSON |
| `language` | string | Language hint (empty for auto-detect) |
| `code_switching` | string | `"1"` or `"0"` |
| `worker_id` | string | Assigned worker identifier |
| `closed_at` | string | ISO-8601 timestamp (set when status=`closed`) |
| `raw_audio_uri` | string | MinIO URI for stored raw audio |
| `processed_audio_uri` | string | MinIO URI for processed audio |
| `transcript_uri` | string | MinIO URI for transcript JSON |

---

## Real-Time Events (Redis Pub/Sub)

Batch transcription jobs publish progress events to Redis Pub/Sub channels. The NestJS API Gateway subscribes and relays events via Server-Sent Events (SSE) to clients.

**Channel pattern:** `stt:transcription:{job_id}` (configured via `PUBSUB_CHANNEL_PREFIX`)

Event types:
- `status` — job lifecycle transitions (QUEUED, PROCESSING, COMPLETED, FAILED)
- `progress` — processing percentage with optional stage name
- `chunk` — partial transcript as each audio segment completes
- `transcript` — full final result with word/sentence timestamps
- `error` — failure notification with error code and message

All events are JSON-serialized with a `type` field and `data` payload. The publisher gracefully degrades when Redis is unavailable — events are best-effort. The `PUBSUB_ENABLED` setting controls whether publishing is active.
