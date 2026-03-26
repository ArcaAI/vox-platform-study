# Security Audit Report: SMR V2 (Text Generation Service)

**Service**: `apps/smr/` — Multi-provider LLM Text Generation/Summarization  
**Audit Date**: 2026-03-24  
**Auditor**: HOPE Security Audit (Automated)  
**Scope**: Full source review of `apps/smr/src/smr_v2/` (34 production source files, ~2,400 LOC)  
**Python**: 3.11+ / FastAPI / Pydantic v2

---

## Executive Summary

The SMR V2 service demonstrates **strong security fundamentals** for a healthcare AI micro­service. It uses `SecretStr` for credential handling, `hmac.compare_digest` for timing-safe token comparison, pre-compiled regex-based prompt-injection scanning, HIPAA-compliant audit logging, and well-structured exception handlers that sanitize error messages before returning them to clients.

However, the audit identified **21 findings** across 10 categories. The most critical issues are:

1. **OTLP exporter configured with `insecure=True`** — telemetry data (including prompt metadata) sent in cleartext.
2. **No upper bound on `max_tokens`** — users can request unbounded token generation, causing cost/resource exhaustion.
3. **Provider error strings stored in Redis and audit logs** — may leak internal details or credentials from provider SDK exceptions.
4. **Auth bypass when `service_token` is empty** — intentional for dev but dangerous if deployed to production without the env var.
5. **Task IDs are enumerable UUIDs without ownership checks** — any authenticated client can read/cancel any task.

No hardcoded secrets were found in production code (only test files, which is acceptable).

---

## Findings Summary

| # | Severity | Title | File | OWASP |
|---|----------|-------|------|-------|
| SMR-001 | **Critical** | OTLP exporter uses `insecure=True` — cleartext telemetry | `core/telemetry.py:29` | A02 |
| SMR-002 | **High** | No upper bound on `max_tokens` request field | `models/requests.py:27` | A04 |
| SMR-003 | **High** | Unvalidated `provider` field allows arbitrary string injection | `models/requests.py:24` | A03 |
| SMR-004 | **High** | Provider exception strings stored verbatim in Redis task state | `api/endpoints/generate.py:412` | A09 |
| SMR-005 | **High** | Auth entirely disabled when `service_token` is empty | `api/middleware/auth.py:40-41` | A07 |
| SMR-006 | **High** | Task IDs lack ownership — any client can read/cancel any task | `api/endpoints/tasks.py:14-33` | A01 |
| SMR-007 | **Medium** | Guardrails default to `log` mode — prompt injection not blocked | `core/config.py:133` | A04 |
| SMR-008 | **Medium** | CORS allows `*` methods and `*` headers when enabled | `main.py:199-200` | A05 |
| SMR-009 | **Medium** | Redis connection without TLS/auth by default | `core/config.py:82` | A02 |
| SMR-010 | **Medium** | Metrics endpoint (`/metrics`) exposed without authentication | `main.py:234` | A01 |
| SMR-011 | **Medium** | Unbounded `retry_config.max_retries` with no cap | `models/requests.py:11` | A04 |
| SMR-012 | **Medium** | `max_tokens` default of 4096 applied silently when `None` | `core/defaults.py:12` | A04 |
| SMR-013 | **Medium** | CircuitBreaker state property has read-modify side effect | `services/circuit_breaker.py:27-29` | A04 |
| SMR-014 | **Medium** | SSE stream endpoint has no timeout or max-duration limit | `api/endpoints/stream.py:33-54` | A04 |
| SMR-015 | **Low** | `.env` file loading walks up 10 directories | `core/config.py:169` | A05 |
| SMR-016 | **Low** | `response_format.json_schema` passed directly to LLM providers | `providers/azure_openai.py:68-76` | A03 |
| SMR-017 | **Low** | No security headers (X-Content-Type-Options, etc.) | `main.py` | A05 |
| SMR-018 | **Low** | OpenAI-compat default API key is `"not-needed"` | `core/config.py:70` | A07 |
| SMR-019 | **Low** | `docs_url` and `redoc_url` enabled in all environments | `main.py:173-174` | A05 |
| SMR-020 | **Info** | Prompt injection scanner is regex-only — no semantic analysis | `services/guardrails.py` | A04 |
| SMR-021 | **Info** | No request body size limit beyond Pydantic field max_length | `models/requests.py` | A04 |

