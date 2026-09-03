# syntax=docker/dockerfile:1
# ── Text Service (text) ───────────────────────────────────────────────────
# Multi-stage build: builder → production
#
# Built from the REPO ROOT context so it consumes the single uv workspace lock
# (/uv.lock), resolving identical dependency versions as every other HOPE Python
# service.
#
# Requires hope-python-base first:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Build (from repo root):
#   docker build -f apps/text/Dockerfile --target production -t text.
# ─────────────────────────────────────────────────────────────────────────────

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY text's deps from the workspace lock (cached unless the
# lock or any member manifest changes).
COPY pyproject.toml uv.lock ./
COPY apps/text/pyproject.toml ./apps/text/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
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
# Shared OTEL trace-propagation helpers (`hope-otel`). Same workspace
# path-dependency rule: text now declares `hope-otel`, so `uv sync` needs it on
# disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-otel". Its only dep (opentelemetry-api) is already in
# the lock, so it costs no meaningful layer-cache churn.
COPY packages/py-otel ./packages/py-otel
# Async task/event envelope contract (`hope-async-contract`). Same workspace
# path-dependency rule again: text declares it in [tool.uv.sources], so `uv
# sync` needs it on disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-async-contract". Zero runtime deps.
COPY packages/py-async-contract ./packages/py-async-contract
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package text --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/text/README.md ./apps/text/
COPY apps/text/src ./apps/text/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package text --no-dev --no-editable

# Slim the venv: drop bytecode + egg-info only. Do NOT delete dirs named
# "docs"/"doc"/"tests" — some packages ship real importable submodules with
# those names (e.g. botocore.docs).
RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-text" \
    version="2.0.0" \
    org.opencontainers.image.title="HOPE Text Service" \
    org.opencontainers.image.description="Multi-provider text generation service" \
    org.opencontainers.image.version="2.0.0"

ENV PYTHONPATH="/app/src" \
    ENVIRONMENT=production \
    LOG_LEVEL=info \
    TEXT_OTEL_ENABLED=false \
    TEXT_OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    TEXT_OTEL_SERVICE_NAME=text \
    TEXT_OTEL_SERVICE_NAMESPACE=hope \
    TEXT_OTEL_DEPLOYMENT_ENVIRONMENT=production \
    TEXT_OTEL_INSECURE=true \
    TEXT_OTEL_LOGS_ENABLED=true

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/text/src ./src

# ── bake build identity, LAST layer ───────────────────────────
# These args change on every commit; kept below every COPY/RUN so they never
# invalidate the layer cache above them. Written to /app/build-info.json per
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
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8862/api/v1/health/live')"]

EXPOSE 8862

# ── SINGLE WORKER, DELIBERATELY. DO NOT ADD `--workers`. ─────────────────────
#
# measured this rather than assuming it. Multi-worker IS the
# remaining throughput lever — one worker saturates a single core (0.95 cores
# busy) and 4 workers more than doubled throughput at concurrency 10 — but it
# BREAKS RESUMABILITY, which is a hard owner requirement ("nothing may be
# lost") and outranks the latency win.
#
# The mechanism: `GenerationHub` (routing/hub.py) is process-local, so N
# workers means N independent hubs. A resume request (`GET
# /generations/{gid}/stream`) is load-balanced to an arbitrary worker, and the
# `producer is None` branch in api/endpoints/stream.py reads the flushed Redis
# backlog and RETURNS — it never tails live. anticipated an `XREAD
# BLOCK` fallback for exactly this case; it was never implemented.
#
# Measured with `uvicorn text.main:app --workers 4` against a real shared
# Redis, 8 resumes of a 60-token generation: 4 landed on a non-owner worker and
# each returned HTTP 200 with 3-4 of 60 chunks, NO terminal frame, closing in
# ~2 ms. A clinician sees a truncated summary and no error.
#
# This is NOT a bug that `--workers` introduces — it is one that any second
# process makes reachable, so `replicas > 1` and every rolling restart have it
# too. Raising either is blocked on the same fix.
#
# TO ENABLE, in this order:
#   1. Implement the cross-process live tail (`XREAD BLOCK` on the replay
#      buffer) in the `producer is None` branch of api/endpoints/stream.py.
#   2. Re-run the Lane G resume probe and confirm every resume delivers a
#      terminal frame regardless of which worker serves it.
#   3. Then add `--workers 2` here (2, not 4 or 8 — see
#      the sweep: 8 workers was WORSE than 4, and in the realistic
#      latency-injecting mode 100 concurrent streams keep one worker at only
#      0.51 cores, so workers buy throughput only against a fast local engine).
#
# Cross-worker CANCEL, by contrast, is already correct: it rides a persisted
# Redis flag polled every 0.5 s, and 6/6 producers stopped cleanly under 4
# workers. Only resume is broken.
ENTRYPOINT ["python", "-m", "uvicorn", "text.main:app", "--host", "0.0.0.0", "--port", "8862"]
