# LLM Service Architecture & Visual Specifications (`apps/text`)

This document provides architectural blueprints and visual flowcharts for the HOPE Text Generation & LLM Service (`apps/text`). Every diagram strictly reflects actual codebase implementations.

---

## 1. High-Level System Architecture

`apps/text` is an asynchronous, high-throughput Python/FastAPI microservice running on port `8862`. It serves as the platform's multi-provider LLM gateway, summarization engine, translation broker, and embeddings provider.

```mermaid
flowchart TD
    subgraph ClientTier["Client Tier (Web / Mobile / SDK)"]
        DoctorUI["Clinician Console / Doctor UI"]
        MobileApp["Mobile / Tablet App"]
        AdminUI["Admin Console (:5173)"]
        PartnerClient["External Partner API / SDK"]
    end

    subgraph GatewayTier["API Gateway & Control Plane (apps/api :3000)"]
        GatewayMW["Metrics & ValidationPipe"]
        GatewayGuards["Guards: Throttler -> Cls -> UnifiedAuth -> Consent"]
        Quota["Monthly Token Entitlements Gate"]
        Enrichment["RAG Context Assembly & DNA Style Injection"]
        BYOK["Provider Connection & BYOK Credential Resolution"]
        Proxy["TextProxyController / TextCompatController"]
    end

    subgraph ServiceMesh["Peer Service Callers"]
        Harness["apps/harness (Temporal Workflow Runner)"]
        NLP["apps/nlp (Clinical NLP Service)"]
        GuardrailIn["apps/guardrail (Medical Policy Evaluator)"]
    end

    subgraph TextService["apps/text Service (:8862)"]
        direction TB
        AuthMW["ServiceAuthMiddleware (X-Service-Token, X-Tenant-Id)"]
        PoolRouter["PoolHealthTracker & Pool Router (Degrade Failover)"]
        IdemEngine["Idempotency Cache Engine (text:idem)"]
        InputGate["Input Moderation Gate (POST /api/medical/validate)"]
        Admission["Admission: RateLimitTracker (RPM/TPM) & ProviderQueue"]
        CircuitBreaker["CircuitBreaker & ResizableSemaphore"]
        Hub["GenerationHub / TaskManager (Resumable Streaming)"]
        OutputGate["Post-Receive Output Gate (POST /screen/outbound)"]
        UsageEngine["Token Usage & Attribution Engine (UsageDetail)"]
    end

    subgraph PeerSafety["Safety Plane"]
        GuardrailSvc["apps/guardrail Service (:8861)"]
    end

    subgraph Persistence["Storage & Caching Layer"]
        RedisCluster[("Redis (:6379)\n• Task State (text:task:id)\n• Streams (text:stream:id)\n• Idempotency (text:idem)\n• Pub/Sub (arca:config:invalidate)")]
        PostgresDB[("PostgreSQL Database (:5432)\n• Tenant Accounts & BYOK Keys\n• Token Quotas & Usage Ledgers")]
    end

    subgraph UpstreamProviders["External AI Inference Providers"]
        Commercial["Cloud Providers\n• OpenAI / Azure OpenAI\n• Anthropic Claude\n• AWS Bedrock\n• Google Vertex AI"]
        LocalEngines["Self-Hosted Engines\n• vLLM\n• Ollama\n• LM Studio\n• llama.cpp"]
        Translation["Translation\n• Sarvam AI (Indian Languages)"]
        Embeddings["Embeddings\n• HuggingFace TEI (tei-embed)"]
    end

    subgraph Observability["Telemetry & Monitoring"]
        Prometheus["Prometheus Metrics (:8862/metrics)"]
        OTelCollector["OpenTelemetry gRPC Collector"]
    end

    %% Client traffic
    DoctorUI --> GatewayMW
    MobileApp --> GatewayMW
    AdminUI --> GatewayMW
    PartnerClient --> GatewayMW

    %% Gateway Pipeline
    GatewayMW --> GatewayGuards
    GatewayGuards --> Quota
    Quota <--> PostgresDB
    Quota --> Enrichment
    Enrichment <--> PostgresDB
    Enrichment --> BYOK
    BYOK <--> PostgresDB
    BYOK --> Proxy

    %% Execution Routes
    Proxy --> AuthMW
    Harness --> AuthMW
    NLP --> AuthMW
    GuardrailIn -->|"POST /generate/internal/judge"| AuthMW

    %% Internal Text Pipeline
    AuthMW --> PoolRouter
    PoolRouter --> IdemEngine
    IdemEngine <--> RedisCluster
    IdemEngine --> InputGate
    InputGate -->|"POST /api/medical/validate"| GuardrailSvc
    InputGate --> Admission
    Admission --> CircuitBreaker
    CircuitBreaker --> Hub
    Hub --> Commercial
    Hub --> LocalEngines
    Hub --> Translation
    Hub --> Embeddings
    Hub --> OutputGate
    OutputGate -->|"POST /screen/outbound"| GuardrailSvc
    OutputGate --> UsageEngine
    UsageEngine <--> RedisCluster
    UsageEngine --> Prometheus
    UsageEngine --> OTelCollector

    %% Client Response Returns
    Hub -.-> Proxy
    Proxy -.-> DoctorUI
    Proxy -.-> MobileApp
    Proxy -.-> PartnerClient
```

