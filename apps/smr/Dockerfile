# syntax=docker/dockerfile:1
# ── SMR Service ─────────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Build targets:
#   docker build --target production -t smr .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder — install Python packages into a portable venv ─────────
FROM python:3.11-slim-trixie AS builder

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project --no-editable

COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

RUN find /app/.venv \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" -o -name "tests" -o -name "test" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv -name "*.so" -exec strip --strip-unneeded {} + 2>/dev/null || true

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM python:3.11-slim-trixie AS production

LABEL maintainer="HOPE Team" \
    service="apps-smr" \
    version="2.0.0" \
    description="HOPE Text Generation Service (SMR v2)" \
    stage="production" \
    org.opencontainers.image.title="HOPE SMR Service" \
    org.opencontainers.image.description="Multi-provider text generation service" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="HOPE Team" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.expose.8862/tcp="SMR Service API"

ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app/src" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    ENVIRONMENT=production

ENV LOG_LEVEL=info \
    SMR_V2_OTEL_ENABLED=false \
    SMR_V2_OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    SMR_V2_OTEL_SERVICE_NAME=smr-v2

WORKDIR /app

RUN groupadd -g 1001 -r hope && \
    useradd -r -u 1001 -g hope -s /usr/sbin/nologin -d /nonexistent smr

COPY --from=builder --chown=smr:hope /app/.venv /app/.venv
COPY --chown=smr:hope src/ /app/src/

ENV PATH="/app/.venv/bin:$PATH"

USER smr

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8862/api/v1/health/live')"]

EXPOSE 8862

ENTRYPOINT ["python", "-m", "uvicorn", "smr_v2.main:app", "--host", "0.0.0.0", "--port", "8862"]
