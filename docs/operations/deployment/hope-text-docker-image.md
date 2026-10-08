# HOPE Text Service Docker Image Specification & Operational Guide

**Image:** `hope-text`
**Dockerfile Location:** [`apps/text/Dockerfile`](file:///Users/apple/Desktop/project-hope/apps/text/Dockerfile)
**Base Image:** [`hope-python-base:latest`](file:///Users/apple/Desktop/project-hope/docs/operations/deployment/hope-python-base.md)
**Service Name:** `text` (`apps/text`)
**Container Port:** `8862`
**Target Environment:** Linux Container Runtime (Kubernetes / Docker, `linux/amd64`)
**Status:** Production Standard

---

## 1. Executive Summary

`hope-text` is the containerized runtime for the HOPE platform's **Text Generation and Clinical Summarization Microservice** (`apps/text`). It acts as an asynchronous, stateless orchestration gateway responsible for:

- Clinical SOAP note synthesis and structured report generation.
- Real-time Server-Sent Events (SSE) token-by-token streaming.
- Automated clinical validation and judging.
- Dynamic per-request routing across self-hosted inference engines (Ollama, vLLM, LM Studio) and cloud LLM providers (Azure OpenAI, AWS Bedrock, Anthropic, Google Vertex).

```
                      ┌────────────────────────────────────────┐
                      │    API Gateway / Frontend Clients      │
                      └───────────────────┬────────────────────┘
                                          │
                                          │ POST /api/v1/generate (Port 8862)
                                          ▼
                      ┌────────────────────────────────────────┐
                      │          hope-text Container           │
                      │  (FastAPI / Single-Worker Uvicorn)     │
                      │                                        │
                      │  - ServiceAuthMiddleware               │
                      │  - TaskManager (Redis DB /3)           │
                      │  - GenerationHub (SSE Pub/Sub)         │
                      │  - Provider Registry (Dynamic SDKs)    │
                      └───────────────┬────────────┬───────────┘
                                      │            │
            ┌─────────────────────────┘            └─────────────────────────┐
            ▼                                                                ▼
┌──────────────────────────────┐                           ┌──────────────────────────────────┐
│  Kubernetes Redis            │                           │  Inference Engines (BYOK / Host) │
│  (NodePort 32074, DB /3)     │                           │  - Remote Ollama (qwen2.5:14b)   │
│                              │                           │  - In-Cluster vLLM (:8000)       │
│  - Task States & Caches      │                           │  - Cloud APIs (Azure, Bedrock)   │
│  - SSE Token Event Buffers   │                           └──────────────────────────────────┘
└──────────────────────────────┘
```

---

## 2. In-Image Anatomy & Filesystem Layout

Inside the container, all assets are scoped under `/app` and owned by the non-privileged `hope` user (`uid=1001:gid=1001`):

```text
/app/
├── src/                               # Application Source Code
│   └── text/
│       ├── main.py                    # App boot, lifespan, and lazy provider factories
│       ├── api/                       # HTTP REST and SSE endpoints
│       │   ├── endpoints/             # /generate, /stream, /health, /providers, /judge
│       │   └── middleware/            # ServiceAuthMiddleware (X-Service-Token & X-Tenant-Id)
│       ├── core/                      # Settings, telemetry, guardrails, and connection models
│       ├── models/                    # Pydantic wire models (GenerateRequest, TaskState)
│       ├── providers/                 # LLM engine adapters (OpenAICompat, Ollama, Bedrock, etc.)
│       ├── routing/                   # In-memory GenerationHub & SSE streaming routines
│       └── services/                  # TaskManager, CircuitBreaker, RateLimitTracker
├── .venv/                             # Hermetic Python 3.11 virtual environment
│   ├── bin/                           # python, uvicorn
│   └── lib/python3.11/site-packages/  # Installed dependencies & internal workspace wheels
└── build-info.json                    # CI build metadata (SHA, version, timestamp, branch)
```

---

## 3. Bundled Dependencies & SDKs

Because `apps/text` is an orchestration proxy, it does **not** bundle gigabytes of local weight files inside the image. The image packages client SDKs to interact with remote and self-hosted models:

| Category                       | Packages Baked In                                       | Purpose                                                                                |
| :----------------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------- |
| **Web Server**           | `fastapi`, `uvicorn[standard]`                      | Serves HTTP REST on`0.0.0.0:8862`                                                    |
| **Streaming**            | `sse-starlette`, `redis[hiredis]`                   | Powers live Server-Sent Events over Redis channels                                     |
| **Self-Hosted Adapters** | `openai>=3.1`, `httpx2`, `h2`                     | Communicates with**Ollama**, **vLLM**, and **LM Studio** over HTTP/2 |
| **Cloud Model SDKs**     | `anthropic`, `google-genai`, `boto3`              | Directly invokes Claude, Gemini (Vertex), and AWS Bedrock                              |
| **Data Validation**      | `pydantic v2`, `orjson`, `uuid7`                  | High-speed request validation and JSON parsing                                         |
| **Observability**        | `structlog`, `prometheus-client`, `opentelemetry` | Metrics (`/metrics`) and distributed tracing                                         |

### Shared Monorepo Workspace Wheels

The builder installs 5 shared internal packages from the repo root context:

- `hope-runtime-models`: Central data and error models.
- `hope-env`: Multi-tier environment variable resolution.
- `hope-otel`: Cross-service trace propagation.
- `hope-obs`: Standardized JSON structured logging.
- `hope-async-contract`: Async envelope and event contracts.

---

## 4. Multi-Stage Dockerfile Architecture

The build process defined in [`apps/text/Dockerfile`](file:///Users/apple/Desktop/project-hope/apps/text/Dockerfile) consists of two stages:

### Stage 1: `builder`

- Inherits from `hope-python-base:latest`.
- Copies repository root manifests (`pyproject.toml`, `uv.lock`) and sibling service manifests.
- Copies all shared workspace packages.
- Executes `uv sync --frozen --package text --no-dev` using Docker cache mounts (`/root/.cache/uv`).
- Strips bytecode (`*.pyc`) and build artifacts to minimize layer size.

### Stage 2: `production`

- Inherits cleanly from `hope-python-base:latest`.
- Copies the pre-compiled virtual environment (`/app/.venv`) and source code (`apps/text/src`).
- Bakes build identity into `/app/build-info.json` using strict `set -eu` enforcement.
- Configures health checks and non-root execution (`USER hope`).

---

## 5. Architectural Decision: Single Worker Enforcement

[`apps/text/Dockerfile:L120-L157`](file:///Users/apple/Desktop/project-hope/apps/text/Dockerfile#L120-L157) strictly enforces a **single Uvicorn worker**:

```dockerfile
ENTRYPOINT ["python", "-m", "uvicorn", "text.main:app", "--host", "0.0.0.0", "--port", "8862"]
```

### Why `--workers` is Forbidden:

1. **In-Process `GenerationHub`:** Active SSE streams are tracked in-process. If Uvicorn forks into multiple workers (`--workers 4`), each worker maintains an independent hub.
2. **Stream Truncation Risk:** When a client drops and attempts to resume a stream (`GET /generations/{id}/stream`), a multi-worker setup can route the reconnect to a worker that does not own the active generator. This causes premature termination, returning truncated clinical notes without error.
3. **Throughput Sufficiency:** A single worker saturates a full CPU core (~0.95 cores busy) and delivers ~90+ tokens/sec on typical clinical workloads.

---

## 6. Environment Configuration

| Variable                  | Default in Image             | Recommended Value                 | Purpose                                                      |
| :------------------------ | :--------------------------- | :-------------------------------- | :----------------------------------------------------------- |
| `TEXT_PORT`             | `8862`                     | `8862`                          | Port Uvicorn listens on.                                     |
| `TEXT_HOST`             | `127.0.0.1`                | `0.0.0.0`                       | **Must be `0.0.0.0` in Docker** for port forwarding. |
| `TEXT_REDIS_URL`        | `redis://localhost:6379/0` | `redis://<host>:<port>/3`       | Redis state and SSE streaming channels.                      |
| `INTERNAL_ACCESS_TOKEN` | `CHANGE_ME`                | `<secure-token>`                | Inter-service auth token (bypassed if`CHANGE_ME`).         |
| `DEBUG`                 | `false`                    | `true` (dev) / `false` (prod) | Log verbosity and stack trace exposure.                      |

> [!IMPORTANT]
> **Dynamic Provider Routing:** LLM endpoints are **not** hardcoded in `.env`. The service receives inference targets dynamically per-request via `provider_overrides`:
>
> ```json
> "provider_overrides": {
>   "openai_compat": {
>     "base_url": "http://192.168.112.2:11434/v1",
>     "api_key": "ollama"
>   }
> }
> ```

---

## 7. Build & Deployment Runbook

### Step 1: Build Base Image (from Repo Root)

```bash
docker build --platform linux/amd64 \
  -t hope-python-base:latest \
  infrastructure/docker/python-base/
```

### Step 2: Build Text Service Image

```bash
docker build --platform linux/amd64 \
  -f apps/text/Dockerfile \
  --target production \
  --build-arg BUILD_SERVICE=text \
  --build-arg BUILD_VERSION=2.0.0 \
  --build-arg BUILD_GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main") \
  --build-arg BUILD_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local") \
  --build-arg BUILD_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t hope-text:latest .
```

### Step 3: Run Container (Connecting to Cluster Redis & Ollama)

```bash
docker run -d \
  --name hope-text \
  -p 8862:8862 \
  -e TEXT_HOST=0.0.0.0 \
  -e TEXT_PORT=8862 \
  -e TEXT_REDIS_URL="redis://192.168.112.6:32074/3" \
  -e INTERNAL_ACCESS_TOKEN="CHANGE_ME" \
  hope-text:latest
```

---

## 8. Verification & Health Probes

### 1. Health Probe

```bash
curl http://localhost:8862/api/v1/health
```

**Expected Response:**

```json
{
  "status": "healthy",
  "service": "text",
  "version": "2.0.0",
  "checks": {
    "redis": { "status": "healthy", "duration_ms": 45.99 },
    "openai_compat": { "status": "healthy" },
    "ollama": { "status": "healthy" }
  }
}
```

### 2. Synchronous Inference Test

```bash
curl -X POST http://localhost:8862/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: system" \
  -d '{
    "provider": "openai_compat",
    "model": "qwen2.5:14b",
    "prompt": "Reply with only: Hello from Ollama inside Docker!",
    "provider_overrides": {
      "openai_compat": {
        "base_url": "http://192.168.112.2:11434/v1",
        "api_key": "ollama"
      }
    }
  }'
```

### 3. Real-Time Token Streaming (SSE)

```bash
curl -N -X POST http://localhost:8862/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: system" \
  -d '{
    "provider": "openai_compat",
    "model": "qwen2.5:14b",
    "prompt": "Count from 1 to 5.",
    "stream": true,
    "provider_overrides": {
      "openai_compat": {
        "base_url": "http://192.168.112.2:11434/v1",
        "api_key": "ollama"
      }
    }
  }'
```
