# Vulnerability Scan Report — `apps/stt-v2/`

**Service**: Speech-to-Text V2 (Python/FastAPI)
**Scan Date**: 2026-03-24
**Scope**: Full source tree (`apps/stt-v2/src/`), Dockerfile, config files, pyproject.toml
**Context**: Healthcare AI (HOPE monorepo) — processes medical audio containing PHI/ePHI
**Compliance**: HIPAA Security Rule §164.312 (Access Controls, Audit Controls, Transmission Security, Integrity Controls)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** | 3 |
| **High** | 8 |
| **Medium** | 11 |
| **Low** | 6 |
| **Informational** | 5 |

The STT V2 service has a generally well-architected security posture — it uses parameterised SQL via SQLAlchemy ORM, avoids `pickle`/`eval`/`exec`, runs as non-root in Docker, and enforces multi-tenant isolation in the vector store. However, several critical and high-severity issues exist, particularly around SSRF surface area, credential handling, CORS misconfiguration, and model-loading supply chain risks.

---

## 1. Dependency CVE Analysis

### 1.1 Direct Dependencies (pyproject.toml)

| Package | Pinned | Known Risk | Severity |
|---------|--------|------------|----------|
| `torch>=2.8.0,<2.9.0` | Range-pinned | PyTorch's `torch.load()` uses pickle by default. Not called directly in this codebase (SafeTensors used), but the `from_pretrained()` pipeline in transformers/pyannote internally calls `torch.load()` for `.bin` checkpoint files. | **HIGH** |
| `torchaudio>=2.8.0,<2.9.0` | Range-pinned | Depends on torch; shares same pickle risk via torchaudio transforms | Medium |
| `nemo_toolkit[asr]>=2.6.0` | Floor-pinned | NeMo's `restore_from()` calls `torch.load()` internally on `.nemo` checkpoint archives | **HIGH** |
| `onnxruntime>=1.23.0` | Floor-pinned | ONNX model loading parses protobuf; malformed models can trigger OOB reads. Ensure models come from trusted repos only. | Medium |
| `transformers>=4.48.0` | Floor-pinned | `from_pretrained()` with `trust_remote_code=True` allows arbitrary code execution. Not used here, but the codebase loads user-configured `source_uri` from database. | **HIGH** |
| `huggingface_hub>=0.28.0` | Floor-pinned | `snapshot_download()` / `hf_hub_download()` download arbitrary files from HuggingFace Hub. Model source URIs come from the database, which an admin controls. | Medium |
| `sqlalchemy[asyncio]>=2.0.47` | Floor-pinned | No known CVEs for 2.0.47+. Queries use ORM-parameterised statements (safe). | Low |
| `minio>=7.2.20` | Floor-pinned | MinIO Python client trusts the endpoint configured via env var. SSRF possible if endpoint is attacker-controlled. | Medium |
| `redis[hiredis]>=5.2.0,<7.0` | Range-pinned | No known critical CVEs. `redis.asyncio` connections use plaintext by default (no TLS). | Medium |
| `httpx>=0.28.1` | Floor-pinned | No known critical CVEs. Used for API Gateway calls. | Low |
| `qdrant-client>=1.13.0` | Floor-pinned | Qdrant client connects via HTTP to URL from env var. SSRF surface if URL is attacker-controlled. | Medium |
| `pyannote.audio>=3.3.0` | Floor-pinned | Internally uses `torch.load()` for pretrained models; requires HuggingFace token for gated model access. | Medium |
| `azure-cognitiveservices-speech>=1.47.0` | Floor-pinned | Azure SDK; requires subscription key. Key leakage → billing abuse + data exfiltration. | Medium |
| `pyyaml>=6.0.3` | Floor-pinned | Uses `yaml.safe_load()` internally via the yaml_parser module (verified). No `yaml.load()` with `Loader=FullLoader`. | Low |
| `python-multipart>=0.0.22` | Floor-pinned | Handles multipart file uploads. Older versions had ReDoS (CVE-2024-24762, fixed in 0.0.7+). 0.0.22 is safe. | Low |
| `librosa>=0.11.0` | Floor-pinned | Audio processing library; parses untrusted audio formats. Potential for malformed audio exploits. | Medium |
| `soundfile>=0.13.1` | Floor-pinned | Wraps libsndfile for audio I/O; libsndfile has had heap overflow CVEs historically (CVE-2021-4156, etc.). Depends on system libsndfile version. | Medium |
| `numpy>=2.0.0` | Floor-pinned | No known critical CVEs for 2.0+. | Low |
| `pyrnnoise>=0.4.0` | Floor-pinned | Wraps RNNoise WASM/C library. Native code; potential memory safety issues in C layer. | Low |

