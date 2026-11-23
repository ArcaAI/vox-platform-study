# Text (Text Generation) Service - API Documentation

## Service Overview

**Path**: `apps/text/src/text/`
**Entry Point**: `text/main.py` → `create_app()` → `app = create_app()`
**Port**: 8864 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- **Multi-provider LLM generation** (OpenAI, Anthropic, Azure OpenAI, Bedrock, Vertex, vLLM, Ollama, LM Studio, llama.cpp, OpenAI-compatible)
- **Streaming SSE generation** with resumable tails (cursor-based replay)
- **Provider health probing** (parallel, connection-aware)
- **External guardrail integration** (input + output screening via `apps/guardrail`)
- **Translation** (Sarvam)
- **Embeddings** (tei-embed)
- **Judge/internal evaluation lane** (separate from public `/generate`)
- **Task management** (idempotency, cancellation, status polling)
- **Resumable streaming** (sequence-number cursors, cross-process replay)

### Provider Architecture

| Provider | Type | Key Features |
|----------|------|--------------|
| **OpenAI** | Cloud | OpenAI API |
| **Anthropic** | Cloud | Anthropic API |
| **Azure OpenAI** | Cloud | Azure OpenAI Service |
| **Bedrock** | Cloud | AWS Bedrock |
| **Vertex** | Cloud | GCP Vertex AI |
| **vLLM** | Local/Cloud | OpenAI-compatible, high-throughput |
| **Ollama** | Local | Local models via Ollama |
| **LM Studio** | Local | Local models via LM Studio (first-class adapter) |
| **llama.cpp** | Local | GGUF models |
| **OpenAI Compat** | Local/Cloud | Generic OpenAI-wire (TGI, Groq, etc.) |

### Key Architectural Patterns
- **Lazy provider registration** — factories registered at boot, instances built on first request
- **Per-provider companion state** — rate limiter, queue, circuit breaker, semaphore (floors at boot, lifted by control plane)
- **Degrade-away-from-unhealthy** — pool health tracker reroutes from failing providers
- **Resumable SSE** — sequence-number cursors, cross-process replay via Redis streams
- **External guardrail** — input validation + output screening via `apps/guardrail` (degrade-safe, fail-closed)
- **Internal judge lane** — separate `/judge` endpoint, isolated budget/semaphores

### Infrastructure Dependencies
| Dependency | Purpose | Client |
|------------|---------|--------|
| Redis | Task state, streaming buffers, idempotency cache, config invalidation | redis.asyncio |
| API Gateway | Config resolution, service registration, auth, tenant injection, provider connections | httpx |
| `guardrail` service | Content screening (input + output) | ExternalGuardrailClient |
| PostgreSQL | Not directly used (stateless) | — |

---

## API Endpoints Summary

### Health (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed component health (always 200) |
| GET | `/health/live` | `liveness()` | K8s liveness probe |
| GET | `/health/ready` | `readiness()` | K8s readiness (Redis + ≥1 healthy provider) |
| GET | `/health/startup` | `startup()` | K8s startup probe |

### Generation (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/generate` | `generate()` | Blocking or SSE generation |
| GET | `/api/v1/generations/{id}/stream` | `stream_generation_events()` | Resume stream (204 if unknown) |
| GET | `/api/v1/tasks/{id}/stream` | `stream_task()` | Legacy stream (404 if unknown) |

### Task Management (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/tasks/{id}` | `get_task()` | Task status |
| POST | `/api/v1/tasks/{id}/cancel` | `cancel_task()` | Cancel running task |
| POST | `/api/v1/generations/{id}/cancel` | `cancel_generation()` | Cancel running generation |

### Providers (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/providers` | `list_providers()` | List + probe all providers |
| POST | `/api/v1/providers/probe` | `probe_providers()` | Connection-aware probe (gateway-resolved) |

