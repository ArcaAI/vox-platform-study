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
#   - Guardrail holds NO model weights and needs NO model cache (TASK-817 F-2).
#     TASK-735 Phase 3 moved the GLiNER runtime and MiniCheck to `apps/nlp`;
#     this image installs no huggingface library, so it downloads nothing and
#     has nothing to persist. Do not add HF_HOME or a cache volume here — the
#     service that needs one is `hope-nlp`.
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
COPY apps/text/pyproject.toml ./apps/text/
COPY apps/harness/pyproject.toml ./apps/harness/
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
    GUARDRAIL_HOST=0.0.0.0 \
    GUARDRAIL_PORT=8863

# Copy the resolved venv (includes guardrail + all deps) and the source.
COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/guardrail/src ./src

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

# Longer start-period: first boot downloads the GLiNER ONNX model (~150 MB).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${GUARDRAIL_PORT}/api/health/live || exit 1

EXPOSE 8863

CMD ["python", "-m", "guardrail.main"]
