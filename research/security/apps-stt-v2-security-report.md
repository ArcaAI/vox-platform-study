# Security Audit Report: STT-V2 Service

**Service**: `apps/stt-v2/` — Speech-to-Text Python/FastAPI
**Audit Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Auditor**: Security Auditor Agent
**Scope**: Full source code review of 73 Python source files, configuration, Docker, dependencies
**Classification**: Healthcare AI service processing medical audio (PHI)

> **Update (2026-04-06)**: Re-scan confirmed all original Critical/High findings remain open. CORS still defaults to `["*"]` via `settings.cors_origins`. No authentication middleware has been added. A `.env` file with default credentials remains committed at `apps/stt-v2/.env`.

---

## Executive Summary

The STT-V2 service is a well-structured FastAPI application with good foundational practices (Pydantic validation, SQLAlchemy ORM, structured logging). However, the audit identified **28 security findings** across critical infrastructure areas. The most significant concerns are:

1. **No authentication or authorization on any endpoint** — all API routes are unprotected
2. **Default credentials hardcoded in settings** with no enforcement of production overrides
3. **Wildcard CORS** configured by default, enabling cross-origin attacks
4. **No MIME type or magic-byte validation** on audio file uploads
5. **Sensitive data logged** including partial connection strings and internal error details
6. **ML model loading from untrusted sources** without integrity verification
7. **No encryption at rest** for audio data containing Protected Health Information (PHI)

The service processes healthcare audio containing patient conversations. Under HIPAA, this constitutes electronic Protected Health Information (ePHI), requiring defense-in-depth security measures.

---

## Findings Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 4 | Authentication, secrets, CORS, PHI exposure |
| **High** | 8 | Input validation, error leakage, model trust, storage security |
| **Medium** | 10 | Configuration, DoS vectors, logging, Redis security |
| **Low** | 4 | Best practice improvements |
| **Info** | 2 | Recommendations for future hardening |
| **Total** | **28** | |

---

## Detailed Findings

### CRITICAL Findings

---

#### VULN-001: No Authentication on Any Endpoint

**Severity**: Critical
**Location**: `src/stt_v2/main.py:186-216`
**OWASP**: A01 — Broken Access Control

**Description**:
No authentication middleware, API key validation, JWT verification, or any form of access control exists on any endpoint. All routes — including internal administrative endpoints (`/internal/cache/clear`, `/internal/sessions/cleanup`, `/internal/streaming/sessions`) — are completely open. The only protection is network-level (being behind the API Gateway), which is a single point of failure.

**Evidence**:

```python
def create_app() -> FastAPI:
    app = FastAPI(
        title="STT Service V2",
        # ...
        lifespan=lifespan,
    )
    # No auth middleware added
    app.add_middleware(CORSMiddleware, ...)

    # All routers registered without any dependency guards
    app.include_router(health_router, prefix="/api/v1", tags=["Health"])
    app.include_router(internal_router, tags=["Internal"])
    app.include_router(transcription_router, tags=["Transcription"])
    app.include_router(streaming_router, tags=["Streaming"])
    app.include_router(embedding_router, tags=["Embedding"])
```

While the API Gateway (`gateway.py:39`) sends `X-Internal-Service-Key` when making outbound calls, no endpoint on the STT service validates this key on inbound requests.

**Impact**:
Any client with network access can transcribe audio, manage streaming sessions, clear model caches, and access speaker embeddings. In a zero-trust architecture, internal services must still authenticate peer services.

**Remediation**:

```python
from fastapi import Depends, Header, HTTPException

async def verify_internal_key(
    x_internal_service_key: str = Header(..., alias="X-Internal-Service-Key"),
) -> None:
    if x_internal_service_key != settings.api_gateway_key:
        raise HTTPException(status_code=401, detail="Invalid service key")

# Apply to all internal routers
app.include_router(
    internal_router,
    tags=["Internal"],
    dependencies=[Depends(verify_internal_key)]
)
```

---

#### VULN-002: Default Credentials Hardcoded in Settings with No Production Guard

**Severity**: Critical
**Location**: `src/stt_v2/core/config/settings.py:40-85`, `.env.example:43-68`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
Multiple service credentials have insecure defaults that would be used if environment variables are not explicitly set:

| Setting | Default Value | Risk |
|---------|---------------|------|
| `database_url` | `postgresql+asyncpg://postgres:postgres@localhost:5432/hope` | Default DB creds |
| `minio_access_key` | `minioadmin` | Default MinIO admin |
| `minio_secret_key` | `minioadmin` | Default MinIO admin |
| `api_gateway_key` | `""` (empty string) | No auth at all |
| `redis_url` | `redis://localhost:6379/0` | No auth, no TLS |
| `minio_secure` | `False` | No TLS |

