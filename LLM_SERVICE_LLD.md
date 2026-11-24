# Low-Level Design (LLD) — LLM Service (`apps/text`)

**Document Version**: 2.0.0
**Target Service**: `apps/text`
**Classification**: Production Architecture & Technical Specification
**Authors**: Senior Software Architecture & Core Platform Engineering Team

---

## 1. Executive Summary & Architectural Posture

The **Text Generation & LLM Microservice** (`apps/text`) is the central inference gateway, summarization broker, translation coordinator, and embedding engine for Project Hope. It provides a hardened, unified API abstraction over heterogeneous commercial cloud models (OpenAI, Anthropic Claude, AWS Bedrock, Google Vertex AI) and self-hosted open-weight inference clusters (vLLM, Ollama, LM Studio, llama.cpp, TEI).

### Core Architectural Invariants

1. **Stateless Gateway Posture (D-1)**: `apps/text` stores no persistent tenant credentials, owns no proprietary model weights, and hardcodes no provider endpoints. Credentials arrive via **PUSH** per request (`provider_overrides`), while platform capacity limits and timeouts arrive via **PULL** from the control plane (`apps/api` via `GET /internal/effective-config?service=text`).
2. **Fail-Closed Clinical Safety**: Medical AI demands zero-tolerance safety. All incoming clinical prompts pass through an external input moderation gate (`apps/guardrail`), and generated completions pass through a post-receive outbound gate. Any safety violation or sustained guardrail outage fails closed (`422 ContentBlockedError` or `422 OutputRejectedError`).
3. **Resumable Streaming Across Network Drops**: Generation tasks run in detached background `asyncio.Task` producers owned by `GenerationHub`. Token chunks are simultaneously broadcast to connected SSE clients and persisted to Redis Streams (`text:stream:{id}`). Reconnecting clients seamlessly replay missed tokens using `Last-Event-ID` or `?from_seq=`.
4. **Lane Partitioning & Safety Isolation**: Concurrency is partitioned into two independent lanes: the `user` lane (concurrency floor 4, queue 200, timeout 300s) and the `judge` lane (concurrency floor 2, queue 0, timeout 60s). This guarantees safety evaluation and hallucination detection never starve during high user traffic.
5. **Single-Worker Process Invariant**: Enforced in `apps/text/Dockerfile` because `GenerationHub` is process-local. Scaling is strictly vertical or horizontal with single-worker pods until cross-worker `XREAD BLOCK` stream tailing is deployed.

---

## 2. System Architecture & End-to-End Topology