### Other (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/judge` | `judge()` | Internal evaluation lane |
| POST | `/api/v1/translate` | `translate()` | Sarvam translation |
| POST | `/api/v1/embeddings` | `embeddings()` | tei-embed embeddings |

---

## Detailed API Documentation

### 1. Text Generation - POST /api/v1/generate

**File**: `text/api/endpoints/generate.py:417`
**Handler**: `generate(request_body, fastapi_request, ...) -> GenerateResponse | EventSourceResponse`

**Request Model** (`GenerateRequest`):
- `prompt`: string (required)
- `model`: string (required — no default)
- `provider`: string (required — e.g., "openai", "anthropic", "azure-openai")
- `stream`: boolean (default false)
- `system_prompt`: optional string
- `max_tokens`: optional int
- `temperature`: optional float
- `fallback_provider`: optional string
- `provider_overrides`: optional dict (gateway-injected BYOK credentials)
- `guardrail_policy`: optional tenant policy
- `retry_config`: max_retries, retry_on error types

**Response Modes**:
- **Blocking** (`stream=false`): Returns `GenerateResponse` with content, usage, stats
- **SSE** (`stream=true`): Returns `EventSourceResponse` with `chunk` events + terminal `done`/`error`

**Implementation Chain**:
```
generate() [generate.py:417]
  → resolve_pool_route() [services/pool_router.py] — degrade-away-from-unhealthy
  → Idempotency check: Redis GET text:idem:{key}
  → _apply_guardrail_gate() [generate.py:171]
    → ExternalGuardrailClient.validate() [services/external_guardrail.py]
      → POST to guardrail /guard/llm
      → Returns verdict + guardrail_usage
  → Rate limiter check: RateLimitTracker.can_proceed()
  → Queue: ProviderQueue.enqueue() [services/provider_queue.py]
  → Circuit breaker: CircuitBreaker.allow_request() [services/circuit_breaker.py]
  → ProviderRegistry.get(provider) → LLMProvider
  → TaskManager.create_task() [services/task_manager.py]
  → If streaming:
    → GenerationHub.start() [routing/hub.py]
      → run_generation_producer() [routing/streaming.py]
        → Producer.attach() [routing/hub.py]
        → provider.generate() [provider-specific]
    → If blocking:
      → Semaphore acquire (ResizableSemaphore)
      → Retry loop with backoff (services/retry_handler.py)
        → provider.generate() [provider-specific]
      → gate_completion() [services/output_gate.py] — post-receive guardrail
      → build_usage_detail() [routing/usage.py]
      → TaskManager.update_task(COMPLETED)
      → Redis SET text:idem:{key} (TTL 24h)
  → Metrics: GENERATION_TOTAL, LATENCY, TOKENS, STOP_REASON, MODEL_INFERENCE
  → Audit: GenerationAuditEvent [services/generation_audit.py]
```

**Data Integration**:
- **Redis**: Idempotency cache, streaming buffers (Redis Streams), task state, config invalidation pub/sub
- **Provider Registry**: Lazy-loaded provider instances (OpenAI, Anthropic, etc.)
- **Rate Limiters/Queues/Circuit Breakers**: Per-provider, control-plane refreshed
- **External Guardrail**: HTTP client → `apps/guardrail` /guard/llm
- **Usage Ledger**: Gateway records billing (this service returns `usage_detail`)

**Key Features**:
- **Idempotency**: `Idempotency-Key` header → cached response (24h TTL)
- **Degrade Routing**: Pool health tracker reroutes from unhealthy providers
- **Guardrail**: Input gate (before generation) + Output gate (after, before cache)
- **Retries**: Configurable max_retries, retry_on types, exponential backoff + Retry-After
- **Concurrency**: ResizableSemaphore per provider (control-plane resized)
- **Cancellation**: TaskManager.request_cancel() + in-memory event

---

### 2. Streaming - GET /api/v1/generations/{id}/stream

