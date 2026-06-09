# syntax=docker/dockerfile:1
# ── Guardrail Service ────────────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Built from the REPO ROOT context so it can consume the single uv workspace
# lock (/uv.lock). This guarantees guardrail resolves the SAME dependency
# versions as every other HOPE Python service (transformers 5.5.4,
# gliner2-onnx 0.1.1, onnxruntime, ...) — no per-service drift.
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build (from repo root):
#   docker build -f apps/guardrail/Dockerfile --target production -t guardrail .
#
# Notes:
#   - libgomp1 (onnxruntime runtime dep) + curl (healthcheck) come from the base.
#   - GLiNER ONNX model downloads from HuggingFace on first boot (~150 MB).
#     Mount a persistent volume at /app/.hf-cache to avoid re-downloading.
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder — resolve guardrail's deps from the workspace lock ───────
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY guardrail's dependencies (cached unless the workspace
# lock or any member manifest changes). All member manifests must be present for
# uv to validate the workspace, but `--no-install-project` installs deps only.
COPY pyproject.toml uv.lock ./
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/stt-v2/pyproject.toml ./apps/stt-v2/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package guardrail --no-dev --no-install-project --no-editable

# Layer 2: copy guardrail source + install the package itself (deps cached above).
COPY apps/guardrail/README.md ./apps/guardrail/
COPY apps/guardrail/src ./apps/guardrail/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package guardrail --no-dev --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="guardrail" \
    org.opencontainers.image.title="HOPE Guardrail Service" \
    org.opencontainers.image.description="GLiNER ONNX content safety + medical context validation"

ENV PYTHONPATH="/app/src" \
    HF_HOME="/app/.hf-cache" \
    TRANSFORMERS_OFFLINE=0 \
    GUARDRAIL_HOST=0.0.0.0 \
    GUARDRAIL_PORT=8863

# Copy the resolved venv (includes guardrail + all deps) and the source.
COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/guardrail/src ./src

# HuggingFace model cache dir (mount a volume here for persistence).
RUN mkdir -p /app/.hf-cache && chown -R hope:hope /app/.hf-cache

USER hope

# Longer start-period: first boot downloads the GLiNER ONNX model (~150 MB).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${GUARDRAIL_PORT}/api/health/live || exit 1

EXPOSE 8863

CMD ["python", "-m", "guardrail.main"]
