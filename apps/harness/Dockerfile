# syntax=docker/dockerfile:1
# ── Harness Service ─────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Requires hope-python-base image to be built first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build targets:
#   docker build --target production -t harness .
#
# NOTE: This service hosts BOTH the FastAPI HTTP surface (default ENTRYPOINT)
#       and a Temporal worker (override the command to run the worker):
#   docker run harness python -m harness.temporal.worker
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder — install Python packages into a portable venv ─────────
FROM hope-python-base:latest AS builder

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
        -o -name "docs" -o -name "doc" -o -name "examples" -o -name "benchmarks" \
    \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv \( \
        -name "*.pyc" -o -name "*.pyo" \
        -o -name "*.pyi" -o -name "py.typed" \
    \) -type f -delete 2>/dev/null || true \
    && find /app/.venv -name "*.so" -exec strip --strip-unneeded {} + 2>/dev/null || true

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM hope-python-base:latest AS production

LABEL maintainer="HOPE Team" \
    service="apps-harness" \
    version="0.1.0" \
    description="HOPE Clinical Documentation Harness (TASK-330)" \
    org.opencontainers.image.title="HOPE Harness Service" \
    org.opencontainers.image.description="Bounded clinical-documentation loop on Temporal" \
    org.opencontainers.image.version="0.1.0"

ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app/src" \
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
COPY --chown=hope:hope src/ /app/src/

USER hope

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8866/api/v1/health/live')"]

EXPOSE 8866

ENTRYPOINT ["python", "-m", "uvicorn", "harness.main:app", "--host", "0.0.0.0", "--port", "8866"]
