# TASK-023: SMR V2 — Text Generation Service

- **Ticket Number**: TASK-023
- **Created Date**: 2026-02-18
- **Last Updated**: 2026-02-18
- **Status**: Completed

---

## 1. Requirement Analysis

### Business Context

The current SMR (Summarization) service has accumulated significant technical debt from being a medical-domain-specific summarization engine. The business now requires a **general-purpose text generation API** that:

1. Follows **FastAPI best practices** for a production Python service
2. Handles **100+ concurrent users** simultaneously
3. Provides **day-1 OOTB integration** with Ollama (self-hosted), Azure OpenAI, and AWS Bedrock
4. Exposes **simple APIs** for generating text from a prompt with context metadata options (model name, context length, etc.)
5. **Streams results** to end-users via SSE and WebSocket (WebRTC-ready for future)
6. **Tracks progress** of generation tasks with retry/resume capability

### Acceptance Criteria

- [ ] New `src/smr_v2/` package alongside existing `src/smr/`
- [ ] All three providers (Ollama, Azure OpenAI, AWS Bedrock) working with streaming
- [ ] SSE and WebSocket streaming endpoints operational
- [ ] Task tracking with retry/resume via Redis Streams
- [ ] 100+ concurrent user support verified
- [ ] Cloud provider rate limiting handled (proactive gating + queue + reactive recovery)
- [ ] Mid-stream 429 recovery working for Azure and Bedrock
- [ ] Rate limit state exposed via `/api/v2/providers` and Prometheus metrics
- [ ] Clean dependency footprint (~18 packages)
- [ ] Comprehensive test suite including rate-limit simulation
- [ ] Dockerfile and dev scripts updated

---

## 2. Current State Evaluation

### What Exists (apps/smr v1)

| Aspect | Current State | Issue |
|--------|---------------|-------|
| Architecture | Medical-domain monolith (1500+ LoC in summary_service.py) | Over-coupled to medical schemas |
| Concurrency | Blocking `requests` in LangflowService; per-request httpx clients | Cannot handle 100+ users |
| Providers | Single-provider config via env var; no Bedrock | Locks entire service to one provider |
| Dependencies | 40+ packages, 87 dependency lines | Massive attack surface, slow builds |
| Streaming | WebSocket + SSE exist but only for job status updates | Not for token-level LLM streaming |
| Task tracking | Celery + Redis (dual source of truth, bugs in cancel) | Over-engineered, fragile |

### What We Preserve from v1

- Redis pub/sub pattern for real-time updates (channel naming: `job_updates:{job_id}`)
- Pydantic models for request/response validation
- FastAPI router organization pattern
- Prometheus metrics integration
- Health check patterns (liveness, readiness)
- Structured logging approach

---

## 3. Architecture Design

### 3.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        SMR V2 Service                             │
│                                                                    │
│  ┌────────────┐    ┌─────────────────┐    ┌──────────────────┐   │
│  │  API Layer  │───▶│  Task Manager   │───▶│ Provider Registry │   │
│  │ (FastAPI)   │    │ (Redis Streams) │    │                  │   │
│  │             │    │                 │    │ ┌──────────────┐ │   │
│  │ POST /gen   │    │ Create task     │    │ │   Ollama     │ │   │
│  │ GET  /stream│    │ Track progress  │    │ │   Provider   │ │   │
│  │ WS  /ws     │    │ Retry/Resume    │    │ └──────────────┘ │   │
│  │ GET  /tasks │    │ Cancel          │    │ ┌──────────────┐ │   │
│  │ GET  /provs │    │                 │    │ │Azure OpenAI  │ │   │
│  └─────┬───────┘    └────────┬────────┘    │ │  Provider    │ │   │
│        │                     │             │ └──────────────┘ │   │
│        │                     │             │ ┌──────────────┐ │   │
│        │  ┌──────────────┐   │             │ │ AWS Bedrock  │ │   │
│        └─▶│Stream Delivery│◀──┘             │ │  Provider    │ │   │
│           │               │                │ └──────────────┘ │   │
│           │ SSE endpoint  │                └──────────────────┘   │
│           │ WS endpoint   │                                       │
│           │ (WebRTC-ready)│                                       │
│           └───────┬───────┘                                       │
│                   │                                                │
│              Redis Streams                                         │
│           (chunk buffer + state)                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Core Design Principles

1. **Generator-Consumer Decoupling**: The LLM generator writes chunks to Redis Streams. Client-facing endpoints consume from Redis Streams. This means:
   - Generation continues even if the client disconnects
   - Clients can reconnect and resume from where they left off
   - Multiple clients can subscribe to the same generation

2. **Per-Request Provider Selection**: Every request specifies which provider + model to use. All providers are initialized at startup.

3. **Fully Async**: Every I/O operation is non-blocking. Bedrock uses `asyncio.to_thread()` with a shared boto3 client.

4. **Shared Connection Pools**: One `httpx.AsyncClient`, one `AsyncAzureOpenAI` client, one boto3 client — all created at startup, shared across requests.

### 3.3 Task Lifecycle

```
                    POST /api/v2/generate
                           │
                           ▼
                   ┌───────────────┐
                   │   PENDING     │  Task created, stored in Redis
                   └───────┬───────┘
                           │ asyncio.create_task()
                           ▼
                   ┌───────────────┐
                   │   RUNNING     │  LLM streaming chunks → Redis Stream
                   └───────┬───────┘
                          ╱ ╲
                         ╱   ╲
                        ▼     ▼
              ┌──────────┐  ┌──────────┐
              │COMPLETED │  │  FAILED  │
              └──────────┘  └─────┬────┘
                                  │ retry_count < max_retries?
                                  ▼
                          ┌───────────────┐
                          │   RETRYING    │  Exponential backoff
                          └───────┬───────┘
                                  │
                                  ▼
                          ┌───────────────┐
                          │   RUNNING     │  Re-invokes LLM
                          └───────────────┘

Other transitions:
  Any state → CANCELLED (via DELETE /api/v2/tasks/{id})
  FAILED → RESUMING → RUNNING (via POST /api/v2/tasks/{id}/resume)
```

### 3.4 Redis Streams Architecture

