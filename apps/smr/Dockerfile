# syntax=docker/dockerfile:1
# ── SMR Service ─────────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Requires hope-python-base image to be built first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build targets:
#   docker build --target production -t smr .
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
    service="apps-smr" \
    version="2.0.0" \
    description="HOPE Text Generation Service (SMR v2)" \
    org.opencontainers.image.title="HOPE SMR Service" \
    org.opencontainers.image.description="Multi-provider text generation service" \
    org.opencontainers.image.version="2.0.0"

ENV PYTHONPATH="/app/.venv/lib/python3.11/site-packages:/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    SMR_V2_OTEL_ENABLED=false \
    SMR_V2_OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    SMR_V2_OTEL_SERVICE_NAME=smr-v2

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope src/ /app/src/

USER hope

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8862/api/v1/health/live')"]

EXPOSE 8862

ENTRYPOINT ["python", "-m", "uvicorn", "smr_v2.main:app", "--host", "0.0.0.0", "--port", "8862"]
