# syntax=docker/dockerfile:1
# ── hope-v2/qdrant-init ──────────────────────────────────────────────────────
#
# Bakes infrastructure/docker/scripts/init-qdrant-collections.py + qdrant-client
# into an image so the Argo `Sync`-hook Job (deployment/k8s/base/qdrant-init.yaml
# in hope-v2-deployment) never installs a package over the network at pod start.
# The dev docker-compose `qdrant-init` sidecar's
# `pip install -q qdrant-client && python init.py` pattern is fine for local
# dev; it is not acceptable for a PHI-adjacent cluster.
#
# Deliberately NOT built from hope-python-base: this bakes one standalone
# provisioning script, not an apps/* package with its own entry in the uv
# workspace (`[tool.uv.workspace]`), so there is nothing for
# `uv sync --frozen --package <svc>` to resolve against. qdrant-client is
# pinned to the SAME version apps/harness resolves via the workspace lock
# (uv.lock: qdrant-client==1.18.0) so the provisioning script and the harness
# runtime client agree on wire behavior against the same Qdrant server.
#
# Build (from repo root — the script it COPYs lives outside this directory):
#   docker build -f infrastructure/docker/qdrant-init/Dockerfile -t hope-v2/qdrant-init:latest.

FROM python:3.11-slim-trixie

LABEL org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.title="hope-v2/qdrant-init" \
    org.opencontainers.image.description="Idempotent Qdrant collection provisioning for HOPE (knowledge_chunks) — no pip install at pod start"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Pinned (not `qdrant-client` bare) — matches the version apps/harness resolves
# via the root uv workspace lock today. Bump both together if either changes.
RUN pip install --no-cache-dir qdrant-client==1.18.0

# Non-root, matching the platform's `hope:hope` convention verbatim
# (infrastructure/docker/python-base/Dockerfile:48-49) even though this image
# does not build from that shared base.
RUN groupadd --gid 1001 hope && \
    useradd --uid 1001 --gid hope --shell /usr/sbin/nologin --no-create-home hope

WORKDIR /app
COPY --chown=hope:hope infrastructure/docker/scripts/init-qdrant-collections.py ./init-qdrant-collections.py

# ── bake build identity, LAST layer ─────────────────────────────────────────
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

ENTRYPOINT ["python", "/app/init-qdrant-collections.py"]
