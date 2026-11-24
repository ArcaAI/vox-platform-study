# LLM Service Configuration & Environment Reference (`apps/text`)

This document provides a comprehensive configuration guide for the **Text Generation & LLM Microservice** (`apps/text`). It outlines the architectural posture governing settings, documents every environment variable and default floor, details the control-plane pull contract and push invalidation channel, and provides operational deployment matrices.

---

## 1. Architectural Configuration Model

The LLM Service operates strictly as a **Stateless Gateway** governed by Platform Rule 09 (`.claude/rules/09-infrastructure-devops.md`) and Architecture Owner Decision D-1:
- **No In-Service Model Secrets**: `apps/text` stores no vendor API keys (e.g. OpenAI, Anthropic, Bedrock), maintains no local provider catalogs, and hardcodes no tenant-specific rate limits.
- **Two Dynamic Configuration Channels**:
  1. **PUSH Channel (Per-Request)**: Upstream caller (API Gateway `apps/api`) passes model selection, provider connection (`base_url`, `api_key`), custom headers, and tenant funding source via `provider_overrides` on each API call.
  2. **PULL Channel (Per-Service)**: Live operational budgets, provider timeouts, circuit breaker thresholds, and medical guardrail postures are pulled from the API Gateway control plane via `GET /internal/effective-config?service=text`, cached with a 60s TTL + jitter, and invalidated in real time via Redis Pub/Sub (`arca:config:invalidate`).
- **Bootstrap Transport Only**: Environment variables in this service are strictly restricted to bootstrap transport addresses (own port, Redis address, Gateway address, OTel collector) and the canonical internal shared token.

```
+-----------------------------------------------------------------------------------+
|                              CONTROL PLANE (apps/api)                             |
|                                                                                   |
|  - Manages Tenant BYOK Keys & System Provider Accounts in PostgreSQL              |
|  - Exposes GET /internal/effective-config?service=text                            |
|  - Publishes updates to Redis Pub/Sub channel: arca:config:invalidate             |
+------------------------+----------------------------------+-----------------------+
                         |                                  |
           PUSH per request (JSON)             PULL per service (HTTP / Redis)
           [Credentials, Model, Policy]        [Timeouts, Budgets, Moderation]
                         |                                  |
                         v                                  v
+-----------------------------------------------------------------------------------+
|                               APPS/TEXT RUNTIME                                   |
|                                                                                   |
|  Bootstrap Transport:                                                             |
|    TEXT_PORT, TEXT_GATEWAY_URL, TEXT_REDIS_URL, INTERNAL_ACCESS_TOKEN             |
|  Resource Safety Floors:                                                          |
|    USER_LANE_FLOOR, JUDGE_LANE_FLOOR, HTTPX_MAX_CONNECTIONS, TASK_TTL_S           |
+-----------------------------------------------------------------------------------+
```

---

## 2. Environment Variables Matrix

All configuration variables are managed via Pydantic Settings (`apps/text/src/text/core/config.py`). Source hierarchy order:
`Constructor Arguments` > `Host Environment Variables` > `Vault Agent /secrets_dir` > `.env.<NODE_ENV>` > `Default Floor`.

| Variable Name | Type | Default Value | Required | Consumed By | Description & Operational Purpose |
|---|---|---|---|---|---|
| `TEXT_PORT` | `int` | `8862` | Optional | `src/text/core/config.py#L161` | TCP port on which Uvicorn binds and listens. |
| `TEXT_LOG_LEVEL` | `str` | `"info"` | Optional | `src/text/core/config.py#L162` | Logging verbosity (`trace`, `debug`, `info`, `warning`, `error`, `critical`). Normalised to lowercase. |
| `TEXT_GATEWAY_URL` | `str` | `"http://localhost:8868/api/v1"` | Optional | `src/text/core/config.py#L168` | Base URL of the API Gateway control plane. Used for pulling effective config and self-registration. |
| `TEXT_REDIS_URL` | `str` | `"redis://localhost:6379/0"` | Optional | `src/text/core/config.py#L170` | Connection string for Redis. Used for task state persistence, stream chunking, idempotency caching, and pub/sub invalidation. |
| `TEXT_OTEL_EXPORTER_ENDPOINT` | `str` | `""` (Empty string) | Optional | `src/text/core/config.py#L177` | OTLP gRPC/HTTP endpoint (e.g. `http://otel-collector:4317`). An empty string disables export without crashing. |
| `TEXT_EXTERNAL_GUARDRAIL_BASE_URL` | `str` | `"http://localhost:8863"` | Optional | `src/text/core/config.py#L71` | Base URL of the medical guardrail peer service (`apps/guardrail`). |
| `INTERNAL_ACCESS_TOKEN` | `SecretStr` | `""` (Empty string) | **Production Required** | `src/text/core/config.py#L95` | **Canonical Internal Service Secret**. Shared across all HOPE services. Validates inbound `X-Service-Token` and signs outbound peer calls. |
| `NODE_ENV` | `str` | `"development"` | Optional | `src/text/core/config.py#L134` | Deployment tier: `development`, `staging`, `production`, or `test`. Injects trace environment attribute. |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `str` | `""` (Empty string) | **Required in Prod** | `src/text/core/config.py#L135-L149` | **PHI Defense Switch**. In production (`NODE_ENV=production`), this MUST be set to exactly `"NO_CONTENT"`. Service refuses to boot if unset or mismatched. |

