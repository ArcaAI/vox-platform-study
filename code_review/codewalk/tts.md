# TTS (Text-to-Speech) Service - API Documentation

## Service Overview

**Path**: `apps/tts/src/tts/`
**Entry Point**: `tts/main.py` → `create_app()` → `app = create_app()`
**Port**: 8862 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- Real-time streaming synthesis via WebSocket duplex (`/api/v1/audio/stream`)
- Batch synthesis via REST API (`/api/v1/audio/speech`) — OpenAI-compatible
- Multi-provider TTS support (Kokoro, Azure Speech, Sarvam, Indic Parler, Indic F5)
- Voice catalog management
- Provider routing with failover (before-first-byte only)
- Usage metering (characters + audio seconds)
- Model resolvability checks for gateway readiness

### Provider Architecture

| Provider | Type | Credential Posture | Languages | Streaming |
|----------|------|-------------------|-----------|-----------|
| **Kokoro** | Local (ONNX) | SELF_HOST | English | Per-sentence |
| **Azure Speech** | Cloud | BYOK | Multi | Native duplex |
| **Sarvam** | Cloud | BYOK | Indic | Per-sentence |
| **Indic Parler** | Local (HF) | SELF_HOST | Malayalam | Per-sentence |
| **Indic F5** | Local (HF) | SELF_HOST | Malayalam | Per-sentence |

### Infrastructure Dependencies
| Dependency | Purpose | Client |
|------------|---------|--------|
| Redis | Control plane config cache, invalidation pub/sub | redis.asyncio |
| MinIO (S3) | Not directly used (models via HF cache) | — |
| API Gateway | Spec resolution, service registration, auth validation, BYOK injection | httpx |
| HuggingFace Hub | Model weights for local engines (Kokoro, Indic) | transformers/onnxruntime |

---

## API Endpoints Summary

### Health & Internal (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed component health (always 200) |
| GET | `/health/live` | `liveness()` | K8s liveness probe |
| GET | `/health/ready` | `readiness()` | K8s readiness probe (provider health) |
| GET | `/health/startup` | `startup()` | K8s startup probe |

### Internal Model Resolvability (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/internal/models/resolvable` | `resolvable_one()` | Single model resolvability check |
| POST | `/api/v1/internal/models/resolvable` | `resolvable_batch()` | Batch model resolvability check |

### Public Synthesis Endpoints (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/audio/speech` | `create_speech()` | Batch synthesis (OpenAI-compatible) |
| WS | `/api/v1/audio/stream` | `audio_stream()` | Duplex streaming synthesis |

### Admin/Introspection Endpoints (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/providers` | `list_provider_status()` | Per-provider health, breaker, GPU/device |
| GET | `/api/v1/voices` | `list_voices()` | Voice catalog with provider bindings |

---

## Detailed API Documentation

### 1. Batch Synthesis - POST /api/v1/audio/speech

**File**: `tts/api/endpoints/speech.py:65`
**Handler**: `create_speech(body: SpeechRequest, request: Request) -> Response`