---

## Detailed Findings

---

### SMR-001: OTLP Exporter Uses `insecure=True` — Cleartext Telemetry

**Severity**: Critical  
**OWASP**: A02 — Cryptographic Failures  
**File**: `apps/smr/src/smr_v2/core/telemetry.py:29`

**Description**:  
The OpenTelemetry OTLP gRPC span exporter is configured with `insecure=True`, which sends all telemetry data — including span attributes like model names, provider names, temperature settings, token counts, and finish reasons — over unencrypted gRPC. In a healthcare context, this telemetry could contain metadata correlated with patient interactions.

**Code**:
```python
exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
```

**Impact**:  
- Telemetry data transmitted in cleartext; susceptible to network sniffing.
- Span attributes include `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.usage.input_tokens`, etc. — operational metadata that can be correlated with patient sessions.
- In cloud/multi-tenant environments, other tenants on the same network segment could intercept this data.

**Recommended Fix**:
```python
# Use TLS by default; only allow insecure in explicit dev mode
exporter = OTLPSpanExporter(
    endpoint=endpoint,
    insecure=settings.debug,  # Only insecure when debug=True
)
```
Add a config field `otel_insecure: bool = False` and wire it to the exporter. Production deployments must use TLS-enabled collectors.

---

### SMR-002: No Upper Bound on `max_tokens` Request Field

**Severity**: High  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/models/requests.py:27`

**Description**:  
The `max_tokens` field has `ge=1` but no upper bound (`le=...`). A malicious or misconfigured client can send `max_tokens: 1_000_000`, causing the LLM provider to generate an extremely long response, leading to cost exhaustion (Azure/Bedrock billing) and resource starvation.

**Code**:
```python
max_tokens: int | None = Field(default=None, ge=1)
```

**Impact**:  
- Excessive cloud provider costs (Azure OpenAI, Bedrock charge per token).
- Long-running requests consume worker threads/connections, starving other clients.
- Can trigger provider rate limits, opening circuit breakers for all users.

**Recommended Fix**:
```python
max_tokens: int | None = Field(default=None, ge=1, le=32_768)
```
Choose an upper bound appropriate for the models deployed (e.g., 32,768 for GPT-4, 4,096 for smaller models). Consider making this per-provider configurable.

---

### SMR-003: Unvalidated `provider` Field Allows Arbitrary String Injection

**Severity**: High  
**OWASP**: A03 — Injection  
**File**: `apps/smr/src/smr_v2/models/requests.py:24`

**Description**:  
The `provider` field is a bare `str` with no validation. While the registry lookup will fail for unknown providers, the raw string is used throughout metrics labels, log messages, audit events, and Redis keys before that check occurs.

**Code**:
```python
provider: str = "ollama"
```

This value flows into:
- `GENERATION_TOTAL.labels(provider=request_body.provider, ...)` (line 181, generate.py)
- `RATE_LIMIT_REJECTIONS.labels(provider=request_body.provider)` (line 200, generate.py)
- `GuardrailAuditEvent(provider=request_body.provider, ...)` (line 168, generate.py)
- Structured log entries

**Impact**:  
- **Prometheus cardinality explosion**: An attacker sending unique provider strings creates unbounded metric label values, exhausting Prometheus memory.
- **Log injection**: Crafted provider strings with newlines or JSON-special characters could corrupt structured log output.
- **Metric poisoning**: Fake provider names pollute dashboards and alerting.

**Recommended Fix**:
```python
from typing import Literal

VALID_PROVIDERS = Literal["ollama", "azure-openai", "azure", "bedrock", "lm-studio", "openai_compat"]

