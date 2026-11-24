# LLM Service API Reference (`apps/text`)

This document provides a comprehensive, production-grade API specification for the **Text Generation & LLM Microservice** (`apps/text`). It details every public and internal endpoint, authentication requirement, request/response schema, validation constraint, status code, error payload, and internal execution flow mapped directly to source files and line numbers.

---

## Global Ingress & Authentication

### Base URLs & Networking
- **Port**: `8862` (configurable via `TEXT_PORT`, default: `8862`)
- **API Prefix**: `/api/v1`
- **Internal Service Posture**: `apps/text` is an internal service within the cluster mesh. Browser clients reach it strictly via the API Gateway (`apps/api` on port `3000`). Direct CORS is disabled (`apps/text/src/text/main.py#L437-L442`).

### Middleware Execution Order (LIFO)
1. `RequestContextMiddleware` (`hope_obs`): Extracts or generates `X-Request-ID`, captures `X-Tenant-Id`, binds trace contexts.
2. `AccessLogMiddleware` (`hope_obs`): Structured JSON logging without PHI.
3. `ServiceAuthMiddleware` (`apps/text/src/text/api/middleware/auth.py`):
   - Validates internal token against `INTERNAL_ACCESS_TOKEN` (or legacy `SERVICE_API_KEY`).
   - Rejects unauthenticated requests with `401 Unauthorized`.
   - Bypasses auth for: `/api/v1/health*`, `/metrics`, `/api/v1/docs`, `/api/v1/redoc`, `/api/v1/openapi.json`.
4. `PrometheusMiddleware` / `Instrumentator`: Exposes latency, status codes, and request counters at `/metrics`.

### Standard Headers
| Header | Type | Required | Description |
|---|---|---|---|
| `X-Service-Token` | string | Yes (or Bearer) | Shared secret matching `INTERNAL_ACCESS_TOKEN` |
| `Authorization` | string | Optional | `Bearer <INTERNAL_ACCESS_TOKEN>` alternative |
| `X-Tenant-Id` | string | Recommended | Multi-tenant identifier for rate limiting and telemetry attribution |
| `X-Request-ID` | string | Optional | Distributed tracing correlation ID (auto-generated if omitted) |
| `Idempotency-Key` | string | Optional | Prevents duplicate LLM inference executions across network retries |

---

## 1. Text Generation Endpoints

