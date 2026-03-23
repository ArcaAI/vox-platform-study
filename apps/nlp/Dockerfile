# -- Builder stage --
FROM python:3.11-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

WORKDIR /app

COPY pyproject.toml uv.lock ./

# Use uv pip install (system-wide) instead of uv sync because editdistpy
# (symspellpy dep) requires pkg_resources at build time but doesn't declare it.
# uv pip install --system avoids the build-isolation issue.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --no-cache \
        "fastapi>=0.133.0" \
        "uvicorn[standard]>=0.41.0" \
        "pydantic>=2.12.5" \
        "pydantic-settings>=2.13.1" \
        "spacy>=3.8.0" \
        "transformers>=4.48.0" \
        "torch>=2.1.0" \
        "numpy>=2.0.0" \
        "pandas>=2.1.0" \
        "scikit-learn>=1.3.0" \
        "aiofiles>=25.1.0" \
        "python-multipart>=0.0.22" \
        "httpx>=0.28.1" \
        "python-jose[cryptography]>=3.3.0" \
        "passlib[bcrypt]>=1.7.4" \
        "symspellpy>=6.9.0" \
        "prometheus-fastapi-instrumentator>=7.1.0" \
        "opentelemetry-api>=1.39.1" \
        "opentelemetry-sdk>=1.39.1" \
        "opentelemetry-instrumentation>=0.60b1" \
        "opentelemetry-instrumentation-fastapi>=0.60b1" \
        "opentelemetry-instrumentation-logging>=0.60b1" \
        "opentelemetry-exporter-otlp>=1.39.0" \
        "opentelemetry-exporter-jaeger-thrift>=1.21.0" \
        "deprecated>=1.2.18" \
    && find /usr/local/lib/python3.11/site-packages \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -exec rm -rf {} + 2>/dev/null; \
    find /usr/local/lib/python3.11/site-packages -name "*.so" \
        -exec strip --strip-unneeded {} + 2>/dev/null; \
    rm -rf /usr/local/lib/python3.11/site-packages/nvidia \
           /usr/local/lib/python3.11/site-packages/torch/lib/libtorch_cuda*.so \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcudnn*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libnccl*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcublas*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcufft*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcurand*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcusparse*.so* \
           /usr/local/lib/python3.11/site-packages/torch/lib/libcusolver*.so* \
    2>/dev/null; true

# -- Debug stage (optional for development) --
FROM python:3.11-slim AS debug

COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY src/nlp/ /app/src/

WORKDIR /app

ENV PYTHONPATH="/app" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN groupadd --gid 1001 nlpuser && \
    useradd --uid 1001 --gid nlpuser --shell /bin/bash --create-home nlpuser && \
    chown -R nlpuser:nlpuser /app

USER nlpuser

EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8864/api/v1/health || exit 1

ENTRYPOINT ["python", "-m", "nlp.main"]

# -- Production stage --
FROM gcr.io/distroless/python3-debian12:nonroot AS production

LABEL maintainer="HOPE Team" \
    service="nlp" \
    version="1.0.0" \
    description="HOPE NLP Service" \
    stage="production" \
    org.opencontainers.image.title="HOPE NLP Service" \
    org.opencontainers.image.description="Real-time NLP service with Azure Cognitive Services" \
    org.opencontainers.image.version="1.0.0" \
    org.opencontainers.image.vendor="HOPE Team" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.expose.8864/tcp="NLP Service API"

ENV PYTHONPATH="/usr/local/lib/python3.11/site-packages:/app" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random

ENV OTEL_SERVICE_NAME=hope-nlp \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_RESOURCE_ATTRIBUTES=service.name=hope-nlp,service.version=1.0.0,service.namespace=hope,deployment.environment=production \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true \
    LOG_LEVEL=info

COPY --from=builder --chown=65534:65534 /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --chown=65534:65534 src/ /app/src/

WORKDIR /app

USER 65534

EXPOSE 8864

ENTRYPOINT ["/usr/bin/python3", "/app/src/main.py"]
