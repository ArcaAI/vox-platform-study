# Vulnerability Scan Report: `apps/nlp/` — Medical NLP Service

**Date**: 2026-03-24
**Last Updated**: 2026-04-06
**Scope**: `apps/nlp/` — Python/FastAPI Medical NLP microservice
**Context**: HOPE healthcare AI monorepo processing medical text (PHI)
**Scanner**: Manual deep scan — code review + dependency CVE analysis
**Files Scanned**: 41 files (all source, config, Dockerfile, lock)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** | 2 |
| **High** | 6 |
| **Medium** | 8 |
| **Low** | 5 |
| **Informational** | 4 |
| **Total** | **25** |

The NLP service has **2 critical vulnerabilities** (python-jose algorithm confusion allowing JWT forgery, and HuggingFace model deserialization exposing arbitrary code execution), **6 high-severity issues** (unbounded input, no authentication, CORS wildcard, no rate limiting, log injection, and race conditions on shared mutable state), and a constellation of medium/low issues that compound risk in a PHI-processing healthcare context.

---

## Critical Vulnerabilities

### VULN-001: python-jose Algorithm Confusion — JWT Forgery (CVE-2024-33663)

**Severity**: Critical (CVSS 7.4+)
**File**: `pyproject.toml` — dependency `python-jose[cryptography]>=3.3.0`
**Locked Version**: `3.5.0` (`uv.lock` line 1700)

**Description**: python-jose suffers from multiple algorithm confusion vulnerabilities:

1. **CVE-2024-33663**: OpenSSH ECDSA key algorithm confusion allows JWT forgery when ECDSA keys are used
2. **DER-Encoded Key Confusion**: RSA public keys in DER format bypass HMAC key validation, enabling attackers with a public key to forge JWTs using HS256 with raw DER bytes as the HMAC secret
3. **Missing Algorithm Whitelist**: When `algorithms=None` (the default), the algorithm whitelist check is skipped entirely, allowing attacker-controlled algorithm selection from the JWT header
4. **Empty HMAC Keys Accepted**: Both HMAC backends accept empty strings/bytes as valid signing keys
5. **Timing Side-Channels**: JWE authentication tag and `at_hash` verification use non-constant-time comparisons

**Impact**: An attacker who obtains the service's public key can forge arbitrary JWT tokens and impersonate any user or service. In a healthcare context, this could lead to unauthorized access to PHI and medical NLP results.

**Evidence**: python-jose is listed as a dependency but **no JWT verification code exists in `apps/nlp/src/`** — the dependency is declared but unused. This is itself an issue (unnecessary attack surface).

