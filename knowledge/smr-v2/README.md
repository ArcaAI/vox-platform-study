# SMR Service (Summarization V2)

The HOPE Summarization Service (SMR) is a FastAPI-based microservice that generates structured medical summaries from doctor-patient conversation transcripts. It integrates with multiple LLM providers (Azure OpenAI, Ollama, Langflow), offers synchronous and asynchronous processing modes, supports specialty-specific prompt templates, and includes enterprise-grade observability.

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       FastAPI Application                        │
│                                                                  │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────┐ │
│  │  REST API    │  │  WebSocket    │  │  Server-Sent Events   │ │
│  │  /summary/*  │  │  /ws/jobs/*   │  │  /sse/jobs/*          │ │
│  └──────┬───────┘  └───────┬───────┘  └──────────┬────────────┘ │
│         │                  │                     │              │
│         └──────────────────┼─────────────────────┘              │
│                            │                                    │
│         ┌──────────────────┴──────────────────┐                 │
│         │           Service Layer              │                 │
│         │                                      │                 │
│         │  ┌──────────────┐  ┌──────────────┐  │                │
│         │  │SummaryService│  │  JobService   │  │                │
│         │  │ • Chunking   │  │ • Create/Poll │  │                │
│         │  │ • Prompts    │  │ • Progress    │  │                │
│         │  │ • Parsing    │  │ • Cancel      │  │                │
│         │  └──────┬───────┘  └──────┬────────┘  │                │
│         │         │                 │           │                │
│         │    ┌────┴────┐      ┌─────┴──────┐   │                │
│         │    │LLM Layer│      │Celery Tasks│   │                │
│         │    │         │      └─────┬──────┘   │                │
│         │    │• Azure  │            │          │                │
│         │    │• Ollama │            │          │                │
│         │    │• Langflow│           │          │                │
│         │    └─────────┘            │          │                │
│         └───────────────────────────┘          │                │
└──────────────────┬───────────────────┬─────────┘                │
                   │                   │                           │
          ┌────────┴────────┐  ┌───────┴──────┐                   │
          │   PostgreSQL    │  │    Redis      │                   │
          │ (Summaries,     │  │ (Job Queue,   │                   │
          │  Audit Logs)    │  │  Pub/Sub)     │                   │
          └─────────────────┘  └──────────────┘
```

### LLM Provider Abstraction

The service defines an abstract `LLMService` interface with concrete implementations:

| Provider | Class | Success Rate | Key Feature |
|----------|-------|-------------|-------------|
| **Azure OpenAI** | `AzureOpenAIService` | ~99.9 % | Strict JSON schema, structured outputs, GPT-4 |
| **Ollama** | `OllamaService` | 80–95 % | Open-source models, local inference, JSON repair |
| **Langflow** | `LangflowService` | — | Flow-based orchestration, external agent integration |

The active provider is selected via `SUMMARY_SERVICE_PROVIDER` (accepts `azure_openai`, `ollama`, or `langflow`).

### Sync vs. Async Processing

| Mode | Endpoint | Flow |
|------|----------|------|
| **Synchronous** | `POST /api/v1/summary/sync` | HTTP request → LLM call → response in same request |
| **Asynchronous** | `POST /api/v1/summary/async` | HTTP 202 → Celery task → poll via WS/SSE/REST |

Async jobs are queued into Redis via Celery. Clients receive a `job_id` and can track progress through three channels:

1. **REST polling** — `GET /api/v1/jobs/{job_id}`
2. **WebSocket** — `WS /api/v1/ws/jobs/{job_id}`
3. **Server-Sent Events** — `GET /api/v1/sse/jobs/{job_id}`

### Specialty Prompt System

The service ships with department-specific prompt templates stored in `src/smr/models/prompts_*.py`. A `PromptSelector` resolves the correct template based on `department` and `visit_type`:

| Department | Visit Types | Aliases |
|-----------|-------------|---------|
| Breast Endocrine | New Referral, Follow-up | `breast & endocrine`, `breast and endocrine`, `breast`, `endocrine`, `breast/endocrine` |
| Hematology | New Referral, Revisit | `hematology`, `haematology` |
| Medicine | New Referral, Follow-up | `medicine`, `general medicine`, `internal medicine`, `general` |
| Neurology | New Referral, Follow-up | `neurology` |
| Orthopedics | New Referral, Review | `orthopedics`, `orthopaedics`, `ortho` |
| Rheumatology | New Referral, Follow-up | `rheumatology` |
| Surgery | New Referral, Follow-up | `surgery` |

Visit type normalization maps many common terms (e.g., "new", "first", "initial", "exam", "consult", "referral") to `new_referral`, and follow-up terms (e.g., "follow up", "review", "revisit", "fu") to `followup`.

Each template generates a JSON-enforced prompt pair (system + user) that guides the LLM to produce structured clinical documentation.

### Celery Worker Architecture

```
run_celery_worker.py
        │
        ▼
  Celery Worker
  ├── Task: create_medical_summary
  │     ├── Reads job params from Redis
  │     ├── Calls SummaryService
  │     ├── Publishes progress via Redis Pub/Sub
  │     └── Stores result in PostgreSQL
  ├── Queue: summary_tasks
  └── Broker: Redis (db 0)
```

Workers are started separately and can be scaled horizontally. Concurrency is controlled by `CELERY_WORKER_CONCURRENCY` (default: 3).

## Tech Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Framework | FastAPI | >=0.104.0 | Async HTTP framework |
| Language | Python | >=3.11 | Service implementation |
| Package Manager | pip / uv | Latest | Dependency management |
| Database | PostgreSQL | 17 | Summary persistence, audit logs |
| ORM | SQLAlchemy | >=2.0.0 (asyncio) | Async database operations |
| Migrations | Alembic | >=1.13.0 | Schema versioning |
| Cache / Queue | Redis | 8 | Celery broker, pub/sub, caching |
| Task Queue | Celery | >=5.3.0 | Background job processing |
| LLM (Azure) | openai SDK | >=1.10.0 | Azure OpenAI GPT-4 integration |
| LLM (Local) | ollama SDK | >=0.2.0 | Local model inference |
| Validation | Pydantic | >=2.5.0 | Request/response models |
| Settings | pydantic-settings | >=2.1.0 | Environment-based configuration |
| Logging | structlog | >=23.2.0 | Structured JSON logging |
| Metrics | prometheus-client | >=0.19.0 | Prometheus metric export |
| Metrics (FastAPI) | prometheus-fastapi-instrumentator | >=6.1.0 | FastAPI metrics instrumentation |
| Tracing | OpenTelemetry | >=1.20.0 | Distributed tracing |
| WebSocket | websockets | >=12.0 | Real-time job updates |
| SSE | sse-starlette | >=1.8.0 | Server-Sent Events |
| Monitoring | psutil | >=5.9.0 | Resource usage tracking |
| Text | tiktoken, nltk | — | Token counting, text processing |
| Vector Store | qdrant-client | >=1.5.0 | Feedback and summary embedding storage |
| HTTP Clients | httpx, aiohttp | >=0.25.0, >=3.9.0 | Async HTTP requests |
| JSON | orjson | >=3.9.0 | High-performance JSON serialization |

## Getting Started

### Prerequisites

- Python 3.11+
- PostgreSQL 17
- Redis 8
- Conda (recommended) or virtualenv
- Azure OpenAI account **or** Ollama installation

### Environment Setup

```bash
# Create and activate conda environment
conda create -n hope-smr python=3.11 -y
conda activate hope-smr

# Navigate to the SMR service
cd apps/smr

# Install dependencies (uv recommended)
pip install uv
uv pip install -e .

# Or with pip
pip install -e .

# Copy environment template
cp env.example .env
# Edit .env — see configuration.md for all variables
```

### Database Setup

```bash
# Start PostgreSQL (or use existing)
docker run -d --name postgres-smr \
  -e POSTGRES_DB=hope \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:17

# Run migrations
alembic upgrade head
```

### Start Redis

```bash
docker run -d --name redis-smr -p 6379:6379 redis:8-alpine
```

### Run the Service

```bash
# Option 1: Convenience script
./run_dev.sh

# Option 2: Python runner
python run_dev.py

# Option 3: Uvicorn directly
uvicorn smr.main:app --host 0.0.0.0 --port 5005 --reload
```

### Start Celery Worker (for async processing)

```bash
python run_celery_worker.py
```

### Access Points

| Resource | URL |
|----------|-----|
| Swagger UI | http://localhost:8862/docs |
| ReDoc | http://localhost:8862/redoc |
| Health Check | http://localhost:8862/api/v1/health |
| Prometheus Metrics | http://localhost:8862/metrics |

> **Note:** The standard port is `8862` (set by `SUMMARY_AGENT_PORT`). This can be overridden via environment variable.

## Configuration

All environment variables are documented in [configuration.md](./configuration.md). Key groups:

| Group | Examples |
|-------|---------|
| Application | `SUMMARY_AGENT_HOST`, `SUMMARY_AGENT_PORT`, `SUMMARY_AGENT_LOG_LEVEL` |
| LLM Provider | `SUMMARY_SERVICE_PROVIDER`, `AZURE_OPENAI_*`, `OLLAMA_*` |
| Database | `SUMMARY_AGENT_DATABASE_URL` |
| Redis / Celery | `SUMMARY_AGENT_REDIS_URL`, `CELERY_BROKER_URL` |
| Observability | `OTEL_*`, `ENABLE_METRICS`, `LOG_*` |
| Security | `ENABLE_SECURITY_HEADERS`, `CORS_*` |

## API Reference

See [api-reference.md](./api-reference.md) for the full endpoint catalog with request/response schemas.

## Testing

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src/smr --cov-report=html

# Run only unit tests
pytest tests/unit/

# Run specific test
pytest tests/unit/test_services.py::test_summary_creation -v

# Parallel execution
pytest -n auto
```

Test structure:

```
tests/
├── unit/               # Isolated service and model tests
├── integration/        # Full API flow tests (require DB + Redis)
├── fixtures/           # Shared test data generators
└── conftest.py         # Pytest configuration and shared fixtures
```

## Deployment

### Docker

```bash
docker build -t hope-smr:latest .
docker run -d -p 8862:8862 --env-file .env.production hope-smr:latest
```

### Docker Compose

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes

The service supports standard Kubernetes deployment with readiness (`/api/v1/readiness`) and liveness (`/api/v1/liveness`) probes. See the deployment guide for manifests, HPA configuration, and resource limits.

### Production Checklist

- [ ] `NODE_ENV=production`
- [ ] `SUMMARY_SERVICE_PROVIDER` and LLM credentials set
- [ ] `SUMMARY_AGENT_DATABASE_URL` with production PostgreSQL
- [ ] Redis cluster configured for HA
- [ ] `ENABLE_METRICS=true` and `OTEL_TRACES_ENABLED=true`
- [ ] `ENABLE_SECURITY_HEADERS=true`
- [ ] CORS restricted to known origins
- [ ] Log level set to `INFO`
- [ ] Celery workers scaled to expected load
- [ ] Alembic migrations applied (`alembic upgrade head`)

## Observability

### Prometheus Metrics

Exposed at `GET /metrics`:

| Metric | Type | Description |
|--------|------|-------------|
| `smr_summaries_created_total` | Counter | Total summaries generated (by provider, specialty) |
| `smr_summary_duration_seconds` | Histogram | Summary generation latency |
| `smr_llm_requests_total` | Counter | LLM API requests (by provider, model, status) |
| `smr_llm_tokens_total` | Counter | Token usage (input / output) |
| `smr_errors_total` | Counter | Errors by type and component |
| `smr_jobs_created_total` | Counter | Async jobs created |
| `smr_job_duration_seconds` | Histogram | Async job processing time |
| `smr_websocket_connections_total` | Gauge | Active WebSocket connections |
| `smr_cpu_usage_percent` | Gauge | CPU utilization |
| `smr_memory_usage_bytes` | Gauge | Memory consumption |

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /api/v1/health` | Basic health | Application status |
| `GET /api/v1/health?detailed=true` | Full health | DB, Redis, LLM, system resources |
| `GET /api/v1/readiness` | K8s readiness | Critical dependencies |
| `GET /api/v1/liveness` | K8s liveness | Process alive |

> **Note:** Readiness and liveness probes are registered under the `/api/v1` prefix (not at root level).

### Logging

Structured JSON logs with correlation IDs:

```json
{
  "timestamp": "2025-01-15T12:00:00.000Z",
  "level": "INFO",
  "logger": "smr.services.summary_service",
  "message": "Summary generation completed",
  "correlation_id": "req-123e4567",
  "session_id": "session_123",
  "provider": "azure_openai",
  "duration_seconds": 2.3
}
```

### Distributed Tracing

OpenTelemetry auto-instruments FastAPI and HTTPX. Traces are exported via OTLP gRPC to the configured collector (Jaeger, Tempo, etc.). The instrumentation is set up in `src/smr/infrastructure/observability.py`.

### Resource Alerts

Background monitoring (via `psutil`) triggers warnings when:

| Condition | Default Threshold |
|-----------|-------------------|
| CPU usage | > 80 % |
| Memory usage | > 85 % |
| Disk usage | > 90 % |
| High error rate | > 10 % |
| Slow P95 latency | > 5 s |

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| "Failed to connect to LLM service" | Azure key / Ollama not running | Verify `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT`, or `curl http://localhost:11434/api/tags` for Ollama |
| "Cannot connect to database" | PostgreSQL down | Check `docker ps \| grep postgres` and `psql` connectivity |
| "Redis connection refused" | Redis not running | `redis-cli ping` should return `PONG` |
| "Alembic migration failed" | Schema drift | `alembic current`, then `alembic downgrade -1 && alembic upgrade head` |
| "Unable to parse JSON response" (Ollama) | Model producing malformed JSON | Lower `OLLAMA_TEMPERATURE`, check model compatibility, consider Azure |
| High memory usage | Large batch or model loaded | Check `docker stats`, reduce `CELERY_WORKER_CONCURRENCY` |
| Jobs stuck in "pending" | Celery worker not running | Start worker with `python run_celery_worker.py` |

### Debug Mode

```bash
SUMMARY_AGENT_DEBUG=true
SUMMARY_AGENT_LOG_LEVEL=DEBUG
```

### Log Analysis

```bash
tail -f logs/smr.log | jq .
jq 'select(.level == "ERROR")' logs/smr.log
jq 'select(.session_id == "session_123")' logs/smr.log
```

## Related Documentation

- [API Reference](./api-reference.md) — full endpoint catalog
- [Configuration](./configuration.md) — environment variable table
- [API Gateway](../api/README.md) — upstream NestJS gateway
- [Technical Architecture](../architecture/README.md) — platform-wide architecture
