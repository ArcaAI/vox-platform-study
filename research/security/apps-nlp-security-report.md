# Security Audit Report: Medical NLP Service (`apps/nlp/`)

**Audit Date:** 2026-03-24
**Auditor:** Automated Security Auditor Agent
**Service:** Medical Entity Recognition & NLP Service
**Version:** 1.0.0
**Framework:** FastAPI (Python 3.11+)
**Scope:** Full source code review of `apps/nlp/` — 26 Python source files, 1 Dockerfile, 1 pyproject.toml

---

## Executive Summary

The Medical NLP service processes **sensitive medical text** (patient transcripts, clinical notes, diagnostic data) and returns medical entity classifications, diagnosis suggestions, and text corrections. Due to the nature of the data processed, this service falls under **HIPAA** and healthcare data protection requirements.

This audit identified **21 findings** across the NLP service codebase. The most critical issues are:

1. **Wildcard CORS configuration** allowing any origin to access medical data endpoints
2. **No authentication or authorization** on any endpoint, including WebSocket connections
3. **No input size limits** on text fields that are processed by ML models, enabling resource exhaustion
4. **Medical data (PHI/PII) logged in plaintext** to files and console
5. **WebSocket sessions lack authentication**, DoS protections, and input validation
6. **ML models loaded from remote untrusted HuggingFace repos** without integrity verification
7. **Internal exception details leaked** to WebSocket clients

Immediate remediation of Critical and High severity findings is strongly recommended before production deployment, particularly given the healthcare data sensitivity.

---

## Findings Summary

| ID | Severity | Title | OWASP | File |
|----|----------|-------|-------|------|
| VULN-001 | **Critical** | Wildcard CORS Allows All Origins | A05 | `core/config.py:167` |
| VULN-002 | **Critical** | No Authentication on Any Endpoint | A07 | `app.py`, `api/` |
| VULN-003 | **Critical** | WebSocket Endpoints Lack Authentication | A07 | `api/v1/ws/classify.py` |
| VULN-004 | **High** | No Input Size Limits on Text Fields | A05 | `schemas/classification.py` |
| VULN-005 | **High** | PHI/PII Logged in Plaintext | A09 | Multiple |
| VULN-006 | **High** | ML Models Loaded from Untrusted Remote Sources | A08 | `services/*.py` |
| VULN-007 | **High** | No Rate Limiting on Any Endpoint | A05 | `app.py` |
| VULN-008 | **High** | WebSocket: No Connection Rate Limiting or Auth | A07 | `core/websocket_manager.py` |
| VULN-009 | **High** | Exception Details Leaked to WebSocket Clients | A05 | `core/websocket_manager.py:84` |
| VULN-010 | **High** | Diagnosis Suggestion Response Logged Verbatim | A09 | `api/v1/rest/diagnosis.py:22` |
| VULN-011 | **Medium** | No Security Headers Middleware | A05 | `app.py` |
| VULN-012 | **Medium** | `allow_headers=["*"]` in CORS Configuration | A05 | `app.py:35` |
| VULN-013 | **Medium** | No Request Body Size Limit | A05 | `app.py`, `main.py` |
| VULN-014 | **Medium** | Unvalidated WebSocket JSON Input | A03 | `core/websocket_manager.py:65` |
| VULN-015 | **Medium** | Unvalidated `session_id` Path Parameter | A03 | `api/v1/ws/classify.py:14,30` |
| VULN-016 | **Medium** | No Model Integrity Verification | A08 | `services/*.py` |
| VULN-017 | **Medium** | `print()` Statement in Production Code | A09 | `services/token_classifier.py:113` |
| VULN-018 | **Low** | `host` Defaults to `0.0.0.0` Binding All Interfaces | A05 | `core/config.py:41` |
| VULN-019 | **Low** | Deprecated `opentelemetry-exporter-jaeger-thrift` | A06 | `pyproject.toml:38` |
| VULN-020 | **Low** | `python-jose` Has Known Vulnerabilities | A06 | `pyproject.toml:27` |
| VULN-021 | **Info** | Unused Auth Dependencies (python-jose, passlib) | A06 | `pyproject.toml:27-28` |

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 7 |
| Medium | 7 |
| Low | 3 |
| Info | 1 |

---

## Detailed Findings

---

### VULN-001: Wildcard CORS Allows All Origins