provider: VALID_PROVIDERS = "ollama"
```
Or validate against the registry's known providers early in the endpoint, before any metrics/logging.

---

### SMR-004: Provider Exception Strings Stored Verbatim in Redis Task State

**Severity**: High  
**OWASP**: A09 — Security Logging and Monitoring Failures  
**File**: `apps/smr/src/smr_v2/api/endpoints/generate.py:412,484`

**Description**:  
When provider calls fail, the raw exception message (`str(exc)`) is stored in Redis task state and audit logs. Provider SDK exceptions from Azure OpenAI, Bedrock, and OpenAI may contain:
- API endpoint URLs with path segments
- Request IDs that could be used for correlation attacks
- In rare cases, partial request/response payloads

**Code**:
```python
# generate.py:412
await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error=str(exc))

# generate.py:484 (streaming)
await task_manager.update_task(task_id, status=TaskStatus.FAILED, error=str(exc))
```

The task state is later returned to clients via `/api/v1/tasks/{task_id}`:
```python
# tasks.py:22
return state.model_dump(mode="json")  # includes error field
```

**Impact**:  
- Internal infrastructure details (endpoint URLs, regions, deployment names) exposed to API consumers.
- Error messages may contain partial credentials if SDK formatting changes.
- Violates principle of least information for error responses.

**Recommended Fix**:
```python
def _sanitize_error(exc: Exception) -> str:
    """Return a generic error message, stripping internal details."""
    error_type = type(exc).__name__
    safe_messages = {
        "TimeoutError": "Request timed out",
        "APIError": "Provider API error",
        "ClientError": "Provider service error",
        "BotoCoreError": "Provider service error",
    }
    return safe_messages.get(error_type, "Generation failed due to an internal error")

