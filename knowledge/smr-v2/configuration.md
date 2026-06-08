# SMR Service — Configuration

All configuration is read from environment variables using **pydantic-settings**. The settings classes live in `src/smr_v2/core/config.py` (`Settings` plus one `BaseSettings` sub-config per provider/concern). In development, place a `.env` file in `apps/smr/` (or at the monorepo root); a template is provided at `.env.example`, and a production template at `.env.production`.

Every variable uses the `SMR_V2_` prefix. Sub-configs add their own nested prefix (for example `SMR_V2_AZURE_*`, `SMR_V2_OLLAMA_*`, `SMR_V2_CB_*`). Field names map to env vars by upper-casing the field and prepending the prefix — e.g. the `timeout_s` field of `AzureOpenAIConfig` is `SMR_V2_AZURE_TIMEOUT_S`.

> **Loading & precedence:** On startup `get_settings()` calls `_load_dotenv_into_environ()`, which walks up from `config.py` (up to 10 levels) and loads every `.env` it finds, root-first then closer files, so an app-level `apps/smr/.env` overrides the monorepo-root `.env`. Variables already present in the real environment always win. `get_settings()` is **not** cached and is called once during application startup.

The tables below list **code defaults** (from `config.py`). Example `.env` files may ship different sample values.

---

## Application