**Severity:** Critical
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/core/config.py:167`, `src/nlp/app.py:30-36`

**Description:**
The default CORS configuration allows **all origins** (`["*"]`), **all HTTP methods** (GET, POST, PUT, DELETE, OPTIONS), **all headers**, and **credentials**. This permits any website on the internet to make authenticated cross-origin requests to the NLP service's medical data endpoints.

**Evidence:**

```python
# src/nlp/core/config.py:164-171
class SecurityConfig(BaseSettings):
    cors_origins: List[str] = Field(default=["*"])
    cors_methods: List[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    cors_headers: List[str] = Field(default=["*"])
    cors_allow_credentials: bool = Field(default=True)
```

```python
# src/nlp/app.py:30-36
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.security.cors_origins,
    allow_credentials=True,
    allow_methods=settings.security.cors_methods,
    allow_headers=["*"],  # hardcoded wildcard, ignores config
)
```

**Impact:**
A malicious website could exfiltrate medical data by making cross-origin requests from a user's browser. Combined with `allow_credentials=True`, this can bypass browser same-origin policy for authenticated sessions.

Note: Per the CORS spec, `allow_origins=["*"]` with `allow_credentials=True` is actually rejected by browsers, but FastAPI's `CORSMiddleware` silently converts this into reflecting the request origin — effectively allowing every origin with credentials.

**Recommended Fix:**

```python
class SecurityConfig(BaseSettings):
    cors_origins: List[str] = Field(
        default=["http://localhost:5174", "http://localhost:5175"]
    )
    cors_methods: List[str] = Field(default=["GET", "POST", "OPTIONS"])
    cors_headers: List[str] = Field(
        default=["Content-Type", "Authorization", "X-Request-ID"]
    )
```

In `app.py`, use `settings.security.cors_headers` instead of the hardcoded `["*"]`.

---

### VULN-002: No Authentication on Any Endpoint

**Severity:** Critical
**OWASP:** A07 — Identification and Authentication Failures
**Location:** `src/nlp/app.py`, all files under `src/nlp/api/`

**Description:**
None of the REST API endpoints implement any authentication mechanism. There are no JWT validation dependencies, API key checks, or bearer token middleware. Any network-accessible client can invoke medical text classification, entity extraction, diagnosis suggestion, and spelling correction endpoints without any identity verification.

The `pyproject.toml` includes `python-jose` and `passlib` as dependencies, but they are never imported or used in any source file — suggesting auth was planned but never implemented.

**Evidence:**

```python
# src/nlp/api/v1/rest/classify.py:18-22 — no auth dependency
@router.post("/text", response_model=TextClassificationResponse)
async def classify_text(
    request: TextClassificationRequest,
    service: TextClassifier = Depends(get_text_classifier),
) -> TextClassificationResponse:
```

All 5 REST endpoints and 2 WebSocket endpoints follow this same pattern with zero auth checks.

**Impact:**
Unauthorized access to medical NLP capabilities. In a healthcare context, this is a HIPAA compliance violation for any endpoint processing PHI.

**Recommended Fix:**
Implement a shared auth dependency:

```python
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

security = HTTPBearer()

async def verify_token(
    credentials: HTTPAuthorizationCredentials = Security(security),
) -> dict:
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid authentication")

# Then use in every endpoint:
@router.post("/text")
async def classify_text(
    request: TextClassificationRequest,
    user: dict = Depends(verify_token),
    service: TextClassifier = Depends(get_text_classifier),
):
```

If authentication is handled by the API Gateway, document this clearly and still implement defense-in-depth with internal service tokens.

---

### VULN-003: WebSocket Endpoints Lack Authentication

**Severity:** Critical
**OWASP:** A07 — Identification and Authentication Failures
**Location:** `src/nlp/api/v1/ws/classify.py:14-28`, `src/nlp/api/v1/ws/classify.py:30-42`

**Description:**
Both WebSocket endpoints (`/ws/classify/token/{session_id}` and `/ws/classify/text/{session_id}`) accept connections from any client. The `session_id` is a user-supplied path parameter with no validation or verification. There is no token exchange, no handshake authentication, and no origin checking.

**Evidence:**

```python
# src/nlp/api/v1/ws/classify.py:14-22
@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,  # arbitrary user input, no validation
    service: TokenClassifier = Depends(get_token_classifier),
    ws_manager: WebSocketManager = Depends(get_websocket_manager),
):
    try:
        await ws_manager.handle_connection(...)