**Remediation**:
- **If JWT auth is NOT needed in this service**: Remove `python-jose[cryptography]` and `passlib[bcrypt]` from `pyproject.toml` entirely. Authentication should be handled at the API Gateway (`apps/api/`).
- **If JWT auth IS planned**: Replace python-jose with [`PyJWT`](https://pypi.org/project/PyJWT/) or [`joserfc`](https://pypi.org/project/joserfc/), which actively maintain security patches. Always pass an explicit `algorithms` list when decoding.

---

### VULN-002: HuggingFace Model Deserialization — Arbitrary Code Execution

**Severity**: Critical (CVSS 9.8)
**Files**: `services/text_classifier.py:57-58`, `services/token_classifier.py:58-59`, `services/medical_suggester.py:29-30`

**Description**: The service uses `AutoTokenizer.from_pretrained()` and `AutoModel*.from_pretrained()` to download and load models from HuggingFace Hub at startup. These calls will load pickle-serialized model weights by default. If a model repository is compromised (typosquatting, supply chain attack, or account takeover), the pickle deserialization executes arbitrary code during model loading.

Models loaded:
- `michellejieli/emotion_text_classifier` — 3rd-party community model
- `blaze999/Medical-NER` — 3rd-party community model
- `shanover/symps_disease_bert_v3_c41` — 3rd-party community model

All three are community-uploaded models, not from verified organizations.

**Impact**: Full server compromise at startup. Attacker gains code execution as the process user. In a healthcare service, this means access to all PHI passing through the NLP pipeline.

**Remediation**:
```python
# Force safetensors format (safe from arbitrary code execution)
model = AutoModelForSequenceClassification.from_pretrained(
    self.model_name,
    use_safetensors=True,
    trust_remote_code=False,  # explicitly deny remote code
)
```
- Pin model revisions to specific commit hashes instead of `latest`
- Pre-download models in CI/CD and serve from a private model registry
- Never set `TRUST_REMOTE_CODE=True` in production
- Consider converting all models to safetensors format and hosting internally

---

## High Vulnerabilities

### VULN-003: No Input Length Validation — Unbounded Text Processing

**Severity**: High (CVSS 7.5)
**Files**: `schemas/classification.py:11-12`, `schemas/classification.py:26-27`, `schemas/diagnosis.py:17-18`, `schemas/correction.py:19-20`

**Description**: All Pydantic request models accept `text: str` with no maximum length constraint:

```python
# classification.py
class TextClassificationRequest(BaseModel):
    text: str = Field(..., description="Input text")  # No max_length!

# diagnosis.py
class DiagnosisSuggestionRequest(BaseModel):
    text: str = Field(..., description="Patient conversation transcript")  # No max_length!
```

The transformer models have `max_sequence_length=512` in config, but this is never enforced before the text hits the pipeline. An attacker can send multi-megabyte texts that:
- Exhaust GPU/CPU memory during tokenization
- Cause OOM kills on the container
- Create denial-of-service conditions

**Impact**: Service denial-of-service. In healthcare, this disrupts real-time medical NLP for all users.

**Remediation**:
```python
class TextClassificationRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=50_000,  # reasonable max for medical documents
        description="Input text",
    )
```

---

### VULN-004: No Authentication or Authorization

**Severity**: High (CVSS 8.0)
**Files**: All endpoint files under `api/v1/rest/` and `api/v1/ws/`

**Description**: None of the REST endpoints or WebSocket connections require any authentication. There are no auth guards, API key checks, JWT verification, or middleware protecting the endpoints. Despite `python-jose` and `passlib` being in dependencies, they are never imported in any source file.

The WebSocket endpoint accepts any `session_id` string in the URL path with no validation:

```python
@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,  # User-controlled, no validation
    ...
```

**Impact**: Any network-reachable client can send arbitrary medical text for processing, extract medical entities, and receive diagnosis suggestions without authorization. PHI submitted by legitimate users may be accessible to attackers.

**Remediation**:
- If the API Gateway handles auth: ensure NLP service is network-isolated (only reachable from api gateway, not from public internet). Add header-based service-to-service authentication.
- If direct access is needed: implement JWT verification middleware using the API Gateway's signing key.

---

### VULN-005: CORS Wildcard with Credentials

**Severity**: High (CVSS 6.8)
**File**: `core/config.py:167`, `app.py:30-36`

**Description**: CORS is configured with wildcard origins AND credentials enabled simultaneously:

```python
class SecurityConfig(BaseSettings):
    cors_origins: List[str] = Field(default=["*"])     # allow ALL origins
    cors_allow_credentials: bool = Field(default=True)  # allow cookies/auth headers

# app.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.security.cors_origins,  # ["*"]
    allow_credentials=True,
    allow_headers=["*"],
)
```

While browsers prevent `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` (the Starlette CORS middleware will echo the requesting origin instead), this still means ANY origin is allowed to make credentialed requests. This enables cross-site request forgery and data exfiltration from any domain.

**Impact**: Any website can make authenticated requests to the NLP service from a user's browser, potentially extracting PHI or medical analysis results.

**Remediation**:
```python
cors_origins: List[str] = Field(
    default=["https://app.hope.example.com"],
    description="Explicit allowed origins"
)
```

---

### VULN-006: No Rate Limiting

**Severity**: High (CVSS 7.0)
**Files**: All endpoint files

**Description**: No rate limiting is implemented at any level — no middleware, no per-IP throttling, no per-endpoint limits. The documentation mentions rate limiting headers (`X-RateLimit-*`) but these are aspirational — no code implements them.

ML inference endpoints are computationally expensive (200-300ms GPU time per request). An attacker can saturate the service with requests, causing:
- GPU memory exhaustion
- CPU saturation during tokenization
- Service-wide denial of service

**Impact**: A single attacker can deny medical NLP services to all legitimate users by flooding endpoints with requests.

**Remediation**: Use `slowapi` or a custom middleware to enforce per-IP rate limits (e.g., 60 req/min for classification, 20 req/min for diagnosis).

---

### VULN-007: Log Injection via User-Controlled Data

**Severity**: High (CVSS 6.5)
**Files**: Multiple — `api/v1/ws/classify.py:25,27`, `core/websocket_manager.py:60,85,179`, `api/v1/rest/diagnosis.py:21`

**Description**: User-controlled data is interpolated directly into log messages via f-strings:

```python
# websocket_manager.py — session_id from URL path, user-controlled
logger.info(f"WebSocket session established: {session_id}")
logger.error(f"Error processing message for session {session_id}: {str(e)}")

# diagnosis.py — full response object logged
logger.info(f"Diagnosis suggestions: {response}")
```

An attacker can inject newlines and fake log entries via crafted `session_id` values (e.g., `legit\n[2026-03-24] INFO - Admin login successful`), which:
- Corrupts log integrity for forensic analysis
- Can trigger false alerts in log-monitoring/SIEM systems
- In JSON-formatted logs, can inject additional JSON fields

The `diagnosis.py` endpoint also logs the full `response` object which contains medical diagnoses — PHI data written to log files.

**Impact**: Log tampering, false audit trails, PHI leakage to log storage systems.

**Remediation**:
- Use parameterized logging: `logger.info("Session established: %s", session_id)`
- Sanitize session_id inputs (allow only `[a-zA-Z0-9-_]`)
- Never log full response objects containing medical/PHI data
- Replace `f"Diagnosis suggestions: {response}"` with a safe summary

---

### VULN-008: Race Conditions on Shared Mutable State

**Severity**: High (CVSS 6.0)
**Files**: `dependencies.py:8-34`, `core/websocket_manager.py:27,57-58`

**Description**: The dependency injection pattern uses `globals()` as a singleton store without any locking:

```python
def get_text_classifier() -> TextClassifier:
    if globals().get("_text_classifier_instance") is None:
        globals()["_text_classifier_instance"] = TransformerTextClassifier()
    return globals()["_text_classifier_instance"]
```

When running with `workers > 1` (each worker is a separate process, so this is safe across processes), but within a single worker handling concurrent async requests, the check-then-set pattern is not atomic. Two concurrent requests arriving before initialization completes could create duplicate model instances, wasting GPU memory.

More critically, `WebSocketManager.sessions` is a plain `dict` mutated concurrently:

```python
self.sessions[session_id] = session      # in handle_connection
self.websockets.add(websocket)           # in handle_connection
del self.sessions[session_id]            # in cleanup_session
self.websockets.remove(session.websocket) # in cleanup_session
```

The cleanup loop iterates `self.sessions.items()` while `handle_connection` may concurrently modify it, risking `RuntimeError: dictionary changed size during iteration`.

**Impact**: Service crashes, duplicate model loading (memory exhaustion), corrupted session state.

**Remediation**:
- Use `asyncio.Lock` to protect session dict mutations
- Replace globals-based singletons with proper FastAPI dependency injection using `@lru_cache`

---

## Medium Vulnerabilities

### VULN-009: Dictionary Path Traversal via Environment Variable

**Severity**: Medium (CVSS 5.5)
**File**: `core/config.py:180`, `services/text_corrector.py:57-71`

**Description**: The `dictionary_path` is configurable via `SPELLING_CORRECTOR_DICTIONARY_PATH` environment variable and used in string concatenation for file loading:

```python
dictionary_path: str = Field(default=str(get_project_root() / "data" / "dictionaries"))

# text_corrector.py
self.sym_spell_instances[language].load_bigram_dictionary(
    self.config.dictionary_path + "/en/bigram.txt", ...
)
```

If an attacker can control the environment variable (container escape, config injection), they can set `SPELLING_CORRECTOR_DICTIONARY_PATH=/etc` or similar, causing the service to attempt loading arbitrary files as dictionaries. While SymSpell's `load_dictionary` expects a specific format, errors during parsing could leak file existence/contents via error messages.

**Impact**: Limited file read/existence disclosure if environment variables are compromised.

**Remediation**: Validate that `dictionary_path` is an absolute path within the project directory; reject paths containing `..`.

---

### VULN-010: Model Name Injection via Environment Variable

**Severity**: Medium (CVSS 6.5)
**File**: `core/config.py:73,99,129`

**Description**: Model names and tokenizer names are fully configurable via environment variables:

```python
model_name: str = Field(default="michellejieli/emotion_text_classifier")
# Overridable via TEXT_CLASSIFIER_MODEL_NAME env var
```

An attacker who gains write access to environment variables or `.env` files can redirect model loading to a malicious HuggingFace repository, compounding VULN-002.

**Impact**: Model poisoning — attacker replaces legitimate medical NLP models with malicious ones that return wrong diagnoses or execute arbitrary code.

**Remediation**:
- Maintain an allowlist of approved model names
- Validate model names against the allowlist at startup
- Use content-addressable model references (commit hashes)

---

### VULN-011: WebSocket Session ID Not Validated

**Severity**: Medium (CVSS 5.3)
**File**: `api/v1/ws/classify.py:14-15,30-31`

**Description**: The `session_id` path parameter is an unconstrained string:

```python
@router.websocket("/token/{session_id}")
async def websocket_classify_token(
    websocket: WebSocket,
    session_id: str,  # Any string accepted
```

An attacker can:
- Use excessively long session IDs (memory exhaustion in the sessions dict)
- Use special characters that break log parsing (see VULN-007)
- Overwrite existing sessions by reusing a known session_id

**Impact**: Session hijacking, log corruption, memory exhaustion.

**Remediation**: Validate `session_id` as UUID format and limit length.

---

### VULN-012: No Timeout on ML Inference

**Severity**: Medium (CVSS 6.5)
**Files**: `services/text_classifier.py:82`, `services/token_classifier.py:83`, `services/medical_suggester.py:208`

**Description**: ML pipeline inference calls have no timeout:

```python
pipeline_results = self.pipeline(request["text"])  # No timeout, can hang indefinitely
```

If a carefully crafted input causes the transformer model to take an unusually long time (adversarial input), the async request handler blocks the event loop thread, stalling all other requests on that worker.

**Impact**: Single-request denial of service that blocks the entire worker.

**Remediation**: Wrap inference calls with `asyncio.wait_for()` or run them in a thread pool executor with a timeout.

---

### VULN-013: PHI Leakage in Error Messages and Logs

**Severity**: Medium (CVSS 5.5)
**Files**: `app.py:47,52`, `api/v1/rest/diagnosis.py:21`, `services/token_classifier.py:113`

**Description**: Multiple locations leak potentially sensitive information:

```python
# app.py — exception details returned to client
logger.error(f"HTTP {exc.status_code}: {exc.detail}")
logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)

# diagnosis.py — full medical diagnosis logged
logger.info(f"Diagnosis suggestions: {response}")

# token_classifier.py — uses print() instead of logger
print(f"Error in token classification: {str(e)}")
```

The general exception handler logs full tracebacks which may include PHI from request payloads in stack frames. The diagnosis endpoint logs the complete medical diagnosis response.

**Impact**: PHI written to log files, potentially violating HIPAA logging requirements. Error messages may reveal internal implementation details.

**Remediation**:
- Never log full request/response objects containing medical data
- Replace `print()` with structured logger calls
- Redact PHI from log messages
- Return generic error messages to clients (already partially done)

---

### VULN-014: Uninitialized Variable in Error Handler

**Severity**: Medium (CVSS 4.0)
**File**: `services/token_classifier.py:119-125`

**Description**: The error handler references `entities` which may not be defined if the exception occurs before `entities = self._to_entities(...)` on line 102:

```python
except Exception as e:
    print(f"Error in token classification: {str(e)}")
    return TokenClassificationResponse(
        entities=entities,       # UnboundLocalError if exception on line 83
        model_version=self.version,
    )
```

**Impact**: Unhandled `UnboundLocalError` crashes the request, exposing a stack trace.

**Remediation**: Set `entities = []` before the try block or use an empty list in the except handler.

---

### VULN-015: Deprecated Jaeger Thrift Exporter

**Severity**: Medium (CVSS 4.0)
**File**: `pyproject.toml:38`, `core/observability.py:8,43-51`

**Description**: `opentelemetry-exporter-jaeger-thrift>=1.21.0` was formally deprecated in the OpenTelemetry specification in 2022 and **removed from the specification in April 2024**. The Jaeger client repositories are archived and no longer receive security updates.

**Impact**: Using deprecated, unmaintained code that no longer receives security patches. May contain undisclosed vulnerabilities.

**Remediation**: Migrate to OTLP exporter (already partially implemented — `OTLPSpanExporter` is configured). Remove the Jaeger thrift dependency and use OTLP exclusively.

---

### VULN-016: `get_current_time()` Returns String, Used as Datetime

**Severity**: Medium (CVSS 3.5)
**File**: `utils.py:17-18`, `core/websocket_manager.py:21,120-121,208`

**Description**: `get_current_time()` returns an ISO string but is compared as a datetime object:

```python
# utils.py
def get_current_time() -> datetime:
    return datetime.now().isoformat()  # Returns str, not datetime!

# websocket_manager.py
self.last_heartbeat = get_current_time()   # str

# Then compared as datetime:
time_since_heartbeat = (current_time - session.last_heartbeat).total_seconds()
# TypeError: unsupported operand type(s) for -: 'datetime' and 'str'
```

**Impact**: The cleanup loop will crash with a TypeError, meaning stale WebSocket sessions are never cleaned up — leading to unbounded memory growth.

**Remediation**: Fix `get_current_time()` to return `datetime.now(timezone.utc)` instead of an isoformat string.

---

## Low Vulnerabilities

### VULN-017: Passlib — Unmaintained Dependency

**Severity**: Low (CVSS 2.0)
**File**: `pyproject.toml:27`

**Description**: `passlib[bcrypt]>=1.7.4` has not been updated since October 2020 (5+ years). No known CVEs, but no security maintenance either. Like python-jose, passlib is declared but **never imported or used** in any source file.

**Impact**: Unnecessary attack surface from an unmaintained dependency.

**Remediation**: Remove from `pyproject.toml` if not used.

---

### VULN-018: Error Swallowing Hides Security Events

**Severity**: Low (CVSS 3.0)
**Files**: `services/text_classifier.py:93-99`, `services/text_corrector.py:78-79`, `core/config.py:62-63`

**Description**: Multiple locations catch all exceptions and return fallback responses without raising or alerting:

```python
# text_classifier.py — returns "other" silently on ANY error
except Exception as e:
    return TextClassificationResponse(
        predicted_label="other",
        confidence=0.0, ...
    )

# config.py — silently ignores URL parsing errors
except Exception:
    pass
```

This hides potential security events (model corruption, injection attempts, resource exhaustion) from monitoring.

**Impact**: Security incidents may go undetected.

**Remediation**: Log errors at WARNING/ERROR level and emit metrics for error tracking. Never silently swallow exceptions in security-sensitive code.

---

### VULN-019: Shutdown Bug — Reference to Non-Existent Attribute

**Severity**: Low (CVSS 2.5)
**File**: `services/text_corrector.py:132`

**Description**: `shutdown()` references `self.language_configs` which is never defined:

```python
async def shutdown(self) -> None:
    self.sym_spell_instances.clear()
    self.language_configs.clear()  # AttributeError — never defined
```

**Impact**: Graceful shutdown fails, potentially leaving resources unreleased.

**Remediation**: Remove the `self.language_configs.clear()` line or add the attribute to `__init__`.

---

### VULN-020: Overly Permissive HTTP Methods in CORS

**Severity**: Low (CVSS 3.0)
**File**: `core/config.py:168`

**Description**: CORS allows PUT and DELETE methods, but the NLP service only uses GET and POST:

```python
cors_methods: List[str] = Field(default=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
```

**Impact**: Slightly increases attack surface if unintended methods are exposed.

**Remediation**: Restrict to `["GET", "POST", "OPTIONS"]`.

---

### VULN-021: `allow_headers=["*"]` in CORS Middleware

**Severity**: Low (CVSS 2.5)
**File**: `app.py:35`

**Description**: Wildcard `allow_headers` permits any custom header in CORS preflight responses, which is more permissive than necessary.

**Impact**: Minimal direct risk but violates the principle of least privilege.

**Remediation**: Specify only the required headers (e.g., `Content-Type`, `Authorization`).

---

## Informational

### INFO-001: Dockerfile — Generally Well-Hardened

**File**: `Dockerfile`

The Dockerfile follows security best practices:
- Multi-stage build (build artifacts don't leak to production image)
- Non-root user (`nlpuser:1001`)
- No `--no-cache-dir` missing (build caches are Docker-layer-cached only)
- Health check configured
- `PYTHONHASHSEED=random` (mitigates hash collision DoS)
- `.dockerignore` excludes `.env`, secrets, and dev artifacts

**Minor items**:
- Base image `python:3.11-slim-trixie` is version-pinned but not digest-pinned. Supply chain attacks on Docker Hub could replace the image. Consider using `@sha256:...` pinning.
- `PYTHONDONTWRITEBYTECODE=1` is set only in production stage, not debug stage.
- The health check uses `urllib.request.urlopen` without timeout, which could hang if the service is stuck.

---

### INFO-002: No Secrets Detected in Committed Files

Scanned all source files, config files, `.env.example`, and documentation for hardcoded secrets. No API keys, passwords, private keys, or access tokens were found in committed code. The `.env.example` contains only structural variable names without values.

---

### INFO-003: Absence of Security Headers

**File**: `app.py`

The FastAPI application does not set any security response headers:
- No `X-Content-Type-Options: nosniff`
- No `X-Frame-Options: DENY`
- No `Strict-Transport-Security`
- No `Content-Security-Policy`

While this is a backend API (not serving HTML), security headers are defense-in-depth and recommended.

---

### INFO-004: Test File Executes at Module Level

**File**: `tests/test_classification.py:52`

The test file has `text_classification()` called at module level (line 52), which downloads and runs a HuggingFace model whenever the file is imported. This is not a security vulnerability per se, but it means `pytest` collection will trigger model downloads.

---

## Scan Coverage Summary

| Category | Result | Details |
|---|---|---|
| **Dependency CVEs** | 2 found | python-jose (CVE-2024-33663 + multiple unfixed), Jaeger exporter (deprecated/archived) |
| **Pickle/Deserialization** | 1 critical | `from_pretrained()` loads pickle-serialized model weights from 3rd-party repos |
| **Command Injection** | Clean | No `subprocess`, `os.system`, or `os.popen` calls found |
| **Path Traversal** | 1 medium | Dictionary path configurable via env var, string concatenation |
| **SSRF** | Clean | No HTTP client calls in source code (only in docs/Dockerfile healthcheck) |
| **XXE** | Clean | No XML parsing libraries imported |
| **ReDoS** | Clean | Single regex `r"(\d+)"` is safe — no backtracking risk |
| **Race Conditions** | 1 high | Shared mutable session dict without locks; globals() singleton pattern |
| **Memory/Resource Exhaustion** | 2 found | No input length limits; no inference timeouts |
| **Unsafe eval/exec** | Clean | No `eval()`, `exec()`, or `compile()` calls |
| **Temp File Vulnerabilities** | Clean | No temporary file usage |
| **Type Confusion** | 1 found | `get_current_time()` type mismatch (str vs datetime) |
| **Docker** | Good | Well-hardened, minor improvements possible |
| **Committed Secrets** | Clean | No secrets in committed files |

---

## Prioritized Remediation Roadmap

### Immediate (Before Next Deployment)

| # | Issue | Effort | Impact |
|---|---|---|---|
| 1 | Remove `python-jose` and `passlib` (unused) | 5 min | Eliminates critical CVE surface |
| 2 | Add `use_safetensors=True, trust_remote_code=False` to all `from_pretrained()` calls | 15 min | Prevents arbitrary code execution |
| 3 | Pin model revisions to specific commit hashes | 30 min | Prevents model supply chain attacks |
| 4 | Add `max_length` to all text input fields | 15 min | Prevents resource exhaustion DoS |
| 5 | Fix `get_current_time()` to return datetime | 5 min | Fixes WebSocket session cleanup crash |
| 6 | Fix `entities` unbound variable in error handler | 5 min | Prevents unhandled exception |
| 7 | Fix `self.language_configs` reference in shutdown | 5 min | Prevents shutdown crash |

### Short-Term (Within 1 Sprint)

| # | Issue | Effort | Impact |
|---|---|---|---|
| 8 | Add rate limiting (slowapi) | 2 hours | Prevents DoS attacks |
| 9 | Add `asyncio.Lock` to WebSocket session dict | 1 hour | Prevents race condition crashes |
| 10 | Restrict CORS origins to explicit domains | 15 min | Prevents cross-origin attacks |
| 11 | Switch to parameterized logging everywhere | 2 hours | Prevents log injection |
| 12 | Remove full response logging in diagnosis endpoint | 15 min | Prevents PHI leakage to logs |
| 13 | Validate session_id format (UUID) | 30 min | Prevents injection/hijacking |
| 14 | Add inference timeouts via `asyncio.wait_for()` | 1 hour | Prevents single-request DoS |
| 15 | Migrate from Jaeger thrift to OTLP exporter | 1 hour | Removes deprecated dependency |

### Medium-Term (Within 1 Month)

| # | Issue | Effort | Impact |
|---|---|---|---|
| 16 | Implement service-to-service auth (API key or mTLS) | 1 day | Prevents unauthorized access |
| 17 | Set up private model registry | 2 days | Full model supply chain control |
| 18 | Add security response headers middleware | 1 hour | Defense-in-depth |
| 19 | Implement proper error tracking (Sentry or similar) | 2 hours | Better security event visibility |
| 20 | Add model integrity verification (checksums) | 2 hours | Detects model tampering |

---

## Appendix: Dependency Version Inventory

| Package | Locked Version | Status | Notes |
|---|---|---|---|
| fastapi | 0.135.1 | OK | No known CVEs |
| uvicorn | 0.42.0 | OK | No known CVEs |
| pydantic | 2.12.5 | OK | No known CVEs |
| pydantic-settings | 2.13.1 | OK | No known CVEs |
| spacy | 3.8.7 | OK | CVE-2025-25362 affects spacy-llm, not spacy core |
| transformers | 4.52.4 | Caution | Pickle deserialization risk (see VULN-002) |
| torch | 2.7.1 | OK | No known CVEs in current version |
| numpy | 2.3.0 | OK | No known CVEs |
| pandas | 2.3.0 | OK | No known CVEs |
| scikit-learn | 1.7.0 | OK | No known CVEs |
| httpx | 0.28.1 | OK | Not used in source code |
| aiofiles | 25.1.0 | OK | Not used in source code |
| python-jose | 3.5.0 | **CRITICAL** | CVE-2024-33663 + multiple unfixed issues; unused |
| passlib | 1.7.4 | **LOW** | No CVEs but unmaintained since 2020; unused |
| python-multipart | 0.0.22 | OK | No known CVEs |
| symspellpy | 6.9.0 | OK | No known CVEs |
| prometheus-fastapi-instrumentator | 7.1.0 | OK | No known CVEs |
| opentelemetry-exporter-jaeger-thrift | 1.21.0 | **DEPRECATED** | Removed from OTel spec April 2024 |
| deprecated | 1.2.18 | OK | No known CVEs |
