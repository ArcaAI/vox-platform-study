# SMR Service — Configuration

All configuration is read from environment variables. In development, place a `.env` file in `apps/smr/`. Templates are provided at `env.example` (development) and `env.production.example` (production).

Settings are loaded via a custom `get_config()` function in `src/smr/core/config.py` (using `os.getenv` with manual parsing, not Pydantic `BaseSettings`). Additional validation is available from `src/smr/infrastructure/config_validator.py`.

---

## Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICE_NAME` | No | `hope-smr` | Service identifier in logs and traces |
| `SERVICE_VERSION` | No | `1.0.0` | Reported in health checks |
| `NODE_ENV` | No | `development` | `development`, `staging`, or `production` |
| `SUMMARY_AGENT_HOST` | No | `0.0.0.0` | Server bind address |
| `SUMMARY_AGENT_PORT` | No | `8862` | HTTP listen port |
| `SUMMARY_AGENT_DEBUG` | No | `false` | Enable debug mode |
| `SUMMARY_AGENT_LOG_LEVEL` | No | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |

---

## LLM Provider Selection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUMMARY_SERVICE_PROVIDER` | Yes | `azure_openai` | Active provider: `azure_openai`, `ollama`, or `langflow` |

> **Note:** The codebase uses `SUMMARY_SERVICE_PROVIDER` as the single provider variable for all three providers (Azure OpenAI, Ollama, and Langflow). There is no separate `SUMMARY_AGENT_LLM_PROVIDER` variable.

---

## Azure OpenAI

Required when `SUMMARY_SERVICE_PROVIDER=azure_openai`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_OPENAI_API_KEY` | Yes | — | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Yes | — | Azure resource endpoint URL |
| `AZURE_OPENAI_API_VERSION` | No | `2024-02-01` | API version |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | Yes | — | Deployment name (e.g. `gpt-4`) |
| `AZURE_OPENAI_MODEL` | No | `gpt-4` | Model name |
| `AZURE_OPENAI_TEMPERATURE` | No | `0.1` | Sampling temperature (0.0–2.0) |
| `AZURE_OPENAI_MAX_TOKENS` | No | `8192` | Maximum output tokens (overridden to `6000` by `ENHANCED_CONFIG_DEFAULTS` in Pydantic model) |
| `AZURE_OPENAI_TOP_P` | No | `1.0` | Top-p (nucleus) sampling (overridden to `0.95` by `ENHANCED_CONFIG_DEFAULTS` in Pydantic model) |
| `AZURE_OPENAI_FREQUENCY_PENALTY` | No | `0.0` | Frequency penalty |
| `AZURE_OPENAI_PRESENCE_PENALTY` | No | `0.0` | Presence penalty |

> **Important:** The `config.py` `get_config()` function reads `AZURE_OPENAI_TEMPERATURE` with a default of `0.1` and `AZURE_OPENAI_MAX_TOKENS` with a default of `8192`. However, the `AzureOpenAIConfig` Pydantic model defaults are set from `ENHANCED_CONFIG_DEFAULTS` (`temperature=0.1`, `max_tokens=6000`, `top_p=0.95`). The env var values take precedence when set.

---

## Ollama

Required when `SUMMARY_SERVICE_PROVIDER=ollama`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `llama2:latest` | Model tag |
| `OLLAMA_TEMPERATURE` | No | `0.1` | Sampling temperature |
| `OLLAMA_TOP_K` | No | `40` | Top-k sampling |
| `OLLAMA_TOP_P` | No | `0.9` | Top-p sampling |
| `OLLAMA_REPEAT_PENALTY` | No | `1.1` | Repeat penalty |
| `OLLAMA_NUM_CTX` | No | `8192` | Context window size |
| `OLLAMA_NUM_PREDICT` | No | `-1` | Maximum prediction tokens (`-1` = unlimited) |

---

## Langflow

Required when `SUMMARY_SERVICE_PROVIDER=langflow`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGFLOW_BASE_URL` | Yes | — | Langflow server base URL |
| `LANGFLOW_API_KEY` | Yes | — | Langflow API key (also accepts `LANGFLOW_X_API_KEY`) |
| `LANGFLOW_API_VERSION` | No | `v1` | Langflow API version |
| `LANGFLOW_FLOW_ID_SUMMARY` | Yes | — | Langflow flow ID for summaries (also accepts `LANGFLOW_SUMMARY_FLOW_ID`) |
| `LANGFLOW_FLOW_ID_PRE_SUMMARY` | No | — | Langflow flow ID for pre-summaries (also accepts `LANGFLOW_PRESUMMARY_FLOW_ID`) |
| `LANGFLOW_TIMEOUT_SECONDS` | No | `60` | Langflow request timeout in seconds |

---

## Database (PostgreSQL)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUMMARY_AGENT_DATABASE_URL` | Yes | `postgresql+asyncpg://postgres:postgres@localhost:5432/medical_summaries` | Async connection URL (`postgresql+asyncpg://...`) |
| `SUMMARY_AGENT_DATABASE_ECHO` | No | `false` | Log SQL statements |

