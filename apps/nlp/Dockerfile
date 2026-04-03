# syntax=docker/dockerfile:1
# ── NLP Service ──────────────────────────────────────────────────────────────
# Multi-stage build: deps → builder → debug | production
#
# Build targets:
#   docker build --target production -t nlp .
#   docker build --target debug -t nlp:debug .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps — system libraries needed to compile native wheels ────────
FROM python:3.11-slim-trixie AS deps

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libasound2-dev

# ── Stage 2: builder — install Python packages into a portable venv ─────────
FROM deps AS builder

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Layer 1: Install torch CPU-only from PyTorch index.
# Separated so this ~200MB layer is cached independently and only rebuilds
# when the torch version constraint changes.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /app/.venv && \
    uv pip install --python /app/.venv \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.1.0"

# Layer 2: Install remaining deps from lockfile.
# editdistpy's setuptools requirement is handled by
# [tool.uv.extra-build-dependencies] in pyproject.toml.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-dev --no-install-project --no-editable \
        --python /app/.venv/bin/python

COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

RUN find /app/.venv/lib -type d \( \
        -name "__pycache__" -o -name "*.egg-info" \
        -o -name "tests" -o -name "test" \
    \) -exec rm -rf {} + 2>/dev/null; \
    find /app/.venv/lib -name "*.so" \
        -exec strip --strip-unneeded {} + 2>/dev/null; true

# ── Debug stage ─────────────────────────────────────────────────────────────
FROM python:3.11-slim-trixie AS debug

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    curl procps

COPY --from=builder /app/.venv /app/.venv

WORKDIR /app
COPY src/nlp/ /app/src/

ENV PATH="/app/.venv/bin:$PATH" \
    VIRTUAL_ENV=/app/.venv \
    PYTHONPATH="/app" \
    PYTHONUNBUFFERED=1

RUN groupadd --gid 1001 nlpuser && \
    useradd --uid 1001 --gid nlpuser --shell /bin/bash --create-home nlpuser && \
    chown -R nlpuser:nlpuser /app

USER nlpuser
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "nlp.main"]

# ── Production stage ────────────────────────────────────────────────────────
FROM python:3.11-slim-trixie AS production

LABEL maintainer="HOPE Team" \
    service="nlp" \
    description="HOPE NLP Service" \
    org.opencontainers.image.title="HOPE NLP Service" \
    org.opencontainers.image.description="Real-time NLP service with Azure Cognitive Services" \
    org.opencontainers.image.vendor="HOPE Team" \
    org.opencontainers.image.licenses="MIT"

ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH"

ENV OTEL_SERVICE_NAME=hope-nlp \
    OTEL_RESOURCE_ATTRIBUTES="service.name=hope-nlp,service.namespace=hope,deployment.environment=production" \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true \
    LOG_LEVEL=info \
    LOG_CONSOLE_JSON_FORMAT=true

WORKDIR /app

RUN groupadd --gid 1001 nlpuser && \
    useradd --uid 1001 --gid nlpuser --shell /usr/sbin/nologin --no-create-home nlpuser

COPY --from=builder --chown=nlpuser:nlpuser /app/.venv /app/.venv
COPY --chown=nlpuser:nlpuser src/ /app/src/

USER nlpuser
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "nlp.main"]