### 1.1 `POST /api/v1/generate` (Non-Streaming & Streaming)
**Source**: [`apps/text/src/text/api/endpoints/generate.py#L404-L658`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/generate.py#L404-L658)  
**Purpose**: Primary entry point for text generation, clinical summarization, Q&A, and structured LLM inference. Supports both synchronous single-shot JSON returns and chunked Server-Sent Events (SSE).

#### Request Headers
- `Content-Type`: `application/json`
- `X-Service-Token`: Required
- `X-Tenant-Id`: Required for rate limiting and billing
- `Idempotency-Key`: Optional (strongly recommended for non-streaming)

#### Request Body (`GenerateRequest`)
Defined in [`apps/text/src/text/models/requests.py#L86-L230`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/models/requests.py#L86-L230).

```json
{
  "prompt": "Summarize the clinical notes for patient admission.",
  "system_prompt": "You are a specialized clinical documentation assistant.",
  "messages": [
    {"role": "user", "content": "Summarize the clinical notes for patient admission."}
  ],
  "provider": "vllm",
  "model": "meta-llama/Llama-3-70b-Instruct",
  "temperature": 0.2,
  "top_p": 0.95,
  "max_tokens": 1024,
  "stream": false,
  "response_format": {
    "type": "json_object"
  },
  "stop": ["User:", "\n\n\n"],
  "seed": 42,
  "presence_penalty": 0.0,
  "frequency_penalty": 0.0,
  "provider_overrides": {
    "api_key": "local-key",
    "base_url": "http://hope-vllm:8000/v1",
    "custom_headers": {}
  },
  "lane": "user"
}
```

| Field | Type | Required | Default | Validation & Rules |
|---|---|---|---|---|
| `prompt` | string | Optional* | `""` | User prompt string. Either `prompt` or non-empty `messages` required. Max 200,000 chars. |
| `system_prompt` | string | Optional | `None` | High-priority system instructions. |
| `messages` | array[object] | Optional* | `None` | Multi-turn chat array (`role`: `system` \| `user` \| `assistant`, `content`: string). |
| `provider` | string | Optional | `None` | Provider ID (e.g. `openai`, `anthropic`, `vllm`, `ollama`, `lmstudio`, `bedrock`, `vertex`). If omitted, resolved via `PoolRouter`. |
| `model` | string | Optional | `None` | Specific model ID (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`). |
| `temperature` | float | Optional | `0.7` | `0.0 <= temperature <= 2.0` |
| `top_p` | float | Optional | `1.0` | `0.0 <= top_p <= 1.0` |
| `max_tokens` | integer | Optional | `1024` | `1 <= max_tokens <= 32768` |
| `stream` | boolean | Optional | `false` | `false` = synchronous JSON; `true` = SSE stream. |
| `response_format` | object | Optional | `None` | `{"type": "text"}` or `{"type": "json_object"}` or schema map. |
| `stop` | array[string] | Optional | `None` | Up to 4 stop sequences. |
| `seed` | integer | Optional | `None` | Deterministic sampling seed. |
| `presence_penalty`| float | Optional | `0.0` | `-2.0 <= presence_penalty <= 2.0` |
| `frequency_penalty`| float | Optional | `0.0` | `-2.0 <= frequency_penalty <= 2.0` |
| `provider_overrides`| object | Optional | `None` | Dynamic per-request credentials (`api_key`, `base_url`, `model`). |
| `lane` | string | Optional | `"user"` | Concurrency lane (`"user"` or `"judge"`). |

#### Responses

##### 1. Non-Streaming Success (`200 OK`)
**Content-Type**: `application/json`
```json
{
  "task_id": "gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z",
  "status": "completed",
  "text": "The patient was admitted with acute shortness of breath and fever...",
  "reasoning": null,
  "provider": "vllm",
  "model": "meta-llama/Llama-3-70b-Instruct",
  "usage": {
    "prompt_tokens": 85,
    "completion_tokens": 142,
    "total_tokens": 227
  },
  "stats": {
    "total_duration_ms": 1284.5,
    "inference_duration_ms": 1150.2,
    "input_gate_duration_ms": 65.1,
    "output_gate_duration_ms": 69.2,
    "first_token_duration_ms": null
  },
  "error": null,
  "cached": false
}
```

##### 2. Streaming Success (`200 OK`)
**Content-Type**: `text/event-stream`  
**Headers**: `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
```text
id: gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z:0
event: token
data: {"generation_id":"gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z","seq":0,"text":"The","delta":"The","created_at":"2026-11-18T13:45:00.120Z"}

id: gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z:1
event: token
data: {"generation_id":"gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z","seq":1,"text":"The patient","delta":" patient","created_at":"2026-11-18T13:45:00.145Z"}

id: gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z:2
event: terminal
data: {"generation_id":"gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z","seq":2,"status":"completed","error":null,"usage":{"prompt_tokens":85,"completion_tokens":2,"total_tokens":87}}
```

#### Error Status Codes
- `400 Bad Request`: Validation failure on request body parameters.
- `401 Unauthorized`: Missing or invalid `X-Service-Token`.
- `422 Unprocessable Entity`:
  - `ContentBlockedError`: Input prompt was flagged by medical moderation gate (`POST /api/medical/validate`).
  - `OutputRejectedError`: Model output was flagged by outbound medical screen (`POST /api/v1/guardrail/screen/outbound`).
- `429 Too Many Requests`: Exceeded tenant or provider TPM/RPM rate limits.
- `502 Bad Gateway`: Upstream LLM provider returned unparseable or protocol-invalid response.
- `503 Service Unavailable`: Circuit breaker is OPEN for the requested provider, or provider connection timed out.
- `504 Gateway Timeout`: Inference exceeded configured provider timeout budget.

#### Internal Execution Flow
1. Check `Idempotency-Key` via `_resolve_stream_idempotency` (`apps/text/src/text/api/endpoints/generate.py#L276`).
2. Resolve provider via `PoolRouter.resolve()` (`apps/text/src/text/services/pool_router.py`).
3. Screen input via `ExternalGuardrailClient.validate()` (`apps/text/src/text/services/external_guardrail.py#L42`).
4. Enforce tenant rate limits via `RateLimiter.check()` (`apps/text/src/text/services/rate_limiter.py#L80`).
5. Check circuit breaker state via `CircuitBreaker.allow_request()` (`apps/text/src/text/services/circuit_breaker.py#L112`).
6. Acquire concurrency permit via `ResizableSemaphore.acquire()` (`apps/text/src/text/services/resizable_semaphore.py#L45`).
7. Execute inference via `LLMProvider.generate()` or launch detached producer via `GenerationHub` (`apps/text/src/text/routing/hub.py#L88`).
8. If non-streaming: Screen completion via `gate_completion()` (`apps/text/src/text/services/output_gate.py#L38`).
9. Cache completed response in Redis (`text:idem:{key}`) with 24h TTL.
10. Release concurrency permit and return response.

---

## 2. Resumable Streaming & Task Lifecycle Endpoints

### 2.1 `GET /api/v1/generations/{generation_id}/stream`
**Source**: [`apps/text/src/text/api/endpoints/stream.py#L377-L402`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/stream.py#L377-L402)  
**Purpose**: Resumes or attaches to an active or completed streaming generation. Clients reconnecting after network drops provide `Last-Event-ID` or `?from_seq=N` to receive missed chunks before tailing live updates.

#### Query Parameters & Headers
| Parameter / Header | Type | Required | Description |
|---|---|---|---|
| `generation_id` | path string | Yes | Unique generation task ID |
| `from_seq` | query integer | Optional | Sequence number to resume from (default: 0) |
| `Last-Event-ID` | header string | Optional | Standard SSE resume cursor formatted as `<generation_id>:<seq>` |

#### Responses
- `200 OK`: `text/event-stream` delivering missed events from Redis Stream `text:stream:{generation_id}`, followed by live queue subscriptions.
- `404 Not Found`: Generation ID unknown, not found in TaskManager, and absent from Redis.

---

### 2.2 `GET /api/v1/tasks/{task_id}/stream`
**Source**: [`apps/text/src/text/api/endpoints/stream.py#L404-L429`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/stream.py#L404-L429)  
**Purpose**: Direct alias for `/generations/{generation_id}/stream` for unified task protocol compatibility.

---

### 2.3 `GET /api/v1/tasks/{task_id}`
**Source**: [`apps/text/src/text/api/endpoints/tasks.py#L43-L52`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/tasks.py#L43-L52)  
**Purpose**: Polls the execution status, text, error state, and token usage of a background or completed generation task.

#### Response (`200 OK`)
```json
{
  "task_id": "gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z",
  "status": "completed",
  "created_at": "2026-11-18T13:45:00.000Z",
  "updated_at": "2026-11-18T13:45:01.284Z",
  "text": "The patient was admitted...",
  "error": null,
  "usage": {
    "prompt_tokens": 85,
    "completion_tokens": 142,
    "total_tokens": 227
  }
}
```

---

### 2.4 `POST /api/v1/tasks/{task_id}/cancel` & `POST /api/v1/generations/{generation_id}/cancel`
**Source**: [`apps/text/src/text/api/endpoints/tasks.py#L54-L75`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/tasks.py#L54-L75)  
**Purpose**: Immediately terminates in-flight inference, cancels the producer `asyncio.Task`, closes upstream provider sockets, and updates task status to `cancelled`.

#### Response (`200 OK`)
```json
{
  "task_id": "gen_01HZX87Y9M5Q7P3N1B2V4C5X6Z",
  "status": "cancelled",
  "created_at": "2026-11-18T13:45:00.000Z",
  "updated_at": "2026-11-18T13:45:00.540Z",
  "text": "",
  "error": "Task was cancelled by client request",
  "usage": null
}
```

---

## 3. Internal Safety & Judge Lane Endpoints

### 3.1 `POST /api/v1/generate/internal/judge`
**Source**: [`apps/text/src/text/api/endpoints/judge.py#L180-L215`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/judge.py#L180-L215)  
**Purpose**: Dedicated inference endpoint for platform safety evaluators, clinical guardrail judges, and LLM-as-a-judge scoring.
- **Isolation**: Runs on an isolated concurrency budget (`JUDGE_LANE_FLOOR`: concurrency 2, queue 0, timeout 60s) completely partitioned from user requests.
- **Safety Posture**: Moderation bypass is permitted strictly because the judge evaluates adversarial attacks and toxic examples without triggering self-blocking.

#### Request Body (`JudgeRequest`)
```json
{
  "prompt": "Evaluate whether the following clinical output contains diagnostic hallucinations: [...]",
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.0,
  "max_tokens": 512,
  "provider_overrides": {
    "api_key": "sk-proj-...",
    "base_url": "https://api.openai.com/v1"
  }
}
```

#### Response (`200 OK`)
```json
{
  "judgment": "HALLUCINATION_DETECTED: FALSE",
  "score": 0.98,
  "explanation": "All clinical entities match the provided discharge summary accurately.",
  "provider": "openai",
  "model": "gpt-4o",
  "usage": {
    "prompt_tokens": 340,
    "completion_tokens": 28,
    "total_tokens": 368
  }
}
```

---

## 4. Provider Discovery & Probing Endpoints

### 4.1 `GET /api/v1/providers`
**Source**: [`apps/text/src/text/api/endpoints/providers.py#L162-L169`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/providers.py#L162-L169)  
**Purpose**: Returns all registered LLM providers, their supported models, credential postures, and streaming capabilities.

#### Response (`200 OK`)
```json
[
  {
    "name": "openai",
    "is_available": true,
    "supported_models": ["gpt-4o", "gpt-4o-mini", "o1-preview"],
    "credential_posture": "push_per_request",
    "supports_streaming": true,
    "supports_structured_output": true
  },
  {
    "name": "vllm",
    "is_available": true,
    "supported_models": ["meta-llama/Llama-3-70b-Instruct", "mistralai/Mistral-7B-Instruct-v0.3"],
    "credential_posture": "push_per_request",
    "supports_streaming": true,
    "supports_structured_output": true
  },
  {
    "name": "lmstudio",
    "is_available": false,
    "supported_models": [],
    "credential_posture": "push_per_request",
    "supports_streaming": true,
    "supports_structured_output": false
  }
]
```

---

### 4.2 `POST /api/v1/providers/probe`
**Source**: [`apps/text/src/text/api/endpoints/providers.py#L171-L191`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/providers.py#L171-L191)  
**Purpose**: Actively probes provider connectivity, validating upstream reachability and round-trip latency using supplied test connections.

#### Request Body (`ProbeRequest`)
```json
{
  "providers": ["vllm", "openai"],
  "connections": {
    "vllm": {
      "base_url": "http://hope-vllm:8000/v1",
      "api_key": "none"
    }
  }
}
```

#### Response (`200 OK`)
```json
[
  {
    "provider": "vllm",
    "status": "healthy",
    "latency_ms": 14.2,
    "models_discovered": ["meta-llama/Llama-3-70b-Instruct"],
    "error": null
  },
  {
    "provider": "openai",
    "status": "degraded",
    "latency_ms": 420.8,
    "models_discovered": [],
    "error": "Authentication failed: invalid_api_key"
  }
]
```

---

## 5. Embeddings & Translation Endpoints

### 5.1 `POST /api/v1/embeddings`
**Source**: [`apps/text/src/text/api/endpoints/embeddings.py#L28-L47`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/embeddings.py#L28-L47)  
**Purpose**: Generates high-dimensional vector embeddings for clinical text, RAG vector searches, and document chunk indexing.

#### Request Body (`EmbeddingRequest`)
Defined in [`apps/text/src/text/models/embedding.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/models/embedding.py).
```json
{
  "inputs": [
    "Hypertension secondary to renovascular stenosis.",
    "Patient prescribed Lisinopril 10mg daily."
  ],
  "model": "BAAI/bge-large-en-v1.5",
  "normalize": true,
  "truncate": true
}
```

#### Response (`200 OK`)
```json
{
  "model": "BAAI/bge-large-en-v1.5",
  "embeddings": [
    [0.0124, -0.0452, 0.0891, "... 1024 floats total ..."],
    [0.0341, -0.0118, 0.0543, "... 1024 floats total ..."]
  ],
  "usage": {
    "prompt_tokens": 24,
    "total_tokens": 24
  }
}
```

---

### 5.2 `POST /api/v1/translate`
**Source**: [`apps/text/src/text/api/endpoints/translate.py#L29-L49`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/translate.py#L29-L49)  
**Purpose**: Translates clinical consultations and medical instructions into regional languages (e.g. Hindi, Tamil, Telugu) via specialized translation backends (Sarvam AI).

#### Request Body (`TranslateRequest`)
```json
{
  "input_text": "Please take one tablet twice daily after meals.",
  "source_language_code": "en-IN",
  "target_language_code": "hi-IN",
  "speaker_gender": "female",
  "mode": "formal"
}
```

#### Response (`200 OK`)
```json
{
  "translated_text": "कृपया भोजन के बाद दिन में दो बार एक गोली लें।",
  "source_language_code": "en-IN",
  "target_language_code": "hi-IN",
  "model": "sarvam-translate:v1"
}
```

---

## 6. Health & Telemetry Endpoints

### 6.1 Kubernetes Probes
**Source**: [`apps/text/src/text/api/endpoints/health.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/health.py)

| Endpoint | Probe Type | Check Logic | Expected Response |
|---|---|---|---|
| `GET /api/v1/health/live` | Liveness | Verifies event loop is responsive | `200 OK` `{"status": "alive"}` |
| `GET /api/v1/health/startup` | Startup | Verifies lifespan initialization and registries ready | `200 OK` `{"status": "started"}` |
| `GET /api/v1/health/ready` | Readiness | Checks Redis connectivity and shutdown state | `200 OK` `{"status": "ready"}` (or `503` during drain) |
| `GET /api/v1/health` | Deep Health | Reports Redis ping, memory RSS, pool health, active semaphores | `200 OK` (full health payload) |

#### Deep Health Response Example (`GET /api/v1/health`):
```json
{
  "status": "healthy",
  "version": "2.0.0",
  "timestamp": "2026-11-18T13:45:00.000Z",
  "redis": {
    "status": "connected",
    "latency_ms": 1.2
  },
  "memory": {
    "rss_mb": 142.5,
    "vms_mb": 420.1
  },
  "providers": {
    "registered_count": 8,
    "active_count": 7
  },
  "concurrency": {
    "user_lane_capacity": 4,
    "judge_lane_capacity": 2
  }
}
```

---

### 6.2 Telemetry & Metrics (`GET /metrics`)
**Source**: [`apps/text/src/text/main.py#L477-L480`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/main.py#L477-L480)  
**Purpose**: Scrape target for Prometheus collector. Exposes:
- `text_requests_total{provider, model, status}`
- `text_request_duration_seconds{provider, model, lane}`
- `text_tokens_generated_total{provider, model, type="prompt|completion"}`
- `text_circuit_breaker_state{provider}` (0=Closed, 1=Half-Open, 2=Open)
- `text_active_permits{provider, lane}`