---

## Redis & Job Queue

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUMMARY_AGENT_REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `SUMMARY_AGENT_JOB_TIMEOUT` | No | `300` | Max job duration in seconds |
| `SUMMARY_AGENT_MAX_RETRIES` | No | `3` | Max retry attempts for failed jobs |
| `SUMMARY_AGENT_HEARTBEAT_INTERVAL` | No | `30` | WebSocket/SSE heartbeat interval in seconds |
| `SUMMARY_AGENT_CONNECTION_TIMEOUT` | No | `3600` | WebSocket/SSE connection timeout in seconds |

---

## Summary Processing

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUMMARY_AGENT_SYSTEM_PROMPT` | No | *(built-in medical prompt)* | Override the default system prompt |
| `SUMMARY_AGENT_USER_PROMPT_TEMPLATE` | No | *(built-in template)* | Override the default user prompt template |
| `SUMMARY_AGENT_MAX_CONVERSATION_LENGTH` | No | `50000` | Maximum conversation text length |
| `SUMMARY_AGENT_CHUNK_SIZE` | No | `10000` | Text chunk size for long conversations |
| `SUMMARY_AGENT_CHUNK_OVERLAP` | No | `500` | Overlap between chunks |

---

## Celery

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CELERY_BROKER_URL` | No | `redis://localhost:6379/0` | Celery broker URL |
| `CELERY_RESULT_BACKEND` | No | `redis://localhost:6379/0` | Celery result backend URL |
| `CELERY_TASK_TRACK_STARTED` | No | `true` | Track task start time |
| `CELERY_TASK_PUBLISH_RETRY` | No | `true` | Retry failed task publishing |
| `CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP` | No | `true` | Retry broker connection on startup |
| `CELERY_WORKER_CONCURRENCY` | No | `3` | Number of concurrent worker threads |

Additional Celery settings configured in `celery_app.py` (not env-configurable):

| Setting | Value | Description |
|---------|-------|-------------|
| `task_default_queue` | `summary_tasks` | Default queue name |
| `result_expires` | `86400` (24h) | Result expiration in seconds |
| `task_acks_late` | `true` | Acknowledge task after completion |
| `task_reject_on_worker_lost` | `true` | Reject task if worker is lost |
| `worker_prefetch_multiplier` | `1` | Tasks fetched per worker at a time |

---

## Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `INFO` | Root log level |
| `LOG_FILE_ENABLED` | No | `true` | Write logs to files |
| `LOG_FILE_PATH` | No | `/app/logs` | Log file directory |
| `LOG_FILE_JSON_FORMAT` | No | `true` | Use JSON log format |
| `LOG_FILE_MAX_SIZE` | No | `100MB` | Max file size before rotation |
| `LOG_FILE_BACKUP_COUNT` | No | `30` | Number of rotated files to keep |
| `LOG_ERROR_FILE_MAX_SIZE` | No | `50MB` | Max error log file size |
| `LOG_ERROR_FILE_BACKUP_COUNT` | No | `10` | Number of error log files to keep |
| `LOG_CONSOLE_ENABLED` | No | `true` | Output logs to console |
| `LOG_SENSITIVE_DATA` | No | `false` | Include sensitive data in logs |

---

## OpenTelemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTEL_SERVICE_NAME` | No | `hope-smr` | Service name in traces |
| `OTEL_SERVICE_VERSION` | No | `1.0.0` | Service version |
| `OTEL_SERVICE_NAMESPACE` | No | `hope` | Service namespace |
| `OTEL_TRACES_ENABLED` | No | `false` | Enable distributed tracing |
| `OTEL_METRICS_ENABLED` | No | `false` | Enable metrics export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://jaeger:4317` | OTLP gRPC collector endpoint |
| `OTEL_RESOURCE_ATTRIBUTES` | No | — | Comma-separated key=value resource attributes |

---

## Prometheus Metrics

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_METRICS` | No | `true` | Enable Prometheus metrics endpoint |
| `METRICS_PATH` | No | `/metrics` | Metrics endpoint path |

---

## Resource Monitoring

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESOURCE_MONITORING_INTERVAL` | No | `30` | Monitoring interval in seconds |
| `ENABLE_BACKGROUND_MONITORING` | No | `true` | Enable background resource monitoring |
| `ALERT_MEMORY_THRESHOLD` | No | `85` | Memory usage alert threshold (%) |
| `ALERT_CPU_THRESHOLD` | No | `80` | CPU usage alert threshold (%) |
| `ALERT_DISK_THRESHOLD` | No | `90` | Disk usage alert threshold (%) |
| `ALERT_COOLDOWN_MINUTES` | No | `5` | Minimum interval between repeated alerts |

---

## Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_SECURITY_HEADERS` | No | `true` | Inject security response headers |
| `ENABLE_CORRELATION_TRACKING` | No | `true` | Track and propagate correlation IDs |
| `CORS_ALLOW_ORIGINS` | No | `*` | Comma-separated allowed origins |
| `CORS_ALLOW_CREDENTIALS` | No | `false` | Allow credentials in CORS requests |
| `CORRELATION_HEADER_NAME` | No | `X-Correlation-ID` | Header name for correlation IDs |
| `CORRELATION_AUTO_GENERATE` | No | `false` | Auto-generate correlation ID if missing |