---

## 2. Internal Component Architecture (`apps/text`)

This diagram details the internal modular structure inside `apps/text/src/text`.

```mermaid
flowchart TD
    subgraph IngressLayer["1. Ingress & Security Layer"]
        AuthMiddleware["ServiceAuthMiddleware (api/middleware/auth.py)\n• X-Service-Token constant-time verification\n• X-Tenant-Id binding (428 if missing)\n• EXEMPT_PATHS bypass (/health, /metrics)"]
        ExceptionHandlers["Exception Handlers (core/exception_handlers.py)\n• Maps domain exceptions to standard JSON ErrorResponse"]
    end

    subgraph RoutingLayer["2. Routing & Admission Control"]
        PoolRouterMod["Pool Router (services/pool_router.py)\n• Re-routes from unhealthy pool to fallback_provider"]
        HealthTracker["PoolHealthTracker (services/pool_health.py)\n• In-memory provider status cache updated by /health"]
        Idempotency["Idempotency Filter (api/endpoints/generate.py)\n• Redis text:idem:{key} 24h cache check"]
        RateLimiterMod["RateLimitTracker (services/rate_limiter.py)\n• Rolling-window RPM & TPM tracker"]
        QueueMod["ProviderQueue (services/provider_queue.py)\n• Priority queue for throttled requests"]
        CircuitBreakerMod["CircuitBreaker (services/circuit_breaker.py)\n• CLOSED -> OPEN -> HALF_OPEN states"]
        SemaphoreMod["ResizableSemaphore (services/resizable_semaphore.py)\n• Live-adjustable concurrent permit limiter"]
    end

    subgraph SafetyLayer["3. Clinical Safety Plane"]
        ExtGuardrail["ExternalGuardrailClient (services/external_guardrail.py)\n• Input: POST /api/medical/validate (Fail-Closed)\n• Output: POST /api/v1/guardrail/screen/outbound"]
        OutputGateMod["Output Gate (services/output_gate.py)\n• Toxicity, refusal, and PII-leakage validation"]
        JudgeGuard["Judge Scope Guard (services/judge_guard.py)\n• assert_not_in_judge_scope cycle tripwire"]
    end

    subgraph HubLayer["4. Execution Hub & Task Lifecycle"]
        GenHub["GenerationHub (routing/hub.py)\n• Producer-Subscriber detached execution\n• Gapless resumption via in-memory ring buffer"]
        TaskMgr["TaskManager (services/task_manager.py)\n• Redis TaskState hash updates (Lua scripts)\n• Redis Stream chunk appender (XADD)"]
        StreamingProd["Streaming Producer (routing/streaming.py)\n• Batch chunk coalescing (32 chunks / 25ms)\n• Wall-clock cancel flag polling"]
        ShutdownMgr["ShutdownManager (services/shutdown_manager.py)\n• Active task counter & graceful 30s drain"]
    end

    subgraph ProviderLayer["5. Inference Adapters & Pooling"]
        Registry["ProviderRegistry (providers/base.py)\n• Lazy factory-driven provider instantiation"]
        ConnectionPool["Transport Pool (providers/pool.py)\n• HTTPX / HTTPX2 pooled AsyncClient\n• Wire byte counter (count_provider_bytes)"]
        ClientCache["Client Cache (providers/clients.py)\n• Isolated by (provider, base_url, credential)"]
        CloudAdapters["Cloud Adapters:\n• OpenAIProvider\n• AzureOpenAIProvider\n• AnthropicProvider\n• BedrockProvider\n• VertexProvider"]
        LocalAdapters["Self-Hosted Adapters:\n• VllmProvider\n• OllamaProvider\n• LMStudioProvider\n• LlamaCppProvider\n• OpenAICompatProvider"]
        SpecializedAdapters["Specialized:\n• SarvamTranslateProvider\n• TeiEmbedProvider"]
    end

    subgraph ControlPlane["6. Dynamic Control Plane"]
        EffConfig["EffectiveConfigClient (core/effective_config.py)\n• Pulls GET /internal/effective-config?service=text\n• 60s TTL jittered cache & negative caching\n• Subscribes to Redis arca:config:invalidate"]
        LimitsEngine["Runtime Limits (services/runtime_limits.py)\n• Live updates to Semaphores, Breakers & RateLimiters"]
    end

    IngressLayer --> RoutingLayer
    RoutingLayer --> SafetyLayer
    SafetyLayer --> HubLayer
    HubLayer --> ProviderLayer
    ControlPlane --> RoutingLayer
    ControlPlane --> SafetyLayer
    ControlPlane --> ProviderLayer
```

