# syntax=docker/dockerfile:1
# ── TTS Service (tts) ─────────────────────────────────────────────────────
# Multi-stage build: builder → production. Built from the REPO ROOT context so
# it consumes the single uv workspace lock (/uv.lock).
#
# This image installs the base deps PLUS the `[kokoro]` extra: Kokoro
# is the built-in, credential-free English engine that the SYSTEM TenantTtsConfig
# row already routes `en` to, so it must be present for the service to be Ready
# without a cloud key. torch comes from the PyTorch CPU wheel index — the PyPI
# linux/x86_64 torch wheel drags in the whole nvidia-cu12 stack that a CPU-only
# 82M model has no use for. Measured on linux/amd64: 1.39 GB with the CPU pin vs
# 7.34 GB without it. `KokoroConfig.device` already defaults to "cpu".
#
# NOT in this image: Indic Parler-TTS (Malayalam) and IndicF5. Parler needs the
# `[indic-parler]` extra plus the git-installed `parler-tts` (kept out of the
# shared lock) and its ai4bharat weights are HF-gated; IndicF5 is license-blocked
# (CC-BY-NC base weights — see tts/core/config.py). Both belong in a separate
# image variant, with the weights mirrored internally rather than pulled at run time.
#
# Kokoro model weights are NOT baked in: `KPipeline` pulls hexgrad/Kokoro-82M
# (~327 MB, Apache-2.0, ungated) from huggingface.co on first synth. See
# To bake them instead, add a builder-stage
# `huggingface_hub.snapshot_download` into ${HF_HOME} and COPY it into the
# production stage; nothing else here has to change.
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
# Build (from repo root):
#   docker build -f apps/tts/Dockerfile --target production -t tts .
# ─────────────────────────────────────────────────────────────────────────────

ARG BASE_IMAGE=hope-python-base:latest
# Must match the `torch` version resolved in the workspace lock. The CPU index
# publishes the same version as `<version>+cpu`.
ARG TORCH_VERSION=2.8.0
ARG TORCH_CPU_INDEX=https://download.pytorch.org/whl/cpu

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder
ARG TORCH_VERSION
ARG TORCH_CPU_INDEX

# The CUDA stack `torch` declares on linux/x86_64. Skipped from the frozen sync
# and replaced by the CPU-only wheel below; on aarch64 these are already excluded
# by their environment markers, so the flags are simply no-ops there.
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

# Layer 1: install ONLY tts's deps from the workspace lock (cached unless the
# lock or any member manifest changes).
COPY pyproject.toml uv.lock ./
COPY apps/tts/pyproject.toml ./apps/tts/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt/pyproject.toml ./apps/stt/
# Shared model-lifecycle package. `--no-install-project` skips only
# the TARGET package, not its workspace path dependencies (verified: omitting
# this COPY fails layer 1 with "Distribution not found"). Dependency-free and
# rarely changed, so it costs no meaningful layer-cache churn.
COPY packages/py-runtime-models ./packages/py-runtime-models
# Shared env-file loader (`hope-env`). Same workspace path-dependency
# rule as py-runtime-models above: every service now declares `hope-env`, so
# `uv sync` needs it on disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-env". Dependency-light and rarely changed.
COPY packages/py-env ./packages/py-env
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package tts --extra kokoro --no-dev --no-install-project --no-editable \
        ${UV_NO_CUDA_SKIPS}

# Layer 1b: CPU-only torch, pinned to the lock's version. Kept in its own layer
# so it is cached alongside the lock rather than re-run on every source edit.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python \
        --index-url "${TORCH_CPU_INDEX}" "torch==${TORCH_VERSION}"

# Layer 1c: the spaCy English pipeline that Kokoro's G2P front-end needs.
# `misaki.en.G2P.__init__` calls `spacy.cli.download('en_core_web_sm')` when the
# package is absent — i.e. it would pip-install from github.com on FIRST SYNTH,
# as the non-root `hope` user with no writable HOME. Verified: that fails, and
# Kokoro never produces audio. Baking it in is what makes the engine work.
# It is not published on PyPI (URL wheel), which is exactly why it must NOT go
# into apps/tts/pyproject.toml — the shared uv.lock has to stay resolvable.
ARG SPACY_EN_MODEL=https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python "${SPACY_EN_MODEL}"

# Layer 2: copy source + install the package itself. `--inexact` keeps the
# CPU torch installed above (a plain sync would prune it as extraneous).
COPY apps/tts/README.md ./apps/tts/
COPY apps/tts/src ./apps/tts/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package tts --extra kokoro --no-dev --no-editable --inexact \
        ${UV_NO_CUDA_SKIPS}

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

# HF_HOME must point somewhere the non-root `hope` user can write: $HOME
# (/home/hope) does NOT exist in hope-python-base, so huggingface_hub's default
# ~/.cache/huggingface fails outright and Kokoro can never fetch its weights.
ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    HF_HOME=/app/.cache/huggingface

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/tts/src ./src

# Is OPEN: the Kokoro weights (hexgrad/Kokoro-82M, ~327 MB,
# Apache-2.0, ungated) are NOT baked in — they are fetched from huggingface.co on
# first synth into the directory below. To close OD-2 the other way, add a builder
# stage that runs `huggingface_hub.snapshot_download` and `COPY` its output here;
# then set HF_HUB_OFFLINE=1. Mount this path as a volume if the pull should
# survive pod restarts.
RUN mkdir -p /app/.cache/huggingface && chown -R hope:hope /app/.cache

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
# docs/implementation/TASK-648-Service-Version-And-Release-Registry/contracts/build-info.schema.json.
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8865/api/v1/health/live')"]

EXPOSE 8865

ENTRYPOINT ["python", "-m", "uvicorn", "tts.main:app", "--host", "0.0.0.0", "--port", "8865"]