### 1.2 Transitive / Implicit Risks

| Risk | Detail |
|------|--------|
| **Pickle deserialization via `from_pretrained()`** | HuggingFace `transformers`, `pyannote.audio`, and `nemo_toolkit` all internally use `torch.load()` when loading `.bin` checkpoints. SafeTensors mitigates this for models distributed in `.safetensors` format, but `.bin` fallback is still triggered for older models. The `model_source` URI comes from the database `AiModel.source_uri` field — if an attacker gains write access to the database, they can point models at malicious repos. |
| **`huggingface_hub` code execution** | The `transformers` library supports `trust_remote_code=True` which downloads and executes arbitrary Python. The codebase does NOT pass this flag (verified), but `from_pretrained()` can still execute model-specific code from `__init__.py` in downloaded model repos via `AutoConfig`. |

---

## 2. Pickle / Deserialization Vulnerabilities

### 2.1 Finding: **No Direct `pickle.load()` / `torch.load()` / `joblib.load()` Calls** ✅

**Severity**: N/A (positive finding)

Grep for `pickle.load`, `torch.load`, `joblib.load`, `dill.load` across `apps/stt-v2/` returned **zero matches**. The codebase exclusively uses:
- `from_pretrained()` via HuggingFace Transformers (uses SafeTensors by default)
- `ort.InferenceSession()` for ONNX models (protobuf, not pickle)
- `nemo_asr.models.*.restore_from()` (internally uses torch.load — see below)

### 2.2 Finding: **Indirect Pickle via NeMo `restore_from()`**

**Severity**: **HIGH**
**File**: `src/stt_v2/models/nemo_loader.py:105`

```python
model = model_class.restore_from(checkpoint_path)
```

NeMo's `restore_from()` unpacks `.nemo` archives (tar files containing `.ckpt` files) and calls `torch.load()` internally. The `checkpoint_path` comes from either:
- `model_config.local_path` (database `AiModel.localPath` field)
- `hf_hub_download()` result (controlled by `model_config.source_uri` from database)

**Impact**: If an attacker gains write access to the database or MinIO model storage, they can replace a `.nemo` checkpoint with a malicious one containing arbitrary pickle payloads.

**Remediation**:
1. Validate model checksums before loading (the `AiModel.checksum` field exists but is not verified during load)
2. Consider using `torch.load(..., weights_only=True)` where supported
3. Run model loading in a sandboxed subprocess with restricted capabilities

### 2.3 Finding: **Indirect Pickle via HuggingFace `from_pretrained()`**

**Severity**: **HIGH**
**File**: `src/stt_v2/models/huggingface_loader.py:139-168`

Multiple calls to `WhisperForConditionalGeneration.from_pretrained()`, `AutoModelForSpeechSeq2Seq.from_pretrained()`, etc. These will use SafeTensors by default for repos that publish `.safetensors` files, but fall back to `torch.load()` for `.bin`-only repos.

**Remediation**: Pass `use_safetensors=True` to all `from_pretrained()` calls to force SafeTensors-only loading and reject `.bin` files.

---

## 3. Path Traversal in File Uploads

### 3.1 Finding: **Filename Sanitization Present but Incomplete**

**Severity**: **Medium**
**File**: `src/stt_v2/storage/path_resolver.py:248-285`

The `_sanitize_filename()` method strips `..` and `/` via:
```python
filename = filename.replace("\\", "/").split("/")[-1]
```

This correctly extracts the basename, preventing classic `../../etc/passwd` traversal in MinIO object keys. However:

1. **Null bytes not stripped**: Filenames like `audio\x00.wav` could cause truncation issues in C-backed storage layers.
2. **Unicode normalization missing**: Filenames with Unicode lookalike characters (e.g., `．．／`) are not normalized.
3. **Length limit only on filename, not full path**: The full constructed path (tenant_id + year + month + consultation_id + job_id + filename) could exceed MinIO's 1024-byte key limit.

**Remediation**:
1. Strip null bytes: `filename = filename.replace('\x00', '')`
2. Apply NFKC Unicode normalization before sanitization
3. Validate total path length against MinIO's 1024-byte limit

### 3.2 Finding: **`parse_uri()` Accepts Arbitrary Bucket Names**

**Severity**: **Medium**
**File**: `src/stt_v2/storage/path_resolver.py:227-246`