# Usage:
await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error=_sanitize_error(exc))
```
Log the full `str(exc)` at `logger.error()` level only (already done), but sanitize before persisting to Redis or returning to clients.

---

### SMR-005: Auth Entirely Disabled When `service_token` Is Empty

**Severity**: High  
**OWASP**: A07 — Identification and Authentication Failures  
**File**: `apps/smr/src/smr_v2/api/middleware/auth.py:40-41`

**Description**:  
When `SMR_V2_SERVICE_TOKEN` is unset or empty, the `ServiceAuthMiddleware` bypasses authentication entirely — all endpoints (including `/generate`, `/tasks/*/cancel`, `/providers`) are publicly accessible.

**Code**:
```python
if not service_token:
    return await call_next(request)
```

The config defaults to `SecretStr("")`:
```python
service_token: SecretStr = SecretStr("")
```

**Impact**:  
- If deployed to production without setting `SMR_V2_SERVICE_TOKEN`, the entire service is unauthenticated.
- Any network-accessible client can generate text, consume LLM credits, and read/cancel tasks.
- This is documented as "dev mode" but there is no runtime warning or startup check.

**Recommended Fix**:
1. Add a startup warning when `service_token` is empty and `debug` is `False`:
```python
if not settings.service_token.get_secret_value() and not settings.debug:
    logger.critical("smr_v2.auth_disabled_in_production", 
                    message="SERVICE_TOKEN is empty in non-debug mode. Auth is DISABLED.")
```
2. Consider refusing to start in non-debug mode without a token.
3. Add a health check field indicating whether auth is enabled.

---

### SMR-006: Task IDs Lack Ownership — Any Client Can Read/Cancel Any Task

**Severity**: High  
**OWASP**: A01 — Broken Access Control  
**File**: `apps/smr/src/smr_v2/api/endpoints/tasks.py:14-33`

**Description**:  
Task endpoints (`GET /tasks/{task_id}`, `POST /tasks/{task_id}/cancel`) perform no authorization check beyond the service token. Any authenticated client can read or cancel any task if they know or guess the UUID.

While UUIDv4 is hard to brute-force, the `task_id` is returned in the `POST /generate` response and in SSE stream URLs, so it may be leaked via logs, referrer headers, or shared URLs.

**Code**:
```python
@router.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, ...):
    state = await task_manager.get_task(task_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
    return state.model_dump(mode="json")
```

**Impact**:  
- Cross-tenant data access: One service consumer can see another's task status, error messages, and token usage.
- Task cancellation abuse: A malicious client could cancel other users' in-progress generations.
- In a healthcare context, task metadata (provider, model, timestamps) could reveal consultation patterns.

**Recommended Fix**:
Store a `created_by` or `service_id` field in `TaskState` (derived from the service token or a client identifier header). Validate ownership on task read/cancel.

---

### SMR-007: Guardrails Default to `log` Mode — Prompt Injection Not Blocked

**Severity**: Medium  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/core/config.py:133`

**Description**:  
The default guardrail mode is `"log"`, meaning detected prompt injections are only logged, not blocked. High-risk patterns (instruction injection, jailbreak markers, data exfiltration attempts) pass through to LLM providers.

**Code**:
```python
guardrail_mode: str = "log"
```

The blocking logic in generate.py:
```python
blocked = (
    scan_result.is_suspicious
    and scanner.mode == "block"
    and scan_result.risk_level in ("medium", "high")
)
```

**Impact**:  
- Prompt injection attacks succeed by default.
- In a healthcare service, injected prompts could manipulate medical summaries.
- The audit trail exists (log mode), but no active defense is present.

**Recommended Fix**:
- Default to `"block"` for production environments.
- Add validation: `guardrail_mode: Literal["log", "block"] = "block"`
- Consider a per-risk-level policy (e.g., block "high", log "medium").

---

### SMR-008: CORS Allows `*` Methods and `*` Headers When Enabled

**Severity**: Medium  
**OWASP**: A05 — Security Misconfiguration  
**File**: `apps/smr/src/smr_v2/main.py:199-200`

**Description**:  
When CORS is enabled, the middleware is configured with `allow_methods=["*"]` and `allow_headers=["*"]`, which is overly permissive for a backend-to-backend service.

**Code**:
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Impact**:  
- Allows arbitrary HTTP methods (DELETE, PATCH, OPTIONS, etc.) from browser origins.
- `allow_credentials=True` with broad origins enables credential-bearing cross-origin requests.
- In combination with a permissive `cors_origins`, this could enable CSRF-like attacks.

**Recommended Fix**:
```python
allow_methods=["GET", "POST"],
allow_headers=["Content-Type", "Authorization", "X-Service-Token", "X-Request-ID"],
```
Restrict to only the methods and headers the API actually uses.

---

### SMR-009: Redis Connection Without TLS/Auth by Default

**Severity**: Medium  
**OWASP**: A02 — Cryptographic Failures  
**File**: `apps/smr/src/smr_v2/core/config.py:82`

**Description**:  
The default Redis URL is `redis://localhost:6379/0` — no TLS, no authentication. Redis stores task state including prompts metadata, error messages, and stream chunks.

**Code**:
```python
redis_url: str = "redis://localhost:6379/0"
```

**Impact**:  
- In production with an unencrypted Redis, task data (which may contain medical context metadata) is transmitted in cleartext.
- Without Redis AUTH, any process on the network can read/modify task state.

**Recommended Fix**:
- Document that production must use `rediss://` (TLS) URLs with authentication.
- Add a startup check: if not `debug` mode and URL scheme is `redis://` (not `rediss://`), emit a warning.
- Consider: `redis_url: str = Field(default="redis://localhost:6379/0", pattern=r"^rediss?://.*")`

---

### SMR-010: Metrics Endpoint Exposed Without Authentication

**Severity**: Medium  
**OWASP**: A01 — Broken Access Control  
**File**: `apps/smr/src/smr_v2/main.py:234`

**Description**:  
The `/metrics` endpoint is added to EXEMPT_PATHS in the auth middleware (line 21 of auth.py), meaning Prometheus metrics are accessible without any authentication.

**Code**:
```python
# main.py:234
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# auth.py:19-20
EXEMPT_PATHS: frozenset[str] = frozenset({
    "/metrics",
    ...
})
```

**Impact**:  
- Metrics expose provider names, model names, error rates, queue sizes, rate limit states, and active generation counts.
- An attacker can fingerprint the service, identify which providers are active, and determine load patterns.
- `smr_v2_generation_errors_total` with `error_type` labels reveals failure modes.

**Recommended Fix**:
- Remove `/metrics` from `EXEMPT_PATHS`.
- Or expose metrics on a separate port/path that is not externally accessible (internal-only network binding).
- Or add IP-allowlist middleware for the metrics endpoint.

---

### SMR-011: Unbounded `retry_config.max_retries` With No Cap

**Severity**: Medium  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/models/requests.py:11`

**Description**:  
The `max_retries` field in `RetryConfig` has no upper bound. A client can set `max_retries: 1000`, causing a single request to retry for hours with exponential backoff, tying up server resources.

**Code**:
```python
class RetryConfig(BaseModel):
    max_retries: int = 3
    retry_on: list[str] = Field(default_factory=lambda: ["timeout", "provider_error"])
```

**Impact**:  
- Resource exhaustion: a single request with 100+ retries consumes a semaphore slot for hours.
- Amplification attack: one request generates hundreds of LLM calls.
- Combined with the unbounded `max_tokens`, this multiplies cost impact.

**Recommended Fix**:
```python
max_retries: int = Field(default=3, ge=0, le=10)
retry_on: list[str] = Field(
    default_factory=lambda: ["timeout", "provider_error"],
    max_length=5,
)
```

---

### SMR-012: `max_tokens` Default of 4096 Applied Silently When `None`

**Severity**: Medium  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/core/defaults.py:12`

**Description**:  
When the client omits `max_tokens` (sends `None`), the server silently applies a default of 4096. This is not documented in the API response and the client has no indication of the effective limit.

**Code**:
```python
GENERATION_DEFAULTS: dict[str, float | int] = {
    "temperature": 0.1,
    "max_tokens": 4096,
    "top_p": 0.95,
}
```

**Impact**:  
- Clients may not realize their output is being truncated at 4096 tokens.
- For healthcare summarization, truncated medical summaries could miss critical information.
- This is a usability/safety issue rather than a direct security vulnerability.

**Recommended Fix**:
- Document the default in the OpenAPI schema using `Field(description=...)`.
- Return the effective `max_tokens` in the response metadata.
- Consider returning a warning when output is truncated.

---

### SMR-013: CircuitBreaker State Property Has Read-Modify Side Effect

**Severity**: Medium  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/services/circuit_breaker.py:27-29`

**Description**:  
The `state` property mutates `self._state` from `OPEN` to `HALF_OPEN` as a side effect of reading. In a concurrent async environment, multiple coroutines checking `cb.state` simultaneously could race on this transition.

**Code**:
```python
@property
def state(self) -> CircuitState:
    if self._state == CircuitState.OPEN:
        if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
            self._state = CircuitState.HALF_OPEN  # MUTATION during read
    return self._state
```

**Impact**:  
- Multiple concurrent requests could all see `HALF_OPEN` and all proceed, exceeding the intended `half_open_max_calls` limit.
- Not a direct security vulnerability but undermines the circuit breaker's protective function.

**Recommended Fix**:
Use an `asyncio.Lock` or separate the state transition into an explicit method. Alternatively, use compare-and-swap semantics:
```python
def try_transition_to_half_open(self) -> bool:
    if self._state == CircuitState.OPEN and ...:
        self._state = CircuitState.HALF_OPEN
        return True
    return False
```

---

### SMR-014: SSE Stream Endpoint Has No Timeout or Max-Duration Limit

**Severity**: Medium  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/api/endpoints/stream.py:33-54`

**Description**:  
The SSE event generator loop runs indefinitely, only terminating when: the client disconnects, a `done`/`error` chunk arrives, or the task reaches a terminal status. If the background generation hangs, the SSE connection stays open forever.

**Code**:
```python
async def event_generator():
    cursor = last_event_id or "0-0"
    while True:  # No timeout
        if await request.is_disconnected():
            break
        entries = await task_manager.read_chunks_blocking(
            task_id, last_id=cursor, block_ms=5000
        )
        # ...
```

**Impact**:  
- Resource exhaustion: stuck connections consume server worker threads.
- A malicious client could open many SSE connections for tasks that never complete.
- Memory leak from accumulated Redis XREAD contexts.

**Recommended Fix**:
Add a maximum SSE connection duration:
```python
MAX_STREAM_DURATION_S = 600  # 10 minutes
stream_start = time.monotonic()

async def event_generator():
    while True:
        if time.monotonic() - stream_start > MAX_STREAM_DURATION_S:
            yield {"event": "error", "data": '{"error":"Stream timeout"}'}
            return
        # ... existing logic
```

---

### SMR-015: `.env` File Loading Walks Up 10 Directories

**Severity**: Low  
**OWASP**: A05 — Security Misconfiguration  
**File**: `apps/smr/src/smr_v2/core/config.py:169`

**Description**:  
The `_load_dotenv_into_environ` function walks up 10 parent directories looking for `.env` files. In a containerized environment this is relatively safe, but on a shared development machine or CI runner, it could pick up `.env` files from unexpected parent directories.

**Code**:
```python
current = pathlib.Path(__file__).resolve().parent
for _ in range(10):
    candidate = current / ".env"
    if candidate.is_file():
        env_files.append(candidate)
    current = current.parent
```

**Impact**:  
- Could accidentally load environment variables from a monorepo root `.env` that contains secrets for other services.
- In CI/CD, could pick up stale or poisoned `.env` files.

**Recommended Fix**:
Limit traversal to the project root (e.g., stop at the directory containing `pyproject.toml`) or use a fixed path:
```python
# Stop at monorepo root
if (current / "turbo.json").exists() or (current / "pyproject.toml").exists():
    break
```

---

### SMR-016: `response_format.json_schema` Passed Directly to LLM Providers

**Severity**: Low  
**OWASP**: A03 — Injection  
**File**: `apps/smr/src/smr_v2/providers/azure_openai.py:68-76`

**Description**:  
The `response_format.json_schema` dictionary from the request body is passed directly into the LLM provider's API call without validation. While the immediate risk is low (the LLM provider validates schemas), a deeply nested or excessively large schema could be used for DoS.

**Code**:
```python
schema = request.response_format.json_schema or {}
kwargs["response_format"] = {
    "type": "json_schema",
    "json_schema": {
        "name": schema.get("title", "output"),
        "schema": schema,  # Arbitrary dict from user
        "strict": request.response_format.strict,
    },
}
```

**Impact**:  
- Oversized schemas could waste provider API resources.
- Malformed schemas could trigger unexpected provider-side errors.
- In Bedrock's `toolConfig` path (bedrock.py:60-69), the schema is embedded as tool input schema.

**Recommended Fix**:
Add a maximum depth/size check on the schema:
```python
import json
schema_json = json.dumps(schema)
if len(schema_json) > 10_000:
    raise InputValidationError("JSON schema exceeds maximum size (10KB)")
```

---

### SMR-017: No Security Headers (X-Content-Type-Options, etc.)

**Severity**: Low  
**OWASP**: A05 — Security Misconfiguration  
**File**: `apps/smr/src/smr_v2/main.py`

**Description**:  
The application does not set standard security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HSTS)
- `Cache-Control: no-store` for API responses
- `Content-Security-Policy`

**Impact**:  
While this is a backend API (not serving HTML), security headers are a defense-in-depth measure. The `/docs` and `/redoc` pages serve HTML and could be vulnerable to clickjacking without `X-Frame-Options`.

**Recommended Fix**:
Add a middleware for security headers:
```python
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        return response
```

---

### SMR-018: OpenAI-Compat Default API Key Is `"not-needed"`

**Severity**: Low  
**OWASP**: A07 — Identification and Authentication Failures  
**File**: `apps/smr/src/smr_v2/core/config.py:70`

**Description**:  
The `OpenAICompatConfig` defaults to `api_key: SecretStr = SecretStr("not-needed")`. If an operator enables this provider without explicitly setting an API key, requests will be sent with a dummy credential.

**Code**:
```python
api_key: SecretStr = SecretStr("not-needed")
```

**Impact**:  
- Low risk for local models (LM Studio, vLLM), which typically don't require auth.
- If used with a remote OpenAI-compatible API that requires auth, the dummy key will appear in request headers — potentially triggering rate limits or account flags.

**Recommended Fix**:
Document this clearly. Consider an empty default with a startup check:
```python
api_key: SecretStr = SecretStr("")
# At startup:
if config.enabled and not config.api_key.get_secret_value():
    logger.warning("openai_compat.no_api_key", message="No API key set; requests may fail")
```

---

### SMR-019: `docs_url` and `redoc_url` Enabled in All Environments

**Severity**: Low  
**OWASP**: A05 — Security Misconfiguration  
**File**: `apps/smr/src/smr_v2/main.py:173-174`

**Description**:  
The Swagger UI (`/api/v1/docs`) and ReDoc (`/api/v1/redoc`) are always enabled, regardless of the `debug` setting.

**Code**:
```python
app = FastAPI(
    title="SMR V2 — Text Generation Service",
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
)
```

**Impact**:  
- API documentation reveals all endpoints, request/response schemas, and error codes.
- Reconnaissance tool for attackers to understand the API surface.
- While these are auth-exempt paths, they should ideally be disabled in production.

**Recommended Fix**:
```python
app = FastAPI(
    title="SMR V2 — Text Generation Service",
    docs_url="/api/v1/docs" if settings.debug else None,
    redoc_url="/api/v1/redoc" if settings.debug else None,
    openapi_url="/api/v1/openapi.json" if settings.debug else None,
)
```

---

### SMR-020: Prompt Injection Scanner Is Regex-Only

**Severity**: Info  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/services/guardrails.py`

**Description**:  
The `PromptInjectionScanner` uses pre-compiled regex patterns to detect prompt injection. While this catches common patterns (system prompt overrides, role hijacking, jailbreak markers, encoding evasion, delimiter injection), it is fundamentally limited:

- Obfuscated attacks (Unicode homoglyphs, multi-language injection, payload splitting across prompt + system_prompt) will evade detection.
- Semantic attacks ("tell me a story where the doctor ignores his instructions") bypass keyword patterns.

The scanner does cover output scanning for leaked API keys, AWS keys, and private keys, which is good.

**Impact**:  
- Sophisticated prompt injection attacks will bypass the scanner.
- For a healthcare AI service, manipulated summaries could have clinical impact.

**Recommended Fix**:
- Layer the regex scanner with an LLM-based classifier for prompt injection detection.
- Consider integrating Azure AI Content Safety or AWS Bedrock Guardrails (already partially done via `guardrailConfig` in Bedrock provider).
- Add more patterns: Unicode normalization before scanning, multi-language injection patterns.

---

### SMR-021: No Request Body Size Limit Beyond Pydantic Field max_length

**Severity**: Info  
**OWASP**: A04 — Insecure Design  
**File**: `apps/smr/src/smr_v2/models/requests.py`

**Description**:  
The `prompt` field has `max_length=200_000` (200K characters) and `system_prompt` has `max_length=50_000`. Combined with the `context` dict (unbounded) and `response_format.json_schema` (unbounded), a single request could be several MB.

There is no ASGI-level body size limit (e.g., uvicorn's `--limit-concurrency` or a middleware).

**Code**:
```python
prompt: str = Field(..., min_length=1, max_length=200_000)
system_prompt: str | None = Field(default=None, max_length=50_000)
context: dict[str, Any] | None = None  # Unbounded
response_format: ResponseFormat | None = None  # Contains unbounded json_schema
```

**Impact**:  
- Large request bodies consume memory during JSON parsing.
- Combined with concurrent requests, this could lead to OOM conditions.
- The `context` field is particularly risky as it's a completely unbounded dict.

**Recommended Fix**:
- Add a request body size limit middleware or configure uvicorn's `--limit-request-line` and `--limit-request-body`.
- Validate `context` dict size: `context: dict[str, Any] | None = Field(default=None, max_length=100)`
- Or add a custom validator that checks `len(json.dumps(context)) < 50_000`.

---

## Positive Security Controls (Already Implemented)

The following security controls are already well-implemented:

| Control | Implementation | Files |
|---------|---------------|-------|
| **SecretStr for credentials** | Azure API key and OpenAI-compat API key use `pydantic.SecretStr` preventing accidental logging | `core/config.py:32,70` |
| **Timing-safe token comparison** | `hmac.compare_digest()` for service token validation | `api/middleware/auth.py:47` |
| **Request ID propagation** | UUID-based request tracing across all logs | `api/middleware/request_id.py` |
| **Prompt injection scanning** | Regex-based input + output scanning with risk levels | `services/guardrails.py` |
| **HIPAA audit logging** | Structured audit events for guardrail scans and generation | `services/audit.py`, `services/generation_audit.py` |
| **Pydantic input validation** | `Field()` constraints on prompt length, temperature range, top_p range | `models/requests.py` |
| **Circuit breaker pattern** | Per-provider circuit breakers prevent cascading failures | `services/circuit_breaker.py` |
| **Rate limiting** | Sliding-window RPM/TPM tracking per provider | `services/rate_limiter.py` |
| **Concurrency limiting** | Per-provider semaphores cap concurrent LLM calls | `main.py:130-134` |
| **Graceful shutdown** | Drain active tasks before closing connections | `services/shutdown_manager.py` |
| **Error message sanitization** | Exception handler returns `error_code` + generic `message`, not raw exceptions | `core/exception_handlers.py` |
| **Output scanning** | Checks LLM output for leaked API keys, AWS keys, private keys | `services/guardrails.py:100-113` |
| **Structured logging** | JSON-formatted logs via structlog, no raw string concatenation | `core/logging.py` |
| **Atomic Redis updates** | Lua script for read-modify-write task updates | `services/task_manager.py:20-39` |

---

## Dependency Assessment

Based on `pyproject.toml` review:

| Package | Version | Risk | Notes |
|---------|---------|------|-------|
| fastapi | >=0.133.0 | Low | Recent version, actively maintained |
| pydantic | >=2.12.5 | Low | Recent v2, good security track record |
| httpx | >=0.28.1 | Low | Well-audited HTTP client |
| redis | >=5.2.0 | Low | Standard async Redis client |
| openai | >=2.24.0 | Low | Official SDK with SecretStr support |
| boto3 | >=1.42.0 | Low | Official AWS SDK, IAM credential chain |
| structlog | >=25.5.0 | Low | No known vulnerabilities |
| sse-starlette | >=3.2.0 | Low | Thin wrapper, limited attack surface |
| prometheus-client | >=0.24.1 | Low | Read-only metrics, no security issues |
| orjson | >=3.11.7 | Low | C extension, well-tested JSON parser |

**Recommendation**: Run `pip-audit` or `safety check` in CI to catch newly disclosed CVEs. Pin exact versions in a lockfile for reproducible builds.

---

## Recommendations Priority Matrix

### Immediate (Before Next Deployment)

1. **SMR-001**: Fix OTLP `insecure=True` — use TLS in production
2. **SMR-002**: Add `max_tokens` upper bound (e.g., `le=32_768`)
3. **SMR-004**: Sanitize error messages before storing in Redis/returning to clients
4. **SMR-005**: Add startup warning/refusal when auth disabled in non-debug mode
5. **SMR-011**: Cap `max_retries` (e.g., `le=10`)

### Short-Term (Next Sprint)

6. **SMR-003**: Validate `provider` field against known providers (enum or allowlist)
7. **SMR-006**: Add task ownership validation
8. **SMR-007**: Default guardrails to `block` mode for production
9. **SMR-008**: Restrict CORS methods and headers
10. **SMR-010**: Restrict `/metrics` endpoint access
11. **SMR-014**: Add SSE stream timeout

### Medium-Term (Next Quarter)

12. **SMR-009**: Enforce Redis TLS in production
13. **SMR-017**: Add security headers middleware
14. **SMR-019**: Disable docs in production
15. **SMR-020**: Layer semantic prompt injection detection
16. **SMR-021**: Add request body size limits and validate `context` dict

### Low Priority

17. **SMR-013**: Fix circuit breaker state race condition
18. **SMR-015**: Limit `.env` traversal depth
19. **SMR-016**: Validate `json_schema` size
20. **SMR-018**: Warn on dummy API key usage

---

## Next Steps

- [ ] Address all **Critical** and **High** findings before production deployment
- [ ] Integrate `pip-audit` into CI pipeline for continuous dependency scanning
- [ ] Schedule penetration testing focused on prompt injection and LLM abuse scenarios
- [ ] Review this report after remediation and verify all fixes with updated tests
- [ ] Consider a follow-up audit of the SSE streaming path under load (concurrency + memory profiling)

---

*End of Security Audit Report*