---

## 3. Resource-Safety Floors (`core/runtime_defaults.py`)

The values below are **Resource-Safety Floors**, deliberately hardcoded in code rather than exposed as environment variables (`apps/text/src/text/core/runtime_defaults.py`). They establish the minimum fail-safe ceilings that prevent a hung or saturated upstream provider from starving the microservice before the control plane can answer.

### 3.1 Concurrency & Lane Budgets
The service isolates traffic into two independent lanes to prevent safety evaluation starvation:
- **`user` Lane**: User-facing interactive generations and background jobs.
- **`judge` Lane**: Dedicated to safety evaluators (`/generate/internal/judge`) scoring adversarial attacks and outputs.

| Parameter | `user` Lane Floor | `judge` Lane Floor | Source Code Anchor | Purpose & Behavior |
|---|---|---|---|---|
| `max_concurrent` | `4` | `2` | `runtime_defaults.py#L130,L148` | Initial concurrency permit limit per provider before queueing or rejection. |
| `acquire_timeout_s` | `60.0s` | `5.0s` | `runtime_defaults.py#L131,L149` | Timeout for acquiring a concurrency permit from `ResizableSemaphore`. |
| `timeout_s` | `300s` | `60s` | `runtime_defaults.py#L132,L150` | Maximum round-trip wall-clock duration for an upstream LLM inference call. |
| `failure_threshold` | `5` | `5` | `runtime_defaults.py#L133,L151` | Consecutive network/5xx failures before opening `CircuitBreaker`. |
| `recovery_timeout_s`| `30.0s` | `30.0s` | `runtime_defaults.py#L134,L152` | Duration circuit breaker remains OPEN before transitioning to HALF-OPEN. |
| `queue_max_size` | `200` | `0` (No Queue) | `runtime_defaults.py#L135,L153` | Maximum queued requests waiting for permits. Judge lane has 0 queue to fail-fast. |
| `queue_max_wait_s` | `60.0s` | `0.0s` | `runtime_defaults.py#L136,L154` | Maximum time a request may sit in queue before shedding with 429. |
| `count_rate_limits` | `False` | `False` | `runtime_defaults.py#L112` | Upstream 429s honor `Retry-After` headers and do NOT trip circuit breakers. |

### 3.2 Platform-Wide Transport & Task Hygiene Floors
| Constant Name | Value | Purpose |
|---|---|---|
| `HTTPX_MAX_CONNECTIONS` | `200` | Process-wide connection pool ceiling for outbound provider and peer HTTP calls. |
| `HTTPX_MAX_KEEPALIVE` | `100` | Maximum reusable idle keepalive TCP connections. |
| `TASK_TTL_S` | `3600s` (1 hour) | Retention TTL for completed task metadata in Redis (`text:task:{id}`). |
| `TASK_STREAM_MAX_LEN` | `10,000` | Maximum sequence chunks preserved in Redis Stream (`text:stream:{id}`). |
| `MODEL_RETENTION_TTL_FLOOR_S` | `600s` (10 mins) | Keep-alive hint forwarded to local inference engines (Ollama, LM Studio). |
| `PROVIDER_PROBE_TIMEOUT_S` | `5s` | Strict ceiling on `/providers/probe` reachability checks so hung nodes don't block. |

---

## 4. Control-Plane Dynamic Configuration (`EffectiveConfigSnapshot`)