```python
def parse_uri(self, uri: str) -> tuple[str, str]:
    if uri.startswith("s3://"):
        uri = uri[5:]
    parts = uri.split("/", 1)
    bucket = parts[0]
    path = parts[1] if len(parts) > 1 else ""
    return bucket, path
```

The `parse_uri()` method extracts bucket and path from user-influenced URIs (e.g., `audio_uri` from Dramatiq job messages) without validating that the bucket is one of the configured buckets (`hope-audio`, `hope-audio-chunks`). An attacker with queue injection capability could craft a URI like `s3://other-bucket/sensitive-data` to read from arbitrary MinIO buckets.

**Remediation**: Validate that parsed bucket matches configured `minio_audio_bucket` or `minio_chunk_bucket`.

---

## 4. Server-Side Request Forgery (SSRF)

### 4.1 Finding: **MinIO Endpoint from Environment Variable**

**Severity**: **CRITICAL** (in misconfigured environments)
**File**: `src/stt_v2/core/config/settings.py:80-81`

```python
minio_endpoint: str = "localhost:9000"
```

The MinIO endpoint is configured via `MINIO_ENDPOINT` env var. If this is set to an internal hostname (e.g., `169.254.169.254:80` for cloud metadata), the MinIO client will make requests to arbitrary internal services. The MinIO client also follows redirects by default.

**Mitigations present**: The endpoint is typically set at deployment time, not user-controlled. However, no validation exists that the endpoint resolves to an expected IP range.

**Remediation**: Validate `minio_endpoint` against an allowlist of expected hostnames/IP ranges at startup.

### 4.2 Finding: **HuggingFace Model Downloads from Database-Controlled URIs**

**Severity**: **CRITICAL**
**Files**: `src/stt_v2/models/huggingface_loader.py:46`, `src/stt_v2/models/onnx_loader.py:272-319`, `src/stt_v2/models/nemo_loader.py:150`

```python
model_source = model_config.local_path or model_config.source_uri
```

The `source_uri` field comes from the `AiModel` database table, which is populated by admin users via the API Gateway. If an attacker gains admin access or SQL write access, they can set `source_uri` to:
- A private network address (SSRF)
- A malicious HuggingFace repo containing backdoored model weights
- A custom HTTP server serving crafted ONNX/SafeTensor files

The `snapshot_download()` and `hf_hub_download()` calls in the ONNX and NeMo loaders make outbound HTTP requests to whatever `source_uri` resolves to.

**Remediation**:
1. Validate `source_uri` against an allowlist of trusted HuggingFace organizations (e.g., `openai/`, `onnx-community/`, `nvidia/`)
2. Block `source_uri` values containing IP addresses, localhost, or private network ranges
3. Implement model integrity verification using the `checksum` field before loading

### 4.3 Finding: **Qdrant URL from Environment Variable**

**Severity**: **Medium**
**File**: `src/stt_v2/core/config/settings.py:129-130`

```python
qdrant_url: str = "http://localhost:6333"
```

Same SSRF surface as MinIO: if `QDRANT_URL` is attacker-controlled, the Qdrant client will make HTTP requests to arbitrary internal services.

### 4.4 Finding: **API Gateway URL from Environment Variable**

**Severity**: **Medium**
**File**: `src/stt_v2/core/api_client/gateway.py:35-42`

The `httpx.AsyncClient` uses `settings.api_gateway_url` as `base_url`. If this is set to an attacker-controlled URL, all job lifecycle calls (start, progress, complete, fail) and transcript creation calls leak PHI data.

---

## 5. SQL Injection Analysis

### 5.1 Finding: **All Queries Use SQLAlchemy ORM — No Raw SQL Injection** ✅

**Severity**: N/A (positive finding)

All database queries in `src/stt_v2/pipeline/config_reader.py` use SQLAlchemy's `select()` with `.where()` clauses and parameterised values:

```python
result = await session.execute(
    select(AsrPipelineRead).where(
        AsrPipelineRead.id == pipeline_id,
        AsrPipelineRead.resource_status == "ENABLED",
    )
)
```

The only `text()` calls are `text("SELECT 1")` for health checks in `connection.py` and `health/api/routes.py`. No string formatting or concatenation in SQL queries.

---

## 6. Command Injection

### 6.1 Finding: **No `subprocess` / `os.system` in Production Code** ✅

**Severity**: N/A (positive finding)

Grep for `subprocess`, `os.system`, `os.popen`, `shlex` found only one match in `tests/helpers/db.py:26` (test infrastructure, not production code). The production source tree has zero shell command execution.

Audio processing uses Python-native libraries (`soundfile`, `librosa`, `pyrnnoise`, `numpy`) — no FFmpeg subprocess calls.