---

## 3. End-to-End Request Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Client as Clinician UI
    participant Gateway as apps/api Gateway
    participant Postgres as PostgreSQL
    participant Text as apps/text Service
    participant Redis as Redis Cache
    participant Guardrail as apps/guardrail
    participant Upstream as Upstream Provider (e.g. OpenAI)

    Client->>Gateway: POST /api/v1/text-generations/generate
    Note over Gateway: UnifiedAuthGuard validates JWT, binds X-Tenant-Id

    Gateway->>Postgres: assertLlmAllowance() (monthly token quota check)
    alt Monthly Quota Saturated
        Gateway-->>Client: 429 Too Many Requests
    end

    Gateway->>Postgres: RAG context retrieval & BYOK credential resolution
    Gateway->>Text: POST /api/v1/generate (X-Service-Token, X-Tenant-Id, Idempotency-Key)
    Note over Text: ServiceAuthMiddleware verifies token against accepted_service_tokens

    opt Idempotency-Key Supplied
        Text->>Redis: GET text:idem:{key}
        alt Cache Hit
            Redis-->>Text: Cached GenerateResponse JSON
            Text-->>Gateway: 200 OK (Cached)
            Gateway-->>Client: 200 OK (Cached)
        end
    end

    Note over Text: Input Moderation Gate
    Text->>Guardrail: POST /api/medical/validate
    Guardrail-->>Text: 200 OK {allowed: true, is_medical: true}
    alt Non-Medical or Unsafe
        Text-->>Gateway: 422 ContentBlockedError
        Gateway-->>Client: 422 Content Blocked
    end

    Note over Text: Admission Control
    Text->>Text: RateLimitTracker checks RPM/TPM
    Text->>Text: CircuitBreaker.allow_request()
    Text->>Redis: TaskManager.create_task() (sets PENDING status)
    Text->>Text: ResizableSemaphore.acquire() (Provider concurrency permit)

    alt Streaming Request (stream = true)
        Text->>Text: GenerationHub starts detached Producer
        Text-->>Gateway: 200 OK text/event-stream (SSE)
        Gateway-->>Client: 200 OK text/event-stream (SSE)
        loop Stream Token Delivery
            Upstream-->>Text: Async chunk delta
            Text->>Redis: XADD text:stream:{id} (coalesced 32 chunks / 25ms)
            Text-->>Gateway: event: token
            Gateway-->>Client: event: token
        end
        Text->>Text: Release provider permit
        Text->>Guardrail: POST /api/v1/guardrail/screen/outbound (assembled completion)
        Guardrail-->>Text: 200 OK {decision: "allow"}
        Text-->>Gateway: event: terminal (stats, usage, finish_reason)
        Gateway-->>Client: event: terminal
    else Synchronous Non-Streaming Request (stream = false)
        loop Inference Retry Loop
            Text->>Upstream: provider.generate()
            alt Upstream 429 / 5xx
                Text->>Text: Release permit, wait exponential backoff, re-acquire permit
            else Upstream Success
                Upstream-->>Text: (content, reasoning, GenerationStats)
            end
        end
        Text->>Text: Release provider permit immediately

        Note over Text: Output Moderation Gate
        Text->>Guardrail: POST /api/v1/guardrail/screen/outbound (completion, source_context)
        Guardrail-->>Text: 200 OK {decision: "allow"}

        Text->>Redis: TaskManager.update_task(status=COMPLETED)
        Text->>Redis: SET text:idem:{key} (24h TTL)
        Text-->>Gateway: 200 OK GenerateResponse
        Gateway->>Postgres: UsageLedgerService records metered token spend
        Gateway-->>Client: 200 OK GenerateResponse JSON
    end
