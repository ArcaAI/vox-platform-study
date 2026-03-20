# STT Service V2 Dockerfile
# Multi-stage build for optimized production image
#
# Build targets:
#   - runtime:    Lightweight API server (no ML dependencies)
#   - ml-runtime: Full ML runtime with GPU support
#   - worker:     Dramatiq worker with ML dependencies
#
# Build examples:
#   docker build -f docker/Dockerfile --target runtime    -t stt-v2:latest .
#   docker build -f docker/Dockerfile --target ml-runtime -t stt-v2:ml-gpu .
#   docker build -f docker/Dockerfile --target worker     -t stt-v2:worker .

# =============================================================================
# Stage 1: Builder — install Python packages in an isolated stage
# =============================================================================
FROM python:3.11-slim AS builder

WORKDIR /build

# Install only the build-time system dependencies needed to compile wheels.
# Combined into a single RUN to minimise layers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency metadata first (maximises Docker layer cache).
# README.md is required because pyproject.toml declares `readme = "README.md"`.
COPY pyproject.toml README.md ./
COPY src/ ./src/

# Install only base runtime dependencies for the lightweight `runtime` target.
# --no-compile: skip .pyc generation — PYTHONDONTWRITEBYTECODE=1 is set at runtime.
# --no-cache-dir: don't store pip's HTTP cache inside the image.
RUN pip install \
    --no-cache-dir \
    --no-compile \
    --timeout 300 \
    --retries 3 \
    ".[ml-gpu,dev,test]"

# =============================================================================
# Stage 2: GPU Builder — install ML-GPU packages in a CUDA-based stage
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS gpu-builder

WORKDIR /build

# Install Python 3.11 + build toolchain inside the CUDA base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create a venv so all packages install to a known, self-contained path.
# This avoids Debian dist-packages vs site-packages path confusion.
RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY pyproject.toml README.md ./
COPY src/ ./src/

# Install GPU variant (includes onnxruntime-gpu instead of onnxruntime).
RUN pip install \
    --no-cache-dir \
    --no-compile \
    --timeout 300 \
    --retries 3 \
    ".[ml-gpu]"

# =============================================================================
# Stage 3: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM python:3.11-slim AS runtime

# -- OCI image labels --
LABEL org.opencontainers.image.title="stt-v2" \
    org.opencontainers.image.description="High-availability Speech-to-Text service" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.source="https://github.com/arcaai/hope"

WORKDIR /app

# Install minimal runtime system libraries + curl for HEALTHCHECK.
# Single RUN + cleanup to keep the layer small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built Python packages from the builder stage.
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application source code (nothing else — tests, configs stay out).
COPY src/ ./src/

# Create a non-root user and hand over ownership in a single layer.
RUN useradd --create-home --shell /bin/bash app \
    && chown -R app:app /app

USER app

# Python runtime tuning
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src

EXPOSE 8861

# Health check — generous start-period for model preloading.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8861/api/v1/health || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 4: ML Runtime — full inference stack with NVIDIA CUDA GPU support
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-v2-ml" \
    org.opencontainers.image.description="STT V2 ML runtime with CUDA GPU support" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.source="https://github.com/arcaai/hope"

WORKDIR /app

# Install Python runtime + audio libs + curl (for HEALTHCHECK).
# No build-essential — all compilation happened in gpu-builder.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    libsndfile1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the complete venv from the gpu-builder stage.
COPY --from=gpu-builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application source code only.
COPY src/ ./src/

# Create non-root user + model cache directory in a single layer.
RUN useradd --create-home --shell /bin/bash app \
    && mkdir -p /models \
    && chown -R app:app /app /models

USER app

# Python + model cache configuration.
# NOTE: TRANSFORMERS_CACHE is deprecated — HF_HOME is the canonical variable.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache

# PyTorch / ONNX Runtime CPU threading — critical for Intel performance.
# Set these in your K8s deployment to match the pod CPU limit.
# Example for 8-core pods:
#   OMP_NUM_THREADS=8
#   MKL_NUM_THREADS=8
#   TORCH_NUM_THREADS=8
# If unset, the application auto-detects from os.cpu_count().

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8861/api/v1/health || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: Worker — Dramatiq worker extending ml-runtime
# =============================================================================
FROM ml-runtime AS worker

# No additional layers needed — just override the entrypoint.
CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]