**Request Model** (`SpeechRequest`):
- `model`: "tts" (default)
- `input`: text to synthesize (required, min 1 char)
- `voice`: voice ID (optional — uses agent's default)
- `response_format`: `pcm` | `wav` | `mp3` (default: `pcm`)
- `speed`: 0.25–4.0 (default: 1.0)
- `stream_format`: `audio` | `sse` | null (null = batch)
- `resolved_spec`: `ResolvedTtsSpec` (REQUIRED — gateway-resolved agent)
- `provider_overrides`: BYOK credentials (gateway-injected)

**Implementation Chain**:
```
create_speech() [speech.py:65]
  → count_characters() [usage.py:26]
  → candidate_chain() [spec.py] — resolve ordered engine chain
  → refresh_model_cache_retention() [effective_config.py] — read-triggered config pull
  → tts_router.synthesize() [routing/router.py:348]
    → candidates() [router.py:263] — filter by circuit breaker
    → _engine_for() [router.py:280] — build/cache spec engine
      → _engine_cache_key() [router.py:138] — cache key by model+credential
      → _build_spec_engine() [router.py:210] — adapter.from_spec()
        → Adapter factory (e.g., KokoroProvider.from_spec)
    → _request_for() [router.py:318] — build SynthesisRequest per candidate
    → engine.synthesize() [provider-specific]
      → Kokoro: ONNX inference
      → Azure: REST SDK streaming
      → Sarvam/Indic: HF model inference
    → _sentence_adapter() [router.py:514] — chunk text for non-streaming engines
    → track_model_inference() [metrics.py] — Prometheus RTF/TTFA
  → Stream first chunk to determine winner (provider, connection_id, device)
  → Build response based on stream_format:
    - null (batch): collect all → Response with headers (X-Tts-Audio-Seconds, X-Tts-Synthesis-Ms)
    - "sse": EventSourceResponse with speech.audio.delta + speech.audio.done + speech.usage
    - "audio": StreamingResponse with raw PCM bytes
  → record_usage_metrics() [usage.py:68] — Prometheus counters
```

**Data Integration**:
- **In-Memory**: ProviderRegistry (boot-registered engines), spec-engine cache (`_spec_engines`), circuit breakers
- **Model Cache (HF)**: Local engines load weights from HuggingFace cache on first use
- **API Gateway**: Receives `resolved_spec` (agent chain) + `provider_overrides` (BYOK creds)
- **Prometheus**: Metrics for characters, audio seconds, RTF, TTFA, failover, errors

**Response Headers** (all modes):
- `X-Tts-Characters`: input character count
- `X-Tts-Sample-Rate`: output sample rate
- `X-Tts-Audio-Format`: pcm/wav/mp3
- `X-Tts-Provider`: winning provider name
- `X-Tts-Connection-Id`: AiProviderConnection ID (if any)
- `X-Tts-Device`: cuda/mps/cpu (local engines only)
- `X-Tts-Ttfa-Ms`: time-to-first-audio (streaming modes)

**Batch-only headers**:
- `X-Tts-Audio-Seconds`: total duration
- `X-Tts-Synthesis-Ms`: wall-clock synthesis time
- `X-Tts-Response-Bytes`: total bytes
- `X-Tts-Byte-Source`: "wire" (direct) or "app" (Azure SDK decode)

---

### 2. Streaming Synthesis - WS /api/v1/audio/stream

**File**: `tts/api/endpoints/stream_ws.py:104`
**Handler**: `audio_stream(ws: WebSocket) -> None`

**Protocol** (JSON in, binary PCM out):
```
Client → {"type":"init", "voice", "format":"pcm", "sample_rate", "speed", "resolved_spec", "provider_overrides"}
Server → {"type":"ready", "sample_rate", "format":"pcm", "channels":1}
Client → {"type":"text", "text":"words "} (repeated)
Client → {"type":"flush"} (force boundary)
Client → {"type":"end"} (finalize)
Server → binary PCM s16le mono frames
Server → {"type":"done"}
Server → {"type":"usage", "characters", "audioSeconds", "interrupted", "provider", "connectionId"}
```

**Implementation Chain**:
```
audio_stream() [stream_ws.py:104]
  → _authorized() [stream_ws.py:80] — validate X-Service-Token (WS handshake)
  → ws.accept()
  → receive_json() → validate init frame
  → ResolvedTtsSpec.model_validate(init.resolved_spec)
  → candidate_chain() [spec.py] — resolve chain upfront
  → tts_router.stream() [routing/router.py:454]
    → candidates() [router.py:263] — filter by circuit breaker + buildability
    → _engine_for() [router.py:280] — build/cache spec engine
    → Prefer DuplexTTSEngine (Azure) if PCM + speed=1.0
    → Else: _ChainSynthesizer + SentenceAdapter [router.py:549, routing/sentence_adapter.py]
  → Send ready frame
  → Spawn _pump_input() task [stream_ws.py:246] — reads text/flush/end frames
  → Main loop: async for chunk in stream
    → Stamp provider, connection_id on first chunk
    → ws.send_bytes(chunk.data)
  → On done/error: cancel reader, aclose stream
  → compute_audio_seconds() [usage.py:37]
  → record_usage_metrics() [usage.py:68]
  → Send usage frame (best-effort)
  → ws.close()
```

**Data Integration**:
- **In-Memory**: WebSocket state, `_SessionUsage` accumulator, `_pump_input` task
- **ProviderRegistry**: Engine instances (local) or connection pools (cloud)
- **Model Cache (HF)**: Local engine weights loaded lazily
- **API Gateway**: Injects `resolved_spec` + `provider_overrides` on init frame
- **Prometheus**: Same metrics as batch (characters, audio seconds, RTF, TTFA)

**Key Features**:
- One `init` → one stream → one `done` (no session reuse)
- Failover only before first audio byte (mid-stream = error)
- Voice fixed for session lifetime
- Characters counted on every `text` frame push
- Usage frame sent on teardown (success or abort)

---

### 3. Health Endpoints

#### GET /health - Detailed Health
**File**: `tts/api/endpoints/health.py:61`
**Handler**: `health_check() -> dict`

Returns: `{status: "healthy", service: "tts", version, uptime_seconds, timestamp, checks: {}}`

Always 200 — verdict in body.

#### GET /health/live - Liveness
**File**: `tts/api/endpoints/health.py:74`
**Handler**: `liveness() -> dict`

Returns: `{status: "healthy"}` — process is running.

#### GET /health/startup - Startup
**File**: `tts/api/endpoints/health.py:80`
**Handler**: `startup(request: Request) -> dict | JSONResponse`

Checks: `app.state.service_release_task` attribute exists (lifespan ran).

#### GET /health/ready - Readiness
**File**: `tts/api/endpoints/health.py:122`
**Handler**: `readiness(request: Request) -> dict | JSONResponse`

**Implementation Chain**:
```
readiness() [health.py:122]
  → request.app.state.provider_registry.list_providers()
  → for each provider: await provider.health()
    → healthy=True → return 200 healthy
    → healthy=False + is_configured=False → awaiting_credentials
    → healthy=False + loads_on_demand=True → awaiting_warm_load
  → if awaiting_credentials or awaiting_warm_load → 200 degraded (names which)
  → else → 503 unhealthy
```

**Four Readiness States**:
1. **healthy** — at least one provider reports healthy
2. **degraded (awaiting_credentials)** — BYOK providers need per-request keys
3. **degraded (awaiting_warm_load)** — self-hosted engines not yet loaded
4. **unhealthy** — credentialled provider erroring, or no providers registered

---

### 4. Model Resolvability

#### GET /api/v1/internal/models/resolvable
**File**: `tts/api/endpoints/models.py:83`
**Handler**: `resolvable_one() -> dict`

Single model check via query params.

#### POST /api/v1/internal/models/resolvable
**File**: `tts/api/endpoints/models.py:102`
**Handler**: `resolvable_batch(body: ResolvableRequest) -> dict`

**Implementation Chain**:
```
resolvable_batch() [models.py:102]
  → _verdicts() [models.py:72]
    → check_resolvable_many() [hope_runtime_models] — off event loop, budgeted
      → Filesystem check of HF_HOME/hub for each model
  → Returns: {service, checkedAt, warm, results[]}
```

**warm** field:
- `"pending"` — boot warmup not yet touched cache
- `"true"` — cache roots responded
- `"false"` — 60s budget exceeded

---

### 5. Provider Introspection

#### GET /api/v1/providers
**File**: `tts/api/endpoints/providers.py:47`
**Handler**: `list_provider_status(request: Request) -> dict`

Returns per-provider:
- `name`, `healthy` (from provider.health())
- `is_configured` (BYOK: False if no platform cred)
- `breaker_open` (circuit breaker state)
- `gpu_bound` (kokoro/indic_parler/indic_f5)
- `resolved_device` (cuda/mps/cpu from provider config)

---

### 6. Voice Catalog

#### GET /api/v1/voices
**File**: `tts/api/endpoints/voices.py:12`
**Handler**: `list_voices(request: Request) -> dict`

Returns: `{voices: [{id, locale, providers[]}]}`

VoiceCatalog holds static bindings (voice → engine_voice per provider).

---

## Routing & Failover Logic

**File**: `tts/routing/router.py`

### TTSRouter.synthesize() — Failover Chain
1. `candidates()` — filter chain by circuit breaker (open = skip)
2. For each candidate:
   - `_engine_for()` — build/cache spec engine (adapter.from_spec)
   - Skip if engine is None (not in image or BYOK with no cred)
   - Skip if `engine.is_configured == False` (keyless cloud)
   - Execute `engine.synthesize()` or `_sentence_adapter()`
   - On first chunk: stamp provider, connection_id, device, TTFA
   - On success: record RTF, return
   - On failure before first byte: record failure, try next candidate
   - On failure after first byte: **raise** (no mid-stream switch)
3. If all exhausted: raise `AllProvidersUnavailableError`

### TTSRouter.stream() — Duplex Path
- Eagerly validates buildability of ALL candidates upfront
- Prefers native duplex (Azure text-stream) for PCM + speed=1.0
- Else: `_ChainSynthesizer` + `SentenceAdapter`
- First sentence tries chain (failover); locks to winner on first byte
- Later sentences use locked candidate only

### Circuit Breaker
- Threshold: 5 failures
- Recovery: 30 seconds
- Per-provider, in-memory
- Open breaker excludes provider from `candidates()`

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `tts/main.py` | FastAPI app factory, lifespan, provider registration |
| `tts/api/endpoints/speech.py` | Batch synthesis endpoint (3 modes) |
| `tts/api/endpoints/stream_ws.py` | WebSocket duplex streaming |
| `tts/api/endpoints/health.py` | Health/readiness/startup probes |
| `tts/api/endpoints/providers.py` | Provider health/introspection |
| `tts/api/endpoints/voices.py` | Voice catalog |
| `tts/api/endpoints/models.py` | Model resolvability checks |
| `tts/routing/router.py` | Provider selection, failover, spec-engine cache |
| `tts/routing/sentence_adapter.py` | Per-sentence chunking for non-streaming engines |
| `tts/routing/circuit_breaker.py` | Circuit breaker per provider |
| `tts/routing/chunking.py` | Text chunking by locale |
| `tts/providers/base.py` | TTSEngine protocol, AudioChunk, ProviderRegistry |
| `tts/providers/kokoro.py` | Kokoro ONNX provider |
| `tts/providers/azure_speech.py` | Azure Speech SDK provider |
| `tts/providers/sarvam.py` | Sarvam provider |
| `tts/providers/indic_parler.py` | Indic Parler-TTS provider |
| `tts/providers/indic_f5.py` | Indic F5 provider |
| `tts/providers/registration.py` | Boot registration helper |
| `tts/spec.py` | ResolvedTtsSpec, ResolvedTtsCandidate, candidate_chain |
| `tts/catalog/voices.py` | VoiceCatalog (static voice→provider bindings) |
| `tts/core/config.py` | Settings, provider sub-configs |
| `tts/core/effective_config.py` | Control plane config client |
| `tts/core/usage.py` | Character/audio-second computation |
| `tts/core/metrics.py` | Prometheus metrics |
| `tts/core/observability.py` | Logging, tracing, access log |

---

## Configuration Keys (Control Plane)

| Key | Description | Default |
|-----|-------------|---------|
| `tts.warmupEnabled` | Warm up local engines at boot | `false` |
| `tts.modelCacheTtlSeconds` | Model cache TTL for control-plane retention | `3600` |
| `tts.maxInputChars` | Max input characters per request | `4096` |
| `tts.corsEnabled` | Enable CORS | `false` |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `tts-batch-speech.html` — Batch synthesis flow (3 response modes)
- `tts-streaming-ws.html` — WebSocket duplex synthesis flow
- `tts-routing-failover.html` — Router failover chain logic
- `tts-health-readiness.html` — Health/readiness probe logic
- `tts-model-resolvable.html` — Model resolvability check