```
Stream Key: smr:task:{task_id}:chunks
┌────────────────────────────────────────────────────┐
│ Entry ID │  type       │  content                   │
├──────────┼─────────────┼────────────────────────────┤
│ 1-0      │ meta        │ {provider, model, ...}     │
│ 2-0      │ chunk       │ "The quick brown"          │
│ 3-0      │ chunk       │ " fox jumps over"          │
│ 4-0      │ chunk       │ " the lazy dog."           │
│ 5-0      │ usage       │ {prompt_tokens: 10, ...}   │
│ 6-0      │ done        │ {finish_reason: "stop"}    │
└────────────────────────────────────────────────────┘

Hash Key: smr:task:{task_id}:state
┌──────────────────────────────────────┐
│ status         │ "running"           │
│ provider       │ "ollama"            │
│ model          │ "llama3.2:latest"   │
│ created_at     │ "2026-02-18T..."    │
│ started_at     │ "2026-02-18T..."    │
│ completed_at   │ ""                  │
│ retry_count    │ "0"                 │
│ max_retries    │ "3"                 │
│ error          │ ""                  │
│ total_chunks   │ "4"                 │
│ total_tokens   │ "0"                 │
│ ttl_seconds    │ "3600"              │
└──────────────────────────────────────┘
```

**Why Redis Streams over Pub/Sub:**
- Streams persist data; pub/sub is fire-and-forget
- Consumer groups allow resume from last-read position
- Backpressure handling built-in
- Stream entries have unique IDs for replay

---

## 4. API Design

### 4.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v2/generate` | Start text generation (returns task_id + optional inline stream) |
| `GET` | `/api/v2/tasks/{task_id}/stream` | SSE stream of generation chunks (resumable) |
| `WS` | `/api/v2/ws/tasks/{task_id}` | WebSocket stream of generation chunks (resumable) |
| `GET` | `/api/v2/tasks/{task_id}` | Get task status and result |
| `POST` | `/api/v2/tasks/{task_id}/retry` | Retry a failed task |
| `DELETE` | `/api/v2/tasks/{task_id}` | Cancel a running task |
| `GET` | `/api/v2/tasks` | List tasks (with filtering) |
| `GET` | `/api/v2/providers` | List available providers and their models |
| `GET` | `/api/v2/health` | Health check |
| `GET` | `/api/v2/health/ready` | Readiness probe |
| `GET` | `/api/v2/health/live` | Liveness probe |

### 4.2 Request/Response Schemas

#### `POST /api/v2/generate`

**Request:**
```json
{
  "prompt": "Summarize the following patient conversation...",
  "system_prompt": "You are a clinical documentation assistant.",
  "provider": "ollama",
  "model": "llama3.2:latest",
  "temperature": 0.7,
  "max_tokens": 4096,
  "top_p": 1.0,
  "stream": true,
  "context": {
    "department": "cardiology",
    "language": "en",
    "session_id": "abc-123"
  },
  "retry_config": {
    "max_retries": 3,
    "retry_on": ["timeout", "provider_error"]
  }
}
```

**Response (stream=false):**
```json
{
  "task_id": "01JMXX...",
  "status": "completed",
  "content": "The patient presented with...",
  "provider": "ollama",
  "model": "llama3.2:latest",
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 320,
    "total_tokens": 470
  },
  "latency_ms": 2340,
  "finish_reason": "stop",
  "created_at": "2026-02-18T10:00:00Z"
}
```

**Response (stream=true):**
```json
{
  "task_id": "01JMXX...",
  "status": "running",
  "stream_url": "/api/v2/tasks/01JMXX.../stream",
  "ws_url": "/api/v2/ws/tasks/01JMXX...",
  "created_at": "2026-02-18T10:00:00Z"
}
```

#### SSE Stream (`GET /api/v2/tasks/{task_id}/stream`)

Supports `Last-Event-ID` header for resume:

```
event: meta
id: 1-0
data: {"provider":"ollama","model":"llama3.2:latest","task_id":"01JMXX..."}

event: chunk
id: 2-0
data: {"content":"The quick brown"}

event: chunk
id: 3-0
data: {"content":" fox jumps over"}

event: chunk
id: 4-0
data: {"content":" the lazy dog."}

event: usage
id: 5-0
data: {"prompt_tokens":10,"completion_tokens":12,"total_tokens":22}

event: done
id: 6-0
data: {"finish_reason":"stop","total_chunks":4}

event: heartbeat
data: {"ts":"2026-02-18T10:00:05Z"}
```

#### WebSocket Protocol (`WS /api/v2/ws/tasks/{task_id}`)

**Server → Client messages:**
```json
{"type": "meta", "id": "1-0", "data": {"provider": "ollama", "model": "llama3.2:latest"}}
{"type": "chunk", "id": "2-0", "data": {"content": "The quick brown"}}
{"type": "chunk", "id": "3-0", "data": {"content": " fox jumps over"}}
{"type": "done", "id": "6-0", "data": {"finish_reason": "stop"}}
```

**Client → Server messages:**
```json
{"type": "ping"}
{"type": "resume", "last_id": "3-0"}
```

### 4.3 Provider Listing (`GET /api/v2/providers`)

```json
{
  "providers": [
    {
      "name": "ollama",
      "display_name": "Ollama (Self-Hosted)",
      "status": "available",
      "default_model": "llama3.2:latest",
      "models": ["llama3.2:latest", "mistral:latest", "codellama:latest"],
      "supports_streaming": true,
      "config": {
        "base_url": "http://localhost:11434"
      }
    },
    {
      "name": "azure_openai",
      "display_name": "Azure OpenAI",
      "status": "available",
      "default_model": "gpt-4",
      "models": ["gpt-4", "gpt-4o", "gpt-4o-mini"],
      "supports_streaming": true
    },
    {
      "name": "bedrock",
      "display_name": "AWS Bedrock",
      "status": "available",
      "default_model": "anthropic.claude-3-haiku-20240307-v1:0",
      "models": [
        "anthropic.claude-3-haiku-20240307-v1:0",
        "anthropic.claude-3-sonnet-20240229-v1:0",
        "meta.llama3-1-8b-instruct-v1:0"
      ],
      "supports_streaming": true
    }
  ]
}
```

---

## 5. Implementation Plan

### Phase 0: Project Scaffolding