```

```python
# src/nlp/core/websocket_manager.py:50-52
async def handle_connection(self, websocket: WebSocket, session_id: str, process):
    await websocket.accept()  # accepts unconditionally
    session = WebSocketSession(session_id, websocket)
```

**Impact:**
Any client can establish persistent WebSocket connections, send unlimited medical text for processing, and potentially hijack or overwrite another user's session by supplying their `session_id`. This also enables resource exhaustion attacks.

**Recommended Fix:**

```python
@router.websocket("/token/{session_id}")
async def websocket_classify_token(websocket: WebSocket, session_id: str, ...):
    token = websocket.query_params.get("token")
    if not token or not verify_ws_token(token):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    if not SESSION_ID_PATTERN.match(session_id):
        await websocket.close(code=4002, reason="Invalid session ID")
        return

    await ws_manager.handle_connection(...)
```

---

### VULN-004: No Input Size Limits on Text Fields

**Severity:** High
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/schemas/classification.py:11-12`, `src/nlp/schemas/correction.py:19-22`, `src/nlp/schemas/diagnosis.py:17-18`

**Description:**
All request schemas define `text: str = Field(...)` with no `max_length` constraint. Transformer models tokenize the full input and process it through GPU/CPU. An attacker can send megabytes of text, causing:
- Out-of-memory (OOM) crashes on the ML model inference pipeline
- CPU/GPU resource exhaustion (denial of service)
- Extremely slow responses blocking the event loop

**Evidence:**

```python
# src/nlp/schemas/classification.py:11-12
class TextClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")  # no max_length

# src/nlp/schemas/classification.py:26-27
class TokenClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")  # no max_length

# src/nlp/schemas/diagnosis.py:17-18
class DiagnosisSuggestionRequest(BaseModel):
    text: str = Field(..., description="Patient conversation transcript")  # no max_length

# src/nlp/schemas/correction.py:21
class TextCorrectionRequest(BaseModel):
    text: str = Field(..., description="Text to correct")  # no max_length
```

The `max_sequence_length` config exists (512 tokens) but is **never enforced** in any service — it's only a config field with no runtime check.

**Impact:**
Denial of service through resource exhaustion. A single malicious request with a 10MB text payload could crash the inference pipeline.

**Recommended Fix:**

```python
class TextClassificationRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=50_000,  # ~10K words, reasonable for medical docs
        description="Input text",
    )
```

Additionally, enforce truncation in service layers:

```python
async def process(self, request: TextClassificationRequest):
    text = request.text[:self.config.max_sequence_length * 6]  # rough char estimate
    ...
```

---

### VULN-005: PHI/PII Logged in Plaintext

**Severity:** High
**OWASP:** A09 — Security Logging and Monitoring Failures
**Location:** Multiple files

**Description:**
The service processes medical text (patient transcripts, clinical notes, symptoms) which constitutes Protected Health Information (PHI) under HIPAA. Several logging statements output this data in plaintext to console and files.

**Evidence:**

```python
# src/nlp/api/v1/rest/classify.py:36
logger.info(f"Text classified with confidence {result.confidence:.3f}")
# Safe: logs only confidence, not text content

# src/nlp/api/v1/rest/diagnosis.py:22
logger.info(f"Diagnosis suggestions: {response}")
# DANGEROUS: logs the entire DiagnosisSuggestionResponse which includes
# symptoms_analyzed (patient symptoms) and disease suggestions

# src/nlp/core/websocket_manager.py:177
logger.debug(f"Sent message to session {session.session_id}: {json.dumps(message_dict)}")
# DANGEROUS: in debug mode, logs full message content which includes
# medical entity extraction results, patient text, diagnosis data
```

The logging configuration stores logs to files (`./logs/nlp.log`) with no encryption and 30-day retention by default.

**Impact:**
PHI/PII written to unencrypted log files violates HIPAA's minimum necessary standard and data protection requirements. Log files could be accessed by unauthorized personnel or leaked through log aggregation systems.

**Recommended Fix:**

```python
# src/nlp/api/v1/rest/diagnosis.py:22 — replace with:
logger.info(
    "Diagnosis suggestions generated",
    extra={"suggestion_count": len(response.suggestions)},
)

# src/nlp/core/websocket_manager.py:177 — replace with:
logger.debug(
    f"Sent message to session {session.session_id}",
    extra={"message_type": message_dict.get("type")},
)
```

