# syntax=docker/dockerfile:1
# ── hope-python-base ────────────────────────────────────────────────────────
# Single shared base image for ALL HOPE Python services (CPU).
#
# One image, used as BOTH the builder stage (uv is present) and the runtime
# stage (non-root `hope` user + common runtime libs). Every Python service does:
#
#   FROM hope-python-base:latest AS builder      # uv available → uv sync
#   FROM hope-python-base:latest AS production   # copy venv + src, USER hope
#
# Python service images consume the SINGLE workspace lock at the repo root
# (`/uv.lock`) via `uv sync --frozen --package <service>` from a repo-root build
# context, so every service resolves identical dependency versions.
#
# Build (from repo root):
#   docker build -t hope-python-base infrastructure/docker/python-base/
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim-trixie

LABEL org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.title="hope-python-base" \
    org.opencontainers.image.description="Shared CPU base (python 3.11 + uv + non-root hope user) for all HOPE Python services"

# uv pinned to the version that generates the workspace lock. Must stay >= the
# uv that produced `uv.lock` (currently revision 3) or `uv sync --frozen` fails.
COPY --from=ghcr.io/astral-sh/uv:0.11.33 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH" \
    UV_HTTP_TIMEOUT=900
# uv's per-read deadline; the 30s default makes a large wheel restart from zero
# on a stalling link and never finish (see apps/stt/docker/Dockerfile for the
# measured case). Inherited by every service that builds on this base.

# libgomp1: required at runtime by onnxruntime (guardrail, stt, nlp).
# curl: used by container HEALTHCHECKs.
#
# The docker-clean removal is what makes the cache mounts below real. Every
# Debian image ships /etc/apt/apt.conf.d/docker-clean, whose DPkg::Post-Invoke
# hook deletes /var/cache/apt/archives/*.deb after each install — so a mount at
# that path retained nothing and every build re-downloaded from deb.debian.org
# over this runner's ~60 KB/s public egress. It cost little HERE (two small
# packages, and this image's layers come back from the registry cache), but the
# same two lines are load-bearing in apps/harness/Dockerfile, where the toolchain
# is 99 MB and their absence timed out build-harness in pipeline 1161. Kept
# identical in both so neither drifts into looking like the exception.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-downloaded-packages && \
    apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        curl

# Non-root runtime user. The image stays root so builder stages can write to
# /app; service production stages switch to `hope`.
RUN groupadd --gid 1001 hope && \
    useradd --uid 1001 --gid hope --shell /usr/sbin/nologin --no-create-home hope

WORKDIR /app
