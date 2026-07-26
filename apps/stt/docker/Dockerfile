# syntax=docker/dockerfile:1
# STT Service Dockerfile
# Multi-stage build for optimized production image
#
# Built from the REPO ROOT context so the CPU stages can consume the single uv
# workspace lock (/uv.lock):
#   docker build -f apps/stt/docker/Dockerfile --target runtime    -t stt:api .
#   docker build -f apps/stt/docker/Dockerfile --target ml-runtime -t stt:ml .
#   docker build -f apps/stt/docker/Dockerfile --target worker     -t stt:worker .
#
# Build targets:
#   - runtime:    Lightweight API server (no ML dependencies, CPU only)  → workspace lock
#   - ml-runtime: Full ML inference stack (CUDA GPU with CPU fallback)    → GPU override install
#   - worker:     Dramatiq worker extending ml-runtime
#
# Requires hope-python-base first (for CPU stages):
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# CPU vs GPU dependency sourcing:
#   - CPU `runtime` installs stt's BASE deps from the unified workspace lock,
#     so it stays version-consistent with every other HOPE Python service.
#   - GPU `ml-runtime`/`worker` install stt[ml-gpu]/[nemo] with a Dockerfile
#     override that skips redundant nvidia-* wheels (the CUDA libs come from the
#     nvidia/cuda base image). This GPU path is NOT covered by `uv sync --frozen`
#     and must be validated on a GPU CI runner.

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# =============================================================================
# Stage 1: Builder — base Python packages from the workspace lock (CPU, no ML)
# =============================================================================
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY stt's base deps from the workspace lock.
COPY pyproject.toml uv.lock ./
COPY apps/stt/pyproject.toml ./apps/stt/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
# Shared model-lifecycle package. `--no-install-project` skips only
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
    uv sync --frozen --package stt --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/stt/README.md ./apps/stt/
COPY apps/stt/src ./apps/stt/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package stt --no-dev --no-editable

RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# =============================================================================
# Stage 2: ML Builder — unified ML packages (CUDA-capable, CPU fallback)
# =============================================================================
# Uses the CUDA runtime base so compiled extensions link against system CUDA.
# Installs stt[ml-gpu]/[nemo] directly (fresh resolve) with an override that
# skips nvidia-* wheels already provided by the base image. transformers/optimum
# are pinned by stt's pyproject ([ml]) so they match the workspace lock.
# =============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS ml-builder

WORKDIR /build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv \
        build-essential

RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1

# Workspace scaffolding: stt's pyproject declares hope-runtime-models / hope-env
# as `workspace = true` sources, so even this fresh (non-frozen) GPU resolve needs
# the workspace root (root pyproject.toml + uv.lock) and those path members on
# disk — the same set the CPU `builder` stage and the smr/harness Dockerfiles copy.
# Without it, `uv pip install` fails: "hope-runtime-models references a workspace
# in tool.uv.sources, but is not a workspace member".
COPY pyproject.toml uv.lock ./
COPY apps/stt/pyproject.toml apps/stt/README.md ./apps/stt/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/tts/pyproject.toml ./apps/tts/
COPY packages/py-runtime-models ./packages/py-runtime-models
COPY packages/py-env ./packages/py-env
COPY apps/stt/src ./apps/stt/src