---

## 7. Race Conditions

### 7.1 Finding: **Streaming Session State Not Thread-Safe**

**Severity**: **HIGH**
**File**: `src/stt_v2/streaming/session.py`

The `StreamSession` class has mutable state (`ring_buffer`, `current_utterance`, `results`, `status`) that is modified by the `IngestionConsumer` callback (`_on_frame`) and the `ControlListener` callback (`_on_control`). Both run as `asyncio.Task` instances on the same event loop, so standard asyncio cooperative scheduling applies. However:

1. **`record_frame()` and `finalize()` can race**: If a `FINALIZE` control command arrives while a frame is being processed, the session status changes to `FINALIZING` mid-frame.
2. **`ring_buffer` mutations are not atomic**: `extend()` + `del [:overflow]` on `bytearray` — safe in CPython GIL but semantically racy if a coroutine yields between them.
3. **`results` list appended from inference task**: The inference task (`_start_inference_loop`) appends to `session.results` while the frame handler may also read/iterate results.

**Mitigating factor**: All operations are on the same asyncio event loop (single-threaded), so the GIL + cooperative scheduling prevents true data races. But a `await` yield point between bytearray operations could leave the buffer in an inconsistent intermediate state for other coroutines.

**Remediation**: Add `asyncio.Lock` protection around `ring_buffer` mutations and status transitions. Alternatively, use `asyncio.Queue` for all state mutations.

### 7.2 Finding: **Capacity Guard Double-Release**

**Severity**: **Medium**
**File**: `src/stt_v2/streaming/session_manager.py:407-414`

`remove_session()` calls `self._capacity_guard.release(session_id)` but doesn't check if the session was ever successfully acquired. If `create_session()` fails after `try_acquire()` and before registering, then `remove_session()` is called in the `except` handler, potentially releasing a slot that wasn't acquired.

**Mitigating factor**: The `_reconcile_capacity_guard()` heartbeat method (`session_manager.py:1212-1227`) self-heals leaked slots.

---

## 8. Memory / Resource Exhaustion

### 8.1 Finding: **Audio Upload Size Limit Present but Large**

**Severity**: **Medium**
**File**: `src/stt_v2/transcription/api/routes.py:51`

```python
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB
```

A 100 MB audio file is read entirely into memory (`audio_bytes = await file.read()`). With 4 concurrent Dramatiq worker threads, peak memory from file uploads alone could reach 400 MB.

**Remediation**: Consider streaming to a temporary file for files >10 MB instead of reading into memory.

### 8.2 Finding: **Streaming Ring Buffer Bounded** ✅

**Severity**: N/A (positive finding)

The ring buffer is capped at ~960 KB (30 seconds of 16 kHz mono):
```python
max_ring_bytes = sample_rate * 2 * 30  # 30 seconds per TASK-014 design
```

### 8.3 Finding: **Model Cache Has No Memory Limit**

**Severity**: **HIGH**
**File**: `src/stt_v2/core/config/settings.py:99-106`

```python
model_cache_max_models: int = 5
model_cache_ttl_seconds: int = 3600
```

The model cache limits the *count* of models (5) but not total memory. Five large Whisper models could consume ~15 GB of GPU/CPU memory. The `MODEL_CACHE_MAX_MODELS` setting has no memory-based eviction.

**Remediation**: Implement memory-based cache eviction using the `memory_mb` field from `LoadedModel`. Add a `MODEL_CACHE_MAX_MEMORY_MB` setting.

### 8.4 Finding: **Streaming Inference Queue Bounded** ✅

**Severity**: N/A (positive finding)

The inference queue has a configurable maxsize (default 64):
```python
inference_queue: asyncio.Queue[AudioUtterance | None] = asyncio.Queue(
    maxsize=self._inference_queue_maxsize
)
```

### 8.5 Finding: **Redis Stream Trimming Present** ✅

**Severity**: N/A (positive finding)

Audio streams use `XADD ... MAXLEN ~` trimming:
```python
entry_id = await redis.xadd(key, frame.to_redis_dict(), maxlen=maxlen, approximate=True)
```

### 8.6 Finding: **No Upload Size Limit on Embedding Endpoint**

**Severity**: **Medium**
**File**: `src/stt_v2/embedding/api/routes.py:88`

```python
audio_bytes = await file.read()
```

The `/internal/embeddings/upsert` endpoint reads the entire uploaded file into memory with no size limit. A malicious request with a multi-GB file would exhaust memory.

**Remediation**: Add a `_MAX_UPLOAD_BYTES` check similar to the transcription endpoint.

---

