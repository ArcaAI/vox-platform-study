# syntax=docker/dockerfile:1
# ── asr-vllm (TASK-1010 spike) ───────────────────────────────────────────────
# Whisper decode service on vLLM continuous batching. Linux amd64 + NVIDIA only.
#
# AUTHORED, NOT YET BUILT: the lane that wrote it had no Linux/CUDA builder. The first
# `docker build` is part of the GPU run (ticket README §Verification still open).
#
# Why this image does NOT follow the house `hope-python-base` + `uv sync --frozen`
# pattern: vLLM 0.30.0 hard-pins torch==2.13.0 and fastapi<0.137, which the monorepo's
# single uv.lock cannot hold next to the other services (every member requires
# fastapi>=0.141.1 — measured, see README "Dependency isolation"). So the ENGINE stack
# comes from vLLM's own digest-pinned image, and only the thin service shell is
# installed on top — CONSTRAINED to the image's installed versions, so nothing the
# engine depends on can move. A conflict fails this build loudly; it never upgrades
# torch/vllm/fastapi silently.
#
# The base image runs Python 3.12 (vLLM's Dockerfile, PYTHON_VERSION=3.12) while the
# shared packages declare requires-python <3.12 (house pin). The three local packages
# are therefore installed with --ignore-requires-python; they are pure Python and do
# not use 3.11-only behaviour. Verify on the first build (README open item).
#
# Build (from the repo root):
#   docker build -f apps/asr-vllm/Dockerfile -t asr-vllm .
# Run (needs the NVIDIA container toolkit):
#   docker run --gpus all -p 8867:8867 -e INTERNAL_ACCESS_TOKEN=... \
#     -v /path/to/models:/mnt/models-bucket:ro asr-vllm
# ─────────────────────────────────────────────────────────────────────────────

# vllm/vllm-openai:v0.30.0 (2026-09-22) — CUDA 13.0.3, Python 3.12, vLLM in the
# system interpreter. Multi-arch index digest (amd64: sha256:5f5e5352…6d40).
ARG VLLM_IMAGE=vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90

FROM ${VLLM_IMAGE} AS production

LABEL maintainer="HOPE Team" \
    service="apps-asr-vllm" \
    org.opencontainers.image.title="HOPE asr-vllm" \
    org.opencontainers.image.description="Whisper decode on vLLM continuous batching (TASK-1010 spike)"

WORKDIR /app

# Layer 1: freeze what the base image ships, as plain name==version pins (`pip list
# --format=freeze` never emits file:// URLs, unlike `pip freeze` for a wheel install).
RUN python3 -m pip list --format=freeze > /tmp/image-constraints.txt

# Layer 2: the service shell's third-party deps, read from the three pyprojects (so
# they cannot drift from what the tests ran against) and resolved AGAINST the freeze.
COPY packages/py-env/pyproject.toml ./packages/py-env/pyproject.toml
COPY packages/py-obs/pyproject.toml ./packages/py-obs/pyproject.toml
COPY apps/asr-vllm/pyproject.toml ./apps/asr-vllm/pyproject.toml
RUN python3 - > /tmp/service-requirements.txt <<'PY'
import re
import tomllib

LOCAL = {"hope-env", "hope-obs"}
for path in (
    "apps/asr-vllm/pyproject.toml",
    "packages/py-env/pyproject.toml",
    "packages/py-obs/pyproject.toml",
):
    with open(path, "rb") as fh:
        for dep in tomllib.load(fh)["project"]["dependencies"]:
            if re.split(r"[\[<>=!~;\s]", dep, maxsplit=1)[0] not in LOCAL:
                print(dep)
PY
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m pip install --constraint /tmp/image-constraints.txt \
        -r /tmp/service-requirements.txt

# Layer 3: the three local packages themselves — deps already satisfied above.
COPY packages/py-env ./packages/py-env
COPY packages/py-obs ./packages/py-obs
COPY apps/asr-vllm/README.md ./apps/asr-vllm/README.md
COPY apps/asr-vllm/src ./apps/asr-vllm/src
RUN python3 -m pip install --no-cache-dir --no-deps --ignore-requires-python \
        ./packages/py-env ./packages/py-obs ./apps/asr-vllm \
    && rm -rf ./packages ./apps

# Non-root runtime. vLLM writes compile caches under $HOME, and HF_HOME is where an
# `sourceUri`-only spec downloads to — mount a PVC there so a restart does not re-pull.
# Published weights (`localPath`) are read from the read-only models bucket mount.
RUN useradd --create-home --uid 10001 hope \
    && mkdir -p /app/.cache/huggingface \
    && chown -R hope:hope /app/.cache

ENV HOME=/home/hope \
    HF_HOME=/app/.cache/huggingface \
    NODE_ENV=production \
    LOG_LEVEL=info

# ── bake build identity, LAST layer ─────────────────────────────────────────
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

# Liveness is decode-independent (TASK-1007 D-2); a long start-period covers CUDA init.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8867/api/v1/health/live')"]

EXPOSE 8867

# ONE process per GPU: the engine owns the card. Scale out with replicas, never workers.
ENTRYPOINT ["python3", "-m", "uvicorn", "--factory", "asr_vllm.main:create_app", "--host", "0.0.0.0", "--port", "8867", "--workers", "1"]
