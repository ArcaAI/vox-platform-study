# syntax=docker/dockerfile:1
# ── Guardrail Service ────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Key notes:
#   - libgomp1 required by onnxruntime at runtime
#   - GLiNER ONNX model downloads from HuggingFace on first boot (~150 MB)
#     Mount a persistent volume at /app/.hf-cache to avoid re-downloading
#   - HEALTHCHECK start-period=120s to allow model download on first start
#
# Build:
#   docker build --target production -t guardrail .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: builder — install Python packages into a portable venv ──────────
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim AS builder

WORKDIR /app

# System lib needed by onnxruntime at build + runtime
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libgomp1

# Layer 1: Install all declared deps (cached unless pyproject.toml changes).
# A minimal source stub is created so uv can resolve the package metadata
# without the full source tree.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=README.md,target=README.md \
    mkdir -p src/guardrail && \
    echo '__version__ = "1.0.0"' > src/guardrail/__init__.py && \
    touch src/guardrail/py.typed && \
    uv venv /app/.venv && \
    uv pip install --python /app/.venv/bin/python --no-cache -e .

# Layer 2: Copy real source + reinstall package only (deps already cached).
COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /app/.venv/bin/python --no-cache --no-deps -e .

# Strip debug symbols and purge test/doc artefacts to slim the venv
RUN find /app/.venv/lib -type d \( \
        -name "__pycache__" -o -name "*.egg-info" \
        -o -name "tests" -o -name "test" \
        -o -name "docs" -o -name "doc" \
    \) -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( \
        -name "*.pyc" -o -name "*.pyo" \
    \) -type f -delete 2>/dev/null || true

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS production

LABEL maintainer="HOPE Team" \
    service="guardrail" \
    description="HOPE Guardrail Service — GLiNER ONNX content safety + Ollama medical validation" \
    org.opencontainers.image.title="HOPE Guardrail Service" \
    org.opencontainers.image.description="AI-powered content safety and medical context validation"

# libgomp1 required by onnxruntime; curl for HEALTHCHECK
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH="/app/src" \
    PATH="/app/.venv/bin:$PATH" \
    # HuggingFace model cache — mount a volume at this path for persistence
    HF_HOME="/app/.hf-cache" \
    # Set to 1 to block all HF downloads (useful for air-gapped envs)
    TRANSFORMERS_OFFLINE=0 \
    GUARDRAIL_HOST=0.0.0.0 \
    GUARDRAIL_PORT=8863

WORKDIR /app

# Copy venv from builder (includes all deps + installed package)
COPY --from=builder --chown=root:root /app/.venv /app/.venv

# Copy application source (editable install resolves here via .pth)
COPY --chown=root:root src/ ./src/

# Non-root user + HuggingFace model cache directory
RUN useradd --create-home --shell /bin/bash guardrail \
    && mkdir -p /app/.hf-cache \
    && chown -R guardrail:guardrail /app

USER guardrail

# Longer start-period: first boot downloads the GLiNER ONNX model (~150 MB)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${GUARDRAIL_PORT}/api/health/live || exit 1

EXPOSE 8863

CMD ["/app/.venv/bin/python", "-m", "guardrail.main"]