| # | Task | Description |
|---|------|-------------|
| 0.1 | Create `src/smr_v2/` package structure | Directories: `api/`, `core/`, `providers/`, `services/`, `models/` |
| 0.2 | Create `pyproject.toml` dependencies (v2 section) | ~18 core dependencies |
| 0.3 | Create `core/config.py` | `pydantic-settings` BaseSettings with all provider configs loaded simultaneously |
| 0.4 | Create `main.py` with lifespan | Shared clients in `app.state`, proper CORS, structured logging |
| 0.5 | Dev scripts | `run_dev_v2.sh`, Dockerfile update |

**Target dependencies (~18 packages):**
```
fastapi>=0.115.0
uvicorn[standard]>=0.34.0
pydantic>=2.5.0
pydantic-settings>=2.1.0
httpx>=0.27.0
openai>=1.10.0
boto3>=1.35.0
redis[hiredis]>=5.0.0
sse-starlette>=2.0.0
websockets>=14.0
structlog>=24.0.0
orjson>=3.10.0
prometheus-fastapi-instrumentator>=7.0.0
python-dotenv>=1.0.0
uuid7>=0.1.0
psutil>=5.9.0
```

### Phase 1: Provider Abstraction Layer

| # | Task | Description |
|---|------|-------------|
| 1.1 | Define `LLMProvider` protocol | Abstract interface: `generate()`, `generate_stream()`, `validate()`, `list_models()`, `get_rate_limit_state()` |
| 1.2 | Implement `OllamaProvider` | Uses shared `httpx.AsyncClient`; streaming via NDJSON `/api/chat` |
| 1.3 | Implement `AzureOpenAIProvider` | Uses shared `AsyncAzureOpenAI`; streaming via `stream=True`; parses `x-ratelimit-*` headers |
| 1.4 | Implement `BedrockProvider` | Uses shared boto3 client + `asyncio.to_thread()`; streaming via `converse_stream`; handles `ThrottlingException` |
| 1.5 | Create `ProviderRegistry` | Holds all configured providers; lookup by name; health + rate limit status per provider |
| 1.6 | Implement `RateLimitTracker` | Per-provider adaptive rate limiter with sliding window TPM/RPM tracking |
| 1.7 | Tests for all providers | Unit tests with mocked HTTP responses including 429 scenarios |

**Provider Protocol:**
```python
class LLMProvider(Protocol):
    name: str

    async def generate(
        self, prompt: str, system_prompt: str | None = None, **options
    ) -> GenerationResult: ...

    async def generate_stream(
        self, prompt: str, system_prompt: str | None = None, **options
    ) -> AsyncIterator[StreamChunk]: ...

    async def validate(self) -> bool: ...

    async def list_models(self) -> list[ModelInfo]: ...

    def get_rate_limit_state(self) -> RateLimitState: ...
```

### Phase 2: Task Manager (Redis Streams)

| # | Task | Description |
|---|------|-------------|
| 2.1 | Create `TaskManager` service | Create/track/cancel tasks using Redis Hash + Redis Streams |
| 2.2 | Implement task creation | Generate ULID task_id, store state in Redis Hash, set TTL |
| 2.3 | Implement chunk writing | Write LLM chunks to Redis Stream `smr:task:{id}:chunks` |
| 2.4 | Implement chunk reading | Read from stream with consumer groups; support `last_id` for resume |
| 2.5 | Implement retry logic | Exponential backoff; re-invoke LLM; append new chunks to same stream |
| 2.6 | Implement cancel | Set state to CANCELLED; stop generator via `asyncio.Event` |
| 2.7 | Implement cleanup | TTL-based expiry of task state and streams |
| 2.8 | Tests for TaskManager | Unit + integration tests with real Redis |

**Retry Strategy:**
```
Attempt 1: immediate
Attempt 2: 2s delay
Attempt 3: 4s delay
Attempt 4: 8s delay (if max_retries=3, stops here)

Retryable errors:
  - Provider timeout (408, 504)
  - Provider overloaded (429, 503)
  - Connection errors
  - Bedrock throttling

Non-retryable errors:
  - Bad request (400)
  - Auth failure (401, 403)
  - Model not found (404)
  - Content policy violation (451)
```

### Phase 3: API Layer

| # | Task | Description |
|---|------|-------------|
| 3.1 | `POST /api/v2/generate` | Accept request, create task, start generation, return task_id or inline result |
| 3.2 | `GET /api/v2/tasks/{id}/stream` | SSE endpoint consuming Redis Stream; supports `Last-Event-ID` resume |
| 3.3 | `WS /api/v2/ws/tasks/{id}` | WebSocket endpoint consuming Redis Stream; supports `resume` message |
| 3.4 | `GET /api/v2/tasks/{id}` | Return task state + full content (if completed) |
| 3.5 | `POST /api/v2/tasks/{id}/retry` | Retry a failed task |
| 3.6 | `DELETE /api/v2/tasks/{id}` | Cancel a running task |
| 3.7 | `GET /api/v2/tasks` | List tasks with filtering by status, provider |
| 3.8 | `GET /api/v2/providers` | List providers + available models |
| 3.9 | Health endpoints | `/health`, `/health/ready`, `/health/live` |
| 3.10 | Tests for all endpoints | Unit + integration tests |

### Phase 4: Concurrency, Rate Limiting & Resilience

| # | Task | Description |
|---|------|-------------|
| 4.1 | Connection pooling | `httpx.Limits(max_connections=200)`, boto3 `Config(max_pool_connections=150)` |
| 4.2 | Per-request timeouts | `asyncio.wait_for()` wrapping LLM calls; configurable per provider |
| 4.3 | Circuit breaker | Per-provider circuit breaker (CLOSED → OPEN → HALF_OPEN); 429s count toward open threshold |
| 4.4 | Upstream rate limit tracker | Per-provider sliding-window TPM/RPM tracker with adaptive header parsing (see Section 8.5) |
| 4.5 | Request queue with backpressure | `asyncio.Queue` per provider with priority; holds requests when rate-limited instead of failing |
| 4.6 | Inbound rate limiting | Optional middleware limiting RPS per client API key to protect the service itself |
| 4.7 | Mid-stream 429 recovery | Detect rate-limit errors during streaming; pause + retry stream from partial state |
| 4.8 | Graceful shutdown | Drain active streams before stopping; cancel pending tasks |
| 4.9 | Load test | Verify 100+ concurrent users with k6 or locust; include 429-simulation scenarios |