```

---

## 4. LLM Inference Sequence Diagram (Provider Layer Detail)

This diagram focuses strictly on the internal provider adapter lifecycle, pooled connection management, and credential resolution during `provider.generate()`.

```mermaid
sequenceDiagram
    autonumber
    participant Caller as generate() Endpoint
    participant Registry as ProviderRegistry
    participant ClientCache as CLIENT_CACHE
    participant Transport as Pooled HTTP Client (httpx2/httpx)
    participant Upstream as External Provider API (e.g. OpenAI/vLLM)
    participant Telemetry as OpenTelemetry & Prometheus

    Caller->>Registry: get(provider_name)
    alt First invocation for provider
        Registry->>Registry: Call registered factory (e.g. LMStudioProvider())
    end
    Registry-->>Caller: Provider instance

    Caller->>Caller: _credential_attribution(request_body)
    Caller->>Caller: count_provider_bytes contextvar setup

    Caller->>Registry: provider.generate(request_body)
    Note over Registry: resolve_connection(request) extracts injected ProviderOverride

    Registry->>ClientCache: get_or_create(client_key(provider, base_url, secret))
    alt Client not in cache
        ClientCache->>Transport: pooled_http_client(family=TransportFamily.HTTPX2)
        ClientCache->>ClientCache: Instantiate AsyncOpenAI / Anthropic client
    end
    ClientCache-->>Registry: Active SDK Client

    Registry->>Telemetry: tracer.start_as_current_span("gen_ai.generate")
    Registry->>Upstream: POST /v1/chat/completions (model, messages, extra_body)
    Upstream-->>Registry: HTTP 200 (JSON payload with choices, usage, stats)

    Registry->>Registry: Coerce GenerationStats (extract finish_reason, engine_native)
    Registry->>Telemetry: Stamp span attributes (input_tokens, output_tokens, finish_reasons)
    Registry->>Telemetry: Update TOKENS_PER_SECOND & STOP_REASON_TOTAL metrics
    Registry-->>Caller: Return (content, reasoning, stats)
```

---

## 5. Provider Selection and Routing Flow

```mermaid
flowchart TD
    Start["Inbound Request Received"] --> ModelCheck{"Is 'model' field provided?"}
    ModelCheck -- No --> FailModel["Fail Closed: HTTP 422 Unprocessable Entity\n('Text has no default model')"]
    ModelCheck -- Yes --> ProvCheck{"Is 'provider' field provided?"}
    
    ProvCheck -- No --> HardcodedDefault["Default to 'lm-studio'\n(Documented backward-compat fallback)"]
    ProvCheck -- Yes --> TargetProv["Identify Target Provider"]
    
    HardcodedDefault --> RouteCheck
    TargetProv --> RouteCheck

    RouteCheck["Consult PoolHealthTracker"] --> HealthDecision{"Is target provider healthy?"}
    HealthDecision -- Healthy --> SelectPrimary["Select Primary Provider"]
    HealthDecision -- Unhealthy --> FallbackCheck{"Is fallback_provider provided and registered?"}
    
    FallbackCheck -- Yes --> Reroute["Rewrite request.provider to fallback_provider\nLog degrade reroute event"]
    FallbackCheck -- No --> FailUnhealthy["Fail Fast: HTTP 503 PoolUnhealthyError"]

    Reroute --> SelectPrimary
    SelectPrimary --> RegistryGet["ProviderRegistry.get(provider)"]
    RegistryGet --> RegCheck{"Is provider registered?"}
    RegCheck -- No --> FailNotFound["HTTP 404 ProviderNotFoundError"]
    RegCheck -- Yes --> CredentialCheck{"Credential Posture Check"}

    CredentialCheck -- BYOK Provider --> KeyCheck{"Is API Key or Connection present?"}
    KeyCheck -- Missing Key --> FailCreds["Fail Closed: HTTP 503 ProviderCredentialsError"]
    KeyCheck -- Key Present --> BuildClient["Build/Fetch SDK Client from CLIENT_CACHE"]

    CredentialCheck -- Self-Hosted Provider --> BaseUrlCheck{"Is Base URL resolved?"}
    BaseUrlCheck -- Missing URL --> FailUrl["Fail Closed: HTTP 503 ProviderConnectionMissingError"]
    BaseUrlCheck -- URL Present --> BuildClient

    BuildClient --> Dispatch["Execute Inference"]
