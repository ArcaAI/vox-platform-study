# LLM Service API Names & Specification Directory

This document details every API endpoint, internal contract, and upstream wire interface involved in the LLM service lifecycle across the **Vox Platform** ([`apps/api`](file:///Users/apple/Desktop/project-hope/apps/api) Gateway, [`apps/text`](file:///Users/apple/Desktop/project-hope/apps/text) Generation Microservice, and [`apps/guardrail`](file:///Users/apple/Desktop/project-hope/apps/guardrail) Safety Service).

---

## 1. Quick API Reference Index

```
[External Clients / UI / SDK]
        │
        ├── POST /api/v1/text-generations/generate
        ├── POST /api/v1/text-generations/generate/assembled
        ├── GET  /api/v1/text-generations/tasks/:taskId/stream
        ├── GET  /api/v1/text-generations/tasks/:taskId
        ├── POST /api/v1/text-generations/tasks/:taskId/cancel
        ├── GET  /api/v1/text-generations/providers
        ├── POST /api/smr/api/v1/summary/sync
        ├── POST /api/smr/api/v1/presummary
        └── POST /api/v1/auth/stream-ticket
        │
        ▼ (Internal Hop: X-Service-Token + X-Tenant-Id)
[apps/text Microservice :8862]
        ├── POST /api/v1/generate
        ├── POST /api/v1/generate/internal/judge
        ├── GET  /api/v1/tasks/{task_id}/stream
        ├── GET  /api/v1/generations/{generation_id}/stream
        ├── GET  /api/v1/tasks/{task_id}
        ├── POST /api/v1/tasks/{task_id}/cancel
        ├── POST /api/v1/generations/{generation_id}/cancel
        ├── GET  /api/v1/providers
        ├── POST /api/v1/providers/probe
        ├── POST /api/v1/embeddings
        ├── POST /api/v1/translate
        ├── GET  /api/v1/health (health/live, ready, startup)
        └── GET  /metrics
        │
        ├──► [apps/guardrail :8861]
        │     ├── POST /api/medical/validate
        │     └── POST /api/v1/guardrail/screen/outbound
        │
        ├──► [apps/api Gateway Control Plane :3000]
        │     ├── GET  /internal/effective-config
        │     └── POST /internal/service-releases/register
        │
        └──► [Cloud & Self-Hosted LLM Providers]
              ├── POST https://api.openai.com/v1/chat/completions
              ├── POST https://{resource}.openai.azure.com/.../chat/completions
              ├── POST https://api.anthropic.com/v1/messages
              ├── POST https://bedrock-runtime.{region}.amazonaws.com/model/...
              ├── POST https://{location}-aiplatform.googleapis.com/...
              ├── POST http://{vllm_host}:{port}/v1/chat/completions
              ├── POST http://{ollama_host}:{port}/api/chat
              ├── POST http://{lmstudio_host}:{port}/v1/chat/completions
              ├── POST http://{llamacpp_host}:{port}/completion
              ├── POST http://{tei_host}:{port}/embed
              └── POST https://api.sarvam.ai/translate
```

---

## 2. Gateway Client-Facing APIs (`apps/api`)

### 2.1 Standard Text Generation
* **API Name**: Generate Text Proxy
* **Route**: `POST /api/v1/text-generations/generate`
* **Controller**: [`TextProxyController.generate()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts#L721)
* **File**: `apps/api/src/modules/streaming/text-proxy.controller.ts`
* **Auth & Guards**:
  * `UnifiedAuthGuard` (Bearer JWT / Service Account / API Key)
  * `@RequiredScopes('consultation:report:write')`
  * `@RequiredSvcScopes('svc:consultation:report:write')`
  * `@Authorize()`
* **Request Schema (`TextGenerateRequest`)**:
  ```json
  {
    "prompt": "string (required)",
    "system_prompt": "string (optional)",
    "provider": "string (optional: openai | anthropic | azure-openai | bedrock | vertex | vllm | ollama | lm-studio | llama-cpp)",
    "model": "string (optional: resolves via HarnessPolicy if omitted)",
    "temperature": 0.2,
    "max_tokens": 1000,
    "top_p": 1.0,
    "stream": false,
    "response_format": {
      "type": "text | json | json_schema",
      "json_schema": {},
      "strict": true
    },
    "reasoning": {
      "enabled": true,
      "effort": "minimal | low | medium | high"
    }
  }
  ```
* **Response (Sync `stream: false`)**: `200 OK`
  ```json
  {
    "task_id": "gen_01928374...",
    "status": "completed",
    "content": "Generated text completion...",
    "reasoning": null,
    "provider": "openai",
    "model": "gpt-4o",
    "usage": {
      "prompt_tokens": 128,
      "completion_tokens": 45,
      "total_tokens": 173
    },
    "latency_ms": 1240,
    "finish_reason": "stop"
  }
  ```
* **Response (Async Stream Handshake `stream: true`)**: `200 OK`
  ```json
  {
    "task_id": "gen_01928374...",
    "status": "streaming",
    "stream_url": "text-generations/tasks/gen_01928374.../stream",
    "created_at": "2026-10-07T12:00:00Z"
  }
  ```

---

### 2.2 Server-Side Assembled Generation
* **API Name**: Assembled Generation (RAG / Context Assembly)
* **Route**: `POST /api/v1/text-generations/generate/assembled`
* **Controller**: [`TextProxyController.generateAssembled()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts#L1166)
* **File**: `apps/api/src/modules/streaming/text-proxy.controller.ts`
* **Auth & Guards**: Same as standard generate; debug flag requires `SUPER_ADMIN` or `TENANT_ADMIN`.
* **Request Schema (`AssembledGenerateRequest`)**:
  ```json
  {
    "type": "pre-summary | summary (required)",
    "visit_type": "string (optional: new_visit | referral | tenant custom)",
    "context_item_ids": ["uuid-1", "uuid-2"],
    "message": "string (mutually exclusive with context_item_ids)",
    "prompt_template_id": "uuid (optional)",
    "dna_writing_style_id": "uuid (optional)",
    "provider": "string (optional)",
    "model": "string (optional)",
    "temperature": 0.2,
    "max_tokens": 1500,
    "stream": false,
    "debug": false
  }
  ```
* **Internal Behavior**:
  1. Resolves and verifies tenant boundaries on `ContextItemRepository` rows.
  2. Extracts attachment files from `BlobStorageService` (capped at 200,000 characters).
  3. Resolves template from `PromptTemplateRepository` (verifying `USER_PERSONAL` template ownership).
  4. Injects clinician DNA style text via `IDnaWritingStyleService.getEffectiveStyleText()`.
  5. Assembles composite prompt and forwards to Text service.

---

### 2.3 Resumable Stream Subscription
* **API Name**: Stream Task Events (SSE)
* **Route**: `GET /api/v1/text-generations/tasks/:taskId/stream`
* **Controller**: [`TextProxyController.streamTaskEvents()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts#L981)
* **File**: `apps/api/src/modules/streaming/text-proxy.controller.ts`
* **Auth**:
  * `Authorization: Bearer <JWT>` OR single-use ticket in query: `?ticket=<ticket>`
  * `@StreamScope({ namespace: 'text_task', param: 'taskId' })`
* **Request Headers**:
  * `Accept: text/event-stream`
  * `Last-Event-ID: <seq>` *(optional: sequence cursor for gapless stream resumption)*
* **Response Format**: Server-Sent Events stream (`Content-Type: text/event-stream`)
  ```
  event: delta
  id: gen_0192:1
  data: {"type":"delta","delta":"The patient presents with "}

  event: delta
  id: gen_0192:2
  data: {"type":"delta","delta":"persistent cough for 2 weeks."}

  :keepalive

  event: done
  id: gen_0192:3
  data: {"type":"done","content":"...","usage":{"prompt_tokens":120,"completion_tokens":25,"total_tokens":145},"usage_detail":{...}}
  ```

---

### 2.4 Task Status & Cancellation
* **API Name**: Get Task Status
  * **Route**: `GET /api/v1/text-generations/tasks/:taskId`
  * **Controller**: [`TextProxyController.getTaskStatus()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts#L904)
  * **Purpose**: Query async task state, error messages, and completed content.
* **API Name**: Cancel Generation Task
  * **Route**: `POST /api/v1/text-generations/tasks/:taskId/cancel`
  * **Controller**: [`TextProxyController.cancelTask()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts#L934)
  * **Purpose**: Aborts in-flight generation in `GenerationHub` and sets task status to `CANCELLED`.

---

### 2.5 Clinical Summarization APIs
* **API Name**: Synchronous Clinical Summary
  * **Route**: `POST /api/smr/api/v1/summary/sync`
  * **Controller**: [`TextCompatController.summarySync()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/text-compat/text-compat.controller.ts#L309)
  * **Purpose**: Clinical encounter summarization. Binds prompt to `ENHANCED_SUMMARY_SCHEMA` or department schemas for structured JSON output.
* **API Name**: Clinical Pre-Summary
  * **Route**: `POST /api/smr/api/v1/presummary`
  * **Controller**: [`TextCompatController.presummary()`](file:///Users/apple/Desktop/project-hope/apps/api/src/modules/text-compat/text-compat.controller.ts#L588)
  * **Purpose**: Fast pre-summary from consultation transcript with default 800 token ceiling.

---

## 3. Internal Microservice APIs (`apps/text`)

### 3.1 Core Text Generation
* **API Name**: Generate Text Core
* **Route**: `POST /api/v1/generate`
* **Handler**: [`generate()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/generate.py#L404)
* **File**: `apps/text/src/text/api/endpoints/generate.py`
* **Auth**: `X-Service-Token` (HMAC match against `INTERNAL_ACCESS_TOKEN`) + mandatory `X-Tenant-Id`.
* **Headers Accepted**:
  * `X-Service-Token: <token>`
  * `X-Tenant-Id: <uuid | tenantless:reason>`
  * `Idempotency-Key: <key>` *(optional: 24h deduplication cache)*
  * `Accept: text/event-stream` *(triggers streaming mode)*
* **Execution Sequence**:
  1. Verifies shutdown state (`shutdown_manager`).
  2. Degrade-away check via `PoolHealthTracker`.
  3. Checks Redis idempotency key `text:idem:{key}`.
  4. Calls Phase 1 Input Guardrail (`POST /api/medical/validate`).
  5. Enforces rate limits (`RateLimitTracker`), queues (`ProviderQueue`), and circuit breakers (`CircuitBreaker`).
  6. Dispatches to provider (`generate()` or `GenerationHub.start()`).
  7. Post-receive output screening (`gate_completion()`).
  8. Caches result and returns JSON or SSE stream.

---

### 3.2 Safety Plane Judge Lane
* **API Name**: Internal Safety Judge
* **Route**: `POST /api/v1/generate/internal/judge`
* **Handler**: [`judge()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/judge.py#L180)
* **File**: `apps/text/src/text/api/endpoints/judge.py`
* **Caller**: `apps/guardrail` (:8861)
* **Purpose**:
  * Runs LLM evaluations on an isolated semaphore and circuit breaker budget (`judge_semaphores`).
  * Gated with `judge_scope()` tripwire: raises `GuardrailRecursionError` if any recursive guardrail screening is attempted.
  * Bypasses generation queues and rate limits so safety judgements are never starved by user-facing saturation.

---

### 3.3 Internal Stream Subscriptions
* **API Name**: Stream Task Events Internal
  * **Route**: `GET /api/v1/tasks/{task_id}/stream`
  * **Handler**: [`stream_task_events()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/stream.py#L170)
  * **File**: `apps/text/src/text/api/endpoints/stream.py`
  * **Purpose**: Internal SSE subscription with `Last-Event-ID` or `?last_event_id=` sequence cursor.
* **API Name**: Stream Generation Events Internal
  * **Route**: `GET /api/v1/generations/{generation_id}/stream`
  * **Handler**: [`stream_generation_events()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/stream.py#L242)
  * **Purpose**: Alias under modern generation ID convention.

---

### 3.4 Task Status & Cancellation Internal
* **API Name**: Get Task Internal
  * **Route**: `GET /api/v1/tasks/{task_id}`
  * **Handler**: [`get_task()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/tasks.py#L43)
  * **File**: `apps/text/src/text/api/endpoints/tasks.py`
* **API Name**: Cancel Task Internal
  * **Route**: `POST /api/v1/tasks/{task_id}/cancel`
  * **Handler**: [`cancel_task()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/tasks.py#L54)
* **API Name**: Cancel Generation Internal
  * **Route**: `POST /api/v1/generations/{generation_id}/cancel`
  * **Handler**: [`cancel_generation()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/tasks.py#L66)

---

### 3.5 Provider Enumeration & Probing
* **API Name**: List Providers
  * **Route**: `GET /api/v1/providers`
  * **Handler**: [`list_providers()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/providers.py#L162)
  * **File**: `apps/text/src/text/api/endpoints/providers.py`
  * **Purpose**: Probes all registered provider engines in parallel with a 5-second per-provider cap.
* **API Name**: Connection-Aware Provider Probe
  * **Route**: `POST /api/v1/providers/probe`
  * **Handler**: [`probe_providers()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/providers.py#L171)
  * **File**: `apps/text/src/text/api/endpoints/providers.py`
  * **Purpose**: Accepts tenant connection configurations from Gateway and probes caller-specific BYOK endpoints or local models (LM Studio / Ollama).

---

### 3.6 Auxiliary Endpoints (Embeddings & Translation)
* **API Name**: Create Text Embeddings
  * **Route**: `POST /api/v1/embeddings`
  * **Handler**: [`create_embeddings()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/embeddings.py#L28)
  * **File**: `apps/text/src/text/api/endpoints/embeddings.py`
  * **Purpose**: Generates vector embeddings via Text Embeddings Inference (TEI).
* **API Name**: Translate Text
  * **Route**: `POST /api/v1/translate`
  * **Handler**: [`translate()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/translate.py#L39)
  * **File**: `apps/text/src/text/api/endpoints/translate.py`
  * **Purpose**: Indic and multi-lingual translation via Sarvam AI.

---

### 3.7 Health, Probes & Metrics
* **API Name**: Detailed Health Check
  * **Route**: `GET /api/v1/health`
  * **Handler**: [`health_check()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/health.py#L93)
  * **Purpose**: Informational diagnostics (Redis latency, provider availability, effective config timestamp; always 200).
* **API Name**: Liveness Probe
  * **Route**: `GET /api/v1/health/live`
  * **Handler**: [`liveness()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/health.py#L163)
  * **Purpose**: Kubernetes liveness probe (200 OK if event loop responsive).
* **API Name**: Readiness Probe
  * **Route**: `GET /api/v1/health/ready`
  * **Handler**: [`readiness()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/health.py#L211)
  * **Purpose**: Kubernetes readiness probe (requires Redis ping + >=1 healthy provider; returns 503 if not ready).
* **API Name**: Startup Probe
  * **Route**: `GET /api/v1/health/startup`
  * **Handler**: [`startup()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/api/endpoints/health.py#L169)
  * **Purpose**: Kubernetes startup probe (checks lifespan initialization and gateway registration).
* **API Name**: Prometheus Metrics
  * **Route**: `GET /metrics`
  * **Handler**: Prometheus Instrumentator in [`main.py:L479`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/main.py#L479)
  * **Purpose**: Scrapes active generations, token counts, inference latencies, and circuit breaker metrics.

---

## 4. Safety & Guardrail APIs (`apps/guardrail`)

Hosted by the Medical Guardrail Service on Port `8861`:

| API Name | Endpoint | Client Location | Purpose & Contract |
| :--- | :--- | :--- | :--- |
| **Validate Medical Intent** | `POST /api/medical/validate` | [`ExternalGuardrailClient.validate()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/external_guardrail.py#L99) | Pre-generation screening. Evaluates prompt for clinical necessity and relevance. Fails closed (503 if unreachable, 422 if non-medical). |
| **Screen Outbound Output** | `POST /api/v1/guardrail/screen/outbound` | [`ExternalGuardrailClient.screen_output()`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/services/external_guardrail.py#L165) | Post-generation screening (TASK-871). Evaluates model output before delivery for toxicity, refusal, and PII containment relative to prompt. |

---

## 5. Control Plane & Integration APIs (Called by `apps/text`)

Hosted by Gateway on Port `3000`:

| API Name | Endpoint | Client Location | Purpose |
| :--- | :--- | :--- | :--- |
| **Get Effective Config** | `GET /internal/effective-config` | [`EffectiveConfigClient`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/core/effective_config.py) | Dynamic control plane pull: refreshes live rate-limit ceilings, circuit breaker thresholds, and timeout overrides. |
| **Service Release Registration** | `POST /internal/service-releases/register` | `start_registration()` in [`main.py:L315`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/main.py#L315) | Heartbeat registration of running Git SHA, build version, and environment. |

---

## 6. Upstream LLM Provider Wire APIs

Invoked by adapter classes in [`apps/text/src/text/providers/`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers):

| Provider Name | Upstream Wire Endpoint | Adapter File | Protocol / SDK |
| :--- | :--- | :--- | :--- |
| **OpenAI** | `POST https://api.openai.com/v1/chat/completions` | [`openai.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/openai.py) | `AsyncOpenAI` SDK (BYOK key) |
| **Azure OpenAI** | `POST https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=...` | [`azure_openai.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/azure_openai.py) | `AsyncAzureOpenAI` SDK (Azure BYOK) |
| **Anthropic** | `POST https://api.anthropic.com/v1/messages` | [`anthropic.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/anthropic.py) | `AsyncAnthropic` SDK |
| **AWS Bedrock** | `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke-with-response-stream` | [`bedrock.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/bedrock.py) | `aioboto3` (AWS SigV4 auth) |
| **Google Vertex** | `POST https://{location}-aiplatform.googleapis.com/.../models/{model}:streamGenerateContent` | [`vertex.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/vertex.py) | `google-genai` SDK |
| **vLLM** | `POST http://{vllm_host}:{port}/v1/chat/completions` | [`vllm.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/vllm.py) | HTTP REST / SSE |
| **Ollama** | `POST http://{ollama_host}:{port}/api/chat`<br>`GET http://{ollama_host}:{port}/api/tags` | [`ollama.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/ollama.py) | HTTP REST / NDJSON |
| **LM Studio** | `POST http://{lmstudio_host}:{port}/v1/chat/completions`<br>`GET http://{lmstudio_host}:{port}/api/v0/models` | [`lmstudio.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/lmstudio.py) | HTTP REST / SSE (with TTL hint) |
| **llama.cpp** | `POST http://{llamacpp_host}:{port}/completion` | [`llama_cpp.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/llama_cpp.py) | HTTP REST / SSE |
| **TEI Embeddings** | `POST http://{tei_host}:{port}/embed` | [`tei_embed.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/providers/tei_embed.py) | HTTP REST |
| **Sarvam AI** | `POST https://api.sarvam.ai/translate` | [`sarvam.py`](file:///Users/apple/Desktop/project-hope/apps/text/src/text/translation/sarvam.py) | HTTPS REST |