## 9. Unsafe `eval()` / `exec()` / `compile()`

### 9.1 Finding: **No `eval()`, `exec()`, or `compile()` in Production Code** ✅

**Severity**: N/A (positive finding)

Grep for `eval(`, `exec(`, `compile(` returned only `model.eval()` calls in the NeMo loader (PyTorch evaluation mode, not Python `eval`). Zero instances of Python's built-in `eval()`, `exec()`, or `compile()`.

---

## 10. Temporary File Vulnerabilities

### 10.1 Finding: **No `tempfile` Usage in Source Code** ✅

**Severity**: N/A (positive finding)

The codebase processes audio in-memory (BytesIO, numpy arrays) and uploads directly to MinIO. No local temporary files are created for audio processing. Model downloads go to the HuggingFace cache directory (`/models/hf-cache`).

### 10.2 Finding: **HuggingFace Cache Directory Permissions**

**Severity**: **Low**
**File**: `src/stt_v2/models/huggingface_loader.py:49-50`, `docker/Dockerfile:183`

```python
cache_dir = settings.huggingface_cache_dir
os.makedirs(cache_dir, exist_ok=True)
```

The cache directory (`/models/hf-cache`) is created with default permissions (likely 0o755). Downloaded model files may contain symlinks that point outside the cache directory (HuggingFace cache uses symlinks internally).

The Dockerfile creates `/models` with `chown -R app:app`, and the container runs as `USER app` — this limits the blast radius.

---

## 11. WebSocket / Streaming Vulnerabilities

### 11.1 Finding: **No Direct WebSocket Handling in STT V2** ✅

**Severity**: N/A (positive finding)

STT V2 does NOT handle WebSocket connections directly. Audio ingestion flows through Redis Streams:
```
WebSocket (API Gateway / NestJS) → Redis XADD → IngestionConsumer (STT V2)
```

The NestJS API Gateway handles WebSocket connections. STT V2 only reads from Redis Streams via `XREAD`. This eliminates direct WebSocket frame injection risks.

### 11.2 Finding: **Binary Frame Parsing from Redis Stream**

**Severity**: **Medium**
**File**: `src/stt_v2/streaming/redis_streams.py:153-172`

Audio frames are deserialized from Redis Stream entries via `AudioFrame.from_redis_dict(fields)`. If the NestJS gateway writes malformed entries (e.g., truncated PCM data, wrong sample rate), the preprocessor could:
- Create undersized numpy arrays causing index errors
- Pass malformed audio to ONNX VAD causing undefined behavior

**Mitigating factor**: The code handles exceptions per-frame and always advances `last_id` to avoid poisoning:
```python
except Exception as exc:
    logger.warning("Failed to process audio frame, skipping", ...)
finally:
    self._last_id = entry_id  # Always advance
```

---

## 12. DNS Rebinding / SSRF via MinIO

### 12.1 Finding: **MinIO Pre-signed URL Generation Uses Configured Endpoint**

**Severity**: **Medium**
**File**: `src/stt_v2/storage/blob_service.py:260-266`

```python
url = client.client.presigned_get_object(bucket, path, expires=timedelta(seconds=expires_in))
```

Pre-signed URLs are generated using the configured `MINIO_ENDPOINT`. In production, if `MINIO_ENDPOINT` is set to an internal hostname (e.g., `minio.internal:9000`), pre-signed URLs will contain this internal hostname. If these URLs are returned to external clients, they:
- Leak internal infrastructure information
- Won't be accessible from outside the network
- Could be used for DNS rebinding attacks if the hostname resolves to both internal and external IPs

**Remediation**: Use a separate public-facing MinIO endpoint for pre-signed URL generation, or proxy downloads through the API Gateway.

### 12.2 Finding: **MinIO Connection Uses Plaintext by Default**

**Severity**: **HIGH** (for PHI/ePHI compliance)
**File**: `src/stt_v2/core/config/settings.py:83`

```python
minio_secure: bool = False
```

Default `MINIO_SECURE=false` means MinIO connections use HTTP (unencrypted). Audio files containing PHI/ePHI are transmitted in plaintext between STT V2 and MinIO.

**HIPAA Impact**: §164.312(e)(1) requires encryption of ePHI in transit. Plaintext MinIO connections violate this requirement in production.

**Remediation**: Set `MINIO_SECURE=true` in production. Add startup validation that rejects `MINIO_SECURE=false` when `DEBUG=false`.

---

## 13. Audio Processing Bugs

### 13.1 Finding: **Malformed Audio File Handling**

**Severity**: **Medium**
**File**: `src/stt_v2/transcription/preprocessing.py:206-229`

