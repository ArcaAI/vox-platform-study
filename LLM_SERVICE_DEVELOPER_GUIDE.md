# LLM Service Developer & Maintenance Guide (`apps/text`)

This guide provides practical instructions for engineers developing, debugging, extending, testing, and deploying the **Text Generation & LLM Microservice** (`apps/text`).

---

## 1. Local Development Setup

### 1.1 Prerequisites
- **Python**: `3.11.x` (strictly enforced by `pyproject.toml: ">=3.11,<3.12"`)
- **Package Manager**: [`uv`](https://github.com/astral-sh/uv) (v0.4.0+)
- **Redis**: Running locally or via Docker on port `6379`
- **Node/pnpm** (optional, for monorepo-wide scripts): Node 20+, pnpm 9+

### 1.2 Environment Bootstrapping
From the monorepo root:

```bash
# 1. Start local Redis
docker run -d --name hope-redis -p 6379:6379 redis:7-alpine

# 2. Sync virtual environment for apps/text using uv
uv sync --package text --all-extras

# 3. Create development environment file
cat <<EOF > apps/text/.env.development
TEXT_PORT=8862
TEXT_LOG_LEVEL=debug
NODE_ENV=development
TEXT_GATEWAY_URL=http://localhost:3000/api/v1
TEXT_REDIS_URL=redis://localhost:6379/0
TEXT_EXTERNAL_GUARDRAIL_BASE_URL=http://localhost:8861
INTERNAL_ACCESS_TOKEN=dev-secret-internal-token
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT
EOF
```

### 1.3 Starting the Development Server
```bash
# Activate virtualenv or run directly with uv:
uv run uvicorn text.main:app --host 0.0.0.0 --port 8862 --reload
```

Verify service startup:
```bash
curl http://localhost:8862/api/v1/health/live
# Expected: {"status": "alive"}
```

---

## 2. Adding a New LLM Provider Adapter

`apps/text` is a stateless gateway: adapters do **not** read environment variables for API keys or endpoints. They receive them per-request via `ConnectionOverrides` (`apps/text/src/text/core/connection.py`).

### Step 1: Subclass `LLMProvider`
Create `apps/text/src/text/providers/my_provider.py`:

```python
"""Adapter for MyProvider LLM engine."""
from __future__ import annotations

import httpx
from typing import AsyncIterator, Any
from text.providers.base import LLMProvider, GenerationResult, StreamChunk
from text.core.connection import ConnectionOverrides

class MyProvider(LLMProvider):
    name = "my_provider"
    supports_streaming = True
    supports_structured_output = True
    credential_posture = "push_per_request"

    def __init__(self, http_client: httpx.AsyncClient):
        self._client = http_client

    async def generate(
        self,
        prompt: str,
        system_prompt: str | None = None,
        messages: list[dict[str, str]] | None = None,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        overrides: ConnectionOverrides | None = None,
        **kwargs: Any,
    ) -> GenerationResult:
        # 1. Resolve credentials dynamically from overrides
        if not overrides or not overrides.api_key:
            raise ValueError("my_provider requires dynamic api_key via provider_overrides")
        
        base_url = overrides.base_url or "https://api.myprovider.ai/v1"
        target_model = model or overrides.model or "default-model"

        # 2. Build upstream payload
        payload = {
            "model": target_model,
            "messages": messages or [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        # 3. Execute HTTP request with shared pool client
        resp = await self._client.post(
            f"{base_url}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {overrides.api_key.get_secret_value()}"},
            timeout=kwargs.get("timeout", 60.0),
        )
        resp.raise_for_status()
        data = resp.json()

        return GenerationResult(
            text=data["choices"][0]["message"]["content"],
            model=target_model,
            prompt_tokens=data["usage"]["prompt_tokens"],
            completion_tokens=data["usage"]["completion_tokens"],
            total_tokens=data["usage"]["total_tokens"],
            reasoning=None,
        )

    async def stream(
        self,
        prompt: str,
        system_prompt: str | None = None,
        messages: list[dict[str, str]] | None = None,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        overrides: ConnectionOverrides | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[StreamChunk]:
        # Implement async SSE generator yielding StreamChunk(text=delta, is_terminal=False)
        ...
```

### Step 2: Register Factory in `src/text/main.py`
In `apps/text/src/text/main.py#lifespan()`:
```python
from text.providers.my_provider import MyProvider

# Inside lifespan startup block:
registry.register_factory(
    "my_provider",
    lambda: MyProvider(http_client=http_client)
)
```

### Step 3: Register in Concurrency & Circuit Breaker Dictionaries
In `main.py`, update `app.state.circuit_breakers` and `app.state.provider_semaphores` loops to include `"my_provider"`.

---

## 3. Adding a New API Endpoint

### Step 1: Define Schemas
Add request and response models in `apps/text/src/text/models/`:
```python
from pydantic import BaseModel, Field

class AnalysisRequest(BaseModel):
    document_text: str = Field(..., max_length=50000)
    focus_area: str = Field(default="diagnostic")

class AnalysisResponse(BaseModel):
    summary: str
    risk_score: float
```

### Step 2: Create Route Module
Create `apps/text/src/text/api/endpoints/analysis.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from text.core.dependencies import get_provider_registry
from text.providers.registry import ProviderRegistry
from text.models.analysis import AnalysisRequest, AnalysisResponse

router = APIRouter(tags=["Analysis"])

@router.post("/analysis", response_model=AnalysisResponse)
async def analyze_document(
    request: AnalysisRequest,
    registry: ProviderRegistry = Depends(get_provider_registry),
) -> AnalysisResponse:
    # Business logic
    return AnalysisResponse(summary="Normal exam", risk_score=0.1)
```

### Step 3: Mount Router in `src/text/main.py`
In `apps/text/src/text/main.py#create_app()`:
```python
from text.api.endpoints.analysis import router as analysis_router

app.include_router(analysis_router, prefix="/api/v1")
```

---

## 4. Operational Troubleshooting & Runbooks

### Runbook 1: Circuit Breaker Tripped (`503 CircuitOpenError`)
**Symptom**: Requests return `503 Service Unavailable` with message `"Circuit breaker OPEN for provider <name>"`.
- **Cause**: Upstream provider experienced 5 consecutive connection timeouts or 5xx HTTP errors within a short window.
- **Investigation**:
  ```bash
  # Check circuit breaker metrics
  curl -s http://localhost:8862/metrics | grep text_circuit_breaker_state
  # Check recent error logs
  grep "circuit_breaker.state_changed" /var/log/text.log
  ```
- **Resolution**:
  - The circuit breaker enters `HALF-OPEN` after `recovery_timeout_s` (default 30s) and automatically tests with single requests.
  - Verify upstream host reachability with `/api/v1/providers/probe`.
  - If upstream is permanently down, the Gateway's `PoolRouter` automatically degrades to secondary providers.

---

### Runbook 2: Request Timeout (`504 Gateway Timeout`)
**Symptom**: Long-running requests fail at exactly 300 seconds (or configured timeout).
- **Cause**: Inference exceeded `PROVIDER_TIMEOUT_FLOOR_S` (300s) or control plane `provider_timeouts[provider]`.
- **Resolution**:
  - If using self-hosted local engines (e.g. vLLM or LM Studio generating 4k tokens on CPU/slow GPU), raise the control plane timeout via the Admin Console or update `runtime_profile`.
  - For massive documents, verify chunking and use streaming (`stream=true`), which generates tokens immediately and avoids single HTTP timeout boundaries.

---

### Runbook 3: Stream Resumption Drops & Single-Worker Invariant
**Symptom**: Clinician client reconnects with `Last-Event-ID` and receives only 2 chunks with no terminal frame.
- **Root Cause**: Uvicorn was accidentally launched with `--workers > 1` or multiple pod replicas without shared Redis `XREAD BLOCK` tailing.
- **Architecture Invariant**: `GenerationHub` is in-process. A resume request load-balanced to a non-owner worker reads the Redis backlog and exits immediately if the in-memory producer is absent.
- **Action**: Verify container runs with exactly **1 worker** (`ENTRYPOINT ["python", "-m", "uvicorn", "text.main:app", "--port", "8862"]`). Multi-worker mode is strictly forbidden until cross-process `XREAD BLOCK` tailing is implemented.

---

### Runbook 4: LM Studio Residency Error (`SERVICE_UNREACHABLE`)
**Symptom**: Admin Console reports:
`SERVICE_UNREACHABLE: The lm-studio residency agent has no address: LMSTUDIO_AGENT_URL is not set, so POST /internal/residency/load was not sent.`
- **Cause**:
  1. `apps/api` requires `LMSTUDIO_AGENT_URL` (typically `http://hope-lmstudio:8869`) to communicate with the in-pod sidecar agent responsible for model loading.
  2. If GGUF model weights are not pre-downloaded in MinIO/S3, the residency agent cannot mount the weights into memory.
- **Fix**:
  1. Ensure `LMSTUDIO_AGENT_URL=http://hope-lmstudio:8869` is set in the Gateway's environment.
  2. Run the model download pipeline or ensure model weights exist in the shared bucket before issuing load requests.

---

## 5. Testing Suite Execution

The test suite runs under `pytest` with async support and strict isolation.

### 5.1 Running Unit Tests
```bash
# Run unit tests only (excludes slow e2e vendor calls)
uv run pytest src/text/tests -m "not e2e"
```

### 5.2 Running with Code Coverage
```bash
uv run pytest --cov=text --cov-report=term-missing --cov-report=html
```

### 5.3 Linting and Type Checking
```bash
# Format code
uv run black apps/text/src

# Fast linter check
uv run ruff check apps/text/src

# Strict type check (excludes tests directory)
uv run mypy
```

---

## 6. Container Build & Packaging

Build the production Docker image from the **monorepo root**:

```bash
# Build base image first if not already present
docker build -t hope-python-base infrastructure/docker/python-base/

# Build text service image
docker build \
  -f apps/text/Dockerfile \
  --target production \
  --build-arg BUILD_SERVICE=text \
  --build-arg BUILD_VERSION=2.0.0 \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  -t hope-text:2.0.0 .
```

Test the container locally:
```bash
docker run -d --name text-test \
  -p 8862:8862 \
  -e INTERNAL_ACCESS_TOKEN=test-token \
  -e OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT \
  hope-text:2.0.0

curl http://localhost:8862/api/v1/health/live
docker rm -f text-test
```

