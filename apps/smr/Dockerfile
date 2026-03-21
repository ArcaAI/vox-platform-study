# -- BUILD STAGE --
FROM python:3.11-slim AS builder

# Re-declare ARG after FROM to make it available in this stage
ARG UV_VERSION=0.8.13

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential=12.* gcc=4:* && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get clean && \
    pip install --no-cache-dir uv==0.8.13

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY src/ ./src/

RUN uv sync --frozen --no-dev

RUN mkdir -p /opt/app && \
    cp -r /app/.venv /opt/app/ && \
    find /opt/app/.venv -name "*.pyc" -delete && \
    find /opt/app/.venv -name "__pycache__" -type d -exec rm -rf {} + || true && \
    find /opt/app/.venv -name "*.pyo" -delete

# -- PRODUCTION STAGE --
FROM python:3.11-slim AS production

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

RUN apt-get update && \
    apt-get install -y --no-install-recommends wget && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1001 -r hope && \
    useradd -r -u 1001 -g hope -s /usr/sbin/nologin -d /nonexistent smr

COPY --from=builder --chown=smr:hope /opt/app/.venv /app/.venv
COPY --chown=smr:hope src/ /app/src/

USER smr

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8862/api/v1/health/live || exit 1

EXPOSE 8862

ENTRYPOINT ["python", "-m", "uvicorn", "smr_v2.main:app", "--host", "0.0.0.0", "--port", "8862"]