# syntax=docker/dockerfile:1
# ── NLP Service ──────────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Built from the REPO ROOT context so it consumes the single uv workspace lock
# (/uv.lock), resolving the SAME dependency versions as every other HOPE Python
# service (notably transformers 5.5.4 — previously this service drifted to 4.52.4).
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build (from repo root):
#   docker build -f apps/nlp/Dockerfile --target production -t nlp .
#
# Image size note (x86_64): the locked torch 2.8.0 PyPI wheel for linux/amd64
# bundles + pulls nvidia-* CUDA packages (~2 GB). torch >=2.8 eagerly loads some
# CUDA libs at import, so blanket CUDA-stripping breaks `import torch`. A CPU-only
# torch index for linux/amd64 is the correct slimming path and is tracked as a
# follow-up (must be validated on an x86_64 CI runner). On linux/arm64 the locked
# wheel is already CPU-only (~102 MB).
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# build-essential: some pure-source deps (e.g. editdistpy via symspellpy) may
# build from sdist when no matching wheel is published for the target platform.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential

# Layer 1: install ONLY nlp's deps from the workspace lock.
COPY pyproject.toml uv.lock ./
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt-v2/pyproject.toml ./apps/stt-v2/
COPY apps/tts-v2/pyproject.toml ./apps/tts-v2/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package nlp --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/nlp/README.md ./apps/nlp/
COPY apps/nlp/src ./apps/nlp/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package nlp --no-dev --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="nlp" \
    org.opencontainers.image.title="HOPE NLP Service" \
    org.opencontainers.image.description="Medical entity recognition and NLP service"

ENV PYTHONPATH="/app/src" \
    OTEL_SERVICE_NAME=hope-nlp \
    OTEL_RESOURCE_ATTRIBUTES="service.name=hope-nlp,service.namespace=hope,deployment.environment=production" \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \
    OTEL_TRACES_ENABLED=true \
    OTEL_METRICS_ENABLED=true \
    LOG_LEVEL=info \
    LOG_CONSOLE_JSON_FORMAT=true

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/nlp/src ./src

USER hope
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "uvicorn", "--factory", "nlp.app:get_app", "--host", "0.0.0.0", "--port", "8864"]
