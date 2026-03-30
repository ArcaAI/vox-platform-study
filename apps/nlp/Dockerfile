# syntax=docker/dockerfile:1
# ── NLP Service ──────────────────────────────────────────────────────────────
# Multi-stage build: builder → debug | production
#
# Requires hope-python-base image to be built first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build targets:
#   docker build --target production -t nlp .
#   docker build --target debug -t nlp:debug .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder — install Python packages into a portable venv ─────────
FROM hope-python-base:latest AS builder

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    libasound2-dev

# Layer 1: Install torch CPU-only from PyTorch index.
# Separated so this ~200MB layer is cached independently.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /app/.venv && \
    uv pip install --python /app/.venv \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.1.0"

# Layer 2: Install remaining deps from lockfile.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project --no-editable \
        --python /app/.venv/bin/python

COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

RUN find /app/.venv/lib -type d \( \
        -name "__pycache__" -o -name "*.egg-info" \
        -o -name "tests" -o -name "test" \
        -o -name "docs" -o -name "doc" -o -name "examples" -o -name "benchmarks" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( \
        -name "*.pyc" -o -name "*.pyo" \
        -o -name "*.pyi" -o -name "py.typed" \
    \) -type f -delete 2>/dev/null || true \
    && find /app/.venv/lib -name "*.so" \
        -exec strip --strip-unneeded {} + 2>/dev/null || true

# ── Debug stage ─────────────────────────────────────────────────────────────
FROM hope-python-base:latest AS debug

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    curl procps

COPY --from=builder /app/.venv /app/.venv

WORKDIR /app
COPY src/ /app/src/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/src"

USER hope
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "uvicorn", "--factory", "nlp.app:get_app", "--host", "0.0.0.0", "--port", "8864"]

# ── Production stage ────────────────────────────────────────────────────────
FROM hope-python-base:latest AS production

LABEL maintainer="HOPE Team" \
    service="nlp" \
    description="HOPE NLP Service" \
    org.opencontainers.image.title="HOPE NLP Service" \
    org.opencontainers.image.description="Medical entity recognition and NLP service"

ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app/src" \
    OTEL_SERVICE_NAME=hope-nlp \
    OTEL_RESOURCE_ATTRIBUTES="service.name=hope-nlp,service.namespace=hope,deployment.environment=production" \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true \
    LOG_LEVEL=info

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope src/ /app/src/

USER hope
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "uvicorn", "--factory", "nlp.app:get_app", "--host", "0.0.0.0", "--port", "8864"]