```
+-------------------------------------------------------------------------------------------------------------------+
|                                                 EXTERNAL CLIENT TIER                                              |
|            [Web Clinician Console]      [Mobile / Tablet App]      [Admin Playground]      [Partner SDK]          |
+----------------------------------------------------------+--------------------------------------------------------+
                                                           | HTTPS / REST / SSE
                                                           v
+-------------------------------------------------------------------------------------------------------------------+
|                                      API GATEWAY & CONTROL PLANE (apps/api :3000)                                 |
|                                                                                                                   |
|  - Ingress: ThrottlerGuard -> ClsContext -> UnifiedAuthGuard (JWT) -> ConsentGuard -> OriginGuard                 |
|  - Entitlements: assertLlmAllowance() (Monthly token quota validation against PostgreSQL)                          |
|  - Enrichment: TextRequestEnrichment (RAG Context Injection, Clinical Prompt Templates, BYOK Resolution)           |
|  - Dispatches to: apps/text via HTTP with X-Service-Token, X-Tenant-Id, and dynamic provider_overrides             |
+----------------------------------------------------------+--------------------------------------------------------+
                                                           |
                      +------------------------------------+------------------------------------+
                      |                                    |                                    |
                      v                                    v                                    v
          [Lane 1: Direct Interactive]       [Lane 2: Async Orchestration]         [Lane 3: Clinical NLP]
               apps/api Proxy                     apps/harness (Temporal)              apps/nlp Microservice
                      |                                    |                                    |
                      +------------------------------------+------------------------------------+
                                                           |
                                                           v HTTP POST /api/v1/generate
+-------------------------------------------------------------------------------------------------------------------+
|                                        APPS/TEXT LLM GATEWAY (Port :8862)                                         |
|                                                                                                                   |
|  [Middleware Pipeline]                                                                                            |
|    1. RequestContextMiddleware: Binds X-Request-ID, captures X-Tenant-Id                                           |
|    2. AccessLogMiddleware: Emits structured JSON access logs (zero PHI)                                           |
|    3. ServiceAuthMiddleware: Authenticates internal shared secret INTERNAL_ACCESS_TOKEN                            |
|                                                                                                                   |
|  [Execution Pipeline]                                                                                             |
|    +--------------------+       +--------------------+       +--------------------+       +--------------------+  |
|    |    PoolRouter      | ----> |  IdempotencyCheck  | ----> |  InputGuardrail    | ----> |  RateLimiter       |  |
|    | (Degrade Engine)   |       | (Redis SHA-256)    |       | (POST /validate)   |       | (TPM / RPM Leaky)  |  |
|    +--------------------+       +--------------------+       +--------------------+       +--------------------+  |
|                                                                                                    |              |
|    +--------------------+       +--------------------+       +--------------------+                v              |
|    |    OutputGate      | <---- |   GenerationHub    | <---- | ResizableSemaphore | <---- +--------------------+  |
|    | (Screen Outbound)  |       | (Detached Producer)|       | (Permit Governor)  |       |   CircuitBreaker   |  |
|    +--------------------+       +--------------------+       +--------------------+       | (Fail-Fast Engine) |  |
|              |                                                                            +--------------------+  |
|              v                                                                                                    |
|    +--------------------+                                                                                         |
|    |    StatsTracker    | ----> Emits Prometheus metrics & records token usage to Redis                           |
|    +--------------------+                                                                                         |
+----------------------------------------------------------+--------------------------------------------------------+
                                                           |
                                                           v Upstream Inference Execution
+-------------------------------------------------------------------------------------------------------------------+
|                                              AI PROVIDER BACKENDS                                                 |
|  [Commercial APIs]: OpenAI (gpt-4o) | Anthropic (claude-3-5) | AWS Bedrock | Google Vertex AI                      |
|  [Self-Hosted]:     vLLM (Llama-3-70B) | Ollama | LM Studio | llama.cpp                                            |
|  [Specialized]:     Sarvam AI (Translation) | HuggingFace TEI (Dense Vector Embeddings)                           |
+-------------------------------------------------------------------------------------------------------------------+
```

	

---

## 3. Internal Component-Level Design

### 3.1 Module Dependency Matrix

The table below details component dependencies and interactions across `apps/text`:

| Component Class             | Source File                         | Core Dependencies                            | Primary Consumers                               |
| --------------------------- | ----------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `ServiceAuthMiddleware`   | `api/middleware/auth.py`          | `core/config.py`, `starlette.middleware` | FastAPI Application Pipeline (`main.py`)      |
| `PoolRouter`              | `services/pool_router.py`         | `PoolHealthTracker`, `ProviderRegistry`  | `api/endpoints/generate.py`                   |
| `PoolHealthTracker`       | `services/pool_health.py`         | In-process sliding error window              | `PoolRouter`, `api/endpoints/health.py`     |
| `ExternalGuardrailClient` | `services/external_guardrail.py`  | `httpx.AsyncClient`, `core/config.py`    | `api/endpoints/generate.py`                   |
| `RateLimiter`             | `services/rate_limiter.py`        | `aioredis.Redis`, Lua Scripts              | `api/endpoints/generate.py`                   |
| `ProviderQueue`           | `services/provider_queue.py`      | `asyncio.Queue`, `asyncio.Condition`     | `api/endpoints/generate.py`                   |
| `CircuitBreaker`          | `services/circuit_breaker.py`     | In-process counters & state enum             | `api/endpoints/generate.py`, `judge.py`     |
| `ResizableSemaphore`      | `services/resizable_semaphore.py` | `asyncio.Condition`, integer capacity      | `api/endpoints/generate.py`, `judge.py`     |
| `GenerationHub`           | `routing/hub.py`                  | `asyncio.Task`, `asyncio.Queue`          | `api/endpoints/generate.py`, `stream.py`    |
| `TaskManager`             | `services/task_manager.py`        | `aioredis.Redis`, `hope_async_contract`  | `api/endpoints/tasks.py`, `stream.py`       |
| `OutputGate`              | `services/output_gate.py`         | `httpx.AsyncClient`, `core/config.py`    | `api/endpoints/generate.py`, `streaming.py` |
| `EffectiveConfigClient`   | `core/effective_config.py`        | `httpx.AsyncClient`, `aioredis.Redis`    | Application Lifespan (`main.py`)              |