**Circuit Breaker Config (per provider):**
```python
class CircuitBreakerConfig:
    failure_threshold: int = 5          # failures before OPEN
    recovery_timeout_s: float = 30.0    # time before HALF_OPEN
    half_open_max_calls: int = 3        # test calls in HALF_OPEN
    reset_timeout_s: float = 120.0      # full reset after success
    count_rate_limits: bool = True      # 429s count as failures
```

### Phase 5: Observability

| # | Task | Description |
|---|------|-------------|
| 5.1 | Prometheus metrics | Auto HTTP metrics + custom: `smr_generation_duration_seconds`, `smr_generation_total`, `smr_active_streams`, `smr_provider_errors_total` |
| 5.2 | Structured logging | `structlog` with JSON output, request correlation IDs |
| 5.3 | Request tracing | Optional OpenTelemetry (off by default, enable via `OTEL_ENABLED=true`) |
| 5.4 | Provider health dashboard | `/api/v2/providers` includes real-time status |

---

## 6. Project Structure

```
apps/smr/src/smr_v2/
├── __init__.py
├── main.py                          # FastAPI app, lifespan, middleware
│
├── api/
│   ├── __init__.py
│   ├── router.py                    # Include all routers
│   ├── endpoints/
│   │   ├── __init__.py
│   │   ├── generate.py              # POST /generate
│   │   ├── tasks.py                 # GET/DELETE /tasks/{id}, GET /tasks
│   │   ├── stream.py                # GET /tasks/{id}/stream (SSE)
│   │   ├── websocket.py             # WS /ws/tasks/{id}
│   │   ├── providers.py             # GET /providers
│   │   └── health.py                # Health endpoints
│   └── middleware/
│       ├── __init__.py
│       ├── correlation.py           # Request correlation ID
│       ├── error_handler.py         # Global error handler
│       └── rate_limit.py            # Optional rate limiting
│
├── core/
│   ├── __init__.py
│   ├── config.py                    # pydantic-settings BaseSettings
│   ├── dependencies.py              # FastAPI Depends() using app.state
│   └── logging.py                   # structlog configuration
│
├── models/
│   ├── __init__.py
│   ├── requests.py                  # GenerateRequest, RetryRequest
│   ├── responses.py                 # GenerateResponse, TaskResponse, ProviderResponse
│   ├── task.py                      # TaskState, TaskStatus enum
│   ├── provider.py                  # ProviderInfo, ModelInfo
│   └── stream.py                    # StreamChunk, StreamEvent
│
├── providers/
│   ├── __init__.py
│   ├── base.py                      # LLMProvider protocol + RateLimitState model
│   ├── registry.py                  # ProviderRegistry
│   ├── ollama.py                    # OllamaProvider
│   ├── azure_openai.py              # AzureOpenAIProvider (parses x-ratelimit-* headers)
│   ├── bedrock.py                   # BedrockProvider (handles ThrottlingException)
│   ├── circuit_breaker.py           # CircuitBreaker wrapper
│   └── rate_limiter.py              # RateLimitTracker + ProviderQueue + token estimation
│
├── services/
│   ├── __init__.py
│   ├── task_manager.py              # TaskManager (Redis Streams)
│   ├── stream_consumer.py           # Read from Redis Stream → SSE/WS
│   └── generation.py                # Orchestrates provider + queue + task manager
│
└── tests/
    ├── __init__.py
    ├── conftest.py                  # Shared fixtures (mock Redis, mock providers)
    ├── unit/
    │   ├── test_providers.py
    │   ├── test_task_manager.py
    │   ├── test_generation.py
    │   ├── test_rate_limiter.py     # RateLimitTracker, ProviderQueue, token estimation
    │   ├── test_circuit_breaker.py
    │   └── test_models.py
    └── integration/
        ├── test_api_generate.py
        ├── test_api_stream.py
        ├── test_api_websocket.py
        ├── test_api_tasks.py
        └── test_rate_limit_e2e.py   # 429 simulation, mid-stream recovery, queue backpressure
```

---

## 7. Configuration

### Environment Variables

```bash
# ─── Application ───
SMR_V2_HOST=0.0.0.0
SMR_V2_PORT=5006
SMR_V2_DEBUG=false
SMR_V2_LOG_LEVEL=info
SMR_V2_CORS_ORIGINS=["http://localhost:8868/api/v1"]

# ─── Redis ───
SMR_V2_REDIS_URL=redis://localhost:6379/0
SMR_V2_TASK_TTL_SECONDS=3600
SMR_V2_STREAM_MAX_LEN=10000

# ─── Ollama ───
SMR_V2_OLLAMA_ENABLED=true
SMR_V2_OLLAMA_BASE_URL=http://localhost:11434
SMR_V2_OLLAMA_DEFAULT_MODEL=llama3.2:latest
SMR_V2_OLLAMA_TIMEOUT_S=300

# ─── Azure OpenAI ───
SMR_V2_AZURE_ENABLED=true
SMR_V2_AZURE_API_KEY=sk-...
SMR_V2_AZURE_ENDPOINT=https://your-resource.openai.azure.com/
SMR_V2_AZURE_API_VERSION=2024-12-01-preview
SMR_V2_AZURE_DEPLOYMENT_NAME=gpt-4
SMR_V2_AZURE_DEFAULT_MODEL=gpt-4
SMR_V2_AZURE_TIMEOUT_S=120
SMR_V2_AZURE_TPM_LIMIT=80000
SMR_V2_AZURE_RPM_LIMIT=480
SMR_V2_AZURE_ADAPTIVE_LIMITS=true

# ─── AWS Bedrock ───
SMR_V2_BEDROCK_ENABLED=true
SMR_V2_BEDROCK_REGION=us-east-1
SMR_V2_BEDROCK_DEFAULT_MODEL=anthropic.claude-3-haiku-20240307-v1:0
SMR_V2_BEDROCK_TIMEOUT_S=120
SMR_V2_BEDROCK_MAX_POOL_CONNECTIONS=150
SMR_V2_BEDROCK_TPM_LIMIT=100000
SMR_V2_BEDROCK_RPM_LIMIT=100
SMR_V2_BEDROCK_THROTTLE_BACKOFF_S=30
# AWS credentials via standard env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN

# ─── Ollama Rate Limits ───
SMR_V2_OLLAMA_MAX_CONCURRENT=4
SMR_V2_OLLAMA_QUEUE_BACKOFF_S=2

# ─── Request Queue ───
SMR_V2_QUEUE_MAX_SIZE=200
SMR_V2_QUEUE_MAX_WAIT_S=60

# ─── Concurrency ───
SMR_V2_HTTPX_MAX_CONNECTIONS=200
SMR_V2_HTTPX_MAX_KEEPALIVE=100

# ─── Circuit Breaker ───
SMR_V2_CB_FAILURE_THRESHOLD=5
SMR_V2_CB_RECOVERY_TIMEOUT_S=30
SMR_V2_CB_HALF_OPEN_MAX_CALLS=3
SMR_V2_CB_COUNT_RATE_LIMITS=true

# ─── Observability ───
SMR_V2_OTEL_ENABLED=false
SMR_V2_OTEL_EXPORTER_ENDPOINT=http://localhost:4317
SMR_V2_METRICS_ENABLED=true
```