`Settings` (prefix `SMR_V2_`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_HOST` | string | `0.0.0.0` | Server bind address |
| `SMR_V2_PORT` | int | `8862` | HTTP listen port |
| `SMR_V2_DEBUG` | bool | `false` | Enable debug mode |
| `SMR_V2_LOG_LEVEL` | string | `info` | Log level (`debug`, `info`, `warning`, `error`); normalized to lowercase |
| `SMR_V2_CORS_ORIGINS` | list[str] (JSON array) | `[]` | Allowed CORS origins, e.g. `["http://localhost:8868"]` |
| `SMR_V2_CORS_ENABLED` | bool | `false` | Enable the CORS middleware (only added when `true` **and** origins are non-empty) |
| `SMR_V2_SERVICE_TOKEN` | secret (string) | `""` | Inter-service auth token validated as the `X-Service-Token` header. Empty disables auth (local dev); health, docs, and `/metrics` paths are always exempt |
| `SMR_V2_HTTPX_MAX_CONNECTIONS` | int | `200` | Shared httpx client: max total connections |
| `SMR_V2_HTTPX_MAX_KEEPALIVE` | int | `100` | Shared httpx client: max keep-alive connections |

---

## LLM Provider Selection

There is **no single global provider variable**. Every provider's sub-config is loaded at startup, and each provider is enabled independently via its `SMR_V2_<PROVIDER>_ENABLED` flag. Enabled providers are registered in a `ProviderRegistry` and selected **per request** via the `provider` field of the generate request (default `lm-studio`). If the requested key is not registered, the service returns `PROVIDER_NOT_FOUND`.

| Provider | Enable flag | Registry key(s) | Config prefix |
|----------|-------------|-----------------|---------------|
| OpenAI-compatible (**LM Studio** — default local engine) | `SMR_V2_OPENAI_COMPAT_ENABLED` | `lm-studio`, `openai_compat` (alias) | `SMR_V2_OPENAI_COMPAT_` |
| Ollama (optional local engine) | `SMR_V2_OLLAMA_ENABLED` | `ollama` | `SMR_V2_OLLAMA_` |
| Azure OpenAI | `SMR_V2_AZURE_ENABLED` | `azure-openai`, `azure` (alias) | `SMR_V2_AZURE_` |
| AWS Bedrock | `SMR_V2_BEDROCK_ENABLED` | `bedrock` | `SMR_V2_BEDROCK_` |

Per-request generation hyperparameters (`temperature`, `max_tokens`, `top_p`) are **not** environment variables. They are supplied per request and fall back to code constants in `src/smr_v2/core/defaults.py` (`temperature=0.1`, `max_tokens=16384`, `top_p=0.95`) only when omitted from the request.

---

## OpenAI-Compatible / LM Studio

`OpenAICompatConfig` (prefix `SMR_V2_OPENAI_COMPAT_`). This is the default local engine (registry keys `lm-studio` and `openai_compat`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_OPENAI_COMPAT_ENABLED` | bool | `false` | Enable the OpenAI-compatible / LM Studio provider |
| `SMR_V2_OPENAI_COMPAT_BASE_URL` | string | `http://localhost:1234/v1` | OpenAI-compatible API base URL |
| `SMR_V2_OPENAI_COMPAT_API_KEY` | secret (string) | `not-needed` | API key; use `not-needed` for local engines without auth |
| `SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL` | string | `google/gemma-4-e4b` | Model used when the request omits `model` |
| `SMR_V2_OPENAI_COMPAT_TIMEOUT_S` | int | `300` | Request timeout in seconds |
| `SMR_V2_OPENAI_COMPAT_MAX_CONCURRENT` | int | `4` | Max concurrent requests (provider semaphore) |
| `SMR_V2_OPENAI_COMPAT_ORGANIZATION` | string \| null | `null` | Optional `OpenAI-Organization` header |

---

## Ollama

`OllamaConfig` (prefix `SMR_V2_OLLAMA_`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_OLLAMA_ENABLED` | bool | `false` | Enable the Ollama provider |
| `SMR_V2_OLLAMA_BASE_URL` | string | `http://localhost:11434` | Ollama server URL |
| `SMR_V2_OLLAMA_DEFAULT_MODEL` | string | `google/gemma-4-e4b` | Model used when the request omits `model` |
| `SMR_V2_OLLAMA_TIMEOUT_S` | int | `300` | Request timeout in seconds |
| `SMR_V2_OLLAMA_MAX_CONCURRENT` | int | `4` | Max concurrent requests (provider semaphore) |
| `SMR_V2_OLLAMA_QUEUE_BACKOFF_S` | float | `2.0` | Backoff between queued requests in seconds |

---

## Azure OpenAI

`AzureOpenAIConfig` (prefix `SMR_V2_AZURE_`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_AZURE_ENABLED` | bool | `false` | Enable the Azure OpenAI provider |
| `SMR_V2_AZURE_API_KEY` | secret (string) | `""` | Azure OpenAI API key (required when enabled) |
| `SMR_V2_AZURE_ENDPOINT` | string | `""` | Azure resource endpoint URL (required when enabled) |
| `SMR_V2_AZURE_API_VERSION` | string | `2024-12-01-preview` | Azure OpenAI API version |
| `SMR_V2_AZURE_DEPLOYMENT_NAME` | string | `""` | Azure deployment name (config field; the provider passes `default_model`/the request `model` as the Azure deployment) |
| `SMR_V2_AZURE_DEFAULT_MODEL` | string | `gpt-5-mini` | Model/deployment used when the request omits `model` |
| `SMR_V2_AZURE_TIMEOUT_S` | int | `120` | Request timeout in seconds |
| `SMR_V2_AZURE_MAX_CONCURRENT` | int | `10` | Max concurrent requests (provider semaphore) |
| `SMR_V2_AZURE_TPM_LIMIT` | int | `80000` | Tokens-per-minute limit for rate limiting |
| `SMR_V2_AZURE_RPM_LIMIT` | int | `480` | Requests-per-minute limit for rate limiting |
| `SMR_V2_AZURE_ADAPTIVE_LIMITS` | bool | `true` | Adapt limits from provider response headers |
| `SMR_V2_AZURE_CONTENT_FILTER_SEVERITY` | string | `medium` | Content filter severity: `low`, `medium`, `high` |

---

## AWS Bedrock

`BedrockConfig` (prefix `SMR_V2_BEDROCK_`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_BEDROCK_ENABLED` | bool | `false` | Enable the AWS Bedrock provider |
| `SMR_V2_BEDROCK_REGION` | string | `us-east-1` | AWS region |
| `SMR_V2_BEDROCK_DEFAULT_MODEL` | string | `anthropic.claude-3-5-haiku-20241022-v1:0` | Model used when the request omits `model` |
| `SMR_V2_BEDROCK_TIMEOUT_S` | int | `120` | Request timeout in seconds |
| `SMR_V2_BEDROCK_MAX_CONCURRENT` | int | `10` | Max concurrent requests (provider semaphore) |
| `SMR_V2_BEDROCK_MAX_POOL_CONNECTIONS` | int | `150` | Max httpx pool connections for the Bedrock client |
| `SMR_V2_BEDROCK_TPM_LIMIT` | int | `100000` | Tokens-per-minute limit for rate limiting |
| `SMR_V2_BEDROCK_RPM_LIMIT` | int | `100` | Requests-per-minute limit for rate limiting |
| `SMR_V2_BEDROCK_THROTTLE_BACKOFF_S` | float | `30.0` | Backoff after a throttling response, in seconds |
| `SMR_V2_BEDROCK_GUARDRAIL_ID` | string | `""` | Optional Bedrock Guardrail ID |
| `SMR_V2_BEDROCK_GUARDRAIL_VERSION` | string | `DRAFT` | Bedrock Guardrail version (`DRAFT` or a version number) |

---

## External Guardrail

`ExternalGuardrailConfig` (prefix `SMR_V2_EXTERNAL_GUARDRAIL_`). When enabled, SMR validates medical content per generate request by calling the Guardrail service's `POST /api/medical/validate`. See [Guardrail Service](../guardrail/README.md).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED` | bool | `false` | Enable external clinical-content validation |
| `SMR_V2_EXTERNAL_GUARDRAIL_BASE_URL` | string | `http://localhost:8863` | Guardrail service base URL |
| `SMR_V2_EXTERNAL_GUARDRAIL_TIMEOUT_S` | int | `10` | Validation request timeout in seconds |
| `SMR_V2_EXTERNAL_GUARDRAIL_FAIL_OPEN` | bool | `false` | If `true`, allow generation when the Guardrail call fails; if `false`, fail closed |
| `SMR_V2_EXTERNAL_GUARDRAIL_REQUIRE_MEDICAL` | bool | `true` | Require content to be classified as medical |
| `SMR_V2_EXTERNAL_GUARDRAIL_INCLUDE_REASONING` | bool | `false` | Ask the Guardrail service to include reasoning in its response |
| `SMR_V2_EXTERNAL_GUARDRAIL_SERVICE_TOKEN` | secret (string) | `""` | Token sent as `X-Service-Token` to the Guardrail service when set |

---

## Redis & Task Management

`RedisConfig` (prefix `SMR_V2_`). Backs the async task manager and SSE/streaming via Redis Streams.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_REDIS_URL` | string | `redis://localhost:6379/0` | Redis connection URL |
| `SMR_V2_TASK_TTL_SECONDS` | int | `3600` | Task record TTL in seconds |
| `SMR_V2_STREAM_MAX_LEN` | int | `10000` | Max length of a Redis Stream per task |

---

## Request Queue

`QueueConfig` (prefix `SMR_V2_QUEUE_`). A per-provider request queue applied when concurrency limits are reached.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_QUEUE_MAX_SIZE` | int | `200` | Max queued requests per provider |
| `SMR_V2_QUEUE_MAX_WAIT_S` | float | `60.0` | Max wait in seconds before a queued request is rejected |

---

## Circuit Breaker

`CircuitBreakerConfig` (prefix `SMR_V2_CB_`). One circuit breaker is created per registered provider.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_CB_FAILURE_THRESHOLD` | int | `5` | Consecutive failures before the circuit opens |
| `SMR_V2_CB_RECOVERY_TIMEOUT_S` | float | `30.0` | Seconds before attempting a half-open probe |
| `SMR_V2_CB_HALF_OPEN_MAX_CALLS` | int | `3` | Max trial calls allowed while half-open |
| `SMR_V2_CB_RESET_TIMEOUT_S` | float | `120.0` | Seconds before a full reset to closed |
| `SMR_V2_CB_COUNT_RATE_LIMITS` | bool | `true` | Count rate-limit responses as failures |

---

## Observability (OpenTelemetry & Metrics)

`Settings` fields (prefixes `SMR_V2_OTEL_` and `SMR_V2_`).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMR_V2_OTEL_ENABLED` | bool | `false` | Enable OpenTelemetry tracing/instrumentation |
| `SMR_V2_OTEL_EXPORTER_ENDPOINT` | string | `http://localhost:4317` | OTLP gRPC collector endpoint |
| `SMR_V2_OTEL_SERVICE_NAME` | string | `smr-v2` | Service name in traces |
| `SMR_V2_OTEL_SERVICE_NAMESPACE` | string | `hope` | Service namespace for trace grouping |
| `SMR_V2_OTEL_DEPLOYMENT_ENVIRONMENT` | string | `production` | Deployment environment attribute for trace filtering |
| `SMR_V2_OTEL_INSECURE` | bool | `true` | Use an insecure (non-TLS) gRPC connection to the collector |
| `SMR_V2_OTEL_LOGS_ENABLED` | bool | `true` | Export logs via OTLP when tracing is enabled |
| `SMR_V2_METRICS_ENABLED` | bool | `true` | Expose Prometheus metrics |

> The Prometheus metrics endpoint path is hard-coded to `/metrics` (not configurable). Metrics are only instrumented/exposed when `SMR_V2_METRICS_ENABLED=true`.

---

## Example .env (Development)

```bash
SMR_V2_HOST=0.0.0.0
SMR_V2_PORT=8862
SMR_V2_DEBUG=true
SMR_V2_LOG_LEVEL=debug

# LM Studio (OpenAI-compatible) is the default local engine
SMR_V2_OPENAI_COMPAT_ENABLED=true
SMR_V2_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL=google/gemma-4-e4b
SMR_V2_OPENAI_COMPAT_TIMEOUT_S=300

# Ollama — optional, disabled by default
SMR_V2_OLLAMA_ENABLED=false
SMR_V2_OLLAMA_BASE_URL=http://localhost:11434
SMR_V2_OLLAMA_DEFAULT_MODEL=gemma3:latest

SMR_V2_REDIS_URL=redis://localhost:6379/0

# External clinical-content validation (off by default in dev)
SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=false
SMR_V2_EXTERNAL_GUARDRAIL_BASE_URL=http://localhost:8863
```

---

## Example .env (Production)

```bash
SMR_V2_HOST=0.0.0.0
SMR_V2_PORT=8862
SMR_V2_LOG_LEVEL=info
SMR_V2_DEBUG=false

# Inter-service auth (enable by setting a non-empty token)
SMR_V2_SERVICE_TOKEN=<managed-secret>

# Providers — configure per deployment
SMR_V2_OPENAI_COMPAT_ENABLED=false
SMR_V2_OLLAMA_ENABLED=false
SMR_V2_AZURE_ENABLED=true
SMR_V2_AZURE_API_KEY=<managed-secret>
SMR_V2_AZURE_ENDPOINT=https://prod-resource.openai.azure.com/
SMR_V2_AZURE_DEPLOYMENT_NAME=gpt-4o-mini
SMR_V2_BEDROCK_ENABLED=false

# External Guardrail
SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=true
SMR_V2_EXTERNAL_GUARDRAIL_BASE_URL=http://guardrail:8863
SMR_V2_EXTERNAL_GUARDRAIL_FAIL_OPEN=false

SMR_V2_REDIS_URL=redis://redis:6379/0

# Observability
SMR_V2_METRICS_ENABLED=true
SMR_V2_OTEL_ENABLED=true
SMR_V2_OTEL_EXPORTER_ENDPOINT=http://otel-collector:4317
SMR_V2_OTEL_DEPLOYMENT_ENVIRONMENT=production

# CORS (only applied when enabled and origins are non-empty)
SMR_V2_CORS_ENABLED=true
SMR_V2_CORS_ORIGINS=["https://app.hope.com"]
```

---

## Environment-Specific Behavior

| Aspect | Development | Production |
|--------|-------------|------------|
| Inter-service auth | Disabled (`SMR_V2_SERVICE_TOKEN` empty) | Enabled (non-empty token) |
| Logging | `debug` level | `info` level |
| Tracing | Disabled (`SMR_V2_OTEL_ENABLED=false`) | Enabled |
| CORS | Disabled by default | Enabled with explicit origins |
| Provider engine | LM Studio (`SMR_V2_OPENAI_COMPAT_ENABLED=true`) | Per deployment (e.g. Azure/Bedrock) |
| Service URLs | `localhost:*` | Container service names |

---

## Related Documentation

- [SMR Service Overview](./README.md)
- [API Reference](./api-reference.md)
- [Guardrail Service](../guardrail/README.md)
- [API Gateway Configuration](../api/configuration.md)