**File**: `text/api/endpoints/stream.py:377`
**Handler**: `stream_generation_events(generation_id, request, ...) -> EventSourceResponse`

**Implementation Chain**:
```
stream_generation_events() [stream.py:377]
  → _subscribe() [stream.py:322]
    → parse_cursor() — Last-Event-ID or ?from= query
    → _known() — check TaskManager + stream buffer
    → If unknown: return 204 (no content)
    → resolve_generation_policy() — maxGenerationSeconds ceiling
    → stream_generation() [stream.py:243]
      → If producer in hub: attach subscriber, replay ring + backlog, tail
      → Else: _replay_then_tail() [stream.py:118]
        → TaskManager.read_events_blocking() — XREAD from Redis
        → dedupe_by_seq() — merge backlog + ring, filter by cursor
        → Yield SSE frames with sequence ids
        → Stop at terminal frame or deadline
```

**Data Integration**:
- **Redis Streams**: Durable event buffer (`text:events:{generation_id}`)
- **GenerationHub**: In-memory producer registry + ring buffers
- **TaskManager**: Task state + event persistence
- **Trace Context**: W3C `traceresponse` header injected

**Cursor Semantics**: `Last-Event-ID: {gen_id}:{seq}` or `?from={seq}`

---

### 3. Providers - GET/POST /api/v1/providers

**File**: `text/api/endpoints/providers.py`

**GET /providers** — `list_providers()`:
- Probes all registered providers in parallel (5s timeout)
- Returns `ProviderInfo` with `probe_status` (ok/timeout/error/skipped)

**POST /providers/probe** — `probe_providers(body: ProviderProbeRequest)`:
- Gateway-resolved connections per provider (`ProbeConnection`)
- Connection-aware enumeration (tenant sees their LM Studio/Ollama)
- POST because body carries credential material

**Implementation Chain**:
```
list_providers() / probe_providers() [providers.py:162,171]
  → _probe_all() [providers.py:139]
    → _probe() [providers.py:75]
      → registry.get(name) → LLMProvider
      → If connection + ConnectionAwareProbe: discover_models(connection)
      → Else: provider.get_info() (process memo _last_base_url)
      → pool_health_tracker.record() — feeds degrade routing
      → Returns ProviderInfo + probe_status + pool_health + in_flight
```

---

### 4. Task Management

**File**: `text/api/endpoints/tasks.py`

| Endpoint | Handler | Description |
|--------|---------|-------------|
| GET `/tasks/{id}` | `get_task()` | Task status + content + usage |
| POST `/tasks/{id}/cancel` | `cancel_task()` | Cancel task |
| POST `/generations/{id}/cancel` | `cancel_generation()` | Cancel generation |

**Implementation Chain**:
```
cancel_task() [tasks.py:55]
  → _cancel() [tasks.py:23]
    → TaskManager.request_cancel() — persists flag to Redis
    → GenerationHub.get() → Producer.request_cancel() — in-memory event
    → TaskManager.cancel_task() — marks CANCELLED
```

---

### 5. Health Endpoints

**File**: `text/api/endpoints/health.py`

| Endpoint | Handler | Logic |
|----------|---------|-------|
| `/health` | `health_check()` | Redis + all provider health checks (always 200) |
| `/health/live` | `liveness()` | Always 200 |
| `/health/ready` | `readiness()` | Redis + ≥1 healthy provider |
| `/health/startup` | `startup()` | Checks `service_release_task` attribute |

**Readiness Logic**:
- Redis must be healthy
- At least one provider must pass `health_check()`

---

### 6. Judge / Internal Lane

**File**: `text/api/endpoints/judge.py` (not read but referenced)

**Purpose**: Internal evaluation lane for `apps/guardrail` — separate from public `/generate`
- Separate semaphores/circuit breakers (`judge_semaphores`, `judge_circuit_breakers`)
- Guardrail asserts `assert_not_in_judge_scope()` to prevent cycles

---

## Provider Implementation Files