```python
def _load_audio(self, audio_bytes: bytes) -> tuple[np.ndarray, int]:
    try:
        import soundfile as sf
        audio_io = io.BytesIO(audio_bytes)
        samples, sr = sf.read(audio_io)
        return samples.astype(np.float32), sr
    except ImportError:
        import librosa
        audio_io = io.BytesIO(audio_bytes)
        samples, sr = librosa.load(audio_io, sr=None)
        return samples, sr
```

Malformed audio files are parsed by `soundfile` (libsndfile C library) or `librosa`. Historical CVEs in libsndfile include heap buffer overflows (CVE-2021-4156, CVE-2022-33065). The service trusts the audio format completely — no format validation, magic byte checking, or sandboxing.

**Mitigating factor**: libsndfile in the Docker image comes from Debian packages which receive security patches.

**Remediation**:
1. Validate audio file magic bytes before passing to libsndfile (WAV: `RIFF....WAVE`, FLAC: `fLaC`, MP3: `\xff\xfb`, etc.)
2. Set a maximum decoded sample count to prevent decompression bombs
3. Consider running audio decoding in a subprocess with resource limits

### 13.2 Finding: **Integer Overflow in PCM Conversion**

**Severity**: **Low**
**File**: `src/stt_v2/streaming/preprocessor.py:191`

```python
frame_int16 = np.frombuffer(frame_bytes, dtype=np.int16)
frame_f32 = frame_int16.astype(np.float32) / 32768.0
```

The conversion from `int16` to `float32` divides by 32768.0. The minimum `int16` value is -32768, producing exactly -1.0. The maximum is 32767, producing 0.99997. This is standard and correct, but the asymmetry means audio clipping detection should account for this.

---

## 14. Database Connection Leaks

### 14.1 Finding: **Per-Event-Loop Engine Cache Without Cleanup**

**Severity**: **HIGH**
**File**: `src/stt_v2/core/database/connection.py:24-63`

```python
_engines: dict[int, AsyncEngine] = {}

def _get_or_create_engine() -> tuple[AsyncEngine, async_sessionmaker]:
    loop_id = _get_loop_id()
    if loop_id not in _engines:
        engine = create_async_engine(settings.database_url, ...)
        _engines[loop_id] = engine
```

Each unique event loop (e.g., each `asyncio.run()` in Dramatiq workers) creates a new engine with its own connection pool (`pool_size=5, max_overflow=10`). The `_engines` dict is keyed by `id(loop)`, but dead event loops are never cleaned up. Over time in long-running worker processes:

1. Dead event loop IDs accumulate in `_engines`
2. Each dead engine holds up to 15 connections (5 pool + 10 overflow)
3. Connection pool exhaustion on PostgreSQL

**Mitigating factor**: Dramatiq workers use `asyncio.run()` per job, which creates and destroys an event loop per job. CPython reuses memory addresses, so `id(loop)` may collide, effectively reusing engine slots. However, this is an implementation detail, not a guarantee.

**Remediation**: Implement engine cleanup when event loops are destroyed, or use a single engine per process with proper async context management.

### 14.2 Finding: **Session Context Manager Properly Handles Rollback** ✅

**Severity**: N/A (positive finding)

```python
async with session_factory() as session:
    try:
        yield session
    except Exception:
        await session.rollback()
        raise
```

Sessions are properly rolled back on exception and closed via the context manager.

---

## 15. Configuration & Dockerfile Vulnerabilities

### 15.1 Finding: **CORS Wildcard Default**

**Severity**: **CRITICAL**
**File**: `src/stt_v2/core/config/settings.py:37`

```python
cors_origins: list[str] = Field(default_factory=lambda: ["*"])
```

And in `main.py:199-204`:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

The default CORS configuration allows ALL origins with credentials. This means any website can make authenticated cross-origin requests to the STT API, potentially exfiltrating PHI/ePHI.

**HIPAA Impact**: Violates access control requirements. A malicious website visited by a healthcare worker could silently transcribe audio and exfiltrate results.

**Remediation**:
1. Set `CORS_ORIGINS` to the specific admin/playground domains in production
2. Add startup validation that rejects `["*"]` when `DEBUG=false`
3. Remove `allow_credentials=True` when using wildcard origins (browsers enforce this, but defense-in-depth)

### 15.2 Finding: **Default Credentials in Settings**

**Severity**: **HIGH**
**File**: `src/stt_v2/core/config/settings.py:40-41, 80-83`

```python
database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/hope"
minio_access_key: str = "minioadmin"
minio_secret_key: str = "minioadmin"
```

