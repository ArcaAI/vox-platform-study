# syntax=docker/dockerfile:1
# ── TTS Service (tts) ─────────────────────────────────────────────────────
# Multi-stage build: builder → production. Built from the REPO ROOT context so
# it consumes the single uv workspace lock (/uv.lock).
#
# This image installs the BASE deps only (cloud path — Azure Speech). Self-hosted
# local engines (Kokoro, Indic Parler-TTS) require the `[local]` extra + torch and
# a GPU node; build a separate GPU image variant that adds `--extra local` and the
# git-installed parler-tts (the ai4bharat weights are HF-gated — mirror them into
# an internal registry rather than pulling at build/run time).
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
# Build (from repo root):
#   docker build -f apps/tts/Dockerfile --target production -t tts .
# ─────────────────────────────────────────────────────────────────────────────

ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY tts's deps from the workspace lock (cached unless the
# lock or any member manifest changes).
COPY pyproject.toml uv.lock ./
COPY apps/tts/pyproject.toml ./apps/tts/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt/pyproject.toml ./apps/stt/
# TASK-529 — shared model-lifecycle package. `--no-install-project` skips only
# the TARGET package, not its workspace path dependencies (verified: omitting
# this COPY fails layer 1 with "Distribution not found"). Dependency-free and
# rarely changed, so it costs no meaningful layer-cache churn.
COPY packages/py-runtime-models ./packages/py-runtime-models
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package tts --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/tts/README.md ./apps/tts/
COPY apps/tts/src ./apps/tts/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package tts --no-dev --no-editable

RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-tts" \
    version="0.1.0" \
    org.opencontainers.image.title="HOPE TTS Service" \
    org.opencontainers.image.description="Realtime multi-provider text-to-speech (English + Malayalam)" \
    org.opencontainers.image.version="0.1.0"

ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/tts/src ./src

USER hope

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8865/api/v1/health/live')"]

EXPOSE 8865

ENTRYPOINT ["python", "-m", "uvicorn", "tts.main:app", "--host", "0.0.0.0", "--port", "8865"]