---

## 8. Key Design Decisions

### 8.1 Redis Streams vs Celery for Task Management

| Criteria | Redis Streams (chosen) | Celery |
|----------|----------------------|--------|
| Streaming support | Native (chunks are stream entries) | None (fire-and-forget) |
| Resume from last position | Built-in via consumer groups | Not possible |
| Complexity | Low (Redis only) | High (broker + worker + result backend) |
| Dependencies | `redis` only | `celery` + `redis` + worker process |
| Latency | Sub-millisecond | 10-100ms message overhead |
| Scaling | Excellent | Good but requires separate workers |

### 8.2 SSE vs WebSocket vs WebRTC

| Protocol | Use Case | v2 Support |
|----------|----------|------------|
| **SSE** | Default streaming; browser-native, auto-reconnect, `Last-Event-ID` resume | Day 1 |
| **WebSocket** | Bidirectional; when client needs to send control messages mid-stream | Day 1 |
| **WebRTC** | Ultra-low-latency audio/video; future voice generation | Future (architecture is ready) |

SSE is the **recommended default** for LLM streaming because:
- Auto-reconnect with `Last-Event-ID` (free resume)
- Works through proxies, CDNs, and load balancers
- Lower server resource usage than WebSocket
- Simpler client implementation

### 8.3 boto3 + asyncio.to_thread() vs aioboto3

Chosen: **boto3 + `asyncio.to_thread()`**

- boto3 is the official AWS SDK; fully supported and documented
- `asyncio.to_thread()` offloads blocking calls to a thread pool without blocking the event loop
- aioboto3 has known issues with SSL initialization blocking the event loop
- For 100+ users, we set `Config(max_pool_connections=150)` and share one client

### 8.4 Bedrock Converse API vs invoke_model

Chosen: **Converse API (`converse_stream`)**

- Unified interface across all Bedrock models (Claude, Llama, Mistral, etc.)
- No model-specific body format required
- Built-in streaming event structure (`messageStart`, `contentBlockDelta`, `messageStop`, `metadata`)
- Supports system prompts, tool use, and guardrails natively

### 8.5 Cloud Provider Rate Limiting Strategy

This is a critical production concern. Azure OpenAI and AWS Bedrock both enforce **TPM (Tokens Per Minute)** and **RPM (Requests Per Minute)** limits. Without proactive handling, 100 concurrent users will rapidly trigger 429 responses that cascade into failures.

#### 8.5.1 How Each Provider Rate-Limits

| Aspect | Azure OpenAI | AWS Bedrock | Ollama (self-hosted) |
|--------|-------------|-------------|---------------------|
| **Limits enforced** | TPM + RPM (rolling window) | TPM + RPM (per model, per region) | Concurrency (`OLLAMA_NUM_PARALLEL`) + queue (`OLLAMA_MAX_QUEUE`) |
| **429 response** | HTTP 429 with headers | HTTP 429 `ThrottlingException` | HTTP 503 "Server Overloaded" (queue full) |
| **Rate limit headers** | `x-ratelimit-remaining-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-tokens`, `Retry-After` | None | None |
| **Token accounting** | Charged on `prompt_tokens + max_tokens` (estimated max) | Actual token usage | N/A |
| **Window** | TPM: rolling 60s; RPM: rolling 10s | 60s cycle | N/A |
| **Streaming behavior** | Same TPM/RPM; **429 possible mid-stream** | Same TPM/RPM; **429 possible mid-stream** | 503 if queue full at request start |
| **Provisioned option** | PTUs (reserved capacity) | Provisioned Throughput (Model Units) | More GPU/RAM |

#### 8.5.2 Three-Layer Rate Limit Architecture

SMR V2 uses three complementary layers to handle rate limiting:

```
┌─────────────────────────────────────────────────────┐
│              Layer 1: PROACTIVE GATING               │
│   (Prevent 429s before they happen)                  │
│                                                      │
│   ┌──────────────────────────────────┐              │
│   │  RateLimitTracker (per provider) │              │
│   │                                  │              │
│   │  Sliding window TPM counter      │              │
│   │  Sliding window RPM counter      │              │
│   │  Adaptive limits from headers    │              │
│   │  Token estimation before send    │              │
│   │                                  │              │
│   │  → can_accept(est_tokens) → bool │              │
│   │  → wait_time() → seconds         │              │
│   └──────────────────────────────────┘              │
├─────────────────────────────────────────────────────┤
│              Layer 2: REQUEST QUEUE                   │
│   (Buffer requests when rate-limited)                │
│                                                      │
│   ┌──────────────────────────────────┐              │
│   │  ProviderQueue (per provider)    │              │
│   │                                  │              │
│   │  asyncio.PriorityQueue           │              │
│   │  max_size configurable           │              │
│   │  Backpressure → 503 to client    │              │
│   │                                  │              │
│   │  Drain loop:                     │              │
│   │    wait until can_accept()       │              │
│   │    dequeue + dispatch            │              │
│   └──────────────────────────────────┘              │
├─────────────────────────────────────────────────────┤
│              Layer 3: REACTIVE RECOVERY               │
│   (Handle 429s that slip through)                    │
│                                                      │
│   ┌──────────────────────────────────┐              │
│   │  RetryHandler                    │              │
│   │                                  │              │
│   │  Parse Retry-After header        │              │
│   │  Exponential backoff + jitter    │              │
│   │  Update RateLimitTracker         │              │
│   │  Re-queue or fail after max      │              │
│   │  Mid-stream recovery             │              │
│   └──────────────────────────────────┘              │
└─────────────────────────────────────────────────────┘
```

#### 8.5.3 Layer 1: Proactive Gating — `RateLimitTracker`