| File | Purpose |
|------|---------|
| `text/providers/openai.py` | OpenAI API |
| `text/providers/anthropic.py` | Anthropic API |
| `text/providers/azure_openai.py` | Azure OpenAI |
| `text/providers/bedrock.py` | AWS Bedrock |
| `text/providers/vertex.py` | GCP Vertex AI |
| `text/providers/vllm.py` | vLLM |
| `text/providers/ollama.py` | Ollama |
| `text/providers/lmstudio.py` | LM Studio (first-class) |
| `text/providers/llama_cpp.py` | llama.cpp |
| `text/providers/openai_compat.py` | Generic OpenAI-wire |
| `text/providers/base.py` | LLMProvider protocol, ProviderRegistry |
| `text/providers/embedding.py` | EmbeddingProviderRegistry (tei-embed) |
| `text/translation/sarvam.py` | Sarvam translation |

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `text/main.py` | FastAPI app factory, lifespan, provider registration |
| `text/api/endpoints/generate.py` | Main generation endpoint (blocking + SSE) |
| `text/api/endpoints/stream.py` | SSE resume/replay |
| `text/api/endpoints/tasks.py` | Task status + cancellation |
| `text/api/endpoints/providers.py` | Provider listing + probing |
| `text/api/endpoints/health.py` | Health probes |
| `text/services/task_manager.py` | Redis-backed task state + event streams |
| `text/services/provider_queue.py` | Priority queue with per-lane budgets |
| `text/services/rate_limiter.py` | Token-bucket rate limiting (RPM/TPM) |
| `text/services/circuit_breaker.py` | Circuit breaker per provider |
| `text/services/resizable_semaphore.py` | Dynamic concurrency control |
| `text/services/pool_router.py` | Degrade-away-from-unhealthy routing |
| `text/services/pool_health.py` | Provider health tracker (cache + probe) |
| `text/services/retry_handler.py` | Retry classification + backoff |
| `text/services/shutdown_manager.py` | Graceful drain on shutdown |
| `text/services/external_guardrail.py` | Guardrail HTTP client |
| `text/services/output_gate.py` | Post-receive guardrail screening |
| `text/services/generation_audit.py` | Audit logging |
| `text/routing/hub.py` | GenerationHub (producers, subscribers) |
| `text/routing/streaming.py` | Producer implementation |
| `text/routing/usage.py` | Usage detail building |
| `text/core/effective_config.py` | Control plane config client |
| `text/core/dependencies.py` | FastAPI dependency providers |
| `text/core/runtime_defaults.py` | Safety floors (RPM/TPM/queue/timeout) |

---

## Configuration (Control Plane)

| Key | Description | Floor |
|-----|-------------|-------|
| `text.provider.{name}.rpm` | Requests/minute | 60 |
| `text.provider.{name}.tpm` | Tokens/minute | 10000 |
| `text.provider.{name}.maxConcurrent` | Max concurrent | 10 |
| `text.provider.{name}.queueMaxSize` | Queue size | 100 |
| `text.provider.{name}.queueMaxWaitS` | Queue wait | 30s |
| `text.provider.{name}.timeoutS` | Request timeout | 120s |
| `text.provider.{name}.failureThreshold` | CB failures | 5 |
| `text.provider.{name}.recoveryTimeoutS` | CB recovery | 30s |
| `text.lane.{name}.queueMaxWaitS` | Lane queue wait | 30s |
| `text.guardrailPosture` | `enforcing`/`permissive`/`disabled` | — |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `text-generate.html` — Blocking generation with guardrail, retries, idempotency
- `text-streaming.html` — SSE generation + resumable tail
- `text-providers-probe.html` — Parallel provider health probing
- `text-guardrail-gate.html` — Input + output guardrail gates
- `text-task-cancel.html` — Task cancellation (persisted flag + in-memory)
- `text-health-probes.html` — Health/readiness/startup probes