---

### 3.2 Detailed Component Specifications

#### A. Ingress Security & Correlation (`ServiceAuthMiddleware`)

- **File**: [`apps/text/src/text/api/middleware/auth.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/middleware/auth.py)
- **Class**: `ServiceAuthMiddleware(BaseHTTPMiddleware)`
- **Logic**:
  1. Inspects request path. If path matches exempt prefixes (`/api/v1/health`, `/metrics`, `/api/v1/docs`, `/api/v1/redoc`, `/api/v1/openapi.json`), passes through immediately.
  2. Extracts token from `X-Service-Token` header or `Authorization: Bearer <token>`.
  3. Uses constant-time string comparison (`hmac.compare_digest`) against `settings.internal_access.token`. Rejects mismatches with `401 Unauthorized`.
  4. Validates presence of `X-Tenant-Id`. If missing on generation routes, raises `428 Precondition Required`.

#### B. Pool Routing & Provider Degradation Engine (`PoolRouter`)

- **File**: [`apps/text/src/text/services/pool_router.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/pool_router.py)
- **Class**: `PoolRouter`
- **Method**: `async def resolve(requested_provider: str | None, requested_model: str | None) -> tuple[LLMProvider, str]`
- **Logic**:
  - If a specific provider is requested:
    - Queries `PoolHealthTracker.get_status(provider)`.
    - If provider is `DEGRADED` or `UNHEALTHY`, inspects fallback chains defined in the control-plane routing profile.
    - If primary provider circuit is OPEN, diverts traffic to fallback provider (e.g. `vllm` -> `openai`).
  - If no provider is requested:
    - Selects highest priority healthy provider matching model capabilities.

#### C. Redis Idempotency Engine