Each cloud provider gets its own tracker instance. The tracker maintains two sliding-window counters (TPM and RPM) and adaptively adjusts limits from response headers.

**Data model:**
```python
class RateLimitState(BaseModel):
    """Exposed via GET /api/v2/providers for observability."""
    provider: str
    rpm_limit: int
    rpm_remaining: int
    rpm_reset_seconds: float
    tpm_limit: int
    tpm_remaining: int
    tpm_reset_seconds: float
    is_rate_limited: bool
    retry_after_seconds: float | None
    last_updated: datetime
```

**Sliding window algorithm:**
```python
class RateLimitTracker:
    def __init__(self, tpm_limit: int, rpm_limit: int):
        self._tpm_limit = tpm_limit
        self._rpm_limit = rpm_limit
        self._token_log: deque[tuple[float, int]] = deque()   # (timestamp, tokens)
        self._request_log: deque[float] = deque()              # timestamps
        self._retry_after: float | None = None
        self._lock = asyncio.Lock()

    async def can_accept(self, estimated_tokens: int) -> bool:
        """Check if a request with estimated_tokens can proceed."""
        async with self._lock:
            now = time.monotonic()
            # Respect Retry-After if active
            if self._retry_after and now < self._retry_after:
                return False
            # Purge entries older than 60s
            self._purge_old_entries(now)
            current_tpm = sum(t for _, t in self._token_log)
            current_rpm = len(self._request_log)
            return (
                current_tpm + estimated_tokens <= self._tpm_limit
                and current_rpm + 1 <= self._rpm_limit
            )

    async def wait_time(self, estimated_tokens: int) -> float:
        """Seconds to wait before estimated_tokens can be accepted."""
        async with self._lock:
            now = time.monotonic()
            if self._retry_after and now < self._retry_after:
                return self._retry_after - now
            self._purge_old_entries(now)
            # Find when enough tokens will expire
            current_tpm = sum(t for _, t in self._token_log)
            if current_tpm + estimated_tokens > self._tpm_limit:
                needed = (current_tpm + estimated_tokens) - self._tpm_limit
                wait = self._time_until_tokens_free(needed, now)
                return max(wait, 0.1)
            current_rpm = len(self._request_log)
            if current_rpm + 1 > self._rpm_limit:
                oldest = self._request_log[0]
                return max((oldest + 10.0) - now, 0.1)  # RPM window is 10s
            return 0.0

    async def record_request(self, estimated_tokens: int):
        """Record a request being sent."""
        async with self._lock:
            now = time.monotonic()
            self._token_log.append((now, estimated_tokens))
            self._request_log.append(now)

    async def record_completion(self, actual_tokens: int, estimated_tokens: int):
        """Adjust token count after completion (actual vs estimated)."""
        # Replaces estimated with actual in the log (net adjustment)
        ...

    async def update_from_headers(self, headers: dict[str, str]):
        """Adaptively update limits from Azure response headers."""
        # x-ratelimit-remaining-tokens → adjust tpm tracking
        # x-ratelimit-remaining-requests → adjust rpm tracking
        # x-ratelimit-limit-tokens → update tpm_limit if different
        # Retry-After → set _retry_after
        ...

    async def record_rate_limited(self, retry_after: float | None):
        """Called when a 429 is received."""
        async with self._lock:
            if retry_after:
                self._retry_after = time.monotonic() + retry_after
            else:
                # Default: back off for 10 seconds
                self._retry_after = time.monotonic() + 10.0
```

**Token estimation** (before sending to LLM):
```python
def estimate_tokens(prompt: str, max_tokens: int) -> int:
    """Estimate total tokens for rate limit accounting.
    Azure charges prompt_tokens + max_tokens (worst case).
    We use a simple heuristic: ~4 chars per token for English.
    """
    prompt_tokens = max(len(prompt) // 4, 1)
    return prompt_tokens + max_tokens
```

#### 8.5.4 Layer 2: Request Queue — `ProviderQueue`

When `can_accept()` returns `False`, instead of immediately failing the request, we queue it with backpressure:

```python
class ProviderQueue:
    def __init__(self, provider_name: str, max_size: int = 200):
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue(maxsize=max_size)
        self._tracker: RateLimitTracker = ...
        self._drain_task: asyncio.Task | None = None

    async def enqueue(self, request: GenerateRequest, priority: int = 10) -> str:
        """Enqueue a generation request. Returns task_id.
        Raises HTTP 503 if queue is full (backpressure).
        """
        if self._queue.full():
            raise HTTPException(
                status_code=503,
                detail=f"Provider '{self.provider_name}' is at capacity. Try again later.",
                headers={"Retry-After": "10"}
            )
        task_id = generate_task_id()
        await self._queue.put((priority, time.monotonic(), task_id, request))
        return task_id

    async def _drain_loop(self):
        """Background loop: dequeue when rate limit allows."""
        while True:
            priority, enqueued_at, task_id, request = await self._queue.get()
            estimated = estimate_tokens(request.prompt, request.max_tokens)

            # Wait until we can send
            wait = await self._tracker.wait_time(estimated)
            if wait > 0:
                await asyncio.sleep(wait)

            await self._tracker.record_request(estimated)
            # Dispatch to provider (runs generation + writes to Redis Stream)
            asyncio.create_task(self._dispatch(task_id, request))
```

**Queue priorities** (lower number = higher priority):
```
0  = system/internal retries
5  = premium/priority requests
10 = normal requests (default)
20 = bulk/batch requests
```

#### 8.5.5 Layer 3: Reactive Recovery — 429 Handling

When a 429 slips through (rate limit headers can lag behind actual state), the provider catches it and coordinates with the tracker:

**Non-streaming 429:**
```python
async def _handle_rate_limit(self, error, task_id: str, request: GenerateRequest):
    """Handle 429 from cloud provider."""
    # 1. Parse Retry-After
    retry_after = self._parse_retry_after(error)

    # 2. Update tracker so future requests wait
    await self.rate_tracker.record_rate_limited(retry_after)

    # 3. Determine if we should retry
    task_state = await self.task_manager.get_state(task_id)
    if task_state.retry_count < request.retry_config.max_retries:
        # Re-queue with higher priority
        delay = retry_after or self._backoff_delay(task_state.retry_count)
        await asyncio.sleep(delay)
        await self.task_manager.update_state(task_id, status="retrying")
        await self.queue.enqueue(request, priority=0)  # Priority retry
    else:
        await self.task_manager.update_state(task_id, status="failed",
            error=f"Rate limited after {task_state.retry_count} retries")
```

