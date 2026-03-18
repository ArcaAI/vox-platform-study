# -- Builder stage --
FROM python:3.11-slim AS builder

# Build optimization environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# Install build dependencies with version pinning for security
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential=12.* \
    libasound2-dev=1.* \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install uv package manager with specific version for reproducibility
RUN pip install --no-cache-dir uv==0.4.29

# Set working directory
WORKDIR /app

# Copy dependency files for better layer caching
COPY pyproject.toml uv.lock ./

# Install dependencies and create a clean virtual environment
RUN uv sync --frozen --no-dev

# Create a minimal Python installation directory with better cleanup
RUN mkdir -p /opt/app && \
    cp -r /app/.venv /opt/app/ && \
    find /opt/app/.venv -name "*.pyc" -delete && \
    find /opt/app/.venv -name "__pycache__" -type d -exec rm -rf {} + || true && \
    find /opt/app/.venv -name "*.pyo" -delete

# -- Debug stage (optional for development) --
FROM python:3.11-slim AS debug

# Copy virtual environment from builder
COPY --from=builder /opt/app/.venv /app/.venv

# Install minimal debugging tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl=7.* \
    procps=2:* \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy source code
COPY src/nlp/ /app/src/

WORKDIR /app

# Add virtual environment to Python path
ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app"
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Create non-root user for security
RUN groupadd --gid 1001 nlpuser && \
    useradd --uid 1001 --gid nlpuser --shell /bin/bash --create-home nlpuser && \
    chown -R nlpuser:nlpuser /app

USER nlpuser

# Expose port
EXPOSE 8864

# Health check for debug builds
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8864/api/v1/health || exit 1

# Use Python entrypoint
ENTRYPOINT ["/usr/bin/python3", "/app/src/main.py"]

# -- Production stage --
FROM gcr.io/distroless/python3-debian12:latest AS production

# Add comprehensive build metadata
LABEL maintainer="HOPE Team"
LABEL service="nlp"
LABEL version="1.0.0"
LABEL description="HOPE NLP Service"
LABEL stage="production"
LABEL org.opencontainers.image.title="HOPE NLP Service"
LABEL org.opencontainers.image.description="Real-time NLP service with Azure Cognitive Services"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.vendor="HOPE Team"
LABEL org.opencontainers.image.licenses="MIT"

# Set secure environment variables
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONHASHSEED=random

# Observability environment variables with consistent naming
ENV OTEL_SERVICE_NAME=hope-nlp
ENV OTEL_SERVICE_VERSION=1.0.0
ENV OTEL_RESOURCE_ATTRIBUTES=service.name=hope-nlp,service.version=1.0.0,service.namespace=hope,deployment.environment=production
ENV OTEL_TRACES_ENABLED=true
ENV OTEL_METRICS_ENABLED=true
ENV LOG_LEVEL=info

# Copy the virtual environment from builder with proper ownership
COPY --from=builder --chown=1001:1001 /opt/app/.venv /app/.venv

# Copy source code with proper ownership
COPY --chown=1001:1001 src/ /app/src/

# Set working directory
WORKDIR /app

# Switch to non-root user (distroless uses numeric IDs)
USER 1001

# Add virtual environment to Python path
ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app"

# Expose port with documentation
EXPOSE 8864

# Add metadata about the exposed port
LABEL org.opencontainers.image.expose.8864/tcp="NLP Service API"

# Note: Distroless doesn't have curl, so we remove healthcheck for production
# Use external monitoring instead (Kubernetes liveness/readiness probes)
# Kubernetes probe endpoints: /api/health (liveness), /api/health?detailed=true (readiness)

# Use the distroless Python entrypoint with explicit path
ENTRYPOINT ["/usr/bin/python3", "/app/src/main.py"]