- **File**: [`apps/text/src/text/api/endpoints/generate.py#L262-L330`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/generate.py#L262-L330)
- **Functions**: `_payload_fingerprint(request_body: GenerateRequest) -> str`, `_resolve_stream_idempotency()`
- **Mechanism**:
  - When header `Idempotency-Key: <key>` is present, constructs cache key: `text:idem:{tenant_id}:{key}`.
  - Computes SHA-256 fingerprint of the request payload (prompt, model, temperature, seed).
  - Checks Redis:
    - If key exists and status is `COMPLETED`: Returns cached JSON response directly with header `X-Cache-Lookup: HIT`, saving 100% of LLM provider costs and token latency.
    - If status is `IN_PROGRESS`: Returns `409 Conflict` or attaches to the active generation stream to prevent parallel duplicate execution.
  - On generation completion: Persists full response payload with a 24-hour TTL (`EX 86400`).

#### D. Clinical Moderation Gate (`ExternalGuardrailClient`)

- **File**: [`apps/text/src/text/services/external_guardrail.py#L42-L115`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/external_guardrail.py#L42-L115)
- **Class**: `ExternalGuardrailClient`
- **Method**: `async def validate(prompt: str, tenant_id: str, posture: GuardrailPosture) -> GuardrailResult`
- **Execution Path**:
  - If `posture.enabled` is `False` (local dev floor), returns `allowed=True`.
  - Dispatches `POST /api/medical/validate` to `TEXT_EXTERNAL_GUARDRAIL_BASE_URL` with a 10s timeout.
  - Validates two critical attributes:
    1. `is_safe`: If toxic, abusive, or containing PII/PHI leakage, returns `allowed=False`.
    2. `is_medical`: If `posture.require_medical` is `True` and the prompt is non-clinical, returns `allowed=False, reason="NON_MEDICAL_PROMPT"`.
  - If rejected, `generate.py` immediately raises `422 ContentBlockedError`, halting inference before provider dispatch.
  - Resilient Retry: If guardrail peer returns transient 5xx, retries 2 times with exponential backoff (100ms floor). A sustained outage fails closed.

#### E. Admission Control: Rate Limiting & Concurrency Governors

1. **`RateLimiter`** ([`services/rate_limiter.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/rate_limiter.py)):
   - Implements atomic token bucket in Redis via Lua scripting.
   - Evaluates both **RPM** (Requests Per Minute) and **TPM** (Tokens Per Minute) against tenant quotas and provider account limits.
   - Rejects excess traffic with `429 Too Many Requests` and standard `Retry-After` header.
2. **`CircuitBreaker`** ([`services/circuit_breaker.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/circuit_breaker.py)):
   - Three-state state machine: `CLOSED`, `OPEN`, `HALF-OPEN`.
   - Transitions to `OPEN` after 5 consecutive upstream timeouts or 5xx HTTP errors.
   - Fail-fast: When `OPEN`, immediately sheds load with `503 CircuitOpenError` without hitting upstream sockets.
   - `count_rate_limits=False` (TASK-993): Upstream 429s reflect quota consumption, not provider instability; they do not trip the breaker.
3. **`ResizableSemaphore`** ([`services/resizable_semaphore.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/resizable_semaphore.py)):
   - Custom semaphore built on `asyncio.Condition`.
   - Allows control plane to dynamically alter `max_concurrent` permits in-flight.
   - Resizing adjusts the capacity boundary without destroying active permits or stranding waiting coroutines.

#### F. Generation Hub & Detached Task Producer

- **File**: [`apps/text/src/text/routing/hub.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/routing/hub.py) & [`apps/text/src/text/routing/streaming.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/routing/streaming.py)
- **Class**: `GenerationHub`
- **Method**: `async def create_producer(generation_id: str, coro) -> GenerationProducer`
- **Resilient Streaming Architecture**:
  ```
  HTTP Client ---> GET /generate?stream=true
                         |
                         v
              [GenerationHub.create()]
                         |
       +-----------------+-----------------+
       |                                   |
       v                                   v
  [Subscriber Queue]             [Detached Producer Task]
  (Process Memory)               (asyncio.Task in Hub)
       |                                   |
       v                                   | Streams tokens from upstream LLM
  Yields SSE Events                        |
  to HTTP response                         v
                         Coalescing Flusher (32 chunks / 25ms)
                                           |
                                           v
                              Redis Stream: text:stream:{id}
  ```

  - If the client's HTTP socket disconnects prematurely, the detached producer continues executing to completion, saving the full generation to Redis.
  - When the clinician reconnects, `stream.py` replays the buffered tokens from `text:stream:{id}` and resumes live subscription.

#### G. Post-Receive Outbound Output Gate

- **File**: [`apps/text/src/text/services/output_gate.py#L38-L92`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/output_gate.py#L38-L92)
- **Function**: `async def gate_completion(text: str, tenant_id: str, client: httpx.AsyncClient) -> None`
- **Execution**:
  - Intercepts raw model generation before delivering to the client.
  - Sends completion to `POST /api/v1/guardrail/screen/outbound`.
  - Checks for hallucinated medical dosages, toxic diagnosis commentary, or unmasked PHI.
  - If flagged, completion is discarded, Redis task marked `failed`, and `422 OutputRejectedError` returned.

---

## 4. LLM Provider & Model Management Layer

### 4.1 Supported Provider Implementations

All providers subclass `LLMProvider` (`apps/text/src/text/providers/base.py`):

| Provider Name     | Class Name               | Source File                    | Protocol / SDK               | Special Capabilities                                         |
| ----------------- | ------------------------ | ------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `openai`        | `OpenAIProvider`       | `providers/openai.py`        | Official SDK (`openai>=3`) | JSON Schema structured outputs, seed, o1/gpt-4o              |
| `azure_openai`  | `AzureOpenAIProvider`  | `providers/azure_openai.py`  | Azure SDK / OpenAI Compat    | Enterprise private VNet endpoints, deployment IDs            |
| `anthropic`     | `AnthropicProvider`    | `providers/anthropic.py`     | Official SDK (`anthropic`) | Claude 3.5 Sonnet, 8k output tokens, prompt caching          |
| `bedrock`       | `BedrockProvider`      | `providers/bedrock.py`       | `boto3` Bedrock Runtime    | AWS IAM Role auth, Converse API, Claude/Llama on AWS         |
| `vertex`        | `VertexProvider`       | `providers/vertex.py`        | `google-genai` SDK         | GCP ADC / Service Account auth, Gemini 1.5 Pro               |
| `vllm`          | `VLLMProvider`         | `providers/vllm.py`          | HTTP/2 OpenAI-Compatible     | High-throughput local batched inference, PagedAttention      |
| `ollama`        | `OllamaProvider`       | `providers/ollama.py`        | Ollama REST API              | Local GGUF models, automatic `keep_alive` management       |
| `lmstudio`      | `LMStudioProvider`     | `providers/lmstudio.py`      | LM Studio REST API           | In-pod residency agent coordination (`LMSTUDIO_AGENT_URL`) |
| `llama_cpp`     | `LlamaCppProvider`     | `providers/llama_cpp.py`     | llama.cpp HTTP server        | Embedded CPU/Metal inference for edge nodes                  |
| `openai_compat` | `OpenAICompatProvider` | `providers/openai_compat.py` | Custom REST                  | Generic OpenAI API compatible reverse proxies                |
| `tei_embed`     | `TEIEmbeddingProvider` | `providers/tei_embed.py`     | HuggingFace TEI REST         | High-performance embedding generation                        |
| `sarvam`        | `SarvamTranslation`    | `translation/sarvam.py`      | Sarvam AI REST API           | Specialized Indic language medical translation               |

### 4.2 Dynamic Credential Posture (`ConnectionOverrides`)

Providers do not read global API keys. All connection properties are passed per request via `ConnectionOverrides` (`apps/text/src/text/core/connection.py`):

```python
class ConnectionOverrides(BaseModel):
    api_key: SecretStr | None = None
    base_url: str | None = None
    model: str | None = None
    custom_headers: dict[str, str] = Field(default_factory=dict)
    timeout_s: float | None = None
```

---

## 5. Persistence, State Machine & Redis Data Architecture

`apps/text` uses Redis (`TEXT_REDIS_URL`) as its high-speed state store. It connects via `aioredis` (using hiredis parsers).

### 5.1 Redis Key Layout

| Key Pattern                             | Data Structure  | TTL                    | Purpose                                                         |
| --------------------------------------- | --------------- | ---------------------- | --------------------------------------------------------------- |
| `text:task:{task_id}`                 | Redis Hash      | 3600s (`TASK_TTL_S`) | Task status, execution metadata, token counts, error message    |
| `text:stream:{task_id}`               | Redis Stream    | 3600s                  | Chunk sequence entries (`XADD`), capped at 10,000 entries     |
| `text:idem:{tenant_id}:{idem_key}`    | Redis Hash      | 86400s (24h)           | Fingerprinted payload & cached `GenerateResponse` JSON        |
| `text:ratelimit:{tenant_id}:{window}` | Redis String    | 120s                   | Rolling token / request usage counter for rate limiting         |
| `arca:config:invalidate`              | Pub/Sub Channel | N/A                    | Broadcast channel for control-plane configuration invalidations |

### 5.2 Task State Machine

Generation tasks transition through the following lifecycle states managed by `TaskManager`:

```
               [PENDING]
                   |
                   | (Worker acquires concurrency permit)
                   v
              [PROCESSING]
                   |
         +---------+---------+
         |                   |
         | (Inference OK)    | (Exception / Guardrail Block)
         v                   v
    [COMPLETED]          [FAILED]
         ^
         |
    [CANCELLED] <--- (Triggered by POST /tasks/{id}/cancel)
```

- State transitions are performed atomically in Redis using an embedded Lua script (`apps/text/src/text/services/task_manager.py`) to prevent race conditions during concurrent polling and cancellations.

---

## 6. Error Handling & Resilience Matrix

The service maps internal domain exceptions to exact HTTP status codes and error payloads:

| Exception Class            | Trigger Condition                                           | HTTP Status | Response Code       | Recovery / Client Action                                |
| -------------------------- | ----------------------------------------------------------- | ----------- | ------------------- | ------------------------------------------------------- |
| `ValidationError`        | Missing required fields, invalid temperature/top_p          | `400`     | `INVALID_REQUEST` | Client fixes schema; do not retry without modification. |
| `UnauthorizedError`      | Missing or invalid `X-Service-Token`                      | `401`     | `UNAUTHORIZED`    | Verify shared `INTERNAL_ACCESS_TOKEN` configuration.  |
| `PreconditionRequired`   | Missing `X-Tenant-Id` header                              | `428`     | `MISSING_TENANT`  | Inject client tenant identifier header.                 |
| `ContentBlockedError`    | Input failed medical moderation (`/api/medical/validate`) | `422`     | `CONTENT_BLOCKED` | Non-retryable. Prompt violates clinical guidelines.     |
| `OutputRejectedError`    | Completion failed outbound medical screen                   | `422`     | `OUTPUT_REJECTED` | Non-retryable. Generated content was clinically unsafe. |
| `RateLimitExceededError` | Tenant exceeded allocated TPM or RPM                        | `429`     | `RATE_LIMITED`    | Client waits `Retry-After` seconds before retrying.   |
| `CircuitOpenError`       | Circuit breaker is OPEN for requested provider              | `503`     | `CIRCUIT_OPEN`    | Gateway degrades to fallback provider in chain.         |
| `ProviderTimeoutError`   | Inference exceeded wall-clock timeout floor                 | `504`     | `GATEWAY_TIMEOUT` | Use streaming or raise model timeout budget.            |
| `ProviderProtocolError`  | Upstream returned invalid JSON or truncated stream          | `502`     | `BAD_GATEWAY`     | Transient retry with exponential jittered backoff.      |

---

## 7. Security Design & Telemetry Guardrails

### 7.1 Multi-Layer PHI-Safe Telemetry Defense

The platform enforces strict HIPAA and PHI compliance across all logging and distributed tracing:

- **Layer 1: Enforced Boot-Time Pinning**:
  In production (`NODE_ENV=production`), `apps/text/src/text/core/config.py#L140-L149` validates that `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is explicitly set to `"NO_CONTENT"`. If unset or set to any other value, the application refuses to boot.
- **Layer 2: Zero-PHI Access Logging**:
  `AccessLogMiddleware` records request method, path, status, latency, tenant ID, and token usage counts, but **never** logs request bodies, prompt text, or model completions.
- **Layer 3: Header Stripping**:
  Outbound OTLP trace spans sanitize authorization headers, masking `X-Service-Token` and provider API keys.

---

## 8. Source Code Traceability Index

To facilitate rapid codebase navigation, the table below maps every key architectural concept to its exact source file, primary class, and entry point functions:

| Functional Responsibility              | File Path                                              | Primary Class / Function                                  | Line Numbers                 |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- | ---------------------------- |
| Lifespan & Application Setup           | `apps/text/src/text/main.py`                         | `lifespan()`, `create_app()`                          | `L178-L368`, `L369-L484` |
| Primary Generation Endpoint            | `apps/text/src/text/api/endpoints/generate.py`       | `generate()`, `_resolve_stream_idempotency()`         | `L404-L658`, `L276-L340` |
| SSE Resumption & Stream Tailing        | `apps/text/src/text/api/endpoints/stream.py`         | `stream_generation_events()`, `_replay_then_tail()`   | `L377-L402`, `L118-L200` |
| Internal Judge Safety Lane             | `apps/text/src/text/api/endpoints/judge.py`          | `judge()`, `_run_judge()`                             | `L180-L215`, `L218-L380` |
| Deep Health & Kubernetes Probes        | `apps/text/src/text/api/endpoints/health.py`         | `health_check()`, `readiness()`, `liveness()`       | `L92-L160`, `L210-L234`  |
| Provider Catalog & Reachability        | `apps/text/src/text/api/endpoints/providers.py`      | `list_providers()`, `probe_providers()`               | `L162-L191`                |
| Vector Embeddings (TEI)                | `apps/text/src/text/api/endpoints/embeddings.py`     | `create_embeddings()`                                   | `L28-L47`                  |
| Medical Translation (Sarvam)           | `apps/text/src/text/api/endpoints/translate.py`      | `translate()`                                           | `L29-L49`                  |
| Pydantic Request Schemas               | `apps/text/src/text/models/requests.py`              | `GenerateRequest`, `JudgeRequest`                     | `L86-L230`                 |
| Pydantic Response Schemas              | `apps/text/src/text/models/responses.py`             | `GenerateResponse`, `StreamTokenEvent`                | `L24-L110`                 |
| Bootstrap Transport Config             | `apps/text/src/text/core/config.py`                  | `Settings`, `TelemetryPhiGuardConfig`                 | `L52-L210`                 |
| Resource-Safety Floors                 | `apps/text/src/text/core/runtime_defaults.py`        | `LaneBudget`, `USER_LANE_FLOOR`, `JUDGE_LANE_FLOOR` | `L40-L176`                 |
| Control Plane Pull & Push Invalidation | `apps/text/src/text/core/effective_config.py`        | `EffectiveConfigClient.run_invalidation_listener()`     | `L45-L160`                 |
| Dynamic Credential Overrides           | `apps/text/src/text/core/connection.py`              | `ConnectionOverrides`                                   | `L15-L65`                  |
| Resumable Generation Hub               | `apps/text/src/text/routing/hub.py`                  | `GenerationHub`, `GenerationProducer`                 | `L35-L180`                 |
| Detached Stream Producer Loop          | `apps/text/src/text/routing/streaming.py`            | `run_generation_producer()`                             | `L45-L210`                 |
| Provider Base Interface                | `apps/text/src/text/providers/base.py`               | `LLMProvider` (abstract base class)                     | `L30-L120`                 |
| Dynamic Resizable Semaphore            | `apps/text/src/text/services/resizable_semaphore.py` | `ResizableSemaphore.acquire()`, `resize()`            | `L25-L95`                  |
| Fault-Tolerant Circuit Breaker         | `apps/text/src/text/services/circuit_breaker.py`     | `CircuitBreaker.allow_request()`, `record_failure()`  | `L35-L160`                 |
| Redis Task Persistence & Lua           | `apps/text/src/text/services/task_manager.py`        | `TaskManager.set_status()`, `get_task()`              | `L40-L220`                 |
| External Guardrail Client              | `apps/text/src/text/services/external_guardrail.py`  | `ExternalGuardrailClient.validate()`                    | `L42-L115`                 |
| Outbound Output Screen Gate            | `apps/text/src/text/services/output_gate.py`         | `gate_completion()`                                     | `L38-L92`                  |
