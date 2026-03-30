# syntax=docker/dockerfile:1
# ── hope-python-base ────────────────────────────────────────────────────────
# Shared base image for all HOPE Python services (CPU-only).
#
# Provides two reusable stages:
#   builder-base  — Python 3.11 + uv 0.8.13 + build-essential
#   runtime-base  — Python 3.11 slim + non-root user hope:hope (1001:1001)
#
# Build:
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# Usage in service Dockerfiles:
#   FROM hope-python-base:latest AS builder-base
#   FROM hope-python-base:latest AS runtime-base
# ─────────────────────────────────────────────────────────────────────────────

# ── Builder base: Python + uv + build tools ────────────────────────────────
FROM python:3.11-slim-trixie AS builder-base

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential

WORKDIR /app

# ── Runtime base: minimal Python runtime ───────────────────────────────────
FROM python:3.11-slim-trixie AS runtime-base

LABEL org.opencontainers.image.vendor="ARCA AI" \
    org.opencontainers.image.licenses="MIT"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH"

RUN groupadd --gid 1001 hope && \
    useradd --uid 1001 --gid hope --shell /usr/sbin/nologin --no-create-home hope

WORKDIR /app