Default credentials are hardcoded as field defaults. While these are intended for development only, they will be used if environment variables are not set in production.

**Remediation**: Make `database_url`, `minio_access_key`, and `minio_secret_key` required fields with no defaults, or validate at startup that they differ from defaults when `DEBUG=false`.

### 15.3 Finding: **API Gateway Key Empty by Default**

**Severity**: **HIGH**
**File**: `src/stt_v2/core/config/settings.py:91-95`

```python
api_gateway_key: str = Field(default="", description="Internal service authentication key")
```

The `X-Internal-Service-Key` header is sent with every API Gateway request. If the key is empty, requests may bypass authentication at the gateway level, allowing unauthenticated access to job lifecycle endpoints.

**Remediation**: Validate at startup that `API_GATEWAY_KEY` is set and non-empty when `DEBUG=false`.

### 15.4 Finding: **Database URL Logged at Startup**

**Severity**: **Medium**
**File**: `src/stt_v2/core/database/connection.py:70`

```python
logger.info("Initializing database connection", url=settings.database_url[:50] + "...")
```

The first 50 characters of the database URL (including the scheme, username, and potentially the password) are logged. For a typical URL like `postgresql+asyncpg://stt_reader:MyS3cretP@ss@db.prod:5432/hope`, the first 50 chars would be `postgresql+asyncpg://stt_reader:MyS3cretP@ss@db.pr` — exposing the password.

**Remediation**: Mask the password before logging:
```python
from urllib.parse import urlparse
parsed = urlparse(settings.database_url)
safe_url = parsed._replace(netloc=f"{parsed.username}:***@{parsed.hostname}:{parsed.port}").geturl()
```

### 15.5 Finding: **Dockerfile Uses Non-Root User** ✅

**Severity**: N/A (positive finding)

All Docker stages run as `USER app` (UID 1000) after initial setup. The non-root user cannot escalate privileges within the container.

### 15.6 Finding: **Dockerfile Uses Specific Base Image Tags** ✅

**Severity**: N/A (positive finding)

Base images use specific versions (`python:3.11-slim-bookworm`, `nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04`), not `latest`.

### 15.7 Finding: **Debug Endpoints Conditionally Disabled** ✅

**Severity**: N/A (positive finding)

OpenAPI docs are disabled in production:
```python
docs_url="/api/v1/docs" if settings.debug else None,
redoc_url="/api/v1/redoc" if settings.debug else None,
```

### 15.8 Finding: **Prometheus Metrics Endpoint Publicly Exposed**

**Severity**: **Medium**
**File**: `src/stt_v2/main.py:207`

```python
Instrumentator().instrument(app).expose(app, endpoint="/metrics")
```

The `/metrics` endpoint is unconditionally exposed without authentication. Metrics can leak:
- Active session counts
- Request latencies
- Error rates
- Memory usage patterns

**Remediation**: Restrict `/metrics` to internal networks or add authentication.

### 15.9 Finding: **Redis Connection Uses Plaintext by Default**

**Severity**: **HIGH** (for PHI/ePHI compliance)
**File**: `src/stt_v2/core/config/settings.py:74-77`

```python
redis_url: str = "redis://localhost:6379/0"
```

Redis connections use plaintext by default. Transcription events (containing PHI) and audio stream data flow through Redis without encryption.

**HIPAA Impact**: §164.312(e)(1) requires encryption of ePHI in transit.

**Remediation**: Use `rediss://` (Redis with TLS) in production. Add startup validation.

---

## 16. Additional Findings

### 16.1 Finding: **Qdrant API Key Optional**

**Severity**: **Medium**
**File**: `src/stt_v2/core/config/settings.py:132-134`

```python
qdrant_api_key: str | None = Field(default=None)
```

If Qdrant is deployed without authentication and the network is compromised, speaker embeddings (biometric data, potential ePHI) can be read by any service on the network.

### 16.2 Finding: **Azure Speech Key in Environment Variable**

**Severity**: **Low**
**File**: `src/stt_v2/core/config/settings.py:119-126`

Azure Speech key is loaded from env var `AZURE_SPEECH_KEY`. If leaked, an attacker can:
- Use the Azure subscription for their own speech-to-text
- Potentially access audio data if the service retains it (depends on Azure retention settings)

### 16.3 Finding: **HuggingFace Token in Environment Variable**

**Severity**: **Low**
**File**: `src/stt_v2/core/config/settings.py:113-115`

HuggingFace token provides access to gated models (e.g., pyannote). If leaked, an attacker can download gated models and potentially access private repos.