### Security Headers (when `ENABLE_SECURITY_HEADERS=true`)

| Variable | Default |
|----------|---------|
| `SECURITY_HEADER_X_CONTENT_TYPE_OPTIONS` | `nosniff` |
| `SECURITY_HEADER_X_FRAME_OPTIONS` | `DENY` |
| `SECURITY_HEADER_X_XSS_PROTECTION` | `1; mode=block` |
| `SECURITY_HEADER_REFERRER_POLICY` | `strict-origin-when-cross-origin` |
| `SECURITY_HEADER_CSP` | `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'` |
| `SECURITY_HEADER_HSTS` | `max-age=31536000; includeSubDomains; preload` |
| `SECURITY_HEADER_PERMISSIONS_POLICY` | `camera=(), microphone=(), geolocation=(), payment=()` |

---

## Infrastructure & External Services

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MINIO_ENDPOINT` | No | — | MinIO endpoint for object storage |
| `MINIO_ACCESS_KEY` | No | — | MinIO access key |
| `MINIO_SECRET_KEY` | No | — | MinIO secret key |
| `FEEDBACK_SERVICE_URL_HTTP` | No | `http://feedback:5015` | Feedback service URL (primary) |
| `FEEDBACK_URL` | No | — | Fallback feedback service URL |

The feedback route (`POST /summary/feedback`) sends behavioral metrics to the Feedback Service at the resolved URL. The resolution order is: `FEEDBACK_SERVICE_URL_HTTP` → `FEEDBACK_URL` → `http://feedback:5015` (default).

---

## Example .env (Development)

```bash
NODE_ENV=development
SERVICE_NAME=hope-smr
SUMMARY_AGENT_HOST=0.0.0.0
SUMMARY_AGENT_PORT=8862
SUMMARY_AGENT_DEBUG=true
SUMMARY_AGENT_LOG_LEVEL=DEBUG

SUMMARY_SERVICE_PROVIDER=azure_openai
AZURE_OPENAI_API_KEY=your_api_key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4
AZURE_OPENAI_MODEL=gpt-4

SUMMARY_AGENT_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/medical_summaries
SUMMARY_AGENT_REDIS_URL=redis://localhost:6379

LOG_LEVEL=DEBUG
LOG_FILE_ENABLED=true
```

---

## Example .env (Production)

```bash
NODE_ENV=production
SERVICE_NAME=hope-smr
SUMMARY_AGENT_HOST=0.0.0.0
SUMMARY_AGENT_PORT=8862
SUMMARY_AGENT_LOG_LEVEL=INFO

SUMMARY_SERVICE_PROVIDER=azure_openai
AZURE_OPENAI_API_KEY=<managed-secret>
AZURE_OPENAI_ENDPOINT=https://prod-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4
AZURE_OPENAI_TEMPERATURE=0.1
AZURE_OPENAI_MAX_TOKENS=8192

SUMMARY_AGENT_DATABASE_URL=postgresql+asyncpg://hope:password@postgres:5432/hope
SUMMARY_AGENT_REDIS_URL=redis://redis:6379

CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/0
CELERY_WORKER_CONCURRENCY=3

ENABLE_METRICS=true
OTEL_SERVICE_NAME=hope-smr
OTEL_TRACES_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317

ENABLE_SECURITY_HEADERS=true
CORS_ALLOW_ORIGINS=https://app.hope.com

LOG_LEVEL=INFO
LOG_FILE_ENABLED=true
LOG_FILE_JSON_FORMAT=true
```

---

## Configuration Validation

The service includes a built-in `ConfigValidator` class (`src/smr/infrastructure/config_validator.py`) to check for missing or invalid variables:

```bash
python -c "from smr.infrastructure.config_validator import validate_environment; print(validate_environment())"
```

For a full report:

```bash
python -c "from smr.infrastructure.config_validator import print_config_report; print_config_report()"
```

For a summary dict:

```bash
python -c "from smr.infrastructure.config_validator import get_config_summary; print(get_config_summary())"
```

You can also get an example `.env` template directly from code:

```bash
python -c "from smr.core.config import get_env_config_example; print(get_env_config_example())"
```

---

## Environment-Specific Behavior

| Aspect | Development | Production |
|--------|-------------|------------|
| Security headers | Relaxed (allows HTTP) | Strict (HSTS, CSP) |
| Logging | DEBUG level, human-readable | INFO level, JSON format |
| Tracing | Disabled by default | Enabled |
| CORS | All origins (`*`) | Restricted |
| Service URLs | `localhost:*` | Container service names |
| Log retention | Small files | Large files, long retention |

---

## Related Documentation

- [SMR Service Overview](./README.md)
- [API Reference](./api-reference.md)
- [API Gateway Configuration](../api/configuration.md)