```

---

## 6. Error-Handling and Resilience Flow

```mermaid
flowchart TD
    ErrorOrigin["Exception Occurs in Pipeline"] --> TypeDecision{"What is the error type?"}

    TypeDecision -- Inbound Auth / Tenant --> AuthErr["Missing/Invalid Token or Missing Tenant ID"]
    AuthErr --> Ret401["HTTP 401 Unauthorized / HTTP 428 Precondition Required"]

    TypeDecision -- Input Validation --> ValidErr["Pydantic ValidationError or Blank Model"]
    ValidErr --> Ret422["HTTP 422 Unprocessable Entity"]

    TypeDecision -- Guardrail Medical Rejection --> ContentErr["ContentBlockedError (Input or Output)"]
    ContentErr --> Ret422Safe["HTTP 422 Unprocessable Entity\n(Sanitized closed-vocabulary error code)"]

    TypeDecision -- Guardrail Outage --> GuardrailOut["GuardrailUnavailableError (Retries Exhausted)"]
    GuardrailOut --> Ret503["HTTP 503 Service Unavailable (Retryable)"]

    TypeDecision -- Concurrency Limit --> ConcurErr["ConcurrencyLimitError / QueueFullError"]
    ConcurErr --> Ret429["HTTP 429 Too Many Requests (Retry-After header)"]

    TypeDecision -- Circuit Breaker --> CBErr["CircuitBreaker Open"]
    CBErr --> Ret503CB["HTTP 503 Service Unavailable (Retry-After: 30)"]

    TypeDecision -- Provider Timeout --> TimeErr["TimeoutError after timeout_s"]
    TimeErr --> RetryEval{"attempt < max_retries?"}
    RetryEval -- Yes --> BackoffSleep["Release Semaphore Permit\nSleep calculate_backoff(attempt)\nRe-acquire Permit"]
    BackoffSleep --> ErrorOrigin
    RetryEval -- No --> Ret502Timeout["HTTP 502 Bad Gateway (ProviderTimeoutError)"]

    TypeDecision -- Upstream Vendor 429 --> RateLimit429["Vendor Rate Limited"]
    RateLimit429 --> RetryEval2{"attempt < max_retries?"}
    RetryEval2 -- Yes --> BackoffJitter["Extract Retry-After from upstream\nSleep jittered delay\nRe-acquire Permit"]
    BackoffJitter --> ErrorOrigin
    RetryEval2 -- No --> Ret429Vendor["HTTP 429 Too Many Requests (RateLimitError)"]

    TypeDecision -- Fatal Upstream Error --> Upstream5xx["Provider Error / 5xx / Connection Drop"]
    Upstream5xx --> CBRecord["CircuitBreaker.record_failure()\nTask marked FAILED in Redis"]
    CBRecord --> Ret502Upstream["HTTP 502 Bad Gateway (ProviderError)"]
```

---

## 7. Deployment Architecture

```mermaid
flowchart TD
    subgraph KubernetesCluster["Kubernetes Production Cluster"]
        subgraph IngressRouting["Ingress Layer"]
            Traefik["Cloud Ingress / API Gateway Proxy"]
        end

        subgraph TextPod["Pod: hope-text (FastAPI)"]
            Uvicorn["Single-Worker Uvicorn Process (Port 8862)\ntext.main:app\nPython 3.11 / uv workspace"]
            Lifespan["FastAPI Lifespan Manager\n• Shared HTTPX connection pool\n• Redis client connection\n• EffectiveConfig client & invalidation listener\n• Graceful shutdown drain (30s timeout)"]
            GenHubProcess["GenerationHub Process-Local Memory\n• Ring buffer (512 deltas)\n• Active producer coroutines"]
            Uvicorn --- Lifespan
            Lifespan --- GenHubProcess
        end

        subgraph RedisInfra["Shared State & Pub/Sub"]
            RedisInstance[("Redis (Port 6379)\n• DB 0: Tasks & Streams\n• Pub/Sub: arca:config:invalidate")]
        end

        subgraph GuardrailPod["Pod: hope-guardrail"]
            GuardrailApp["Guardrail Service (Port 8863 / 8861)"]
        end

        subgraph LocalModelPods["GPU / Local Inference Pods"]
            VLLMPod["vLLM Serving Pod (:8000)"]
            LMStudioPod["LM Studio + Sidecar Pod (:1234, :8869)"]
            TEIPod["HuggingFace TEI Pod (:8080)"]
        end

        subgraph ObservabilityStack["Cluster Observability"]
            PromServer["Prometheus Server (Scrapes :8862/metrics)"]
            OTelCollectorPod["OTel Collector Pod (Receives gRPC traces)"]
        end
    end

    Traefik -->|Internal HTTP| Uvicorn
    Uvicorn <-->|TCP RESP| RedisInstance
    Uvicorn -->|Internal HTTP| GuardrailApp
    Uvicorn -->|Internal HTTP| VLLMPod
    Uvicorn -->|Internal HTTP| LMStudioPod
    Uvicorn -->|Internal HTTP| TEIPod
    Uvicorn -->|gRPC| OTelCollectorPod
    PromServer -->|HTTP Scrape /metrics| Uvicorn
```