The live control plane serves operational parameters dynamically via `GET /internal/effective-config?service=text`. The response is cached in memory by `EffectiveConfigClient` (`apps/text/src/text/core/effective_config.py`).

### 4.1 Ingestion & Update Mechanics
1. **Initial Bootstrap**: Client constructs without network I/O. The first API request lazily triggers the first pull.
2. **Graceful Negative Caching**: If the Gateway is unreachable at boot, the client logs a single warning per minute, negative-caches the failure, and runs on the safety floors without crashing.
3. **Real-Time Push Invalidation**: Background task `run_invalidation_listener()` subscribes to Redis channel `arca:config:invalidate`. When a message matches `service == "text"` or `scope == "all"`, the memory cache is cleared immediately.
4. **Live Semaphore Resizing**: When `maxConcurrent` changes in the control plane, `ResizableSemaphore.resize()` adjusts the live integer capacity in-place without stranding in-flight permits or breaking active asyncio waiters.

### 4.2 Control-Plane Payload Schema
```json
{
  "service": "text",
  "version": "1.4.0",
  "generated_at": "2026-11-18T13:45:00.000Z",
  "ttl_seconds": 60,
  "config": {
    "provider_timeouts": {
      "openai": 60,
      "anthropic": 90,
      "vllm": 120,
      "lmstudio": 180
    },
    "lane_budgets": {
      "openai:user": {
        "max_concurrent": 20,
        "queue_max_size": 500,
        "failure_threshold": 3
      },
      "vllm:user": {
        "max_concurrent": 8,
        "queue_max_size": 100,
        "failure_threshold": 5
      }
    },
    "guardrail_posture": {
      "enabled": true,
      "require_medical": true,
      "timeout_s": 15,
      "max_retries": 2
    }
  }
}
```

---

## 5. Deployment Environments & Profile Samples

### 5.1 Local Development Profile (`.env.development`)
```bash
# Process Identity
TEXT_PORT=8862
TEXT_LOG_LEVEL=debug
NODE_ENV=development

# Infrastructure Transport
TEXT_GATEWAY_URL=http://localhost:3000/api/v1
TEXT_REDIS_URL=redis://localhost:6379/0
TEXT_EXTERNAL_GUARDRAIL_BASE_URL=http://localhost:8861

# Security & Telemetry
INTERNAL_ACCESS_TOKEN=dev-secret-internal-token-change-in-prod
TEXT_OTEL_EXPORTER_ENDPOINT=
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT
```

### 5.2 Kubernetes Production Manifest Fragment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hope-text
  namespace: hope
spec:
  replicas: 1 # Invariant: Single Uvicorn worker per pod due to GenerationHub in-memory ownership
  template:
    spec:
      containers:
      - name: text
        image: ghcr.io/project-hope/text:2.0.0
        ports:
        - containerPort: 8862
          name: http
        env:
        - name: NODE_ENV
          value: "production"
        - name: TEXT_PORT
          value: "8862"
        - name: TEXT_LOG_LEVEL
          value: "info"
        - name: TEXT_GATEWAY_URL
          value: "http://hope-api.hope.svc.cluster.local:3000/api/v1"
        - name: TEXT_REDIS_URL
          value: "redis://hope-redis.hope.svc.cluster.local:6379/0"
        - name: TEXT_EXTERNAL_GUARDRAIL_BASE_URL
          value: "http://hope-guardrail.hope.svc.cluster.local:8861"
        - name: TEXT_OTEL_EXPORTER_ENDPOINT
          value: "http://hope-otel-collector.hope.svc.cluster.local:4317"
        - name: OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT
          value: "NO_CONTENT" # Strictly validated at boot
        - name: INTERNAL_ACCESS_TOKEN
          valueFrom:
            secretKeyRef:
              name: hope-shared-internal-secrets
              key: INTERNAL_ACCESS_TOKEN
        resources:
          requests:
            cpu: "1000m"
            memory: "1Gi"
          limits:
            cpu: "2000m"
            memory: "2Gi"
        readinessProbe:
          httpGet:
            path: /api/v1/health/ready
            port: 8862
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /api/v1/health/live
            port: 8862
          initialDelaySeconds: 10
          periodSeconds: 15
        startupProbe:
          httpGet:
            path: /api/v1/health/startup
            port: 8862
          failureThreshold: 30
          periodSeconds: 2
```