**Mid-stream 429 (stream interrupted by rate limit):**
```python
async def _generate_stream_with_recovery(self, task_id, request):
    """Stream with mid-stream 429 recovery."""
    chunks_so_far = []

    for attempt in range(request.retry_config.max_retries + 1):
        try:
            async for chunk in self.provider.generate_stream(
                prompt=request.prompt,
                system_prompt=request.system_prompt,
                **request.options
            ):
                chunks_so_far.append(chunk.content)
                await self.task_manager.write_chunk(task_id, chunk)

            # Stream completed successfully
            return

        except RateLimitError as e:
            retry_after = self._parse_retry_after(e)
            await self.rate_tracker.record_rate_limited(retry_after)

            if attempt < request.retry_config.max_retries:
                delay = retry_after or self._backoff_delay(attempt)
                await self.task_manager.write_event(task_id, "rate_limited", {
                    "attempt": attempt + 1,
                    "retry_after_s": delay,
                    "chunks_received": len(chunks_so_far),
                })
                await asyncio.sleep(delay)

                # Rebuild prompt with partial context for continuation
                partial_text = "".join(chunks_so_far)
                if partial_text:
                    # Ask LLM to continue from where it left off
                    request = request.model_copy(update={
                        "prompt": f"{request.prompt}\n\n[Continue from where you left off. Your previous output was:]\n{partial_text}\n\n[Continue:]"
                    })
            else:
                await self.task_manager.write_event(task_id, "error", {
                    "type": "rate_limited",
                    "message": f"Rate limited after {attempt + 1} attempts",
                    "partial_content": "".join(chunks_so_far),
                })
                raise
```

#### 8.5.6 Provider-Specific Header Parsing

**Azure OpenAI:**
```python
async def _parse_azure_headers(self, response_headers: dict) -> None:
    """Update rate tracker from Azure response headers."""
    remaining_tokens = response_headers.get("x-ratelimit-remaining-tokens")
    remaining_requests = response_headers.get("x-ratelimit-remaining-requests")
    limit_tokens = response_headers.get("x-ratelimit-limit-tokens")
    reset_tokens = response_headers.get("x-ratelimit-reset-tokens")
    retry_after = response_headers.get("retry-after")

    updates = {}
    if remaining_tokens is not None:
        updates["tpm_remaining"] = int(remaining_tokens)
    if remaining_requests is not None:
        updates["rpm_remaining"] = int(remaining_requests)
    if limit_tokens is not None:
        updates["tpm_limit"] = int(limit_tokens)
    if retry_after is not None:
        updates["retry_after"] = float(retry_after)

    await self.rate_tracker.update_from_headers(updates)
```

**AWS Bedrock:**
```python
async def _handle_bedrock_throttle(self, exc: ClientError) -> float:
    """Extract retry info from Bedrock ThrottlingException.
    Bedrock does NOT return rate limit headers, so we rely on:
    1. The exception message (may contain hints)
    2. A conservative default backoff aligned with the 60s quota cycle
    """
    error_code = exc.response.get("Error", {}).get("Code", "")
    if error_code == "ThrottlingException":
        # Bedrock quota cycles every 60s; default to half-cycle
        return 30.0
    elif error_code == "ServiceQuotaExceededException":
        # Hard quota; longer backoff
        return 60.0
    return 10.0  # Unknown error; short backoff
```

**Ollama (self-hosted):**
```python
async def _handle_ollama_overload(self, status_code: int) -> float:
    """Ollama returns 503 when queue is full.
    No rate limit headers; use short backoff since it's local.
    """
    if status_code == 503:
        return 2.0   # Local service; retry quickly
    return 5.0
```

#### 8.5.7 SSE Event for Rate Limit Transparency

Clients receive real-time visibility when their stream is affected:

```
event: rate_limited
id: 7-0
data: {"attempt":1,"retry_after_s":10.5,"chunks_received":42,"message":"Provider rate-limited. Retrying in 10.5s..."}

event: resumed
id: 8-0
data: {"attempt":2,"message":"Generation resumed"}

event: chunk
id: 9-0
data: {"content":"...continuing from where we left off..."}
```

#### 8.5.8 Configuration for Rate Limits

```bash
# ─── Azure OpenAI Rate Limits ───
SMR_V2_AZURE_TPM_LIMIT=80000           # Tokens per minute (from Azure portal)
SMR_V2_AZURE_RPM_LIMIT=480             # Requests per minute (auto-calculated or from portal)
SMR_V2_AZURE_ADAPTIVE_LIMITS=true      # Auto-adjust from response headers

# ─── AWS Bedrock Rate Limits ───
SMR_V2_BEDROCK_TPM_LIMIT=100000        # Tokens per minute (from AWS quota page)
SMR_V2_BEDROCK_RPM_LIMIT=100           # Requests per minute
SMR_V2_BEDROCK_THROTTLE_BACKOFF_S=30   # Default backoff on ThrottlingException

# ─── Ollama Rate Limits ───
SMR_V2_OLLAMA_MAX_CONCURRENT=4         # Matches OLLAMA_NUM_PARALLEL
SMR_V2_OLLAMA_QUEUE_BACKOFF_S=2        # Backoff when 503

# ─── Request Queue ───
SMR_V2_QUEUE_MAX_SIZE=200              # Max queued requests per provider
SMR_V2_QUEUE_MAX_WAIT_S=60            # Max time a request waits in queue before 504
```

#### 8.5.9 Observability Metrics for Rate Limiting

```
# Prometheus metrics
smr_rate_limit_hits_total{provider="azure_openai"}              # 429s received
smr_rate_limit_queue_depth{provider="azure_openai"}             # Current queue depth
smr_rate_limit_wait_seconds{provider="azure_openai"}            # Time spent waiting
smr_rate_limit_remaining_tokens{provider="azure_openai"}        # From headers
smr_rate_limit_remaining_requests{provider="azure_openai"}      # From headers
smr_rate_limit_mid_stream_recoveries_total{provider="bedrock"}  # Mid-stream retries
smr_rate_limit_queue_rejections_total{provider="bedrock"}       # 503s from full queue
```

---

## 9. Execution Order and Estimates