Implement a PHI-safe logging filter that redacts sensitive fields before writing.

---

### VULN-006: ML Models Loaded from Untrusted Remote Sources

**Severity:** High
**OWASP:** A08 — Software and Data Integrity Failures
**Location:** `src/nlp/services/text_classifier.py:56-57`, `src/nlp/services/token_classifier.py:58-59`, `src/nlp/services/medical_suggester.py:29-30`

**Description:**
All three ML models are downloaded from HuggingFace Hub at runtime using `from_pretrained()` with only a string model name. There is:
- No integrity verification (no hash pinning or checksum validation)
- No revision/commit pinning (always pulls latest)
- No allow-listing of trusted model sources
- No `trust_remote_code=False` enforcement (defaults to `False` in current transformers, but not explicitly set)

The model names are configurable via environment variables, meaning an attacker who can modify environment variables can redirect model loading to a malicious model.

**Evidence:**

```python
# src/nlp/services/text_classifier.py:56-57
self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name)

# src/nlp/services/token_classifier.py:58-59
self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
self.model = AutoModelForTokenClassification.from_pretrained(self.model_name)

# src/nlp/services/medical_suggester.py:29-30
tokenizer = AutoTokenizer.from_pretrained(self.config.tokenizer_name)
model = AutoModelForSequenceClassification.from_pretrained(self.config.model_name)
```

**Impact:**
If a HuggingFace model repository is compromised, or if environment variables are tampered with, a backdoored model could be loaded that exfiltrates data, produces incorrect medical predictions, or executes arbitrary code.

**Recommended Fix:**

```python
self.model = AutoModelForSequenceClassification.from_pretrained(
    self.model_name,
    revision="abc123def456",  # pin to specific commit
    trust_remote_code=False,  # explicitly forbid remote code execution
)
```

For production, pre-download models during the Docker build and load from local paths:

```python
# In Dockerfile
RUN python -c "from transformers import AutoModel; AutoModel.from_pretrained('blaze999/Medical-NER')"

# In service code
self.model = AutoModelForTokenClassification.from_pretrained(
    "/app/models/Medical-NER",
    local_files_only=True,
)
```

---

### VULN-007: No Rate Limiting on Any Endpoint

**Severity:** High
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/app.py` (missing implementation)

**Description:**
The service has no rate limiting on any REST or WebSocket endpoint. ML inference is computationally expensive (200-300ms per request with GPU, potentially seconds on CPU). An attacker can flood the service with requests, causing:
- GPU/CPU resource exhaustion
- Memory exhaustion from concurrent model inferences
- Service unavailability for legitimate users

The documentation states "Rate limiting is handled at API Gateway level" but the NLP service has no defense-in-depth protection.

**Evidence:**
No `slowapi`, `fastapi-limiter`, or custom rate limiting middleware exists anywhere in the codebase. A grep for rate-limiting patterns returns zero results in source code.

**Impact:**
Denial of service. Healthcare services require high availability; resource exhaustion directly impacts patient care workflows.

**Recommended Fix:**

```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

@router.post("/text")
@limiter.limit("30/minute")
async def classify_text(request: Request, ...):
    ...
```

---

### VULN-008: WebSocket: No Connection Rate Limiting or Concurrency Limits

**Severity:** High
**OWASP:** A07 — Identification and Authentication Failures
**Location:** `src/nlp/core/websocket_manager.py`

**Description:**
The WebSocket manager has a `max_connections` config (default 100), but this limit is **never enforced** in the `handle_connection` method. Every connection is unconditionally accepted. Additionally:
- No per-IP connection limiting
- No message rate limiting per session
- No maximum message size enforcement

**Evidence:**

```python
# src/nlp/core/websocket_manager.py:50-56
async def handle_connection(self, websocket: WebSocket, session_id: str, process):
    await websocket.accept()  # unconditional accept, max_connections never checked

    session = WebSocketSession(session_id, websocket)
    self.sessions[session_id] = session
    self.websockets.add(websocket)
