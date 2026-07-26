# syntax=docker/dockerfile:1
# ── SMR Service (smr) ─────────────────────────────────────────────────────
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
#   docker build -f apps/smr/Dockerfile --target production -t smr .
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY smr's deps from the workspace lock (cached unless the
# lock or any member manifest changes).
COPY pyproject.toml uv.lock ./
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt/pyproject.toml ./apps/stt/
COPY apps/tts/pyproject.toml ./apps/tts/
# TASK-529 — shared model-lifecycle package. `--no-install-project` skips only
# the TARGET package, not its workspace path dependencies (verified: omitting
# this COPY fails layer 1 with "Distribution not found"). Dependency-free and
# rarely changed, so it costs no meaningful layer-cache churn.
COPY packages/py-runtime-models ./packages/py-runtime-models
# TASK-558 — shared env-file loader (`hope-env`). Same workspace path-dependency
# rule as py-runtime-models above: every service now declares `hope-env`, so
# `uv sync` needs it on disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-env". Dependency-light and rarely changed.
COPY packages/py-env ./packages/py-env
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package smr --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/smr/README.md ./apps/smr/
COPY apps/smr/src ./apps/smr/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package smr --no-dev --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-smr" \
    version="2.0.0" \
    org.opencontainers.image.title="HOPE SMR Service" \
    org.opencontainers.image.description="Multi-provider text generation service" \
    org.opencontainers.image.version="2.0.0"

ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    SMR_OTEL_ENABLED=false \
    SMR_OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    SMR_OTEL_SERVICE_NAME=smr \
    SMR_OTEL_SERVICE_NAMESPACE=hope \
    SMR_OTEL_DEPLOYMENT_ENVIRONMENT=production \
    SMR_OTEL_INSECURE=true \
    SMR_OTEL_LOGS_ENABLED=true

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/smr/src ./src

USER hope

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8862/api/v1/health/live')"]

EXPOSE 8862

ENTRYPOINT ["python", "-m", "uvicorn", "smr.main:app", "--host", "0.0.0.0", "--port", "8862"]
