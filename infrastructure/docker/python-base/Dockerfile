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
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH"

# libgomp1: required at runtime by onnxruntime (guardrail, stt-v2, nlp).
# curl: used by container HEALTHCHECKs.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        curl

# Non-root runtime user. The image stays root so builder stages can write to
# /app; service production stages switch to `hope`.
RUN groupadd --gid 1001 hope && \
    useradd --uid 1001 --gid hope --shell /usr/sbin/nologin --no-create-home hope

WORKDIR /app