```

The `WebSocketConfig.max_connections = 100` in `config.py` is defined but never referenced in `websocket_manager.py`.

**Impact:**
An attacker can open thousands of WebSocket connections, exhausting server file descriptors and memory. Each connection spawns heartbeat processing, amplifying resource consumption.

**Recommended Fix:**

```python
async def handle_connection(self, websocket: WebSocket, session_id: str, process):
    if len(self.sessions) >= self.max_connections:
        await websocket.close(code=1013, reason="Server overloaded")
        return

    if session_id in self.sessions:
        await websocket.close(code=4003, reason="Session already exists")
        return

    await websocket.accept()
    ...
```

---

### VULN-009: Exception Details Leaked to WebSocket Clients

**Severity:** High
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/core/websocket_manager.py:84`

**Description:**
When message processing fails, the raw Python exception message is sent directly to the WebSocket client. This can leak internal implementation details, file paths, model information, and system configuration.

**Evidence:**

```python
# src/nlp/core/websocket_manager.py:82-84
except Exception as e:
    logger.error(f"Error processing message for session {session_id}: {str(e)}")
    await self._send_error(session, "PROCESSING_ERROR", str(e))
    #                                                   ^^^^^^ raw exception sent to client
```

**Impact:**
Information disclosure. Exception messages from transformer libraries, PyTorch, or system errors can reveal internal architecture, model names, file paths, and library versions.

**Recommended Fix:**

```python
except Exception as e:
    logger.error(f"Error processing message for session {session_id}: {str(e)}")
    await self._send_error(session, "PROCESSING_ERROR", "An internal error occurred")
```

---

### VULN-010: Diagnosis Suggestion Response Logged Verbatim

**Severity:** High
**OWASP:** A09 — Security Logging and Monitoring Failures
**Location:** `src/nlp/api/v1/rest/diagnosis.py:22`

**Description:**
The full diagnosis suggestion response — including analyzed symptoms and disease predictions — is logged as a string representation of the Pydantic model. This data is highly sensitive medical information.

**Evidence:**

```python
# src/nlp/api/v1/rest/diagnosis.py:22
logger.info(f"Diagnosis suggestions: {response}")
# response is DiagnosisSuggestionResponse containing:
#   - suggestions: list of disease names with confidence
#   - symptoms_analyzed: list of patient symptoms extracted from text
```

**Impact:**
Patient symptoms and predicted diagnoses written to log files in plaintext. Direct HIPAA violation.

**Recommended Fix:**

```python
logger.info(
    "Diagnosis suggestions generated",
    extra={"count": len(response.suggestions)},
)
```

---

### VULN-011: No Security Headers Middleware

**Severity:** Medium
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/app.py`

**Description:**
The application does not set any security headers. Missing headers include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HSTS)
- `X-XSS-Protection: 0` (deprecated but still needed for legacy browsers)
- `Content-Security-Policy`
- `Referrer-Policy`

**Impact:**
Browsers interacting with API responses (especially Swagger UI) are not protected against content-type sniffing, clickjacking, or other browser-based attacks.

**Recommended Fix:**

```python
from starlette.middleware import Middleware
from starlette.middleware.httpsredirect import HTTPSRedirectMiddleware

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "0"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    return response
```

---

### VULN-012: `allow_headers=["*"]` Hardcoded in CORS Configuration

**Severity:** Medium
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/app.py:35`

**Description:**
The `allow_headers` parameter in `CORSMiddleware` is hardcoded to `["*"]`, ignoring the `settings.security.cors_headers` configuration. This means even if an operator configures specific allowed headers, the setting is bypassed.

**Evidence:**

```python
# src/nlp/app.py:30-36
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.security.cors_origins,
    allow_credentials=True,
    allow_methods=settings.security.cors_methods,
    allow_headers=["*"],  # BUG: ignores settings.security.cors_headers
)
```

**Recommended Fix:**

```python
allow_headers=settings.security.cors_headers,
```

---

### VULN-013: No Request Body Size Limit