### 16.4 Finding: **Worker Shutdown Skips Async Cleanup**

**Severity**: **Medium**
**File**: `src/stt_v2/worker.py:211-213`

```python
# Note: We skip async cleanup here because the event loop from initialize_services()
# is already closed. The database connections will be cleaned up by the OS on exit.
```

Database and MinIO connections are not properly closed on worker shutdown. While the OS will eventually clean up, this can leave PostgreSQL connections in `idle in transaction` state and MinIO connections in `CLOSE_WAIT`.

### 16.5 Finding: **`_finalize_session` References Undefined Variable**

**Severity**: **Low** (likely bug, not security)
**File**: `src/stt_v2/streaming/session_manager.py:910`

```python
except Exception as exc:
    logger.error(
        "Session finalization failed; forcing cleanup",
        session_id=session.session_id,
        status=status,  # ← 'status' is not defined in this scope
        error=str(exc),
    )
```

This will raise a `NameError` inside the exception handler, masking the original error and potentially leaving the session in an inconsistent state.

---

## Remediation Priority Matrix

### Immediate (Deploy-blocking for HIPAA)

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 15.1 | CORS wildcard with credentials | Critical | Low |
| 12.2 | MinIO plaintext (PHI in transit) | High | Low |
| 15.9 | Redis plaintext (PHI in transit) | High | Low |
| 15.2 | Default credentials in settings | High | Low |
| 15.3 | Empty API Gateway key | High | Low |

### Short-term (Within 1 week)

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 4.2 | SSRF via database-controlled model URIs | Critical | Medium |
| 2.2 | Indirect pickle via NeMo `restore_from()` | High | Medium |
| 2.3 | Indirect pickle via HuggingFace `from_pretrained()` | High | Low |
| 8.3 | Model cache has no memory limit | High | Medium |
| 14.1 | Per-event-loop engine cache leak | High | Medium |
| 3.2 | `parse_uri()` accepts arbitrary buckets | Medium | Low |
| 15.4 | Database URL password logged | Medium | Low |

### Medium-term (Within 1 month)

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 4.1 | MinIO endpoint SSRF surface | Critical (config) | Medium |
| 7.1 | Streaming session state not thread-safe | High | Medium |
| 13.1 | Malformed audio file handling | Medium | Medium |
| 8.1 | 100 MB upload read into memory | Medium | Medium |
| 8.6 | No upload size limit on embedding endpoint | Medium | Low |
| 15.8 | Prometheus metrics publicly exposed | Medium | Low |
| 16.1 | Qdrant API key optional | Medium | Low |
| 12.1 | MinIO pre-signed URL internal hostname | Medium | Medium |

### Ongoing

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 1.1 | Floor-pinned dependency versions | Medium | Low |
| 3.1 | Filename sanitization improvements | Medium | Low |
| 16.4 | Worker shutdown skips cleanup | Medium | Medium |

---

## Positive Security Findings

The following security best practices are correctly implemented:

1. **No pickle/eval/exec/subprocess in production code**
2. **SQLAlchemy ORM parameterised queries everywhere**
3. **Non-root Docker container execution**
4. **Specific Docker base image versions**
5. **Debug endpoints conditionally disabled**
6. **Ring buffer bounded at 30 seconds**
7. **Inference queue bounded with maxsize**
8. **Redis Stream MAXLEN trimming**
9. **Session context manager with proper rollback**
10. **Multi-tenant isolation in Qdrant vector store**
11. **File upload size limit on transcription endpoint**
12. **Streaming sessions bounded by capacity guard**
13. **Background reaper for idle session cleanup**
14. **Worker heartbeat for crash detection**
15. **Graceful SIGTERM handling**
16. **Audio processed in-memory (no temp files)**
17. **Filename sanitization strips path components**
18. **Redis Stream poisoning prevention (always advance last_id)**

---

## Scan Methodology

- **Static analysis**: Manual code review of all 155 files in `apps/stt-v2/`
- **Pattern matching**: Grep for dangerous patterns (`pickle`, `eval`, `exec`, `subprocess`, `os.system`, `text(`, `raw_connection`, etc.)
- **Dependency analysis**: Review of all 60+ dependencies in `pyproject.toml` against known CVE databases
- **Configuration review**: Settings, .env.example, Dockerfile, Docker Compose
- **Architecture analysis**: Data flow from WebSocket → Redis → STT V2 → MinIO/PostgreSQL/Qdrant
- **HIPAA compliance mapping**: §164.312 requirements vs implementation

---

*Report generated by HOPE Vulnerability Scanner. For questions, contact the security team.*
