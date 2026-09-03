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
#   docker build -f apps/nlp/Dockerfile --target production -t nlp.
#
# CPU-ONLY TORCH. The locked torch 2.8.0 PyPI wheel for linux/amd64
# drags in the whole nvidia-cu12 + triton stack (~2.7 GB). `hope-nlp` requests NO
# GPU (`base/nlp.yaml` declares no `nvidia.com/gpu`), and every GPU code path in
# this service is already gated on `torch.cuda.is_available()` — which is False in
# the pod regardless — so that stack is weight the process can never execute. On a
# single-node cluster with `maxSurge: 0`, pull time IS downtime: NLP served zero
# endpoints for 24+ minutes during the 2026-08-09 rollout.
#
# `--extra-index-url` alone does NOT work here: under `--frozen` uv installs the
# exact URL+hash recorded in the lock and ignores extra indexes, silently producing
# the CUDA build anyway. The working form (proven by on apps/tts) is an
# explicit `--no-install-package` exclusion of the CUDA set plus a separate pinned
# install from the PyTorch CPU index. Measured on linux/amd64: see
#
# If NLP is ever given a GPU, the answer is a SECOND image variant, not putting
# CUDA back in the default image.
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest
# Must match the `torch` version resolved for `nlp` in the workspace lock. The CPU
# index publishes the same version as `<version>+cpu`.
ARG TORCH_VERSION=2.8.0
ARG TORCH_CPU_INDEX=https://download.pytorch.org/whl/cpu

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder
ARG TORCH_VERSION
ARG TORCH_CPU_INDEX

# The CUDA stack `torch` 2.8.0 declares on linux/x86_64. Skipped from the frozen
# sync and replaced by the CPU-only wheel below; on aarch64 these are already
# excluded by their environment markers, so the flags are simply no-ops there.
ENV UV_NO_CUDA_SKIPS="--no-install-package torch \
    --no-install-package triton \
    --no-install-package nvidia-cublas-cu12 \
    --no-install-package nvidia-cuda-cupti-cu12 \
    --no-install-package nvidia-cuda-nvrtc-cu12 \
    --no-install-package nvidia-cuda-runtime-cu12 \
    --no-install-package nvidia-cudnn-cu12 \
    --no-install-package nvidia-cufft-cu12 \
    --no-install-package nvidia-cufile-cu12 \
    --no-install-package nvidia-curand-cu12 \
    --no-install-package nvidia-cusolver-cu12 \
    --no-install-package nvidia-cusparse-cu12 \
    --no-install-package nvidia-cusparselt-cu12 \
    --no-install-package nvidia-nccl-cu12 \
    --no-install-package nvidia-nvjitlink-cu12 \
    --no-install-package nvidia-nvtx-cu12"

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
COPY apps/text/pyproject.toml ./apps/text/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt/pyproject.toml ./apps/stt/
COPY apps/tts/pyproject.toml ./apps/tts/
# The shared model-lifecycle package is a workspace PATH dependency,
# and `--no-install-project` skips only the target package, not its workspace
# deps: uv builds this one here, so its source must be present in layer 1. It is
# dependency-free and changes rarely, so this costs no meaningful cache churn.
COPY packages/py-runtime-models ./packages/py-runtime-models
# Shared env-file loader (`hope-env`). Same workspace path-dependency
# rule as py-runtime-models above: every service now declares `hope-env`, so
# `uv sync` needs it on disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-env". Dependency-light and rarely changed.
COPY packages/py-env ./packages/py-env
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package nlp --no-dev --no-install-project --no-editable \
        ${UV_NO_CUDA_SKIPS}

# Layer 1b: CPU-only torch, pinned to the lock's version. Kept in its own layer so
# it is cached alongside the lock rather than re-run on every source edit.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python \
        --index-url "${TORCH_CPU_INDEX}" "torch==${TORCH_VERSION}"

# Layer 2: copy source + install the package itself. `--inexact` keeps the CPU
# torch installed above (a plain sync would prune it as extraneous).
COPY apps/nlp/README.md ./apps/nlp/
COPY apps/nlp/src ./apps/nlp/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package nlp --no-dev --no-editable --inexact \
        ${UV_NO_CUDA_SKIPS}

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
    LOG_CONSOLE_JSON_FORMAT=true \
    HF_HOME=/app/.cache/huggingface

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/nlp/src ./src

# HF_HOME must point somewhere the non-root `hope` user can write.
# `hope-python-base` creates that user with `--no-create-home`, so $HOME
# (/home/hope) does NOT EXIST, and huggingface_hub's default
# `~/.cache/huggingface` therefore resolved to an uncreatable path: every token
# classification model load failed on `hope-v2-dev` with
# `PermissionError at /home/hope when downloading blaze999/Medical-NER`, and
# `/classify/tokens` never came up. `nlp/core/config.py` reads HF_HOME with an
# EMPTY default and only re-exports it when non-empty, so nothing in the service
# supplies this — it has to be the image, exactly as it already is for
# `apps/guardrail` (/app/.hf-cache) and `apps/tts` (/app/.cache/huggingface).
#
# Weights are fetched on first use and live in the container's writable layer,
# so they are re-downloaded on every pod restart. Mount a persistent volume at
# this path to make the pull survive restarts — same note as the two siblings.
RUN mkdir -p /app/.cache/huggingface && chown -R hope:hope /app/.cache

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
ARG BUILD_SERVICE
ARG BUILD_VERSION
ARG BUILD_RELEASE_TAG
ARG BUILD_GIT_BRANCH
ARG BUILD_GIT_SHA
ARG BUILD_AT
ARG BUILD_CI_PIPELINE_ID
ARG BUILD_CI_PIPELINE_URL
RUN set -eu; \
    release_tag=$( [ -n "${BUILD_RELEASE_TAG:-}" ] && printf '"%s"' "${BUILD_RELEASE_TAG}" || printf 'null' ); \
    pipeline_id=$( [ -n "${BUILD_CI_PIPELINE_ID:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_ID}" || printf 'null' ); \
    pipeline_url=$( [ -n "${BUILD_CI_PIPELINE_URL:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_URL}" || printf 'null' ); \
    printf '{"service":"%s","version":"%s","releaseTag":%s,"gitBranch":"%s","gitCommitSha":"%s","buildAt":"%s","ciPipelineId":%s,"ciPipelineUrl":%s}\n' \
      "${BUILD_SERVICE}" "${BUILD_VERSION}" "${release_tag}" "${BUILD_GIT_BRANCH}" "${BUILD_GIT_SHA}" "${BUILD_AT}" "${pipeline_id}" "${pipeline_url}" \
      > /app/build-info.json && \
    chown hope:hope /app/build-info.json

USER hope
EXPOSE 8864

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8864/api/v1/health')"]

ENTRYPOINT ["python", "-m", "uvicorn", "--factory", "nlp.app:get_app", "--host", "0.0.0.0", "--port", "8864"]
