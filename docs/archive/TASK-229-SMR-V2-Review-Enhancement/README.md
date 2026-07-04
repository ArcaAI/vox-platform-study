# TASK-229: SMR V2 Deep Review & Enhancement Plan

- **Ticket Number**: TASK-229
- **Created Date**: 2026-02-28
- **Last Updated**: 2026-03-01
- **Status**: In Progress

---

## 1. Requirement Analysis

### Objective
Perform a comprehensive code review, security scan, and refactoring analysis of the `apps/smr/` (SMR V2 — LLM Gateway Service) against:
- Core business requirements documented in `knowledge/`
- Latest FastAPI AI inference service best practices (2026)
- Production-readiness standards for a healthcare AI platform (HOPE)

### Service Role (Corrected Understanding)

SMR V2 is an **LLM Gateway / Router** — it does NOT perform prompt assembly, specialty routing, SOAP formatting, or any medical domain logic. Its single responsibility is:

1. Receive a fully-formed message request from the `api` app (NestJS API Gateway)
2. Route it to the correct LLM provider based on the request's `provider` field
3. Return the LLM response (sync or streamed) back to the caller

All prompt construction, specialty routing, DNA writing style, two-stage pipeline logic, and consultation context management live **upstream** in the `api` app. SMR V2 is a thin, provider-agnostic forwarding layer.

**Supported providers (current):** Azure OpenAI, AWS Bedrock, Ollama
**Planned providers (future):** LM Studio, any OpenAI-compatible inference server

### Scope
| Dimension | Coverage |
|-----------|----------|
| Folder structure | Monorepo alignment, separation of concerns for a gateway service |
| Code quality | Readability, type safety, Pydantic usage, async patterns |
| Performance | Connection pooling, streaming, concurrency, blocking I/O |
| Logging & monitoring | Structured logging, OpenTelemetry, Prometheus, GenAI semantics |
| Security | OWASP, input validation, secret management, CORS, inter-service auth |

---

## 2. Current State Evaluation

### 2.1 Architecture Overview

SMR V2 is a FastAPI-based LLM gateway that abstracts multiple inference providers behind a unified API:

```
                    ┌─────────────┐
                    │  api (Nest)  │  ← prompt assembly, specialty routing,
                    │  upstream    │    SOAP format, DNA style, context
                    └──────┬──────┘
                           │ HTTP (fully-formed request)
                           ▼
                    ┌─────────────┐
                    │  SMR V2     │  ← THIS SERVICE: route & forward
                    │  (FastAPI)  │
                    └──┬───┬───┬──┘
                       │   │   │
              ┌────────┘   │   └────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Azure   │ │  AWS     │ │  Ollama  │
        │  OpenAI  │ │  Bedrock │ │  / Local │
        └──────────┘ └──────────┘ └──────────┘
```

```
apps/smr/
├── src/smr_v2/
│   ├── main.py              # App entry point, lifespan, router registration
│   ├── api/
│   │   ├── endpoints/       # generate, health, providers, stream, tasks
│   │   └── middleware/       # Empty — no middleware implemented
│   ├── core/                # config, defaults, dependencies, logging
│   ├── models/              # Pydantic models (requests, responses, stream, task, provider)
│   ├── providers/           # base protocol, azure_openai, bedrock, ollama
│   ├── services/            # circuit_breaker, rate_limiter, retry_handler, provider_queue, task_manager, shutdown_manager
│   └── tests/               # unit (23 files), integration (empty)
├── pyproject.toml
├── Dockerfile
├── .env
└── README.md
```

### 2.2 Technology Stack

| Component | Version | Status |
|-----------|---------|--------|
| Python | 3.11+ | OK |
| FastAPI | >=0.133.0 | OK |
| Pydantic | >=2.12.5 | OK (v2) |
| structlog | >=25.5.0 | OK |
| Redis | >=5.2.0 | OK |
| httpx | >=0.28.1 | OK |
| openai SDK | >=2.24.0 | OK |
| boto3 | >=1.42.0 | OK |
| Prometheus | >=0.24.1 | OK |
| uv | Package manager | OK |

### 2.3 Business Alignment Assessment

Given SMR V2's role as an LLM Gateway (not a summarization engine), the alignment is evaluated against gateway responsibilities:

| Gateway Requirement | Implementation Status | Gap |
|-----------------------|----------------------|-----|
| Multi-LLM support (Azure OpenAI, Ollama, Bedrock) | Implemented | None |
| Provider-based routing from request | Implemented | None |
| Sync generation | Implemented | None |
| SSE streaming | Implemented | None |
| Async task processing (Redis-backed) | Implemented | None |
| Extensible provider interface (Protocol) | Implemented | None |
| LM Studio / OpenAI-compatible provider | NOT implemented | **MEDIUM** — future, but no generic OpenAI-compatible adapter exists |
| Latency SLO enforcement (<2s target) | NOT implemented | **MEDIUM** — no per-request timeout or SLO tracking |
| WebSocket support | Declared in response but NOT implemented | **LOW** — `ws_url` in response is misleading |
| Inter-service authentication | NOT implemented | **HIGH** — no auth between api→smr |
| Rate limiting integration | Service exists but NOT wired to endpoints | **HIGH** |
| Circuit breaker integration | Service exists but NOT wired to providers | **HIGH** |
| Provider health monitoring | Basic health check exists | **MEDIUM** — no continuous monitoring or failover |

**Note:** Prompt templates, specialty routing, SOAP/narrative formatting, DNA writing style, consultation context, and prompt versioning are **out of scope** for this service — they belong to the upstream `api` app.

---

## 3. Deep Analysis & Findings

### 3.1 Folder Structure Analysis

#### Strengths
- Clean separation: `api/`, `core/`, `models/`, `providers/`, `services/`
- Proper `src/` layout with `pyproject.toml`
- Tests colocated under `src/smr_v2/tests/`
- Good use of `__init__.py` for package boundaries

#### Issues Found

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| S-1 | Empty middleware directory | Medium | `api/middleware/__init__.py` is empty — no request middleware exists |
| S-2 | No `exceptions/` module | Medium | Custom exceptions are scattered (only `ProviderNotFoundError` in `providers/base.py`) |
| S-3 | No `utils/` module | Low | Token estimation lives in `rate_limiter.py` instead of a shared utility |
| S-4 | Empty integration tests | High | `tests/integration/` contains only `__init__.py` |
| S-5 | Tests inside `src/` package | Low | Tests are inside the distributable package; convention prefers top-level `tests/` |
| S-6 | No `routers.py` aggregation | Low | Router imports are scattered in `main.py` |
| S-7 | Missing `py.typed` marker | Low | Declared in `pyproject.toml` but not created |
| S-8 | No generic provider adapter | Medium | No OpenAI-compatible adapter for LM Studio or other inference servers |

#### Recommended Structure Enhancement

For an LLM gateway service, the structure should focus on provider abstraction, resilience, and observability — not domain logic:

```
apps/smr/
├── src/smr_v2/
│   ├── main.py
│   ├── api/
│   │   ├── endpoints/
│   │   ├── middleware/          # Inter-service auth, request-id, timing, rate-limit
│   │   └── routers.py          # Centralized router aggregation
│   ├── core/
│   │   ├── config.py
│   │   ├── defaults.py
│   │   ├── dependencies.py
│   │   ├── logging.py
│   │   ├── exceptions.py       # NEW: Centralized exception hierarchy
│   │   ├── metrics.py          # NEW: Prometheus + GenAI metrics
│   │   └── telemetry.py        # NEW: OpenTelemetry setup
│   ├── models/
│   ├── providers/
│   │   ├── base.py
│   │   ├── azure_openai.py
│   │   ├── bedrock.py
│   │   ├── ollama.py
│   │   └── openai_compat.py    # NEW: Generic OpenAI-compatible adapter (LM Studio, vLLM, etc.)
│   ├── services/
│   └── utils/                   # NEW: Shared utilities
│       └── tokens.py
├── tests/                       # MOVED: Outside src/
│   ├── unit/
│   ├── integration/
│   └── conftest.py
```

---

### 3.2 Code Quality, Readability & Performance

#### 3.2.1 Strengths

1. **Pydantic V2 usage** — All models use `BaseModel` with proper validators, `Field` constraints, and `model_dump()`/`model_dump_json()`
2. **Type hints** — Consistent use of `from __future__ import annotations`, proper return types
3. **Protocol-based provider interface** — `LLMProvider` uses `Protocol` with `@runtime_checkable`
4. **Async-first** — FastAPI endpoints are async, httpx for async HTTP, `asyncio.to_thread()` for boto3
5. **Lifespan management** — Proper `@asynccontextmanager` for resource lifecycle
6. **Structured config** — `pydantic-settings` with env prefix isolation per provider

#### 3.2.2 Issues Found