**Severity:** Medium
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/app.py`, `src/nlp/main.py`

**Description:**
Neither the FastAPI application nor the Uvicorn server configuration sets a maximum request body size. The default Uvicorn limit is effectively unlimited. An attacker can POST multi-gigabyte payloads.

**Evidence:**

```python
# src/nlp/main.py:16-24 — no limit_max_request_size parameter
uvicorn.run(
    "nlp.app:get_app",
    host=settings.service.host,
    port=settings.service.port,
    workers=settings.service.workers,
    log_level=settings.service.log_level,
    factory=True,
    lifespan="on",
)
```

**Impact:**
Memory exhaustion from oversized request bodies before Pydantic validation even occurs.

**Recommended Fix:**

```python
uvicorn.run(
    "nlp.app:get_app",
    ...
    limit_max_request_size=1_048_576,  # 1 MB
)
```

---

### VULN-014: Unvalidated WebSocket JSON Input

**Severity:** Medium
**OWASP:** A03 — Injection
**Location:** `src/nlp/core/websocket_manager.py:65`

**Description:**
WebSocket messages are parsed with `json.loads()` and passed directly to the service `process()` function as a raw `dict`. REST endpoints use Pydantic validation on request bodies, but WebSocket input bypasses all schema validation.

**Evidence:**

```python
# src/nlp/core/websocket_manager.py:63-65
message_data = await asyncio.wait_for(websocket.receive_text(), timeout=self.WAIT_TIMEOUT)
result = await process(json.loads(message_data))
# json.loads returns arbitrary dict, passed to service.process() without validation
```

In the service layer, `process()` accesses fields via dict indexing:

```python
# src/nlp/services/text_classifier.py:81
pipeline_results = self.pipeline(request["text"])

# src/nlp/services/token_classifier.py:83
pipeline_results = self.pipeline(request["text"])
```

A malformed message missing the `"text"` key will raise a `KeyError` that gets caught and the raw error is sent to the client (see VULN-009).

**Impact:**
Type confusion and unexpected behavior. Arbitrary JSON structures can be passed to ML pipelines, potentially causing crashes or unexpected model behavior.

**Recommended Fix:**

```python
async def handle_connection(self, websocket, session_id, process, schema_class):
    ...
    raw = json.loads(message_data)
    try:
        validated = schema_class.model_validate(raw)
    except ValidationError as e:
        await self._send_error(session, "VALIDATION_ERROR", "Invalid message format")
        continue
    result = await process(validated)
```

---

### VULN-015: Unvalidated `session_id` Path Parameter

**Severity:** Medium
**OWASP:** A03 — Injection
**Location:** `src/nlp/api/v1/ws/classify.py:14`, `src/nlp/api/v1/ws/classify.py:30`

**Description:**
The `session_id` path parameter is an arbitrary string with no format validation. It is used as a dictionary key and logged directly. A malicious client can supply:
- Extremely long strings (memory issues)
- Strings containing control characters or log injection sequences
- Session IDs matching other users' sessions (session hijacking)

**Evidence:**

```python
@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,  # any string accepted
    ...
):
```

```python
# src/nlp/core/websocket_manager.py:54-55
self.sessions[session_id] = session  # attacker controls the key
```

If two clients supply the same `session_id`, the second overwrites the first's session object without notification.

**Impact:**
Session hijacking and log injection. An attacker can overwrite another client's session or inject malicious log entries.

**Recommended Fix:**

```python
import re

SESSION_ID_PATTERN = re.compile(r'^[a-zA-Z0-9\-]{1,128}$')

@router.websocket("/token/{session_id}")
async def websocket_classify_token(websocket: WebSocket, session_id: str, ...):
    if not SESSION_ID_PATTERN.match(session_id):
        await websocket.close(code=4002, reason="Invalid session ID")
        return

    if session_id in ws_manager.sessions:
        await websocket.close(code=4003, reason="Session already active")
        return
```

---

### VULN-016: No Model Integrity Verification

**Severity:** Medium
**OWASP:** A08 — Software and Data Integrity Failures
**Location:** `src/nlp/services/text_classifier.py:56-57`, `src/nlp/services/token_classifier.py:58-59`, `src/nlp/services/medical_suggester.py:29-30`

**Description:**
Models are loaded from HuggingFace Hub without pinning to a specific revision/commit. The `from_pretrained()` calls use only the model name string with no `revision` parameter. If the HuggingFace repository is updated (legitimately or through compromise), the service will load a different model on next startup with no verification.

**Evidence:**

```python
# No revision pinning in any from_pretrained call:
AutoTokenizer.from_pretrained(self.model_name)
AutoModelForSequenceClassification.from_pretrained(self.model_name)
AutoModelForTokenClassification.from_pretrained(self.model_name)
```

**Impact:**
Non-reproducible model loading. A model update could alter medical predictions without operator awareness, potentially providing incorrect medical information.

**Recommended Fix:**
Pin model revisions and verify checksums:

```python
TRUSTED_MODELS = {
    "blaze999/Medical-NER": "a1b2c3d4e5f6...",  # known-good commit hash
    "shanover/symps_disease_bert_v3_c41": "f6e5d4c3b2a1...",
}

