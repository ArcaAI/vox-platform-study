# syntax=docker/dockerfile:1
# ── Harness Service ─────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Built from the REPO ROOT context so it consumes the single uv workspace lock
# (/uv.lock), resolving identical dependency versions as every other HOPE Python
# service.
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build (from repo root):
#   docker build -f apps/harness/Dockerfile --target production -t harness .
#
# NOTE: This service hosts BOTH the FastAPI HTTP surface (default ENTRYPOINT)
#       and a Temporal worker (override the command to run the worker):
#   docker run harness python -m harness.temporal.worker
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# Build toolchain (builder stage ONLY — never leaks into the production stage,
# which copies just /app/.venv + source). Required because the `atomic-fact`
# extra pulls llama-cpp-python (the MiniCheck GGUF entailer, TASK-481), which
# has no usable prebuilt wheel and compiles a native llama.cpp from source;
# hope-python-base intentionally ships no C/C++ toolchain. Its own layer so it
# caches independently of the dependency sync below.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake

# Portability: without this, cmake targets the BUILD HOST's CPU (-march=native),
# producing a llama.cpp binary that SIGILLs on any runtime host with a different
# instruction set. GGML_NATIVE=OFF forces a portable baseline build instead.
ENV CMAKE_ARGS="-DGGML_NATIVE=OFF" \
    FORCE_CMAKE=1

# Layer 1: install ONLY harness's deps from the workspace lock.
COPY pyproject.toml uv.lock ./
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/stt-v2/pyproject.toml ./apps/stt-v2/
COPY apps/tts-v2/pyproject.toml ./apps/tts-v2/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package harness --no-dev --extra rag --extra guardrails --extra atomic-fact \
        --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/harness/README.md ./apps/harness/
COPY apps/harness/src ./apps/harness/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package harness --no-dev --extra rag --extra guardrails --extra atomic-fact \
        --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-harness" \
    version="0.1.0" \
    org.opencontainers.image.title="HOPE Harness Service" \
    org.opencontainers.image.description="Bounded clinical-documentation loop on Temporal" \
    org.opencontainers.image.version="0.1.0"

ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    HARNESS_OTEL_ENABLED=false \
    HARNESS_OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    HARNESS_OTEL_SERVICE_NAME=harness \
    HARNESS_OTEL_SERVICE_NAMESPACE=hope \
    HARNESS_OTEL_DEPLOYMENT_ENVIRONMENT=production \
    HARNESS_OTEL_INSECURE=true \
    HARNESS_OTEL_LOGS_ENABLED=true \
    TEMPORAL_ADDRESS=temporal:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=harness-task-queue

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/harness/src ./src

USER hope

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8866/api/v1/health/live')"]

EXPOSE 8866

ENTRYPOINT ["python", "-m", "uvicorn", "harness.main:app", "--host", "0.0.0.0", "--port", "8866"]