| # | Issue | Severity | File | Detail |
|---|-------|----------|------|--------|
| CQ-1 | `generate` return type mismatch | High | `providers/base.py` | Protocol declares `generate() -> str` but all implementations return `tuple[str, dict]`. The Protocol is lying about the contract. |
| CQ-2 | `__contains__` anti-pattern | Medium | `main.py:53-61` | `registry.list_providers().__contains__("ollama")` — should use `"ollama" in registry.list_providers()` |
| CQ-3 | Bare `except Exception` swallowing | High | `main.py:79`, `health.py`, all providers | Exceptions are caught and silently ignored or converted to booleans, losing diagnostic info |
| CQ-4 | No response_model on endpoints | High | `generate.py`, `health.py`, `providers.py`, `tasks.py` | Endpoints return raw dicts instead of typed `response_model=` — breaks OpenAPI schema generation |
| CQ-5 | Mixed return types in `generate` | High | `generate.py` | Returns `JSONResponse(status_code=202)` for streaming but raw dict for sync — inconsistent |
| CQ-6 | Missing dependency injection | High | `generate.py`, `health.py`, etc. | All endpoints use `request.app.state.*` directly instead of `Depends()` — the dependency functions in `dependencies.py` are NEVER USED |
| CQ-7 | Unused services | High | `services/` | `CircuitBreaker`, `RateLimitTracker`, `ProviderQueue`, `ShutdownManager`, `RetryHandler` are implemented but NEVER wired into the application |
| CQ-8 | `generate_stream` sync iteration | Medium | `providers/bedrock.py:82-93` | Bedrock streaming iterates synchronously over `response["stream"]` inside an async generator — blocks the event loop |
| CQ-9 | No request size limits | High | `models/requests.py` | `prompt` has `min_length=1` but no `max_length` — unbounded input |
| CQ-10 | No timeout per-request | Medium | `generate.py` | No per-request timeout; relies on httpx global 300s timeout |
| CQ-11 | Task TTL race condition | Medium | `task_manager.py` | `update_task` does GET then SET — not atomic; concurrent updates can lose data |
| CQ-12 | Stream polling interval | Low | `stream.py:29` | `asyncio.sleep(0.1)` is hardcoded — 10 polls/sec per client is aggressive |
| CQ-13 | No graceful error in streaming | Medium | `generate.py:60-65` | `_run_streaming_generation` catches `Exception` but doesn't log it |
| CQ-14 | `generate` endpoint has no `async def` type annotations | Low | `generate.py` | Missing return type annotation |

#### 3.2.3 Performance Concerns

| # | Issue | Impact | Detail |
|---|-------|--------|--------|
| P-1 | Bedrock sync streaming | High | `for event in response["stream"]` blocks the async event loop for the entire stream duration |
| P-2 | No connection reuse for Azure | Medium | Each `AzureOpenAIProvider` creates its own `AsyncAzureOpenAI` client; no shared connection pool |
| P-3 | Redis GET+SET non-atomic | Medium | Task updates are not atomic — use Redis `WATCH`/`MULTI` or Lua scripts |
| P-4 | No request deduplication | Low | Identical prompts generate separate tasks with no caching |
| P-5 | Stream chunk polling | Medium | SSE endpoint polls Redis every 100ms per client — use Redis pub/sub or `XREAD BLOCK` instead |
| P-6 | No concurrent request limits | High | No semaphore or queue limiting concurrent LLM calls per provider |
| P-7 | Token estimation not used | Medium | `estimate_tokens()` exists but is never called — rate limiter is disconnected |

---

### 3.3 Logging & Monitoring Analysis

#### 3.3.1 Strengths

1. **structlog** — Proper structured logging with JSON renderer
2. **Contextual log keys** — Uses event-based keys like `smr_v2.starting`, `smr_v2.provider_registered`
3. **Prometheus** — `prometheus-fastapi-instrumentator` is conditionally enabled
4. **Log level configuration** — Configurable via `SMR_V2_LOG_LEVEL`

#### 3.3.2 Issues Found

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| L-1 | No request-id correlation | Critical | No middleware to inject `X-Request-ID` into log context — impossible to trace requests across services |
| L-2 | No OpenTelemetry integration | High | `otel_enabled` config exists but NO OpenTelemetry code is implemented |
| L-3 | No GenAI semantic conventions | High | Missing standard attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| L-4 | No per-request logging | High | Endpoints don't log request start/completion/failure with provider, model, latency, tokens |
| L-5 | No error classification in logs | Medium | Errors are logged as generic strings — no structured error codes or categories |
| L-6 | No health check metrics | Medium | Health endpoint doesn't emit metrics for provider availability |
| L-7 | No custom Prometheus metrics | Medium | Only auto-instrumented HTTP metrics — no LLM-specific counters (tokens, latency per provider, error rates) |
| L-8 | Missing `structlog.contextvars` usage | Medium | Context vars processor is configured but never used to bind request-scoped context |
| L-9 | No audit logging | High | Healthcare platform requires audit trails — no audit log for generation requests |
| L-10 | No log sampling for high-throughput | Low | All requests logged at same level — no sampling strategy for production |

#### 3.3.3 Recommended Metrics (GenAI Semantic Conventions)

```
# Counters
smr_v2_generation_total{provider, model, status, format}
smr_v2_generation_errors_total{provider, model, error_type}
smr_v2_tokens_total{provider, model, direction=input|output}
smr_v2_streaming_chunks_total{provider, model}

# Histograms
smr_v2_generation_latency_seconds{provider, model, stream}
smr_v2_time_to_first_token_seconds{provider, model}
smr_v2_tokens_per_second{provider, model}

# Gauges
smr_v2_active_generations{provider}
smr_v2_circuit_breaker_state{provider}
smr_v2_rate_limit_remaining{provider, type=rpm|tpm}
smr_v2_queue_depth{provider}
```

---

### 3.4 Security Analysis

#### 3.4.1 Security Findings (Gateway Context)

Since SMR V2 is an internal gateway called by the `api` app (not directly by end users), the security model is **inter-service trust**. However, defense-in-depth still requires hardening at this layer.