| Phase | Tasks | Estimate | Dependencies |
|-------|-------|----------|--------------|
| Phase 0 | Scaffolding | 0.5 day | None |
| Phase 1 | Provider Layer + Rate Limit Tracker | 3-4 days | Phase 0 |
| Phase 2 | Task Manager | 2 days | Phase 0 |
| Phase 3 | API Layer | 2 days | Phase 1 + 2 |
| Phase 4 | Concurrency, Queue, Circuit Breaker, Mid-Stream Recovery | 2 days | Phase 3 |
| Phase 5 | Observability + Rate Limit Metrics | 0.5 day | Phase 3 |

**Total: ~10-11 days**

Phases 1 and 2 can be executed in parallel.

---

## 10. Migration Strategy

The v2 service runs alongside v1:

1. **v1 continues on `/api/v1/*`** (existing medical summarization)
2. **v2 runs on `/api/v2/*`** (new text generation)
3. Both are served by the same FastAPI process
4. Gateway can route traffic to either version
5. When v2 is stable, v1 endpoints are deprecated and removed

---

## 11. Implementation Summary

### Completed — All Phases (0 through 5)

**Environment**: conda `smr-v2` with Python 3.11.14

**Test Results**: **143 tests, 143 passed, 0 failures** — all written test-first (TDD Red-Green-Refactor)

### Files Created

#### Core (`src/smr_v2/core/`)
- `config.py` — Pydantic Settings for all providers + Redis + circuit breaker + queue
- `logging.py` — structlog JSON logging configuration
- `dependencies.py` — FastAPI dependency injection functions

#### Models (`src/smr_v2/models/`)
- `task.py` — `TaskStatus` enum, `TaskState` model
- `requests.py` — `GenerateRequest`, `RetryConfig`
- `responses.py` — `GenerateResponse`, `StreamingGenerateResponse`, `TaskResponse`, `TokenUsage`
- `stream.py` — `StreamChunk` (chunk/meta/done/error/usage types)
- `provider.py` — `ModelInfo`, `ProviderInfo`, `RateLimitState`

#### Providers (`src/smr_v2/providers/`)
- `base.py` — `LLMProvider` protocol, `ProviderRegistry`, `ProviderNotFoundError`
- `ollama.py` — Ollama provider via `httpx.AsyncClient` + NDJSON streaming
- `azure_openai.py` — Azure OpenAI provider via `openai.AsyncAzureOpenAI` + SSE streaming
- `bedrock.py` — AWS Bedrock provider via `boto3` + `asyncio.to_thread()` + `converse_stream`

#### Services (`src/smr_v2/services/`)
- `rate_limiter.py` — `SlidingWindowCounter`, `RateLimitTracker`, `estimate_tokens()`
- `circuit_breaker.py` — `CircuitBreaker` (CLOSED/OPEN/HALF_OPEN states)
- `task_manager.py` — Redis-backed task lifecycle + Redis Streams chunk persistence
- `provider_queue.py` — `ProviderQueue` (async priority queue with backpressure)
- `retry_handler.py` — Exponential backoff with jitter, `should_retry()` logic
- `shutdown_manager.py` — Graceful shutdown with active-task draining

#### API Endpoints (`src/smr_v2/api/endpoints/`)
- `health.py` — `GET /api/v2/health` (provider health aggregation)
- `providers.py` — `GET /api/v2/providers` (list available providers)
- `generate.py` — `POST /api/v2/generate` (sync + async/streaming with background task)
- `tasks.py` — `GET /api/v2/tasks/{id}`, `POST /api/v2/tasks/{id}/cancel`
- `stream.py` — `GET /api/v2/tasks/{id}/stream` (SSE with resume via `Last-Event-ID`)

#### Application (`src/smr_v2/`)
- `main.py` — FastAPI app factory with lifespan, CORS, Prometheus metrics, router wiring

#### Tests (`src/smr_v2/tests/unit/`)
- `test_models.py` — 30 tests (Pydantic models, validation, serialization)
- `test_rate_limiter.py` — 22 tests (sliding window, token estimation, tracking)
- `test_circuit_breaker.py` — 11 tests (state transitions, allow/reject, reset)
- `test_provider_registry.py` — 11 tests (register, get, unregister, overwrite)
- `test_ollama_provider.py` — 11 tests (generate, stream, health, info)
- `test_azure_provider.py` — 9 tests (generate, stream, health, info)
- `test_bedrock_provider.py` — 8 tests (generate, stream, health, info)
- `test_task_manager.py` — 11 tests (create, get, update, cancel, chunks)
- `test_api_endpoints.py` — 10 tests (health, providers, generate, tasks)
- `test_provider_queue.py` — 15 tests (queue, retry, shutdown)
- `test_observability.py` — 5 tests (metrics, logging)

### Architecture Highlights

1. **Multi-provider from day 1**: Ollama, Azure OpenAI, AWS Bedrock — all with streaming
2. **Generator-consumer decoupling**: Redis Streams decouple LLM generation from client SSE/WS
3. **Rate-limit resilience**: Sliding-window TPM/RPM tracking, priority queue backpressure, exponential backoff
4. **Circuit breaker**: Per-provider failure isolation (CLOSED → OPEN → HALF_OPEN → CLOSED)
5. **Graceful shutdown**: Active-task drain with configurable timeout
6. **Observability**: Prometheus metrics via `/metrics`, structured JSON logging via structlog
7. **100+ concurrent users**: async throughout, connection pooling (httpx), thread offload for boto3

---

## 12. Change History

| # | Date | Description | Status |
|---|------|-------------|--------|
| 1 | 2026-02-18 | Initial plan created | Pending approval |
| 2 | 2026-02-18 | Added comprehensive rate-limiting strategy (Section 8.5): three-layer architecture (proactive gating, request queue, reactive recovery), per-provider TPM/RPM tracking, mid-stream 429 recovery, adaptive header parsing for Azure, Bedrock throttle handling, queue backpressure, rate-limit SSE events, Prometheus metrics | Updated |
| 3 | 2026-02-18 | Full TDD implementation completed — all 5 phases (143 tests, 143 passed). Created conda smr-v2 env (Python 3.11). Implemented: models, providers (Ollama/Azure/Bedrock), services (rate limiter, circuit breaker, task manager, queue, retry, shutdown), API endpoints (health, providers, generate, tasks, stream), Prometheus metrics | Completed |
