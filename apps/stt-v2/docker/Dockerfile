# syntax=docker/dockerfile:1
# STT Service V2 Dockerfile
# Multi-stage build for optimized production image
#
# Build targets:
#   - runtime:    Lightweight API server (no ML dependencies, CPU only)
#   - ml-runtime: Full ML inference stack (CUDA GPU with automatic CPU fallback)
#   - worker:     Dramatiq worker extending ml-runtime
#
# Requires hope-python-base image to be built first (for CPU stages):
#   docker build -t hope-python-base infrastructure/docker/python-base/
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
FROM hope-python-base:latest AS builder

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=README.md,target=README.md \
    uv sync --frozen --no-install-project --no-dev --no-editable

COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# =============================================================================
# Stage 2: ML Builder — unified ML packages (CUDA-capable, CPU fallback)
# =============================================================================
# Uses the CUDA runtime base so compiled extensions link against system CUDA.
# The cudnn-runtime variant includes cuDNN 9 in the base layer, which
# avoids pip downloading nvidia-cudnn-cu12 (658 MB) separately.
#
# PyTorch auto-detects GPU at runtime:
#   - With --gpus all: torch.cuda.is_available() == True  → GPU inference
#   - Without --gpus:  torch.cuda.is_available() == False → CPU fallback
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

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1

COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/

# Generate overrides that tell uv to skip most nvidia-* pip packages and triton.
#
# Why this is safe (verified by codebase audit of apps/stt-v2/src/):
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
        ".[ml-gpu]"

RUN --mount=type=cache,target=/root/.cache/uv \
    printf '%s\n' \
        'transformers==5.5.4' \
    >> /tmp/cuda-overrides.txt \
    && uv pip install --python /opt/venv/bin/python \
        --override /tmp/cuda-overrides.txt \
        ".[nemo]"

RUN find /opt/venv \( \
        -name "__pycache__" \
        -o -name "*.egg-info" \
        -o -name "tests" -o -name "test" \
        -o -name "docs" -o -name "doc" -o -name "examples" -o -name "benchmarks" \
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
FROM hope-python-base:latest AS runtime

LABEL org.opencontainers.image.title="stt-v2" \
    org.opencontainers.image.description="High-availability Speech-to-Text service"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope src/ ./src/

ENV PYTHONPATH=/app/src

USER hope

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 4: ML Runtime — full inference stack (GPU with CPU fallback)
# =============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-v2-ml" \
    org.opencontainers.image.description="STT V2 ML runtime (CUDA GPU with automatic CPU fallback)" \
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
COPY --chown=hope:hope src/ ./src/

USER hope

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    OTEL_SERVICE_NAME=stt-v2 \
    OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    OTEL_ENABLED=false \
    METRICS_ENABLED=true

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["python3.11", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["python3.11", "-m", "uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: Worker — Dramatiq worker extending ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["python3.11", "-m", "dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]