| # | Finding | Severity | OWASP | Detail |
|---|---------|----------|-------|--------|
| SEC-1 | No inter-service authentication | Critical | A07:2021 | No auth middleware — any network-reachable client can call all endpoints. Even as an internal service, it should validate requests come from the trusted `api` app (shared secret, mTLS, or service mesh token). |
| SEC-2 | CORS allows all origins | High | A05:2021 | `cors_origins: ["*"]` — for an internal service this is less critical than user-facing, but should be locked to the API gateway origin or disabled entirely (service-to-service calls don't use CORS). |
| SEC-3 | No input size limits | High | A03:2021 | `prompt` field has no `max_length` — a malformed or oversized request from the API gateway (or a compromised caller) can exhaust memory. |
| SEC-4 | No rate limiting on endpoints | High | A04:2021 | `RateLimitTracker` exists but is NOT connected to any endpoint. Even for internal services, rate limiting prevents a runaway upstream from exhausting LLM quotas. |
| SEC-5 | API key in config as plain string | High | A02:2021 | `AzureOpenAIConfig.api_key: str = ""` — no secret management integration (e.g., AWS Secrets Manager, Azure Key Vault, HashiCorp Vault). |
| SEC-6 | No request ID / audit trail | High | A09:2021 | Healthcare compliance requires request traceability. No `X-Request-ID` propagation from the API gateway. |
| SEC-7 | Error details exposed | Medium | A04:2021 | `HTTPException(detail=f"Generation failed: {exc}")` leaks internal error messages including provider stack traces. |
| SEC-8 | `.env` file in project root | Medium | A02:2021 | `.env` exists in repo root — risk of secret leakage if committed. |
| SEC-9 | Redis connection unencrypted | Medium | A02:2021 | `redis://localhost:6379` — no TLS, no auth by default. In production, Redis should use TLS and AUTH. |
| SEC-10 | No response sanitization | Medium | — | LLM responses are passed through unfiltered. While prompt injection defense is the API gateway's responsibility, the gateway should still not blindly trust LLM output (e.g., an LLM could return malicious content). |
| SEC-11 | WebSocket URL declared but not implemented | Low | — | `ws_url` in response suggests WebSocket support that doesn't exist — misleading API surface. |

**Note:** Prompt injection protection, PII/PHI detection, content safety filtering, and RBAC/tenant isolation are the **upstream `api` app's responsibility**, not this gateway service. However, defense-in-depth suggests adding basic payload size limits and response sanitization.

#### 3.4.2 HIPAA/Healthcare Compliance (Gateway Layer)

| Requirement | Status | Gateway Responsibility |
|-------------|--------|----------------------|
| Access controls | Missing | Inter-service auth (shared secret / mTLS) |
| Audit logging | Missing | Log every generation request with request-id, provider, model, token count |
| Encryption in transit | Partial | TLS for Redis; rely on infrastructure for service-to-service TLS |
| Encryption at rest | N/A | Gateway doesn't persist PHI — Redis task data is ephemeral (TTL-based) |
| Request traceability | Missing | Propagate `X-Request-ID` from API gateway through to LLM provider calls |

---

## 4. Implementation Plan

### Phase 1: Security Hardening & Architecture Fixes (Priority: CRITICAL)

| Task | Description | Effort | Files Affected |
|------|-------------|--------|----------------|
| 1.1 | **Inter-service auth middleware** — Validate requests from `api` app via shared secret header (`X-Service-Token`) or mTLS. Reject all unauthenticated calls. | 1.5d | New `api/middleware/auth.py`, `core/config.py`, `main.py` |
| 1.2 | **Request-ID propagation middleware** — Extract `X-Request-ID` from incoming request (set by API gateway), bind to structlog context, propagate to LLM provider calls. Generate UUID if missing. | 1d | New `api/middleware/request_id.py`, `main.py` |
| 1.3 | **Disable or restrict CORS** — Internal service-to-service calls don't need CORS. Either disable entirely or lock to API gateway origin. | 0.25d | `core/config.py`, `main.py` |
| 1.4 | **Input size limits** — Add `max_length` on `prompt` (e.g., 100K chars) and `system_prompt` (e.g., 50K chars) in request model. | 0.25d | `models/requests.py` |
| 1.5 | **Sanitize error responses** — Replace `f"Generation failed: {exc}"` with generic error codes. Log full details server-side only. | 0.5d | `api/endpoints/generate.py`, new `core/exceptions.py` |
| 1.6 | **Secret management** — Replace plain-string `api_key` config with support for env-var references to secret stores (document pattern for Vault/AWS SM integration). | 0.5d | `core/config.py`, provider configs |
| 1.7 | **Fix Protocol contract** — Change `LLMProvider.generate()` return type from `-> str` to `-> tuple[str, dict]` to match all implementations. | 0.25d | `providers/base.py` |
| 1.8 | **Wire dependency injection** — Replace all `request.app.state.*` access with proper `Depends()` calls using the existing (but unused) functions in `dependencies.py`. | 1d | All endpoints, `core/dependencies.py` |
| 1.9 | **Remove misleading `ws_url`** — Remove WebSocket URL from `StreamingGenerateResponse` until WebSocket is actually implemented. | 0.25d | `models/responses.py`, `api/endpoints/generate.py` |

### Phase 2: Observability & Monitoring (Priority: HIGH)

| Task | Description | Effort | Files Affected |
|------|-------------|--------|----------------|
| 2.1 | **OpenTelemetry tracing** — Implement the already-configured `otel_enabled` flag. Add `FastAPIInstrumentor`, create spans for each provider call with GenAI semantic attributes. | 2d | New `core/telemetry.py`, `main.py`, all providers |
| 2.2 | **GenAI semantic conventions** — Add standardized span attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.operation.name`. | 0.5d | All providers |
| 2.3 | **Custom Prometheus metrics** — Add LLM-specific counters/histograms: `smr_v2_generation_total`, `smr_v2_generation_latency_seconds`, `smr_v2_tokens_total`, `smr_v2_generation_errors_total`, `smr_v2_active_generations`, `smr_v2_circuit_breaker_state`. | 1d | New `core/metrics.py`, endpoints, providers |
| 2.4 | **Per-request structured logging** — Log request start (provider, model), completion (latency, tokens), and failure (error type) using structlog with bound request-id context. | 1d | New `api/middleware/logging.py`, endpoints |
| 2.5 | **Audit logging** — Emit structured audit events for every generation request: `{request_id, provider, model, token_count, latency_ms, status, timestamp}`. Required for healthcare compliance. | 0.5d | Endpoints, `core/logging.py` |
| 2.6 | **Health check metrics** — Emit Prometheus gauge for each provider's health status. Add liveness vs. readiness distinction. | 0.5d | `api/endpoints/health.py`, `core/metrics.py` |

### Phase 3: Wire Existing Services (Priority: HIGH)

All six services below are fully implemented but **never connected** to the application. This phase wires them in.

| Task | Description | Effort | Files Affected |
|------|-------------|--------|----------------|
| 3.1 | **Wire `CircuitBreaker`** — Wrap each provider's `generate()` and `generate_stream()` calls with circuit breaker checks. Open circuit on repeated failures, half-open for recovery probing. | 1d | Providers, `core/dependencies.py`, `main.py` |
| 3.2 | **Wire `RateLimitTracker`** — Check rate limits before forwarding to provider. Use `estimate_tokens()` for TPM tracking. Return 429 with `Retry-After` header when limited. | 1d | New `api/middleware/rate_limit.py`, `core/dependencies.py` |
| 3.3 | **Wire `RetryHandler`** — Implement retry loop in generate endpoint using `calculate_backoff()` and `should_retry()`. Respect `retry_config` from request model. | 1d | `api/endpoints/generate.py` |
| 3.4 | **Wire `ShutdownManager`** — Register/complete tasks during generation. Use `wait_for_shutdown()` in lifespan teardown to drain active requests. | 0.5d | `main.py`, `api/endpoints/generate.py` |
| 3.5 | **Wire `ProviderQueue`** — Enqueue requests when provider is rate-limited or at capacity. Dequeue and process when capacity frees up. | 1d | `api/endpoints/generate.py`, providers |
| 3.6 | **Per-request timeout** — Wrap provider calls with `asyncio.wait_for(timeout=request_timeout)`. Make timeout configurable per provider. | 0.5d | `api/endpoints/generate.py`, `core/config.py` |

### Phase 4: Performance Fixes (Priority: MEDIUM)

| Task | Description | Effort | Files Affected |
|------|-------------|--------|----------------|
| 4.1 | **Fix Bedrock sync streaming** — The `for event in response["stream"]` loop blocks the event loop. Wrap iteration in `asyncio.to_thread()` or use an async queue to bridge sync→async. | 1d | `providers/bedrock.py` |
| 4.2 | **Atomic Redis task updates** — Replace GET+SET in `update_task()` with a Lua script or `WATCH`/`MULTI` pipeline to prevent race conditions on concurrent updates. | 1d | `services/task_manager.py` |
| 4.3 | **Replace stream polling with `XREAD BLOCK`** — Current SSE endpoint polls Redis every 100ms. Use `XREAD BLOCK` to wait for new chunks efficiently, reducing CPU and latency. | 1d | `api/endpoints/stream.py`, `services/task_manager.py` |
| 4.4 | **Concurrent request semaphore** — Add `asyncio.Semaphore` per provider (configured via `max_concurrent`) to prevent overwhelming LLM backends. | 0.5d | Providers, `core/config.py` |

### Phase 5: Code Quality & Testing (Priority: MEDIUM)

| Task | Description | Effort | Files Affected |
|------|-------------|--------|----------------|
| 5.1 | **Add `response_model` to all endpoints** — Define typed response models for OpenAPI schema accuracy. | 1d | All endpoints |
| 5.2 | **Centralized exception hierarchy** — Create `core/exceptions.py` with `ProviderError`, `RateLimitError`, `TimeoutError`, `CircuitOpenError`, etc. Map to HTTP status codes. | 0.5d | New `core/exceptions.py`, endpoints |
| 5.3 | **Integration tests** — Test against real Redis (testcontainers), mock LLM providers, full request lifecycle including streaming. | 2d | `tests/integration/` |
| 5.4 | **Fix code smells** — `__contains__` anti-pattern, bare `except Exception`, missing return type annotations, inconsistent response types (JSONResponse vs dict). | 0.5d | `main.py`, `generate.py`, providers |
| 5.5 | **Add `py.typed` marker** — Create the file declared in `pyproject.toml`. | 0.1d | `src/smr_v2/py.typed` |
| 5.6 | **Generic OpenAI-compatible provider** — Add an adapter for any OpenAI-compatible server (LM Studio, vLLM, text-generation-inference) using the openai SDK with custom `base_url`. | 1.5d | New `providers/openai_compat.py`, `core/config.py` |

---

## 5. Priority Matrix

```
                        HIGH IMPACT
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
    │  Phase 1 (Security)   │                       │
    │  Phase 2 (Observ.)    │  Phase 5 (Quality)    │
    │  Phase 3 (Wire svcs)  │                       │
    │                       │                       │
HIGH├───────────────────────┼───────────────────────┤LOW
URG │                       │                       │URG
    │  Phase 4 (Perf)       │                       │
    │                       │                       │
    │                       │                       │
    └───────────────────────┼───────────────────────┘
                            │
                        LOW IMPACT
```

### Recommended Execution Order

1. **Phase 1** — Security hardening (CRITICAL — blocks production deployment)
2. **Phase 2** — Observability (HIGH — needed before production to debug issues)
3. **Phase 3** — Wire existing services (HIGH — 6 fully-built services sitting unused)
4. **Phase 4** — Performance fixes (MEDIUM — event loop blocking, Redis atomicity)
5. **Phase 5** — Code quality & extensibility (MEDIUM — testing, OpenAI-compat adapter)

### Estimated Total Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Security & Architecture | ~5.5 days |
| Phase 2: Observability & Monitoring | ~5.5 days |
| Phase 3: Wire Existing Services | ~5 days |
| Phase 4: Performance Fixes | ~3.5 days |
| Phase 5: Code Quality & Testing | ~5.6 days |
| **Total** | **~25.1 days** |

---

## 6. Key Insights Summary

### What's Done Well
1. **Correct architectural boundary** — SMR V2 is a focused LLM gateway that doesn't leak domain logic; prompt assembly and medical context stay in the API gateway where they belong
2. **Modern Python stack** — Python 3.11+, Pydantic V2, structlog, httpx, uv — all current best-practice choices
3. **Protocol-based provider interface** — `LLMProvider` Protocol enables clean multi-provider abstraction with runtime checking
4. **Comprehensive unit test suite** — 23 test files covering providers, services, models, and edge cases
5. **Production-grade Dockerfile** — Multi-stage build, non-root user, uv-based dependency resolution, slim image
6. **Thoughtful service layer design** — Circuit breaker, rate limiter, retry handler, provider queue, shutdown manager, and task manager are all well-implemented

### Critical Gaps (Corrected for Gateway Role)
1. **No inter-service authentication** — Any network-reachable client can call the gateway. Needs shared-secret or mTLS validation from the API gateway.
2. **Six services are orphaned** — CircuitBreaker, RateLimitTracker, ProviderQueue, RetryHandler, ShutdownManager, and the token estimator are all fully implemented but **never wired** into the request flow. The generate endpoint calls providers directly with zero resilience.
3. **Observability is half-built** — Config flags exist for OpenTelemetry (`otel_enabled`) but zero implementation code. No request-ID correlation, no GenAI semantic metrics, no per-request logging, no audit trail.
4. **Protocol contract is broken** — `LLMProvider.generate()` declares `-> str` but all three implementations return `tuple[str, dict]`. The dependency injection functions in `dependencies.py` are defined but never called.
5. **Bedrock blocks the event loop** — Streaming iteration is synchronous inside an async generator, blocking all concurrent requests during stream consumption.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Unauthorized access (no inter-service auth) | High | Critical | Phase 1.1 |
| LLM quota exhaustion (no rate limiting wired) | High | High | Phase 3.2 |
| Cascade failure (no circuit breaker wired) | Medium | High | Phase 3.1 |
| Event loop blocking (Bedrock streaming) | High | Medium | Phase 4.1 |
| Compliance failure (no audit trail) | High | Critical | Phase 2.5 |
| Production debugging impossible (no request-id) | High | High | Phase 1.2 |
| Data race (non-atomic Redis updates) | Medium | Medium | Phase 4.2 |

---

## 7. LLM Security Guardrails — Deep Research & Recommendations

### 7.1 Current State: Zero Guardrails

**No LLM security guardrails exist anywhere in the HOPE platform:**
- No prompt injection detection or prevention
- No PII/PHI filtering on LLM inputs or outputs (only SDK logger redaction for log entries)
- No content safety filtering or moderation
- No guardrail libraries installed (`llm-guard`, `presidio`, `nemo-guardrails`, etc.)
- No provider-native guardrails enabled (Azure Content Safety, Bedrock Guardrails)
- No audit logging of LLM interactions for compliance

The only related measure is PHI field redaction in `packages/agentic-sdk-v2/src/core/logger/SDKLogger.ts` — which only affects log output, not the LLM data path.

### 7.2 OWASP Top 10 for LLM Applications (2025/2026) — Relevance to HOPE

| Rank | Vulnerability | Relevance | Current Protection |
|------|--------------|-----------|-------------------|
| **LLM01** | **Prompt Injection** | **CRITICAL** — transcripts could contain adversarial text | None |
| **LLM02** | **Sensitive Information Disclosure** | **CRITICAL** — PHI in prompts and responses | None |
| **LLM05** | **Improper Output Handling** | **HIGH** — unvalidated LLM responses returned to clinicians | None |
| **LLM07** | **System Prompt Leakage** | **HIGH** — prompts transit through SMR gateway | None |
| **LLM10** | **Unbounded Consumption** | **HIGH** — no token/request limits per provider | None |

### 7.3 Attack Taxonomy for HOPE

#### Prompt Injection Vectors

| Attack Type | Vector in HOPE | Risk |
|-------------|---------------|------|
| **Direct injection** | Malicious text in user-submitted notes or corrections | High |
| **Indirect injection** | Adversarial phrases spoken during recorded consultations, embedded in transcripts | Critical |
| **Encoding obfuscation** | Base64/hex/unicode-encoded instructions in transcript metadata | Medium |
| **Special token injection** | `<\|im_start\|>system`, `[INST]` delimiters in input | Medium |
| **Jailbreaking** | Multi-turn escalation via consultation context | Medium |

#### PHI Leakage Vectors

| Vector | Description | Risk |
|--------|-------------|------|
| **Input leakage** | Patient PHI sent to cloud LLM providers without masking | Critical |
| **Output hallucination** | LLM fabricates PHI not in the source transcript | High |
| **Cross-contamination** | LLM references PHI from other patients (via context window pollution) | Medium |
| **System prompt extraction** | Attacker extracts prompt templates containing PHI patterns | Medium |

### 7.4 Tool Comparison Matrix

| Tool | Prompt Injection | PII/PHI | Content Safety | Self-Hosted | Day-1 Ease | Latency | Cost | HIPAA-Safe |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **LLM Guard** (Protect AI) | Yes | Yes | Yes | Yes | High | 50-500ms CPU | Free (OSS) | Yes |
| **Microsoft Presidio** | No | **Best** | No | Yes | High | ~100ms | Free (OSS) | Yes |
| **Presidio + Stanford AIMI** | No | **Best for clinical** | No | Yes | Medium | ~150ms | Free (OSS) | Yes |
| **OpenAI Moderation API** | No | No | **Best** | SaaS | Very High | ~50ms | **Free** | No* |
| **AWS Bedrock Guardrails** | Yes | Yes | Yes | Managed | Very High | 100-300ms | $0.15/1K units | Via BAA |
| **Azure AI Content Safety** | No | No | Yes | SaaS | High | 100-200ms | ~$1/1K records | Via BAA |
| **NeMo Guardrails** (NVIDIA) | Yes | No | Yes | Yes | **Low** | **1-2s** (extra LLM calls) | Free + LLM costs | Yes |
| **Guardrails AI** | Yes | Yes | Yes | Hybrid | Medium | 100-650ms | Free core | Partial |
| **Lakera Guard** | **Best** | Yes | Yes | SaaS only | Very High | 50-150ms | Free 10K/mo | **No** (SaaS) |
| **Custom Regex** | Partial | No | No | Yes | Very High | **~1ms** | Free | Yes |

*OpenAI Moderation sends data to OpenAI — not suitable for raw PHI. Use only on already-anonymized text.

### 7.5 Provider-Native Guardrails (Already Available, Not Enabled)

#### AWS Bedrock Guardrails — Best Day-1 Value

HOPE already uses Bedrock. Enabling guardrails requires **configuration only, no code changes**:

| Feature | What It Does | Action |
|---------|-------------|--------|
| Content filters | 6 harm categories with severity levels | Configure thresholds |
| Denied topics | Block specific topics (e.g., prescribing, diagnosing) | Define topic list |
| PII detection | Detect and mask 30+ PII entity types | Enable with ANONYMIZE action |
| Prompt attack detection | Detect injection and jailbreak attempts | Enable |
| Contextual grounding | Verify output is grounded in source material | Enable |

**Integration:** Attach `guardrailIdentifier` and `guardrailVersion` to existing `converse()` / `converse_stream()` calls in `providers/bedrock.py`.

#### Azure OpenAI Content Safety — Already Active (Default)

Azure OpenAI has **default content filtering enabled** on all deployments:
- Blocks medium/high severity: violence, hate, sexual, self-harm
- **Healthcare caveat:** Default thresholds may block legitimate clinical language (surgical procedures, trauma descriptions). Custom severity thresholds should be configured.
- Additional features to enable: jailbreak detection, groundedness detection, custom categories

### 7.6 Recommended Day-1 Stack

#### Architecture: Where Guardrails Should Live

```
┌──────────────────────────────────────────────────────────────────┐
│                     NestJS API Gateway (upstream)                 │
│                                                                  │
│  PRE-LLM:                          POST-LLM:                    │
│  • PHI detection + masking          • PHI leak detection         │
│    (Presidio + Stanford AIMI)         in LLM output              │
│  • Input validation                 • Hallucination check        │
│  • Consent verification               vs source transcript       │
│  • Context sanitization             • Medical content flags      │
│                                     • Audit logging              │
└────────────────────┬─────────────────────▲───────────────────────┘
                     │                     │
                     ▼                     │
┌──────────────────────────────────────────────────────────────────┐
│                     SMR V2 (LLM Gateway)                         │
│                                                                  │
│  INPUT GUARDS:                      OUTPUT GUARDS:               │
│  • Regex prompt injection scanner   • System prompt leak detect  │
│  • Encoding detection (base64,      • Credential/API key detect  │
│    hex, unicode)                    • Output size limits          │
│  • Input size limits                • Audit logging               │
│  • Rate limiting                                                 │
│                                                                  │
│  PROVIDER-NATIVE:                                                │
│  • Bedrock → Bedrock Guardrails (content + PII + injection)      │
│  • Azure → Content Safety (content filtering, custom thresholds) │
│  • Ollama → Llama Guard 3 sidecar (content classification)       │
└──────────────────────────────────────────────────────────────────┘
```

**Why this split:**
- **API Gateway** has semantic context — it knows which parts are system instructions vs. patient data vs. user input. Best place for PHI masking and context sanitization.
- **SMR Gateway** is the last checkpoint before the LLM — best place for structural defenses (regex, size limits, encoding detection) and output scanning.
- **Provider-native** guardrails are free/cheap and already optimized — activate them as a third layer.

#### Tier 1: Day-1 Implementation (< 2 days, zero new dependencies)

| What | Where | Effort | Latency Added |
|------|-------|--------|---------------|
| **Regex prompt injection scanner** — compiled patterns for instruction override, role hijacking, system prompt extraction, special token injection, data exfiltration, jailbreak personas | SMR Gateway middleware | 0.5d | ~1-2ms |
| **Encoding detection** — base64, hex, unicode escape, HTML entity, LaTeX hidden text | SMR Gateway middleware | Included above | ~1ms |
| **Input/output size limits** — `max_length` on prompt (100K chars), system_prompt (50K chars), response cap (50K chars) | SMR Gateway models + middleware | 0.25d | ~0ms |
| **Output leak scanning** — detect system prompt leakage, credential/API key patterns, password patterns in LLM responses | SMR Gateway middleware | 0.25d | ~1ms |
| **Enable Bedrock Guardrails** — configure guardrail in AWS Console, attach ID to existing `converse()` calls | SMR Gateway `providers/bedrock.py` | 0.5d | 100-300ms (provider-side) |
| **Tune Azure Content Safety thresholds** — adjust severity levels to allow clinical language | Azure Portal configuration | 0.25d | 0ms (already active) |
| **Audit logging** — log every guardrail evaluation (pass/fail/modified) with request-id | SMR Gateway | 0.25d | ~0ms |

**Total Day-1 effort: ~2 days. Total latency added: ~3ms (regex) + provider-native (parallel with LLM call).**

#### Tier 2: Week-1 Enhancement (2-3 days, adds Presidio)

| What | Where | Effort | Latency Added |
|------|-------|--------|---------------|
| **Microsoft Presidio** with Stanford AIMI clinical model — PHI detection/masking for medical text (97.9% F1 on radiology reports) | API Gateway (pre-LLM) + SMR Gateway (output scanning) | 2d | ~100-150ms |
| **Typoglycemia detection** — catch scrambled-word variants of injection keywords | SMR Gateway middleware | 0.25d | ~2ms |
| **Llama Guard 3 sidecar** — content safety classifier for Ollama-routed requests (runs as a separate Ollama model) | SMR Gateway, Ollama provider | 0.5d | ~200-500ms |

**Dependencies to add:**
```toml
# In apps/smr/pyproject.toml
presidio-analyzer = ">=2.2"
presidio-anonymizer = ">=2.2"
# Plus: python -m spacy download en_core_web_sm
# Plus: pip install transformers torch  (for Stanford AIMI model)
```

#### Tier 3: Month-1 Enhancement (3-5 days, adds ML-based detection)

| What | Where | Effort |
|------|-------|--------|
| **LLM Guard** — comprehensive ML-based scanner suite replacing ad-hoc Presidio + regex with unified pipeline | SMR Gateway | 2d |
| **Bedrock contextual grounding** — verify SOAP notes are grounded in source transcript | Bedrock provider config | 0.5d |
| **Red team testing** — test all defenses against known attack suites (OWASP, Crescendo, BoN) | Both layers | 2d |

### 7.7 Healthcare-Specific Considerations

#### HIPAA Compliance for LLM Guardrails

| Requirement | Implementation |
|-------------|---------------|
| **Minimum Necessary PHI** | Presidio pre-LLM masking — strip PHI not needed for summarization |
| **BAA Coverage** | Azure (via DPA), AWS (via BAA) — both cover LLM processing. Ollama is self-hosted (no BAA needed). |
| **Audit Trail** | Log every guardrail evaluation: `{request_id, timestamp, guardrail_type, action, entities_detected, provider, model}` |
| **6-Year Retention** | Configure log storage with HIPAA-compliant retention |
| **Breach Notification** | Alert on PHI leak detection in LLM output (60-day notification window) |

#### 2026 Regulatory Pressure

- AI-related HIPAA enforcement rose **340% in 2025**
- $12.5M settlement established that standard BAAs don't adequately address AI-related data risks
- OCR preparing **"AI-HIPAA Rule"** for Q1 2026 with mandatory AI impact assessments
- EU AI Act classifies medical AI as **high-risk** — full conformity deadline August 2, 2026

### 7.8 Cost Projection (Monthly)

| Tool | 10K req/mo | 100K req/mo | 1M req/mo |
|------|-----------|------------|----------|
| Custom regex scanner | $0 | $0 | $0 |
| Microsoft Presidio | $0 (self-hosted) | $0 | $0 |
| OpenAI Moderation* | $0 | $0 | $0 |
| Bedrock Guardrails | ~$3 | ~$30 | ~$300 |
| LLM Guard | $0 (self-hosted) | $0 | $0 (compute only) |
| Azure Content Safety | ~$10 | ~$100 | ~$1,000 |

*Only for non-PHI text. Do not send raw patient data to OpenAI Moderation API.

### 7.9 Updated Phase 1 — Security (Revised with Guardrails)

Adding guardrail tasks to the existing Phase 1:

| Task | Description | Effort |
|------|-------------|--------|
| 1.10 | **Regex prompt injection scanner middleware** — compiled patterns for input scanning + output leak detection | 0.5d |
| 1.11 | **Enable Bedrock Guardrails** — configure in AWS Console, attach to `converse()` calls | 0.5d |
| 1.12 | **Tune Azure Content Safety** — adjust thresholds for clinical language | 0.25d |
| 1.13 | **Guardrail audit logging** — log every scan result with request-id | 0.25d |

**Revised Phase 1 total: ~7 days** (was ~5.5 days)

### 7.10 Key Insight: Defense-in-Depth, Not Perfection

> **No defense is complete.** Prompt injection is fundamentally unsolved. Best-of-N attacks with power-law scaling mean a sufficiently motivated attacker will eventually bypass filters. The goal is to raise the cost of attack, detect attempts, and limit blast radius — not achieve perfection.

The recommended approach layers:
1. **Cheap/fast structural defenses** (regex, size limits) — catch 60-70% of naive attacks at ~1ms
2. **Provider-native guardrails** (Bedrock, Azure) — catch another 20-25% at provider cost, zero added latency
3. **Self-hosted ML classifiers** (LLM Guard, Presidio) — catch obfuscated attacks at 50-200ms
4. **Output scanning** — even if injection succeeds, prevent actual harm (credential leakage, PHI exfiltration)
5. **Audit logging** — forensic capability for incident response and compliance

---

## 8. Inter-Service Communication: API ↔ SMR V2

### 8.1 Current State — What Exists Today

#### Pattern 1: HTTP Proxy (SmrController → SMR:8862)

The `SmrController` extends `BaseProxyController` and forwards requests to SMR:8862 via `http-proxy-middleware`.

**Confirmed: NestJS guards, interceptors, and middleware DO execute before the proxy.**

The full request pipeline for a proxied SMR request (e.g., `POST /api/v1/text/api/v2/generate` with `@Authorize()`):

| Order | Layer | Component | What It Does |
|-------|-------|-----------|-------------|
| 1 | Express middleware | Highlight.io | Observability capture |
| 2 | Express middleware | Session | Session management |
| 3 | Express middleware | Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy` |
| 4 | Express middleware | CORS | Origin validation |
| 5 | NestJS interceptor | **ContextInterceptor** | Sets `requestId` (UUIDv7), `correlationId` (CLS), `tenantId` (from `X-Tenant-Id`), logs request start/completion with duration |
| 6 | NestJS interceptor | **ExceptionInterceptor** | Catches and transforms exceptions, formats errors |
| 7 | NestJS interceptor | **MaintenanceInterceptor** | Returns 503 if maintenance mode enabled |
| 8 | NestJS interceptor | **ImpersonationAuditInterceptor** | Emits audit events for impersonated requests |
| 9 | NestJS guard | **UnifiedAuthGuard** (via `@Authorize()`) | Validates JWT or API Key, builds CASL ability, sets CLS context (`user`, `tenantId`, `ability`) |
| 10 | Controller | `SmrController.generate()` | Calls `proxyRequest()` |
| 11 | Proxy | `BaseProxyController.proxyRequest()` | Generates `x-request-id`, logs start/completion/failure with duration, forwards via `http-proxy-middleware` |

**Verdict: The proxy approach is sound.** Auth, observability, maintenance mode, and audit all execute before the request reaches the proxy. The `BaseProxyController` additionally:
- Generates and attaches `x-request-id` header to the proxied request
- Logs request start, completion, and failure with duration
- Handles network errors gracefully (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.)
- Returns structured 502 error when SMR is unavailable

**Minor issue:** The `x-request-id` is generated by `BaseProxyController` using `Math.random().toString(36)` instead of reusing the `requestId` (UUIDv7) already set by `ContextInterceptor`. These should be unified.

#### Pattern 2: Direct Axios HTTP (Application Services → SMR)

`SummaryService` and `ChainSummaryService` make direct `axios.post()` calls. These currently target `SMR_SERVICE_URL` (default `http://localhost:5006`) using v1 API endpoints.

**Decision: Migrate to SMR:8862 (v2 API).** All direct Axios callers should use `SMR_URL` (port 8862) and the v2 API contract. This unifies the port and API version.

| Caller | Current Endpoint | Target Endpoint |
|--------|-----------------|-----------------|
| `SummaryService` | `POST :5006/api/v1/summary/sync` | `POST :8862/api/v2/generate` |
| `ChainSummaryService` | `POST :5006/api/v1/summary/sync` | `POST :8862/api/v2/generate` |

#### Pattern 3: BullMQ Job Processors (Async Summarization)

This is the **primary production pattern** for summarization. Four BullMQ processors handle async generation:

| Processor | Queue | Current Endpoint | Timeout | Retries |
|-----------|-------|-----------------|---------|---------|
| `SummaryProcessor` | `GenerateSummary` | `POST :5006/api/v1/summary/sync` | 120s | 3 (exponential, 1s base) |
| `PreSummaryProcessor` | `GeneratePreSummary` | `POST :5006/api/v1/presummary/sync` | 120s | 3 (exponential, 1s base) |
| `ComprehensiveSummaryProcessor` | `GenerateComprehensiveSummary` | `POST :5006/api/v1/summary/sync` | 180s | 2 (exponential, 2s base) |
| `DnaWritingStyleProcessor` | `GenerateDnaReport` | `POST :5006/api/v2/generate` | 120s | 3 (default) |

**What's already working well:**

| Feature | Status | Detail |
|---------|--------|--------|
| Job queuing | Implemented | Dedicated BullMQ queues per job type (4 queues) |
| Retry with backoff | Implemented | 2-3 attempts, exponential backoff (1-2s base) |
| Progress tracking | Implemented | Multi-step progress (10% → 30% → 70% → 100%) via `notifyProgress()` |
| Real-time SSE delivery | Implemented | Redis Pub/Sub → `RedisSubscriberService` → NestJS `@Sse` endpoint |
| Job status storage | Implemented | Redis with 24h TTL (`consultation_job:{jobId}`) |
| Job cancellation | Implemented | Remove from queue if waiting/delayed, update status |
| Auto-pipeline | Implemented | `ConsultationEventHandler` chains: Transcription → Summary → NER |
| Prompt resolution | Implemented | `PromptResolutionService` resolves department/specialty templates |
| Context gathering | Implemented | Fetches transcripts, case notes, NER entities from DB |
| Result persistence | Implemented | Saves to `ContextItem` via `ContextItemFactory` + `ContextItemRepository` |
| Comprehensive cross-chain | Implemented | Aggregates content across linked consultations |

**This pattern provides high availability and stable summarization** because:
1. BullMQ persists jobs in Redis — survives API restarts
2. Failed jobs retry automatically with exponential backoff
3. Multiple API instances can process from the same queue (horizontal scaling)
4. Job progress is decoupled from the HTTP request lifecycle
5. Clients reconnect to SSE and get current status immediately (terminal state check)

### 8.2 Issues Found (Revised)

| # | Issue | Severity | Detail |
|---|-------|----------|--------|
| IC-1 | **Dual-port / dual-API-version** | High | Proxy uses `:8862` (v2), processors use `:5006` (v1). `SMR_SERVICE_URL` has no `.env` definition. All should unify on `:8862` (v2). |
| IC-2 | **Request-ID not unified** | Medium | `ContextInterceptor` generates UUIDv7 `requestId`, but `BaseProxyController` generates a separate `Math.random()` ID. The proxy should reuse the interceptor's ID. |
| IC-3 | **No inter-service auth on processor calls** | High | Proxied requests go through `@Authorize()` (client auth), but BullMQ processors call SMR directly via Axios with no auth headers. SMR has no way to verify these calls are legitimate. |
| IC-4 | **No request-ID propagation from processors** | Medium | BullMQ processors don't attach `x-request-id` or `correlationId` to their Axios calls to SMR. |
| IC-5 | **No circuit breaker on API side** | High | If SMR is down, all processors hang until timeout (120-180s). BullMQ retries help, but there's no fast-fail mechanism. |
| IC-6 | **SSE proxy doesn't support resume** | Medium | If the proxied SSE connection drops, no `Last-Event-ID` handling. However, the BullMQ SSE path (Pattern 3) handles reconnection correctly — it checks terminal state and emits current status on connect. |
| IC-7 | **No TTFT tracking** | Medium | No measurement of time-to-first-token for streaming responses. |
| IC-8 | **Processor error messages leak internals** | Low | `throw new Error('Failed to generate summary from AI service')` — generic but the caught error is logged with full detail, which is correct. |

### 8.3 Evaluation: Pattern 3 (BullMQ + Job Processors) — Strengths & Gaps

#### Architecture Assessment

```
Client
  │
  ├── POST /api/v1/consultations/:id/summary/async
  │       │
  │       ▼
  │   SummaryController → ConsultationJobService.createSummaryJob()
  │       │
  │       ├── 1. Generate jobId (UUIDv7)
  │       ├── 2. Add to BullMQ queue (GenerateSummary)
  │       ├── 3. Store initial status in Redis (PENDING)
  │       └── 4. Return { jobId, sseUrl } immediately (202 Accepted)
  │
  ├── GET /api/v1/consultations/jobs/:jobId/sse  (subscribe to updates)
  │       │
  │       ▼
  │   ConsultationJobController → @Sse → ConsultationJobService.subscribeToJobUpdates()
  │       │
  │       ├── Check current status (if terminal → emit + complete)
  │       ├── Emit current status immediately
  │       └── Subscribe to Redis Pub/Sub channel: consultation_job_updates:{jobId}
  │
  │   Meanwhile, in the BullMQ worker:
  │
  │   SummaryProcessor.process(job)
  │       ├── 10% — Gather context (transcripts, case notes)
  │       ├── 30% — Call SMR service (HTTP POST)
  │       ├── 70% — Save results (ContextItem to DB)
  │       └── 100% — Complete (notify via Redis Pub/Sub)
  │
  │   Each step: notifyProgress() → Redis SET + Redis PUBLISH → SSE to client
  │
  └── Client receives real-time updates via SSE:
      { status: "RUNNING", progress: 10, currentStep: "Gathering context" }
      { status: "RUNNING", progress: 30, currentStep: "Generating summary with AI" }
      { status: "RUNNING", progress: 70, currentStep: "Saving results" }
      { status: "COMPLETED", progress: 100, result: { contextItemId, content, summaryMeta } }
```

#### What Makes This Pattern Production-Grade

| Capability | Implementation | Quality |
|-----------|---------------|---------|
| **Job persistence** | BullMQ stores jobs in Redis | Jobs survive API restarts |
| **Automatic retry** | 2-3 attempts, exponential backoff | Handles transient SMR failures |
| **Horizontal scaling** | Multiple API instances consume from same queue | Scales with load |
| **Progress tracking** | Multi-step progress via Redis Pub/Sub | Real-time UX |
| **SSE reconnection** | Checks terminal state on connect, emits current status | Handles network drops |
| **Job cancellation** | Remove from queue or update status | User control |
| **Auto-pipeline** | EventEmitter2 chains Transcription → Summary → NER | Automated workflow |
| **Prompt resolution** | `PromptResolutionService` resolves department templates | Specialty-aware |
| **Result persistence** | `ContextItemFactory` + repository pattern | Domain-driven |
| **Cleanup** | `removeOnComplete: 1h`, `removeOnFail: 24h` | Prevents Redis bloat |

#### Gaps to Address

| # | Gap | Severity | Recommendation |
|---|-----|----------|----------------|
| G-1 | **No inter-service auth** on processor→SMR calls | High | Add `X-Service-Token` header to all `callSmrService()` methods |
| G-2 | **No request-ID/correlationId** propagated to SMR | Medium | Pass `jobId` or `correlationId` from job payload as `X-Request-ID` header |
| G-3 | **No circuit breaker** — processors hang 120-180s on SMR failure | High | Add a shared `SmrClient` service with circuit breaker wrapping Axios calls |
| G-4 | **No rate limiting** on processor→SMR calls | Medium | Add BullMQ rate limiter per queue to prevent overwhelming SMR during burst |
| G-5 | **No dead letter queue** | Medium | Move permanently failed jobs (all retries exhausted) to a DLQ for investigation |
| G-6 | **No idempotency** | Low | If a job is retried, it may create duplicate `ContextItem` records. Add idempotency key check. |
| G-7 | **No priority levels** | Low | All jobs have equal priority. Urgent (user-initiated) vs. batch (auto-pipeline) should be differentiated. |
| G-8 | **Port migration needed** | High | All processors use `:5006` (v1 API). Migrate to `:8862` (v2 API). |
| G-9 | **No metrics** on job processing | Medium | Add Prometheus counters: jobs created/completed/failed, processing time histogram, queue depth gauge |

### 8.4 Best Practices — Recommended Enhancements

#### 8.4.1 Unified SMR Client Service

Create a shared `SmrClientService` in `packages/applications/` that all callers use instead of raw Axios:

```
SmrClientService
├── Wraps HttpService (Axios)
├── Uses SMR_URL (:8862) — single config
├── Attaches X-Request-ID, X-Service-Token headers automatically
├── Circuit breaker (open after 5 failures, half-open after 30s)
├── Configurable timeout per call
├── Structured logging (request start, completion, failure with latency)
├── Prometheus metrics (latency histogram, error counter)
└── Used by: all processors, SummaryService, ChainSummaryService
```

#### 8.4.2 HTTP Proxy (Pattern 1) — Keep As-Is with Minor Fixes

The proxy pattern is **correct for its purpose** — it's a transparent gateway for client-initiated v2 API calls. The NestJS pipeline (auth, observability, maintenance) executes before the proxy. Fixes needed:

| Fix | Detail | Effort |
|-----|--------|--------|
| Unify request-ID | Reuse `ContextInterceptor`'s UUIDv7 `requestId` instead of generating a new one in `BaseProxyController` | 0.25d |
| Add `X-Service-Token` | Inject shared secret header in `proxyReq` callback | 0.25d |

#### 8.4.3 SSE Streaming — Two Paths, Both Valid

| Path | Use Case | Status |
|------|----------|--------|
| **Proxied SSE** (Pattern 1) | Client directly streams from SMR v2 task | Works, but no resume support |
| **BullMQ SSE** (Pattern 3) | Client subscribes to job progress | Works well, has reconnection handling |

For day-1, both paths are acceptable. The BullMQ SSE path is more robust (reconnection, terminal state check). Long-term, consider Redis Streams for the proxied SSE path to add resume support.

#### 8.4.4 WebSocket — Not Needed for Day-1

SSE covers the primary use case (server→client streaming). WebSocket adds complexity without clear benefit for unidirectional token streaming. Add later only if bidirectional communication is needed.

#### 8.4.5 BullMQ (Pattern 3) — Enhancement Priorities

| Priority | Enhancement | Effort |
|----------|------------|--------|
| P0 | Migrate all processors to `:8862` (v2 API) | 1d |
| P0 | Add `X-Service-Token` + `X-Request-ID` to all `callSmrService()` | 0.5d |
| P1 | Create shared `SmrClientService` with circuit breaker | 1.5d |
| P1 | Add BullMQ rate limiter per queue | 0.5d |
| P2 | Add dead letter queue for permanently failed jobs | 0.5d |
| P2 | Add job priority (urgent vs. batch) | 0.5d |
| P2 | Add idempotency check to prevent duplicate ContextItems on retry | 0.5d |
| P3 | Add Prometheus metrics for job processing | 0.5d |

### 8.5 Implementation Tasks (Revised)

| Task | Description | Effort | Phase |
|------|-------------|--------|-------|
| IC-1 | **Unify SMR port** — migrate all processors from `:5006` (v1) to `:8862` (v2). Define `SMR_URL` in all `.env` files. Remove `SMR_SERVICE_URL`. | 1d | Phase 1 |
| IC-2 | **Unify request-ID** — reuse `ContextInterceptor`'s UUIDv7 in `BaseProxyController` instead of `Math.random()`. Propagate `correlationId` from BullMQ job data to SMR calls. | 0.5d | Phase 1 |
| IC-3 | **Add X-Service-Token** — inject shared secret in proxy `proxyReq` callback and all processor `callSmrService()` methods. Validate in SMR middleware. | 0.5d | Phase 1 |
| IC-4 | **Create SmrClientService** — shared Axios wrapper with circuit breaker, auto-headers, logging, metrics. Replace raw `httpService.axiosRef.post()` in all processors and services. | 1.5d | Phase 3 |
| IC-5 | **BullMQ rate limiter** — add per-queue rate limiting to prevent overwhelming SMR during burst. | 0.5d | Phase 3 |
| IC-6 | **Dead letter queue** — configure BullMQ to move permanently failed jobs to DLQ. | 0.5d | Phase 5 |
| IC-7 | **TTFT tracking** — measure time-to-first-token for proxied SSE streams, emit as Prometheus histogram. | 0.5d | Phase 2 |
| IC-8 | **Job processing metrics** — Prometheus counters for jobs created/completed/failed, processing time histogram, queue depth gauge. | 0.5d | Phase 2 |

### 8.6 Quick Wins (Can Do Immediately)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | Define `SMR_URL=http://localhost:8862` in all `.env` files, update processors to use it | 30min | Eliminates dual-port confusion |
| 2 | Add `X-Request-ID` header (from `jobId`) to all processor `callSmrService()` calls | 30min | Cross-service log correlation |
| 3 | Add `X-Service-Token` header to proxy `proxyReq` callback + all processor calls | 1hr | Basic inter-service auth |
| 4 | Unify `BaseProxyController` request-ID with `ContextInterceptor` UUIDv7 | 15min | Single consistent request-ID |

---

## Change History

| # | Date | Description |
|---|------|-------------|
| 1 | 2026-02-28 | Initial deep review and enhancement plan created |
| 2 | 2026-02-28 | **Major revision**: Corrected service role understanding — SMR V2 is an LLM Gateway/Router, not a summarization engine. Removed Phase 5 (business logic). Recalibrated security findings for inter-service context. Reduced total effort from ~42.6 days to ~25.1 days. |
| 3 | 2026-02-28 | **Added Section 7**: LLM Security Guardrails deep research. Confirmed zero guardrails exist in HOPE. Added tool comparison (8 tools), attack taxonomy, healthcare-specific requirements, provider-native guardrail activation plan, and 3-tier implementation roadmap. Added tasks 1.10-1.13 to Phase 1. |
| 4 | 2026-02-28 | **Revised Section 8**: Confirmed HTTP proxy (Pattern 1) correctly executes NestJS guards/interceptors (auth, observability, maintenance, audit) before forwarding. Proxy approach is sound — keep as-is with minor fixes (unified request-ID, service token). Confirmed Pattern 2 should migrate to :8862 (v2 API). Deep evaluation of Pattern 3 (BullMQ + processors): confirmed production-grade with job persistence, retry, progress tracking, SSE reconnection, auto-pipeline, and horizontal scaling. Identified 9 gaps (no inter-service auth, no circuit breaker, no rate limiting, no DLQ, no idempotency). Revised from 10 tasks to 8 focused tasks. |
|| 5 | 2026-02-28 | **Phase 1, Task 1.6 — SecretStr for sensitive config fields**: Changed `AzureOpenAIConfig.api_key` and `Settings.service_token` from plain `str` to Pydantic `SecretStr`. Updated consumers (`auth.py` middleware, `azure_openai.py` provider) to call `.get_secret_value()`. Secrets are now hidden in `repr()`, `str()`, and `model_dump()` output, preventing accidental logging. 11 new tests in `test_secret_management.py`, 3 existing tests updated in `test_config.py`. Full suite: 422 passed. |
|| 6 | 2026-02-28 | **Phase 1, Task 1.10 — Prompt Injection Guardrails**: Created `PromptInjectionScanner` service (`services/guardrails.py`) with 7 pre-compiled regex patterns detecting system prompt overrides, role hijacking, instruction injection, data exfiltration, jailbreak markers, encoding evasion, and delimiter injection. Risk levels: medium (patterns 1-2), high (patterns 3-5), low (patterns 6-7). Added `scan_output()` for credential leak detection (OpenAI `sk-*`, AWS `AKIA*`, private keys). Added `guardrail_enabled` and `guardrail_mode` ("log"/"block") to `Settings`. Integrated into `/generate` endpoint via `Depends()` — scans prompt + system_prompt, blocks medium/high risk in "block" mode, logs in "log" mode. Added `get_guardrail_scanner` to `dependencies.py`. 17 new tests in `test_guardrails.py` (11 scanner unit tests, 3 output leak tests, 3 endpoint integration tests). Full suite: 439 passed, 0 regressions. |
| 7 | 2026-02-28 | **Phase 1 COMPLETE — All 16 tasks implemented with TDD.** Summary of all changes: **SMR V2 (Python/FastAPI)**: (1.1) `ServiceAuthMiddleware` with `X-Service-Token` validation via `hmac.compare_digest`, exempt paths for health/metrics/docs, dev mode when token empty; (1.2) `RequestIDMiddleware` extracting/generating `X-Request-ID`, binding to structlog contextvars; (1.3) CORS disabled by default (`cors_enabled=False`, `cors_origins=[]`), opt-in for dev; (1.4) `max_length=200_000` on prompt, `50_000` on system_prompt; (1.5) Error sanitization — generic messages to client, full details logged server-side; (1.6) `SecretStr` for `api_key` and `service_token`; (1.7) `LLMProvider.generate()` return type fixed to `tuple[str, dict]`; (1.8) All endpoints wired with `Depends()` instead of `request.app.state`; (1.9) Removed `ws_url` from `StreamingGenerateResponse`; (1.10) `PromptInjectionScanner` with 7 input patterns + 3 output leak patterns, configurable log/block mode; (1.11) Bedrock guardrail config (`guardrail_id`, `guardrail_version`) injected into `converse()` params; (1.12) Azure `content_filter_severity` config, `BadRequestError` handling for content filter blocks; (1.13) `GuardrailAuditLogger` with structured `guardrail.audit` events for HIPAA compliance. **NestJS API Gateway**: (IC-1) Unified `SMR_SERVICE_URL` → `SMR_URL`, port `5006` → `8862` across 6 processors/services + 6 test files; (IC-2) `BaseProxyController` reuses `ContextInterceptor` UUIDv7 `requestId` + adds `x-correlation-id`; (IC-3) `X-Service-Token` injected in proxy `proxyReq` callback + all 6 processor/service HTTP calls, `X-Request-ID` propagated from job IDs. **Test results**: SMR V2: 455 passed (was 360). API: 1391 passed. Zero regressions. |
| 8 | 2026-02-28 | **Phase 2 COMPLETE — All 7 tasks implemented with TDD.** Summary: (2.1) `core/telemetry.py` — OpenTelemetry setup with `TracerProvider`, OTLP gRPC exporter, `FastAPIInstrumentor`, `HTTPXClientInstrumentor`, controlled by `otel_enabled` flag; (2.2) GenAI semantic conventions — all 3 providers (`ollama`, `azure_openai`, `aws_bedrock`) emit spans with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason` on both `generate()` and `generate_stream()`; (2.3) `core/metrics.py` — 6 custom Prometheus metrics: `GENERATION_TOTAL` (Counter), `GENERATION_LATENCY` (Histogram, 11 LLM-tuned buckets), `TOKENS_TOTAL` (Counter, input/output), `GENERATION_ERRORS` (Counter), `ACTIVE_GENERATIONS` (Gauge), `GUARDRAIL_SCANS` (Counter) — all integrated into generate endpoint for sync and streaming paths; (2.4) `RequestLoggingMiddleware` — logs `request.start`, `request.complete` (with status_code, duration_ms), `request.failed` (with error details) for every request; (2.5) `GenerationAuditLogger` — structured `generation.audit` events with request_id, provider, model, tokens, latency, status for HIPAA compliance; (2.6) Health endpoint enhanced — returns `"degraded"` when providers unhealthy, `PROVIDER_HEALTH` gauge + `HEALTH_CHECK_LATENCY` histogram per provider, new `GET /health/live` (liveness) and `GET /health/ready` (readiness) endpoints for k8s, both auth-exempt; (IC-7) `TTFT_SECONDS` histogram — time-to-first-token tracked in streaming generation. IC-8 (BullMQ job metrics) deferred to Phase 3 — requires `prom-client` setup in NestJS API. **New dependencies**: `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-instrumentation-fastapi`, `opentelemetry-instrumentation-httpx`, `opentelemetry-exporter-otlp-proto-grpc`. **Test results**: SMR V2: 514 passed (was 455). API: 1391 passed. Zero regressions. |
| 9 | 2026-02-28 | **Phase 3 COMPLETE — All 6 tasks implemented with TDD (4 parallel agents).** Wired all 6 pre-built services into the application. **Task 3.1 — Wire CircuitBreaker**: Per-provider `CircuitBreaker` instances created in lifespan from `CircuitBreakerConfig` (failure_threshold, recovery_timeout_s). Stored on `app.state.circuit_breakers`. Generate endpoint checks `cb.allow_request()` before provider call — returns 503 with `Retry-After: 30` when circuit is OPEN. Records `cb.record_success()` on success, `cb.record_failure()` on failure. `CIRCUIT_BREAKER_STATE` Prometheus gauge (0=closed, 1=open, 2=half_open) updated on every state change. **Task 3.2 — Wire RateLimitTracker**: Per-provider `RateLimitTracker` instances created in lifespan using each provider config's `rpm_limit`/`tpm_limit` (Ollama gets 0,0 = unlimited). Stored on `app.state.rate_limiters`. Generate endpoint estimates tokens via `estimate_tokens()`, checks `can_proceed()`, returns 429 with `Retry-After` header when exceeded, calls `record_request()` on success. `RATE_LIMIT_REJECTIONS` Prometheus counter incremented on rejection. **Task 3.3 — Wire RetryHandler**: Generate endpoint wraps provider call in retry loop using `calculate_backoff()` and `should_retry()` from `retry_handler.py`. Controlled by `RetryConfig` on `GenerateRequest` (`max_retries`, `retry_on` list). Classifies errors as `"timeout"` or `"provider_error"`, retries only when error type is in `retry_on`. Exponential backoff with jitter between attempts. **Task 3.4 — Wire ShutdownManager**: `ShutdownManager` created in lifespan, stored on `app.state.shutdown_manager`. Generate endpoint rejects new requests with 503 when `is_shutting_down`. Registers tasks on creation, completes on finish (both sync and streaming paths). Lifespan teardown calls `wait_for_shutdown(timeout=30.0)` to drain active tasks. **Task 3.5 — Wire ProviderQueue**: Per-provider `ProviderQueue` instances created in lifespan from `QueueConfig.max_size`. When rate-limited, requests are queued instead of immediately rejected — waits up to `max_wait_s` for capacity. Returns 429 only when queue is full or wait times out. `QUEUE_SIZE` gauge and `QUEUE_WAIT_TIME` histogram track queue behavior. **Task 3.6 — Per-request Timeout**: `_get_provider_timeout(settings, provider_name)` resolves timeout from provider config (ollama=300s, azure=120s, bedrock=120s, default=120s). Every `provider.generate()` wrapped with `asyncio.wait_for(coro, timeout=timeout_s)`. Timeout errors return HTTP 502. Combined with retry: each attempt gets its own timeout deadline. **Files modified**: `api/endpoints/generate.py` (retry+timeout loop, circuit breaker checks, rate limit checks, queue integration, shutdown guard), `main.py` (lifespan creates all 4 service types, teardown drains via ShutdownManager), `core/dependencies.py` (5 new dependency functions), `core/metrics.py` (4 new metrics: CIRCUIT_BREAKER_STATE, RATE_LIMIT_REJECTIONS, QUEUE_SIZE, QUEUE_WAIT_TIME). **New test files**: 4 files with 37 new tests. **Test results**: SMR V2: **551 passed** (was 514). Zero regressions. |
| 10 | 2026-02-28 | **Phase 4 COMPLETE — All 4 performance tasks implemented with TDD (4 parallel agents).** **Task 4.1 — Fix Bedrock sync streaming**: Replaced the event-loop-blocking `for event in response["stream"]` with an async queue bridge. Boto3's synchronous `EventStream` iterator now runs in a thread pool via `loop.run_in_executor()`, pushing events to an `asyncio.Queue` via `call_soon_threadsafe()`. The async generator awaits `queue.get()`, yielding control to the event loop between events. Verified with a concurrent probe test that proves the event loop is no longer blocked. 7 new tests in `test_bedrock_async_stream.py`. Updated 1 existing test in `test_telemetry.py` to work with the new bridge pattern. **Task 4.2 — Atomic Redis task updates**: Replaced the race-prone GET+SET pattern in `TaskManager.update_task()` with a Redis Lua script (`_UPDATE_TASK_LUA`) that atomically reads, merges via `cjson`, and writes back with TTL in a single `EVAL` call. Proven with an interleaving test: old code lost concurrent updates, new code preserves both. 8 new tests in `test_atomic_task_update.py` using `fakeredis[lua]`. Updated 5 existing mock-based tests. **Task 4.3 — Replace stream polling with XREAD BLOCK**: Added `TaskManager.read_chunks_blocking()` using `XREAD BLOCK 5000` instead of `XRANGE` + `asyncio.sleep(0.1)`. SSE endpoint now waits efficiently for new data with zero CPU when idle. Each SSE event includes the Redis stream message ID for proper `Last-Event-ID` resume support. Reduced latency from 100ms polling to near-instant delivery. 11 new tests in `test_xread_streaming.py`. Updated 7 existing tests in `test_stream_endpoint.py` and 2 in `test_dependency_injection.py`/`test_api_edge_cases.py`. **Task 4.4 — Concurrent request semaphore**: Added `asyncio.Semaphore` per provider to prevent overwhelming LLM backends. Added `max_concurrent: int = 10` to `AzureOpenAIConfig` and `BedrockConfig` (Ollama already had `max_concurrent=4`). Semaphores created in lifespan, stored on `app.state.provider_semaphores`. Generate endpoint acquires with 30s timeout, returns 503 if exhausted. `CONCURRENT_REQUESTS` Prometheus gauge tracks active requests per provider. 14 new tests in `test_concurrency_semaphore.py`. **Files modified**: `providers/bedrock.py` (async queue bridge), `services/task_manager.py` (Lua script + `read_chunks_blocking()`), `api/endpoints/stream.py` (XREAD BLOCK), `api/endpoints/generate.py` (semaphore wrapping), `main.py` (semaphore creation in lifespan), `core/config.py` (`max_concurrent` on Azure/Bedrock), `core/dependencies.py` (`get_provider_semaphores()`), `core/metrics.py` (`CONCURRENT_REQUESTS` gauge). **New test files**: 4 files with 40 new tests. **Dependencies added**: `fakeredis[lua]` (test-only). **Test results**: SMR V2: **591 passed** (was 551). Zero regressions. |
| 11 | 2026-02-28 | **Phase 5 COMPLETE — All 6 tasks implemented with TDD (5 parallel agents).** **Task 5.1 — Add response_model to all endpoints**: Added `HealthResponse`, `LivenessResponse`, `ReadinessResponse`, `ErrorResponse` to `models/responses.py`. Added `response_model=` to health (3), tasks (2), providers (1). Generate uses `responses=` dict for OpenAPI. 16 new tests. **Task 5.2 — Centralized exception hierarchy**: 7 new domain exceptions in `core/exceptions.py`. `core/exception_handlers.py` maps exceptions to HTTP status codes with `Retry-After` headers. Refactored `generate.py` from raw `HTTPException` to domain exceptions. 56 new tests. **Task 5.3 — Integration tests**: `tests/integration/` with `MockProvider`, `fakeredis` fixtures, 17 integration tests covering full lifecycle (non-streaming, streaming, task management, health, providers, guardrails, request-ID propagation). **Task 5.4 — Fix code smells**: Replaced `__contains__()` with `in`, bare `except Exception` with specific types + logging in all providers, added return type annotations to all endpoints, `generate()` returns Pydantic model directly. 23 new tests. **Task 5.5 — py.typed marker**: Created `src/smr_v2/py.typed`. **Task 5.6 — Generic OpenAI-compatible provider**: `providers/openai_compat.py` using `AsyncOpenAI` with custom `base_url` for LM Studio/vLLM/TGI/Groq. `OpenAICompatConfig` in `core/config.py`. Supports streaming, JSON formats, OTel spans. 16 new tests. **Test results**: SMR V2: **719 passed** (was 591). Zero regressions. |