model = AutoModelForTokenClassification.from_pretrained(
    self.model_name,
    revision=TRUSTED_MODELS.get(self.model_name),
)
```

---

### VULN-017: `print()` Statement in Production Code

**Severity:** Medium
**OWASP:** A09 — Security Logging and Monitoring Failures
**Location:** `src/nlp/services/token_classifier.py:113`

**Description:**
A `print()` statement is used instead of the logger in the token classifier error handler. This bypasses structured logging, log level filtering, and JSON formatting — meaning errors will be written to stdout in plaintext without any metadata.

**Evidence:**

```python
# src/nlp/services/token_classifier.py:112-113
except Exception as e:
    print(f"Error in token classification: {str(e)}")
```

**Impact:**
Error messages bypass log management, are not captured by log aggregation systems, and lack context (timestamp, level, trace ID) needed for incident response.

**Recommended Fix:**

```python
except Exception as e:
    logger.error("Token classification failed", exc_info=True)
```

---

### VULN-018: `host` Defaults to `0.0.0.0` Binding All Interfaces

**Severity:** Low
**OWASP:** A05 — Security Misconfiguration
**Location:** `src/nlp/core/config.py:41`

**Description:**
The service defaults to binding on `0.0.0.0`, which listens on all network interfaces. In development, this exposes the service to the local network.

**Evidence:**

```python
host: str = Field(default=os.getenv("HOST", "0.0.0.0"))
```

**Impact:**
Unintended network exposure during development. In production containers, this is standard and expected.

**Recommended Fix:**
Default to `127.0.0.1` for development safety; override to `0.0.0.0` in Docker/production:

```python
host: str = Field(default="127.0.0.1")
```

---

### VULN-019: Deprecated `opentelemetry-exporter-jaeger-thrift`

**Severity:** Low
**OWASP:** A06 — Vulnerable and Outdated Components
**Location:** `pyproject.toml:38`

**Description:**
The `opentelemetry-exporter-jaeger-thrift` package has been deprecated since OpenTelemetry Python SDK 1.20.0. It was marked for removal and is no longer maintained with security patches.

**Evidence:**

```toml
# pyproject.toml:38
"opentelemetry-exporter-jaeger-thrift>=1.21.0",
```

**Impact:**
Using a deprecated, unmaintained package increases risk of unpatched vulnerabilities over time.

**Recommended Fix:**
Migrate to the OTLP exporter which supports Jaeger's OTLP-native ingestion:

```toml
"opentelemetry-exporter-otlp-proto-grpc>=1.39.0",
```

---

### VULN-020: `python-jose` Has Known Vulnerabilities

**Severity:** Low
**OWASP:** A06 — Vulnerable and Outdated Components
**Location:** `pyproject.toml:27`

**Description:**
`python-jose` has known security advisories (e.g., CVE-2024-33664 — algorithm confusion attacks). The library is also no longer actively maintained; `PyJWT` or `joserfc` are the recommended replacements.

**Evidence:**

```toml
# pyproject.toml:27
"python-jose[cryptography]>=3.3.0",
```

Note: This dependency is currently unused in source code (see VULN-021), which reduces the active risk.

**Impact:**
If auth is eventually implemented using this library, it could be vulnerable to JWT algorithm confusion attacks.

**Recommended Fix:**
Replace with `PyJWT`:

```toml
"PyJWT[crypto]>=2.9.0",
```

---

### VULN-021: Unused Auth Dependencies (python-jose, passlib)

**Severity:** Info
**OWASP:** A06 — Vulnerable and Outdated Components
**Location:** `pyproject.toml:27-28`

**Description:**
`python-jose[cryptography]` and `passlib[bcrypt]` are listed as dependencies but are never imported in any source file. These unused dependencies increase the attack surface and Docker image size.

**Evidence:**
A full grep for `jose`, `passlib`, `bcrypt`, or `jwt` across `src/nlp/` returns zero results — these packages are never used.

```toml
"python-jose[cryptography]>=3.3.0",
"passlib[bcrypt]>=1.7.4",
```

**Impact:**
Unnecessary attack surface. Unused packages with vulnerabilities still exist in the deployed container.

**Recommended Fix:**
Remove until authentication is implemented:

```toml
# Remove these lines until auth is implemented:
# "python-jose[cryptography]>=3.3.0",
# "passlib[bcrypt]>=1.7.4",
```

---

## OWASP Top 10 Compliance Summary

| OWASP Category | Status | Findings |
|----------------|--------|----------|
| A01: Broken Access Control | **FAIL** | No auth on any endpoint (VULN-002, VULN-003) |
| A02: Cryptographic Failures | PASS | No crypto operations, data not encrypted at rest |
| A03: Injection | **WARN** | Unvalidated WS input (VULN-014, VULN-015) |
| A04: Insecure Design | **WARN** | No defense-in-depth, no rate limiting |
| A05: Security Misconfiguration | **FAIL** | Wildcard CORS, no headers, no size limits (VULN-001, 011-013) |
| A06: Vulnerable Components | **WARN** | Deprecated/vulnerable deps (VULN-019, 020, 021) |
| A07: Auth Failures | **FAIL** | Zero authentication anywhere (VULN-002, 003, 008) |
| A08: Integrity Failures | **WARN** | Unverified ML model loading (VULN-006, 016) |
| A09: Logging Failures | **FAIL** | PHI in logs, print statements (VULN-005, 010, 017) |
| A10: SSRF | PASS | No outbound user-controlled requests |

---

## HIPAA / Medical Data Security Assessment

| Requirement | Status | Notes |
|-------------|--------|-------|
| Access Control (§164.312(a)) | **FAIL** | No authentication or authorization |
| Audit Controls (§164.312(b)) | **WARN** | Logging exists but contains PHI |
| Integrity Controls (§164.312(c)) | **WARN** | No model integrity verification |
| Transmission Security (§164.312(e)) | **WARN** | No TLS enforcement at app level |
| Minimum Necessary (§164.502(b)) | **FAIL** | PHI logged unnecessarily |
| Data Encryption at Rest | **FAIL** | Log files with PHI are unencrypted |

---

## Prioritized Remediation Roadmap

### Immediate (Before Production)

1. **Implement authentication** on all endpoints (VULN-002, 003)
2. **Restrict CORS origins** to known frontend domains (VULN-001)
3. **Add input size limits** to all text fields (VULN-004)
4. **Remove PHI from logs** (VULN-005, 010)
5. **Sanitize WebSocket error messages** (VULN-009)

### Short-Term (Within 1-2 Sprints)

6. **Add rate limiting** to REST and WebSocket endpoints (VULN-007, 008)
7. **Validate WebSocket input** with Pydantic schemas (VULN-014)
8. **Validate session_id** format and enforce uniqueness (VULN-015)
9. **Add security headers middleware** (VULN-011)
10. **Set request body size limits** in Uvicorn (VULN-013)
11. **Fix hardcoded CORS headers** to use config (VULN-012)

### Medium-Term (Within 1-2 Months)

12. **Pin ML model revisions** and verify integrity (VULN-006, 016)
13. **Pre-download models** during Docker build for offline loading
14. **Replace deprecated dependencies** (VULN-019, 020)
15. **Remove unused dependencies** (VULN-021)
16. **Replace print() with logger** (VULN-017)
17. **Set safe default host** binding (VULN-018)

---

## Positive Security Observations

1. **Production docs disabled**: Swagger/ReDoc endpoints are correctly disabled in production via `is_production()` check
2. **Non-root Docker user**: Both debug and production Dockerfile stages create and run as a non-root user (`nlpuser:1001`)
3. **Generic error responses**: REST exception handlers return generic error messages, not raw exceptions (unlike WebSocket)
4. **Structured logging**: JSON formatter is available for machine-parseable log output
5. **Docker multi-stage build**: Build dependencies are not included in the final image
6. **`.dockerignore` is comprehensive**: Excludes `.env`, tests, docs, and dev artifacts from build context
7. **Pydantic validation**: REST endpoints use Pydantic models for request validation with type checking and constraints on numeric fields
8. **No `eval()`/`exec()`/`subprocess`**: No dangerous code execution patterns found
9. **No SQL/database access**: No injection vectors from database queries
10. **`PYTHONHASHSEED=random`**: Set in production Dockerfile, mitigating hash-flooding DoS

---

*End of Security Audit Report*
