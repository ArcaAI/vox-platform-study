# syntax=docker/dockerfile:1
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

# Phase 1: install deps only (cached unless pyproject.toml/uv.lock change)
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=README.md,target=README.md \
    uv sync --locked --no-install-project --no-dev --no-editable

# Phase 2: copy source and install the project itself
COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# =============================================================================
# Stage 2: ML Builder — install ML packages with CPU-only PyTorch
# =============================================================================
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim AS ml-builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1 \
    UV_PYTHON_DOWNLOADS=0 \
    UV_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends build-essential

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=README.md,target=README.md \
    uv sync --locked --no-install-project --no-dev --no-editable --extra ml

COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable --extra ml

# =============================================================================
# Stage 3: GPU Builder — install ML-GPU packages in a CUDA-based stage
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS gpu-builder

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

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --no-cache \
        ".[ml-gpu]" \
    && find /opt/venv \( \
        -name "*.pyc" -o -name "*.pyo" -o -name "__pycache__" \
        -o -name "*.egg-info" -o -name "tests" -o -name "test" \
    \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /opt/venv -name "*.so" -exec strip --strip-unneeded {} + 2>/dev/null || true

# =============================================================================
# Stage 4: Shared CPU runtime base — common apt deps + non-root user
# =============================================================================
FROM python:3.11-slim-bookworm AS cpu-runtime-base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash app

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src

# =============================================================================
# Stage 5: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM cpu-runtime-base AS runtime

LABEL org.opencontainers.image.title="stt-v2" \
    org.opencontainers.image.description="High-availability Speech-to-Text service" \
    org.opencontainers.image.vendor="ARCA AI"

COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app src/ ./src/

ENV PATH="/app/.venv/bin:$PATH"

USER app

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')" || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 6: ML Runtime (CPU) — full inference stack without CUDA
# =============================================================================
FROM cpu-runtime-base AS ml-runtime-cpu

LABEL org.opencontainers.image.title="stt-v2-ml-cpu" \
    org.opencontainers.image.description="STT V2 ML runtime (CPU only, no CUDA)" \
    org.opencontainers.image.vendor="ARCA AI"

RUN mkdir -p /models && chown app:app /models

COPY --from=ml-builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app src/ ./src/

ENV PATH="/app/.venv/bin:$PATH" \
    HF_HOME=/models/hf-cache

USER app

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')" || exit 1

CMD ["uvicorn", "stt_v2.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 7: ML Runtime (GPU) — full inference stack with NVIDIA CUDA
# =============================================================================
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-v2-ml" \
    org.opencontainers.image.description="STT V2 ML runtime with CUDA GPU support" \
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
# Stage 8: Worker — Dramatiq worker extending GPU ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]

# =============================================================================
# Stage 9: Worker (CPU) — Dramatiq worker extending CPU ml-runtime
# =============================================================================
FROM ml-runtime-cpu AS worker-cpu

CMD ["dramatiq", "stt_v2.worker", "--processes", "2", "--threads", "4"]
