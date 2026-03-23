# syntax=docker/dockerfile:1
# STT Service V2 Dockerfile
# Multi-stage build for optimized production image
#
# Build targets:
#   - runtime:    Lightweight API server (no ML dependencies, CPU only)
#   - ml-runtime: Full ML inference stack (CUDA GPU with automatic CPU fallback)
#   - worker:     Dramatiq worker extending ml-runtime
#
# GPU/CPU behavior:
#   ml-runtime and worker auto-detect GPU at runtime via torch.cuda.is_available().
#   Run with `--gpus all` on NVIDIA hosts; omit for CPU-only fallback.
#
# Build examples:
#   docker build -f docker/Dockerfile --target runtime    -t stt-v2:api .
#   docker build -f docker/Dockerfile --target ml-runtime -t stt-v2:ml .
#   docker build -f docker/Dockerfile --target worker     -t stt-v2:worker .

# =============================================================================
# Stage 1: Builder — install base Python packages (CPU-only, no ML)
# =============================================================================
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends build-essential

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=README.md,target=README.md \
    uv sync --locked --no-install-project --no-dev --no-editable

COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# =============================================================================
# Stage 2: ML Builder — unified ML packages (CUDA-capable, CPU fallback)
# =============================================================================
# Uses the CUDA runtime base so compiled extensions link against system CUDA.
# The cudnn8-runtime variant includes cuDNN (~725 MB in base layer), which
# avoids pip downloading nvidia-cudnn-cu12 (658 MB) separately.
#
# PyTorch auto-detects GPU at runtime:
#   - With --gpus all: torch.cuda.is_available() == True  → GPU inference
#   - Without --gpus:  torch.cuda.is_available() == False → CPU fallback
# =============================================================================
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 AS ml-builder

WORKDIR /build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv \
        build-essential

RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1

COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/

# Phase 1: Install torch + torchaudio with --no-deps.
# This prevents uv from pulling the bundled nvidia-* pip packages (~2.8 GB)
# that duplicate what the CUDA base image already provides as system libraries.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --no-deps \
        "torch>=2.8.0,<2.9.0" \
        "torchaudio>=2.8.0,<2.9.0"

# Phase 2: Install all remaining ML-GPU deps normally.
# torch/torchaudio are already satisfied from Phase 1.
# Then purge nvidia-* pip packages and inference-unnecessary libs:
#   - nvidia-cublas, cusparse, cusolver, cufft, curand, nvrtc → in CUDA base
#   - nvidia-cudnn → in cudnn8-runtime base
#   - nvidia-nccl → multi-GPU comms, not needed for single-GPU inference
#   - nvidia-nvjitlink, cufile, cusparselt → not needed for inference
#   - triton → only for torch.compile() training
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python ".[ml-gpu]" \
    && uv pip uninstall --python /opt/venv/bin/python \
        nvidia-cublas-cu12 \
        nvidia-cuda-cupti-cu12 \
        nvidia-cuda-nvrtc-cu12 \
        nvidia-cuda-runtime-cu12 \
        nvidia-cudnn-cu12 \
        nvidia-cufft-cu12 \
        nvidia-curand-cu12 \
        nvidia-cusolver-cu12 \
        nvidia-cusparse-cu12 \
        nvidia-cusparselt-cu12 \
        nvidia-nccl-cu12 \
        nvidia-nvjitlink-cu12 \
        nvidia-cufile-cu12 \
        triton \
        2>/dev/null || true \
    && find /opt/venv \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" -o -name "tests" -o -name "test" \
    \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /opt/venv -name "*.so" -exec strip --strip-unneeded {} + 2>/dev/null || true

# =============================================================================
# Stage 3: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM python:3.11-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="stt-v2" \
    org.opencontainers.image.description="High-availability Speech-to-Text service" \
    org.opencontainers.image.vendor="ARCA AI"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app

WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app src/ ./src/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src

USER app

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 4: ML Runtime — full inference stack (GPU with CPU fallback)
# =============================================================================
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-v2-ml" \
    org.opencontainers.image.description="STT V2 ML runtime (CUDA GPU with automatic CPU fallback)" \
    org.opencontainers.image.vendor="ARCA AI"

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv libsndfile1 ffmpeg \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app \
    && mkdir -p /models && chown -R app:app /app /models

COPY --from=ml-builder --chown=app:app /opt/venv /opt/venv
COPY --chown=app:app src/ ./src/

USER app

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["python3.11", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: Worker — Dramatiq worker extending ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]