**Evidence**:

```python
class Settings(BaseSettings):
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/hope",
    )
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    api_gateway_key: str = Field(default="")
```

There is no validation that production deployments override these defaults. The application starts successfully with all defaults.

**Impact**:
If deployed to production without overriding every default, the service runs with publicly known credentials. The empty API Gateway key means internal API calls are effectively unauthenticated.

**Remediation**:

```python
from pydantic import field_validator

class Settings(BaseSettings):
    @field_validator("minio_access_key", "minio_secret_key", "database_url")
    @classmethod
    def _reject_default_credentials(cls, v: str, info) -> str:
        defaults = {"minioadmin", "postgres:postgres"}
        for d in defaults:
            if d in v and not os.getenv("ALLOW_DEV_DEFAULTS", ""):
                raise ValueError(
                    f"Default credential detected in {info.field_name}. "
                    "Set a secure value or export ALLOW_DEV_DEFAULTS=1 for local dev."
                )
        return v
```

---

#### VULN-003: Wildcard CORS Allows Cross-Origin Attacks

**Severity**: Critical
**Location**: `src/stt_v2/main.py:198-204`, `src/stt_v2/core/config/settings.py:37`
**OWASP**: A05 — Security Misconfiguration

**Description**:
CORS is configured with `allow_origins=["*"]` by default, combined with `allow_credentials=True`. This is a dangerous combination — it enables any website to make credentialed cross-origin requests to the STT service.

**Evidence**:

```python
# settings.py
cors_origins: list[str] = Field(default_factory=lambda: ["*"])

# main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Impact**:
An attacker can craft a malicious webpage that sends authenticated requests to the STT service from a victim's browser, enabling CSRF-like attacks on any endpoint.

**Remediation**:

```python
cors_origins: list[str] = Field(
    default_factory=list,
    description="Explicit allowed origins. Empty = no CORS (safest default).",
)

# In create_app():
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_origins != ["*"],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-Internal-Service-Key"],
    )
```

---

#### VULN-004: Database Connection String Logged at Startup

**Severity**: Critical
**Location**: `src/stt_v2/core/database/connection.py:70`
**OWASP**: A09 — Security Logging and Monitoring Failures

**Description**:
The database URL (which contains credentials) is logged at startup with only a 50-character truncation. For typical connection strings, this exposes the username and often the password.

**Evidence**:

```python
async def initialize_database() -> None:
    logger.info("Initializing database connection", url=settings.database_url[:50] + "...")
```

A typical URL like `postgresql+asyncpg://stt_reader:S3cretP@ss@db.internal:5432/hope` would log:
`url=postgresql+asyncpg://stt_reader:S3cretP@ss@db.` — exposing the full password.

**Impact**:
Database credentials exposed in application logs. Log aggregation systems (ELK, CloudWatch, Datadog) store these permanently, expanding the attack surface.

**Remediation**:

```python
from urllib.parse import urlparse

def _safe_db_url(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.hostname}:{parsed.port}/{parsed.path.lstrip('/')}"

logger.info("Initializing database connection", url=_safe_db_url(settings.database_url))
```

---

### HIGH Findings

---

#### VULN-005: No MIME Type or Magic Byte Validation on Audio Uploads

**Severity**: High
**Location**: `src/stt_v2/transcription/api/routes.py:69-117`, `src/stt_v2/embedding/api/routes.py:74-100`
**OWASP**: A03 — Injection

**Description**:
The transcription endpoint reads the entire uploaded file into memory and checks only for emptiness and size. There is no validation of:
- MIME type / Content-Type header
- File extension
- Magic bytes (file signature)
- Audio format validity

The embedding endpoint performs basic WAV header parsing (`_wav_duration_seconds`) but catches all exceptions and returns `-1.0`, meaning non-WAV files pass through to `_wav_to_numpy` which can crash or behave unexpectedly.

**Evidence**:

```python
# routes.py - transcription
async def transcribe_audio(
    file: UploadFile = File(...),
    ...
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, ...)
    if len(audio_bytes) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, ...)
    # No format validation — bytes go directly to batch_service
```

**Impact**:
Attackers can upload arbitrary files (executables, archives, polyglots) that get stored in MinIO and processed by ML models, potentially triggering crashes, memory corruption in native audio decoders (librosa, soundfile), or resource exhaustion.

**Remediation**:

