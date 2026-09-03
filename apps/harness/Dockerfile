# syntax=docker/dockerfile:1
# ── Harness Service ─────────────────────────────────────────────────────────
# Multi-stage build: builder → production → worker
#
# Built from the REPO ROOT context so it consumes the single uv workspace lock
# (/uv.lock), resolving identical dependency versions as every other HOPE Python
# service.
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build (from repo root):
#   docker build -f apps/harness/Dockerfile --target production -t harness.
#
# NOTE: This service hosts BOTH the FastAPI HTTP surface (default ENTRYPOINT)
#       and a Temporal worker (override the command to run the worker):
#   docker run harness python -m harness.temporal.worker
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# Build toolchain (builder stage ONLY — never leaks into the production stage,
# which copies just /app/.venv + source). Required because the `atomic-fact`
# extra pulls llama-cpp-python (the MiniCheck GGUF entailer), which
# has no usable prebuilt wheel and compiles a native llama.cpp from source;
# hope-python-base intentionally ships no C/C++ toolchain. Its own layer so it
# caches independently of the dependency sync below.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake

# Portability: without this, cmake targets the BUILD HOST's CPU (-march=native),
# producing a llama.cpp binary that SIGILLs on any runtime host with a different
# instruction set. GGML_NATIVE=OFF forces a portable baseline build instead.
ENV CMAKE_ARGS="-DGGML_NATIVE=OFF" \
    FORCE_CMAKE=1

# Layer 1: install ONLY harness's deps from the workspace lock.
COPY pyproject.toml uv.lock ./
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/text/pyproject.toml ./apps/text/
COPY apps/stt/pyproject.toml ./apps/stt/
COPY apps/tts/pyproject.toml ./apps/tts/
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
# Async task/event envelope (`hope-async-contract`). Same workspace
# path-dependency rule: harness declares it (pyproject `hope-async-contract =
# { workspace = true }`), so `uv sync` needs it on disk or layer 1 fails with
# "Distribution not found at: file:///app/packages/py-async-contract" — which
# is exactly how pipeline #1100's build-harness / build-harness-worker failed
# Zero runtime deps.
COPY packages/py-async-contract ./packages/py-async-contract
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package harness --no-dev --extra rag --extra guardrails --extra atomic-fact \
        --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/harness/README.md ./apps/harness/
COPY apps/harness/src ./apps/harness/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package harness --no-dev --extra rag --extra guardrails --extra atomic-fact \
        --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-harness" \
    version="0.1.0" \
    org.opencontainers.image.title="HOPE Harness Service" \
    org.opencontainers.image.description="Bounded clinical-documentation loop on Temporal" \
    org.opencontainers.image.version="0.1.0"

ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    TEMPORAL_ADDRESS=temporal:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=harness-task-queue

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/harness/src ./src

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
# NOTE: this stage is shared by BOTH build-harness (SERVICE_NAME=harness,
# --target production) and build-harness-worker (SERVICE_NAME=harness-worker,
# --target worker, which FROMs this stage). Each is a separate CI build
# invocation with its own --build-arg BUILD_SERVICE, so the value baked here
# is always the one that matches the target actually being built — no
# duplicate write is needed in the `worker` stage below.
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
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8866/api/v1/health/live')"]

EXPOSE 8866

ENTRYPOINT ["python", "-m", "uvicorn", "harness.main:app", "--host", "0.0.0.0", "--port", "8866"]


# ── Worker stage ────────────────────────────────────────────────────────────
# The Temporal worker: same image contents as `production`, different process.
#
# It is a SEPARATE process by design — apps/harness's FastAPI app connects to
# Temporal best-effort and must come up even when Temporal is down, while the
# worker hard-requires it (06-python-services.md §Temporal). Running both in one
# container would couple those lifecycles.
#
# ENTRYPOINT is overridden, not CMD: the production stage sets ENTRYPOINT, so a
# CMD here would be appended as ARGUMENTS to uvicorn rather than replacing it —
# the container would start the API again and no worker would ever run.
#
# No EXPOSE 8866 and no HTTP healthcheck: the worker serves no HTTP API. It
# inherits the production stage's HEALTHCHECK, which probes the API's
# /health/live, so that is cleared explicitly — otherwise every worker container
# reports unhealthy forever against a port nothing is listening on.
FROM production AS worker

HEALTHCHECK NONE

ENTRYPOINT ["python", "-m", "harness.temporal.worker"]