# Generate overrides that tell uv to skip most nvidia-* pip packages and triton.
#
# Why this is safe (verified by codebase audit of apps/stt/src/):
#   - Zero direct imports of any nvidia.* Python package
#   - Zero torch.compile() calls → triton not needed
#   - Most CUDA libs (cublas, cudnn, cufft, curand, nvrtc, cusparse, cusolver)
#     are already provided as system libraries by the nvidia/cuda base image
#   - The codebase is 100% inference-only: torch.no_grad(), model.generate(),
#     .to(device), torch.cuda.is_available() — no training, no autograd
#
# EXCEPTIONS — packages NOT skipped (must come from pip):
#   - nvidia-cusparselt-cu12: torch >=2.8.0 unconditionally loads
#     libcusparseLt.so.0 at import time (via torch._C), and the runtime
#     base image does NOT bundle cuSPARSELt (~287 MB).
#   - nvidia-cuda-cupti-cu12: torch >=2.8.0 unconditionally loads
#     libcupti.so.12 at import time (via torch._C). CUPTI is only shipped
#     in nvidia/cuda *devel* images, not the runtime variant (~15 MB).
#   - nvidia-nccl-cu12: torch >=2.8.0 unconditionally loads libnccl.so.2
#     at import time (via libtorch_cuda.so). Not shipped in the runtime
#     base image (~300 MB).
#
# This prevents ~2.6 GB of redundant downloads that the old approach
# (install-then-uninstall) was wasting on every uncached build.
RUN printf '%s\n' \
        'nvidia-cublas-cu12 ; sys_platform == "never"' \
        'nvidia-cuda-nvrtc-cu12 ; sys_platform == "never"' \
        'nvidia-cuda-runtime-cu12 ; sys_platform == "never"' \
        'nvidia-cudnn-cu12 ; sys_platform == "never"' \
        'nvidia-cufft-cu12 ; sys_platform == "never"' \
        'nvidia-curand-cu12 ; sys_platform == "never"' \
        'nvidia-cusolver-cu12 ; sys_platform == "never"' \
        'nvidia-cusparse-cu12 ; sys_platform == "never"' \
        'nvidia-nvjitlink-cu12 ; sys_platform == "never"' \
        'nvidia-cufile-cu12 ; sys_platform == "never"' \
        'nvidia-nvtx-cu12 ; sys_platform == "never"' \
        'triton ; sys_platform == "never"' \
        'flash-attn ; sys_platform == "never"' \
    > /tmp/cuda-overrides.txt

# Install torch + torchaudio first (--no-deps) to avoid pulling their
# nvidia-* transitive deps. Then install remaining ML-GPU deps with
# --override to skip nvidia-*/triton entirely during resolution.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --no-deps \
        "torch>=2.8.0,<2.9.0" \
        "torchaudio>=2.8.0,<2.9.0"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --only-binary flash-attn \
        "flash-attn>=2.8.3" \
    || echo "WARNING: flash-attn prebuilt wheel not available, skipping (attention will use default PyTorch SDPA path)"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
        --override /tmp/cuda-overrides.txt \
        "./apps/stt[ml-gpu]"

RUN --mount=type=cache,target=/root/.cache/uv \
    printf '%s\n' \
        'transformers==5.5.4' \
    >> /tmp/cuda-overrides.txt \
    && uv pip install --python /opt/venv/bin/python \
        --override /tmp/cuda-overrides.txt \
        "./apps/stt[nemo]"

RUN find /opt/venv \( \
        -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /opt/venv \( \
        -name "*.pyc" -o -name "*.pyo" \
        -o -name "*.mo" -o -name "*.ipynb" \
    \) -type f -delete 2>/dev/null || true \
    && rm -rf /opt/venv/lib/python3.11/site-packages/torch/test \
              /opt/venv/lib/python3.11/site-packages/torch/utils/benchmark \
              /opt/venv/lib/python3.11/site-packages/caffe2 \
       2>/dev/null || true

# =============================================================================
# Stage 3: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM ${BASE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="stt" \
    org.opencontainers.image.description="High-availability Speech-to-Text service"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/stt/src ./src

ENV PYTHONPATH=/app/src

USER hope

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["uvicorn", "stt.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 4: ML Runtime — full inference stack (GPU with CPU fallback)
# =============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-ml" \
    org.opencontainers.image.description="STT ML runtime (CUDA GPU with automatic CPU fallback)" \
    org.opencontainers.image.vendor="ARCA AI"

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv libsndfile1 ffmpeg \
    && groupadd --gid 1001 hope \
    && useradd --uid 1001 --gid hope --create-home --shell /bin/bash hope \
    && mkdir -p /models && chown -R hope:hope /app /models

COPY --from=ml-builder --chown=hope:hope /opt/venv /opt/venv
COPY --chown=hope:hope apps/stt/src ./src

USER hope

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    OTEL_SERVICE_NAME=stt \
    OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    OTEL_ENABLED=false \
    METRICS_ENABLED=true

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["python3.11", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["python3.11", "-m", "uvicorn", "stt.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: Worker — Dramatiq worker extending ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["python3.11", "-m", "dramatiq", "stt.worker", "--processes", "2", "--threads", "4"]