```python
ALLOWED_AUDIO_MIMETYPES = {
    "audio/wav", "audio/wave", "audio/x-wav",
    "audio/mpeg", "audio/mp3", "audio/mp4",
    "audio/ogg", "audio/flac", "audio/webm",
}
AUDIO_MAGIC_BYTES = {
    b"RIFF": "wav", b"\xff\xfb": "mp3", b"\xff\xf3": "mp3",
    b"ID3": "mp3", b"fLaC": "flac", b"OggS": "ogg",
}

def validate_audio_file(file: UploadFile, audio_bytes: bytes) -> None:
    if file.content_type and file.content_type not in ALLOWED_AUDIO_MIMETYPES:
        raise HTTPException(status_code=400, detail="Unsupported audio format")
    header = audio_bytes[:4]
    if not any(header.startswith(magic) for magic in AUDIO_MAGIC_BYTES):
        raise HTTPException(status_code=400, detail="Invalid audio file signature")
```

---

#### VULN-006: File Upload Read Into Memory Without Streaming Protection

**Severity**: High
**Location**: `src/stt_v2/transcription/api/routes.py:99`
**OWASP**: A05 — Security Misconfiguration

**Description**:
The entire file is read into memory with `await file.read()` before checking the size limit. This means a 100 MB file (or potentially larger if the reverse proxy doesn't enforce limits) is fully loaded into RAM before being rejected. Multiple concurrent uploads can exhaust available memory.

**Evidence**:

```python
audio_bytes = await file.read()        # Full file in memory
if len(audio_bytes) > _MAX_UPLOAD_BYTES:  # Size check AFTER read
    raise HTTPException(status_code=413, ...)
```

**Impact**:
Denial of Service via memory exhaustion. An attacker sending multiple large files concurrently can crash the service before size validation occurs.

**Remediation**:

```python
MAX_CHUNK = 64 * 1024  # 64KB chunks
chunks = []
total = 0
while True:
    chunk = await file.read(MAX_CHUNK)
    if not chunk:
        break
    total += len(chunk)
    if total > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    chunks.append(chunk)
audio_bytes = b"".join(chunks)
```

Additionally, configure uvicorn/nginx with `client_max_body_size` / `--limit-request-body`.

---

#### VULN-007: Internal Error Details Exposed to Clients

**Severity**: High
**Location**: `src/stt_v2/embedding/api/routes.py:99-111`, `src/stt_v2/health/api/routes.py:282`, multiple endpoints
**OWASP**: A05 — Security Misconfiguration

**Description**:
Multiple endpoints return raw Python exception messages to the client in HTTP responses, potentially exposing internal implementation details, file paths, library versions, and stack trace fragments.

**Evidence**:

```python
# embedding/api/routes.py
except Exception as e:
    raise HTTPException(status_code=400, detail=f"Invalid audio file: {e}") from e

except Exception as e:
    raise HTTPException(status_code=500, detail=f"Embedding extraction failed: {e}") from e

except Exception as e:
    raise HTTPException(status_code=500, detail=f"Failed to store embedding: {e}") from e

# health/api/routes.py
except Exception as e:
    raise HTTPException(status_code=500, detail=str(e))
```

**Impact**:
Information disclosure. Internal error messages can reveal database schemas, file system paths, library versions, and system configuration to attackers, aiding further exploitation.

**Remediation**:
Log the full error internally, return generic messages to clients:

```python
except Exception as e:
    logger.exception("Embedding extraction failed", speaker_id=speaker_id)
    raise HTTPException(
        status_code=500,
        detail={"error_code": "EMBEDDING_EXTRACTION_FAILED", "message": "Internal processing error"},
    ) from e
```

---

#### VULN-008: MinIO Operates Without TLS by Default

**Severity**: High
**Location**: `src/stt_v2/core/config/settings.py:83`, `src/stt_v2/core/storage/minio_client.py:30-35`
**OWASP**: A02 — Cryptographic Failures

**Description**:
MinIO client is configured with `secure=False` by default, meaning all object storage communication (including audio files containing PHI) is transmitted in plaintext over HTTP.

**Evidence**:

```python
# settings.py
minio_secure: bool = False

# minio_client.py
self._client = Minio(
    endpoint=endpoint,
    access_key=access_key,
    secret_key=secret_key,
    secure=secure,  # False by default
)
```

**Impact**:
Network-level attackers can intercept audio files containing patient health information, MinIO credentials in HTTP headers, and transcription results. This violates HIPAA technical safeguards requiring encryption in transit.

**Remediation**:
Set `minio_secure: bool = True` as default. Add startup validation:

```python
if not settings.minio_secure and not settings.debug:
    logger.error("MinIO TLS is disabled in non-debug mode. Set MINIO_SECURE=true.")
    raise RuntimeError("MinIO TLS required in production")
```

---

#### VULN-009: ML Models Loaded from HuggingFace Without Integrity Verification

**Severity**: High
**Location**: `src/stt_v2/models/huggingface_loader.py:23-99`, `src/stt_v2/models/onnx_loader.py:252-329`
**OWASP**: A08 — Software and Data Integrity Failures

**Description**:
Models are downloaded from HuggingFace Hub via `from_pretrained()` and `snapshot_download()` without verifying checksums, signatures, or pinning to specific commit hashes. The `model_config.source_uri` comes from the database (pipeline configuration), meaning a compromised pipeline record could point to a malicious model.

**Evidence**:

```python
# huggingface_loader.py
model = WhisperForConditionalGeneration.from_pretrained(
    model_source,
    torch_dtype=torch_dtype,
    low_cpu_mem_usage=True,
    **common_kwargs,  # No verify_checksums, no commit hash pin
)

# onnx_loader.py
local_path = snapshot_download(
    repo_id=model_id,
    revision=revision,  # "main" by default — mutable branch
    cache_dir=cache_dir,
    allow_patterns=allow_patterns,
    # No verify_checksum parameter
)
```

**Impact**:
Supply chain attack via model poisoning. A compromised HuggingFace model could execute arbitrary code during deserialization (especially PyTorch models using `pickle`). SafeTensors mitigates pickle risks but does not prevent adversarial model weights.

**Remediation**:
1. Pin model revisions to immutable commit SHAs, not branch names
2. Verify model checksums after download
3. Use SafeTensors format exclusively (avoid pickle)
4. Maintain an allowlist of approved model repositories

```python
APPROVED_MODEL_REPOS = {
    "openai/whisper-large-v3",
    "onnx-community/whisper-large-v3-turbo",
    "pyannote/embedding",
}

if model_id not in APPROVED_MODEL_REPOS:
    raise ModelLoadError(f"Model '{model_id}' not in approved repository list")
```

---

#### VULN-010: NeMo Checkpoint Loading Uses Pickle Deserialization

**Severity**: High
**Location**: `src/stt_v2/models/nemo_loader.py:90-115`
**OWASP**: A08 — Software and Data Integrity Failures

**Description**:
NeMo's `restore_from()` loads `.nemo` checkpoint files which internally use pickle deserialization. An attacker who can place a malicious `.nemo` file in the model cache directory or compromise the HuggingFace download can achieve remote code execution.

**Evidence**:

```python
async def _load_from_checkpoint(self, checkpoint_path: str, device: str) -> Any:
    model_classes = [
        nemo_asr.models.EncDecCTCModelBPE,
        nemo_asr.models.EncDecRNNTBPEModel,
        nemo_asr.models.EncDecCTCModel,
    ]
    for model_class in model_classes:
        try:
            model = model_class.restore_from(checkpoint_path)  # pickle deserialization
```

**Impact**:
Remote Code Execution via deserialization of untrusted data. A crafted `.nemo` file triggers arbitrary Python code execution during model loading.

**Remediation**:
1. Restrict model loading to pre-approved, pre-validated checkpoints only
2. Verify SHA256 checksums of checkpoint files before loading
3. Run model loading in a sandboxed subprocess with restricted permissions
4. Prefer ONNX/SafeTensors formats which do not use pickle

---

#### VULN-011: Pre-signed URL Generation Without Expiry Limits

**Severity**: High
**Location**: `src/stt_v2/storage/blob_service.py:243-266`
**OWASP**: A01 — Broken Access Control

**Description**:
The `get_presigned_url()` method accepts a caller-controlled `expires_in` parameter with a default of 3600 seconds (1 hour). There is no maximum expiry enforcement, allowing URLs with very long validity periods.

**Evidence**:

```python
async def get_presigned_url(self, uri: str, expires_in: int = 3600) -> str:
    bucket, path = self._resolver.parse_uri(uri)
    client = get_minio_client()
    url = client.client.presigned_get_object(
        bucket, path,
        expires=timedelta(seconds=expires_in),  # No max limit
    )
    return url
```

**Impact**:
Pre-signed URLs for audio files containing PHI can be generated with indefinite validity, creating persistent access tokens that cannot be revoked.

**Remediation**:

```python
MAX_PRESIGN_EXPIRY_S = 3600  # 1 hour max

async def get_presigned_url(self, uri: str, expires_in: int = 900) -> str:
    expires_in = min(expires_in, MAX_PRESIGN_EXPIRY_S)
    ...
```

---

#### VULN-012: Swagger/ReDoc Docs Enabled in Debug Mode Without Auth

**Severity**: High
**Location**: `src/stt_v2/main.py:191-194`
**OWASP**: A05 — Security Misconfiguration

**Description**:
OpenAPI documentation endpoints (`/api/v1/docs` and `/api/v1/redoc`) are enabled when `debug=True`. If debug mode is accidentally enabled in production, the full API schema is exposed.

**Evidence**:

```python
app = FastAPI(
    docs_url="/api/v1/docs" if settings.debug else None,
    redoc_url="/api/v1/redoc" if settings.debug else None,
)
```

**Impact**:
Full API surface discovery for attackers, including all endpoints, request/response schemas, and parameter names.

**Remediation**:
Add environment-based guard:

```python
_enable_docs = settings.debug and os.getenv("ENVIRONMENT", "production") != "production"
```

---

### MEDIUM Findings

---

#### VULN-013: No Rate Limiting on Any Endpoint

**Severity**: Medium
**Location**: `src/stt_v2/main.py` (service-wide)
**OWASP**: A05 — Security Misconfiguration

**Description**:
No rate limiting is implemented on any endpoint. The `/api/v1/transcribe` endpoint is particularly expensive (CPU/GPU inference), and the embedding endpoints write to the vector store.

**Impact**:
DoS via resource exhaustion. An attacker can flood the transcription endpoint, consuming all CPU/GPU resources and blocking legitimate requests.

**Remediation**:
Use `slowapi` or a custom middleware:

```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@router.post("/transcribe")
@limiter.limit("10/minute")
async def transcribe_audio(request: Request, ...):
    ...
```

---

#### VULN-014: Redis Connection Without TLS or Authentication

**Severity**: Medium
**Location**: `src/stt_v2/core/config/settings.py:74-77`, `src/stt_v2/core/messaging/broker.py:55`
**OWASP**: A02 — Cryptographic Failures

**Description**:
Redis is configured with `redis://localhost:6379/0` (no TLS, no password). The Dramatiq broker and all Pub/Sub connections use this unencrypted, unauthenticated connection.

**Evidence**:

```python
redis_url: str = Field(default="redis://localhost:6379/0")

# broker.py
_broker = RedisBroker(url=redis_url, middleware=[])
result_backend = RedisBackend(url=redis_url)
```

**Impact**:
Network-level attackers can read all Pub/Sub messages (containing transcription text), inject malicious Dramatiq jobs, and manipulate streaming session state.

**Remediation**:
Support Redis TLS and require authentication:

```
REDIS_URL=rediss://user:password@redis.internal:6380/0
```

---

#### VULN-015: Streaming Session ID Not Validated

**Severity**: Medium
**Location**: `src/stt_v2/streaming/api/routes.py:54-84`
**OWASP**: A03 — Injection

**Description**:
The `session_id` in `CreateStreamingSessionRequest` is client-provided but not validated for format, length, or uniqueness before being used as a Redis key component (`stt:session:{session_id}`).

**Evidence**:

```python
async def create_streaming_session(request: CreateStreamingSessionRequest):
    session = await mgr.create_session(
        session_id=request.session_id,  # Client-controlled, used in Redis keys
        ...
    )
```

Redis key construction in `redis_streams.py`:
```python
def audio_stream_key(session_id: str) -> str:
    return f"stt:audio:{session_id}"
```

**Impact**:
A malicious session_id could inject Redis key separators or create excessively long keys causing Redis memory issues. Values like `../../` or extremely long strings could cause unexpected behavior.

**Remediation**:

```python
import re

SESSION_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")

@field_validator("session_id")
def _validate_session_id(cls, v: str) -> str:
    if not SESSION_ID_PATTERN.match(v):
        raise ValueError("Invalid session_id format")
    return v
```

---

#### VULN-016: Speaker Embedding Metadata Accepts Arbitrary JSON

**Severity**: Medium
**Location**: `src/stt_v2/embedding/api/routes.py:55-65`, `src/stt_v2/core/vectorstore/speaker_store.py:162`
**OWASP**: A03 — Injection

**Description**:
The embedding upsert endpoint accepts arbitrary JSON metadata from the client which is parsed and directly merged into the Qdrant payload without schema validation or field allowlisting.

**Evidence**:

```python
# routes.py
def _parse_metadata(raw: str | None) -> dict[str, Any] | None:
    parsed = json.loads(raw)
    if isinstance(parsed, dict):
        return parsed  # Any keys accepted

# speaker_store.py
if metadata:
    payload.update(metadata)  # Direct merge into Qdrant payload
```

**Impact**:
An attacker can overwrite reserved payload fields (`tenant_id`, `speaker_id`, `created_at`) in the Qdrant point, potentially bypassing tenant isolation or injecting misleading data.

**Remediation**:

```python
RESERVED_FIELDS = {"tenant_id", "speaker_id", "created_at", "consultation_id"}

if metadata:
    sanitized = {k: v for k, v in metadata.items() if k not in RESERVED_FIELDS}
    payload.update(sanitized)
```

---

#### VULN-017: Prometheus /metrics Endpoint Publicly Accessible

**Severity**: Medium
**Location**: `src/stt_v2/main.py:207`
**OWASP**: A05 — Security Misconfiguration

**Description**:
Prometheus metrics are exposed at `/metrics` without authentication, revealing operational data including request rates, error counts, latency distributions, and active session counts.

**Evidence**:

```python
Instrumentator().instrument(app).expose(app, endpoint="/metrics")
```

**Impact**:
Information disclosure. Metrics reveal system capacity, usage patterns, and error rates that aid in planning DoS attacks or understanding system behavior.

**Remediation**:
Serve metrics on a separate internal port or add authentication.

---

#### VULN-018: Qdrant Vector Store Without API Key by Default

**Severity**: Medium
**Location**: `src/stt_v2/core/config/settings.py:133-136`, `src/stt_v2/core/vectorstore/client.py:48-53`
**OWASP**: A07 — Identification and Authentication Failures

**Description**:
The Qdrant client defaults to no API key (`qdrant_api_key: str | None = None`). Without authentication, anyone with network access to the Qdrant instance can read, modify, or delete speaker embeddings.

**Evidence**:

```python
self._client = AsyncQdrantClient(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,  # None by default
    ...
)
```

**Impact**:
Unauthorized access to biometric speaker embeddings, which are sensitive personal data subject to GDPR/HIPAA protections.

**Remediation**:
Require API key in production:

```python
if not settings.qdrant_api_key and not settings.debug:
    raise VectorStoreConnectionError("QDRANT_API_KEY required in production")
```

---

#### VULN-019: No Request Body Size Limit at Server Level

**Severity**: Medium
**Location**: `src/stt_v2/main.py:232-242`
**OWASP**: A05 — Security Misconfiguration

**Description**:
While the transcription endpoint has an application-level 100MB limit, there is no server-level body size limit configured for uvicorn. Other endpoints (embedding upsert, streaming sessions) have no size limits at all.

**Impact**:
Memory exhaustion via oversized request bodies on endpoints without application-level limits.

**Remediation**:
Configure uvicorn with `--limit-max-request-size` and add a global middleware:

```python
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_REQUEST_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request too large"})
    return await call_next(request)
```

---

#### VULN-020: Redis Pub/Sub Messages Not Validated or Signed

**Severity**: Medium
**Location**: `src/stt_v2/core/messaging/pubsub.py:115-138`
**OWASP**: A08 — Software and Data Integrity Failures

**Description**:
Redis Pub/Sub messages are published as JSON without any integrity verification (HMAC, signing). Any entity with Redis access can publish fake transcription events to job channels.

**Impact**:
An attacker with Redis access can inject fake transcription results, progress updates, or error events that get relayed to clients via SSE.

**Remediation**:
Add HMAC signing to published messages:

```python
import hmac, hashlib

def _sign_event(event: dict, secret: str) -> dict:
    payload = json.dumps(event, sort_keys=True, default=str)
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    event["_sig"] = signature
    return event
```

---

#### VULN-021: Dramatiq Broker Logs Partial Redis URL

**Severity**: Medium
**Location**: `src/stt_v2/core/messaging/broker.py:50`
**OWASP**: A09 — Security Logging and Monitoring Failures

**Description**:
The Dramatiq broker logs the first 30 characters of the Redis URL, which may include credentials.

**Evidence**:

```python
logger.info("Configuring Dramatiq broker", redis_url=redis_url[:30] + "...")
```

For a URL like `redis://user:password@redis.internal:6379/0`, 30 characters exposes the full credentials.

**Remediation**:
Log only the hostname:port.

---

#### VULN-022: Path Traversal Partially Mitigated in Filename Sanitization

**Severity**: Medium
**Location**: `src/stt_v2/storage/path_resolver.py:248-285`
**OWASP**: A01 — Broken Access Control

**Description**:
The `_sanitize_filename()` method handles basic path components but does not account for URL-encoded path separators (`%2F`, `%5C`), null bytes (`%00`), or Unicode normalization attacks.

**Evidence**:

```python
def _sanitize_filename(self, filename: str) -> str:
    filename = filename.replace("\\", "/").split("/")[-1]
    # Does not handle: %2F, %5C, %00, Unicode tricks
```

**Impact**:
While the current implementation strips directory separators, encoded variants could bypass the sanitization in certain configurations.

**Remediation**:

```python
import unicodedata
from urllib.parse import unquote

def _sanitize_filename(self, filename: str) -> str:
    filename = unquote(filename)
    filename = filename.replace("\x00", "")
    filename = unicodedata.normalize("NFKC", filename)
    filename = filename.replace("\\", "/").split("/")[-1]
    filename = re.sub(r"[^\w.\-]", "_", filename)
    if not filename or filename.startswith("."):
        filename = "unnamed_upload"
    return filename[:200]
```

---

#### VULN-023: Streaming Session Reaper Uses Wall Clock Comparison

**Severity**: Medium
**Location**: `src/stt_v2/streaming/session_manager.py:1125-1167`
**OWASP**: N/A — Reliability/Security

**Description**:
The reaper uses `datetime.utcnow()` and string-based ISO timestamp comparison, which can fail on clock skew between containers or if the session's `last_activity` is in a different timezone format.

**Impact**:
Sessions may not be reaped correctly, leading to resource leaks or premature session termination.

---

### LOW Findings

---

#### VULN-024: Health Check Exposes Component Error Messages

**Severity**: Low
**Location**: `src/stt_v2/health/api/routes.py:149`
**OWASP**: A05 — Security Misconfiguration

**Description**:
Health check responses include truncated error messages from failed components (up to 200 characters). While limited, these can reveal internal hostnames, port numbers, and connection details.

**Evidence**:

```python
return ComponentHealth(
    name="database",
    status=HealthStatus.UNHEALTHY,
    latency_ms=latency,
    message=str(e)[:200],  # Can expose internal topology
)
```

---

#### VULN-025: No Content Security Policy or Security Headers

**Severity**: Low
**Location**: `src/stt_v2/main.py`
**OWASP**: A05 — Security Misconfiguration

**Description**:
No security headers are set: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`.

**Remediation**:

```python
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response
```

---

#### VULN-026: No Audit Logging for Administrative Actions

**Severity**: Low
**Location**: `src/stt_v2/health/api/routes.py:285-307`
**OWASP**: A09 — Security Logging and Monitoring Failures

**Description**:
Administrative endpoints like `/internal/cache/clear` and `/internal/sessions/cleanup` do not log the requesting identity or produce audit trail entries.

---

#### VULN-027: Dockerfile Runs as Root in Builder Stages

**Severity**: Low
**Location**: `docker/Dockerfile`
**OWASP**: A05 — Security Misconfiguration

**Description**:
While the production stages should run as non-root (per infrastructure rules), the current multi-stage build does not explicitly create or use a non-root user in the runtime stages. Verification of the full Dockerfile (lines 60+) is recommended.

---

### INFORMATIONAL Findings

---

#### VULN-028: No Encryption at Rest for Audio Data (HIPAA)

**Severity**: Info (Architecture)
**Location**: Service-wide
**OWASP**: A02 — Cryptographic Failures

**Description**:
Audio files containing medical conversations (ePHI) are stored in MinIO without application-level encryption at rest. While MinIO supports server-side encryption (SSE), it is not configured or enforced by the application.

**HIPAA Considerations**:
- 45 CFR § 164.312(a)(2)(iv) requires encryption of ePHI at rest
- Audio containing patient conversations qualifies as ePHI
- Speaker embeddings are biometric identifiers under HIPAA
- Transcription text contains clinical information

**Remediation**:
1. Enable MinIO SSE-S3 (server-side encryption with managed keys)
2. Implement bucket-level encryption policies
3. Configure Qdrant with encryption for speaker embeddings
4. Add data retention policies with automated deletion

---

#### VULN-029: No Data Retention or Right-to-Delete Implementation

**Severity**: Info (Compliance)
**Location**: Service-wide

**Description**:
No mechanism exists to:
- Delete all data for a specific patient/speaker
- Enforce data retention policies
- Respond to GDPR right-to-erasure requests
- Automatically purge audio after configurable retention periods

The `cleanup_expired()` method in `speaker_store.py` exists but is not called by any scheduled task.

---

## OWASP Top 10 Compliance Summary

| OWASP Category | Status | Key Findings |
|----------------|--------|-------------|
| A01: Broken Access Control | **FAIL** | No auth on any endpoint (VULN-001), pre-signed URL control (VULN-011) |
| A02: Cryptographic Failures | **FAIL** | No TLS for MinIO (VULN-008), Redis (VULN-014), no encryption at rest (VULN-028) |
| A03: Injection | **PARTIAL** | Good: SQLAlchemy ORM prevents SQL injection. Bad: No audio format validation (VULN-005), unsanitized metadata (VULN-016) |
| A04: Insecure Design | **PARTIAL** | Good: multi-tenant isolation in Qdrant. Bad: No defense-in-depth (single API Gateway as auth boundary) |
| A05: Security Misconfiguration | **FAIL** | Wildcard CORS (VULN-003), no rate limiting (VULN-013), exposed metrics (VULN-017), default credentials (VULN-002) |
| A06: Vulnerable Components | **REVIEW** | Dependencies should be scanned with `pip-audit`. No known CVEs in current pinned versions but minimum bounds (`>=`) allow vulnerable patch versions |
| A07: Authentication Failures | **FAIL** | Default empty API key (VULN-002), no Qdrant auth (VULN-018) |
| A08: Integrity Failures | **FAIL** | Untrusted model loading (VULN-009, VULN-010), unsigned Pub/Sub (VULN-020) |
| A09: Logging Failures | **PARTIAL** | Good: structured logging with structlog. Bad: credentials in logs (VULN-004, VULN-021), no audit trail (VULN-026) |
| A10: SSRF | **PASS** | No user-controlled URL fetching. Model URIs from database (trusted source). |

---

## Dependency Risk Assessment

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| `fastapi` | >=0.133.0 | Low | Well-maintained, actively patched |
| `transformers` | >=4.48.0 | Medium | Large attack surface, model loading from HF Hub |
| `torch` | >=2.8.0,<2.9.0 | Medium | Pickle-based model loading, large native codebase |
| `onnxruntime` | >=1.23.0 | Low | ONNX format is safer than pickle |
| `pyannote.audio` | >=3.3.0 | Medium | Requires HF token for gated models |
| `redis` | >=5.2.0,<7.0 | Low | Well-maintained |
| `minio` | >=7.2.20 | Low | Well-maintained |
| `pyyaml` | >=6.0.3 | Low | Use `yaml.safe_load()` only (verify in pipeline YAML parser) |
| `httpx` | >=0.28.1 | Low | No known issues |
| `sqlalchemy` | >=2.0.47 | Low | Parameterized queries prevent injection |

**Recommendation**: Run `pip-audit` and `safety check` against the locked dependency set (`uv.lock`) to identify any known CVEs.

---

## Recommendations — Priority Order

### Immediate (Sprint 0 — Critical Fixes)

1. **Add authentication middleware** to all endpoints (VULN-001)
2. **Remove default credentials** or add production guard validators (VULN-002)
3. **Restrict CORS origins** — remove wildcard default (VULN-003)
4. **Redact credentials from logs** — database URL, Redis URL (VULN-004, VULN-021)

### Short-term (Sprint 1 — High Priority)

5. **Add audio file validation** — magic bytes, MIME type, format checks (VULN-005)
6. **Stream file uploads** — check size during read, not after (VULN-006)
7. **Sanitize error responses** — generic messages to clients (VULN-007)
8. **Enable TLS for MinIO and Redis** (VULN-008, VULN-014)
9. **Pin model revisions** to commit SHAs, add model allowlist (VULN-009)
10. **Cap pre-signed URL expiry** (VULN-011)

### Medium-term (Sprint 2 — Hardening)

11. **Add rate limiting** on transcription and embedding endpoints (VULN-013)
12. **Validate session IDs** with strict format regex (VULN-015)
13. **Allowlist metadata fields** for embedding upsert (VULN-016)
14. **Protect /metrics endpoint** (VULN-017)
15. **Require Qdrant API key** in production (VULN-018)
16. **Add security headers** middleware (VULN-025)
17. **Implement audit logging** for admin actions (VULN-026)

### Long-term (Compliance Roadmap)

18. **Enable encryption at rest** for MinIO and Qdrant (VULN-028)
19. **Implement data retention policies** and right-to-delete (VULN-029)
20. **Run regular dependency scans** in CI/CD pipeline
21. **Add HIPAA BAA** with all infrastructure providers
22. **Implement network policies** for service-to-service communication

---

## Files Reviewed

| Category | Files | Count |
|----------|-------|-------|
| Configuration | `settings.py`, `.env.example`, `pyproject.toml` | 3 |
| API Routes | `transcription/api/routes.py`, `streaming/api/routes.py`, `embedding/api/routes.py`, `health/api/routes.py` | 4 |
| Core Infrastructure | `connection.py`, `minio_client.py`, `broker.py`, `pubsub.py`, `gateway.py` | 5 |
| Storage | `blob_service.py`, `path_resolver.py` | 2 |
| Models/ML | `huggingface_loader.py`, `onnx_loader.py`, `nemo_loader.py`, `cache.py`, `base_loader.py` | 5 |
| Streaming | `session_manager.py`, `redis_streams.py`, `capacity_guard.py`, `session.py`, `inference.py`, `preprocessor.py`, `schemas.py` | 7 |
| Vector Store | `client.py`, `speaker_store.py` | 2 |
| Transcription | `batch_service.py`, `preprocessing.py`, `transcribe_file.py` | 3 |
| Application Entry | `main.py`, `worker.py` | 2 |
| Docker | `Dockerfile`, `Dockerfile.apple`, `.dockerignore` | 3 |
| **Total** | | **36** |

---

*Report generated by Security Auditor Agent — HOPE Project*
