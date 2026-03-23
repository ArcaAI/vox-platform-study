# STT Service V2 Dockerfile
# Multi-stage build for optimized production image
#
# Build targets:
#   - runtime:        Lightweight API server (no ML dependencies)
#   - ml-runtime-cpu: Full ML runtime (CPU-only PyTorch, no CUDA)
#   - ml-runtime:     Full ML runtime with NVIDIA CUDA GPU support
#   - worker:         Dramatiq worker with ML + GPU dependencies
#   - worker-cpu:     Dramatiq worker with ML (CPU only)
#
# Build examples:
#   docker build -f docker/Dockerfile --target runtime        -t stt-v2:latest .
#   docker build -f docker/Dockerfile --target ml-runtime-cpu -t stt-v2:ml-cpu .
#   docker build -f docker/Dockerfile --target ml-runtime     -t stt-v2:ml-gpu .
#   docker build -f docker/Dockerfile --target worker         -t stt-v2:worker .
#   docker build -f docker/Dockerfile --target worker-cpu     -t stt-v2:worker-cpu .

# =============================================================================
# Stage 1: Builder — install base Python packages (CPU-only, no ML)
# =============================================================================
FROM python:3.11-slim AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

COPY pyproject.toml README.md ./
COPY src/ ./src/

# Install only base runtime deps (no ML, no dev, no test) via uv pip.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --no-cache \
        "." \
    && find /usr/local/lib/python3.11/site-packages \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/local/lib/python3.11/site-packages -name "*.so" \
        -exec strip --strip-unneeded {} + 2>/dev/null || true

# =============================================================================
# Stage 2: ML Builder — install ML packages with CPU-only PyTorch
# =============================================================================
FROM python:3.11-slim AS ml-builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

COPY pyproject.toml README.md ./
COPY src/ ./src/

# Use PyTorch CPU index to avoid shipping ~1.5GB of CUDA binaries.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --no-cache \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        ".[ml]" \
    && find /usr/local/lib/python3.11/site-packages \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/local/lib/python3.11/site-packages -name "*.so" \
        -exec strip --strip-unneeded {} + 2>/dev/null || true

# =============================================================================
# Stage 3: GPU Builder — install ML-GPU packages in a CUDA-based stage
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS gpu-builder

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv python3-pip \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python3.11 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade "pip>=25.0" setuptools wheel

COPY pyproject.toml README.md ./
COPY src/ ./src/

RUN pip install \
    --no-cache-dir \
    --timeout 300 --retries 3 \
    ".[ml-gpu]" \
    && find /opt/venv \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /opt/venv -name "*.so" -exec strip --strip-unneeded {} + 2>/dev/null || true

# =============================================================================
# Stage 4: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM python:3.11-slim AS runtime

LABEL org.opencontainers.image.title="stt-v2" \
    org.opencontainers.image.description="High-availability Speech-to-Text service" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.source="https://github.com/arcaai/hope"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app

# Copy site-packages and entry-point scripts from builder.
COPY --from=builder --chown=app:app /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder --chown=app:app /usr/local/bin/uvicorn /usr/local/bin/
COPY --chown=app:app src/ ./src/

USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')" || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: ML Runtime (CPU) — full inference stack without CUDA
# =============================================================================
FROM python:3.11-slim AS ml-runtime-cpu

LABEL org.opencontainers.image.title="stt-v2-ml-cpu" \
    org.opencontainers.image.description="STT V2 ML runtime (CPU only, no CUDA)" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.source="https://github.com/arcaai/hope"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app \
    && mkdir -p /models && chown app:app /models

COPY --from=ml-builder --chown=app:app /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=ml-builder --chown=app:app /usr/local/bin/uvicorn /usr/local/bin/dramatiq /usr/local/bin/
COPY --chown=app:app src/ ./src/

USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')" || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 6: ML Runtime (GPU) — full inference stack with NVIDIA CUDA
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-v2-ml" \
    org.opencontainers.image.description="STT V2 ML runtime with CUDA GPU support" \
    org.opencontainers.image.version="2.0.0" \
    org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.source="https://github.com/arcaai/hope"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app \
    && mkdir -p /models && chown -R app:app /app /models

COPY --from=gpu-builder --chown=app:app /opt/venv /opt/venv
COPY --chown=app:app src/ ./src/

USER app

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python3.11 -c "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')" || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 7: Worker — Dramatiq worker extending GPU ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]

# =============================================================================
# Stage 8: Worker (CPU) — Dramatiq worker extending CPU ml-runtime
# =============================================================================
FROM ml-runtime-cpu AS worker-cpu

CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]
