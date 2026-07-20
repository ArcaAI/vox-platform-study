"""Health check, liveness, and readiness endpoints.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Three endpoints: /health (detailed), /health/live, /health/ready
  - Consistent response shape with service, version, timestamp, checks
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from smr_v2.core.dependencies import get_effective_config_client, get_provider_registry, get_redis
from smr_v2.core.effective_config import EffectiveConfigClient
from smr_v2.core.metrics import HEALTH_CHECK_LATENCY, PROVIDER_HEALTH
from smr_v2.providers.base import ProviderRegistry

router = APIRouter(tags=["health"])

_SERVICE_NAME = "smr"
_SERVICE_VERSION = "2.0.0"
_startup_time = time.monotonic()


async def _check_redis(redis_client: aioredis.Redis | None) -> dict[str, Any]:
    """Ping Redis and return a health check result."""
    start = time.monotonic()
    try:
        if redis_client is None:
            return {"status": "unhealthy", "duration_ms": 0.0, "error": "no client"}
        await redis_client.ping()
        return {
            "status": "healthy",
            "duration_ms": round((time.monotonic() - start) * 1000, 2),
        }
    except Exception as exc:
        return {
            "status": "unhealthy",
            "duration_ms": round((time.monotonic() - start) * 1000, 2),
            "error": str(exc),
        }


@router.get("/health")
async def health_check(
    registry: ProviderRegistry = Depends(get_provider_registry),
    redis_client: aioredis.Redis = Depends(get_redis),
    effective_config: EffectiveConfigClient | None = Depends(get_effective_config_client),
) -> dict[str, Any]:
    """Detailed health check with per-provider component status."""
    checks: dict[str, dict[str, Any]] = {}

    redis_result = await _check_redis(redis_client)
    checks["redis"] = redis_result

    for name in registry.list_providers():
        start = time.monotonic()
        try:
            provider = registry.get(name)
            healthy = await provider.health_check()
            status = "healthy" if healthy else "unhealthy"
            PROVIDER_HEALTH.labels(provider=name).set(1 if healthy else 0)
        except Exception:
            status = "unhealthy"
            PROVIDER_HEALTH.labels(provider=name).set(0)
        finally:
            duration_ms = round((time.monotonic() - start) * 1000, 2)
            HEALTH_CHECK_LATENCY.labels(provider=name).observe(duration_ms / 1000)
        checks[name] = {"status": status, "duration_ms": duration_ms}

    statuses = [c["status"] for c in checks.values()]
    if not statuses or all(s == "healthy" for s in statuses):
        overall = "healthy"
    elif all(s == "unhealthy" for s in statuses):
        overall = "unhealthy"
    else:
        overall = "degraded"

    payload: dict[str, Any] = {
        "status": overall,
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }

    # TASK-525 §3.7 — which config lane is live, so operators can see per-group
    # whether the control plane or env is in force. Health is auth-exempt, so
    # this carries SOURCE LABELS and timestamps only — never resolved values.
    # Deliberately does not affect `overall`: a config-plane outage degrades to
    # env values, which is a healthy state.
    if effective_config is not None:
        payload["effective_config"] = effective_config.diagnostics()

    return payload


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    """Kubernetes liveness probe — always returns 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness(
    registry: ProviderRegistry = Depends(get_provider_registry),
    redis_client: aioredis.Redis = Depends(get_redis),
) -> dict[str, Any] | JSONResponse:
    """Kubernetes readiness probe — requires Redis + at least one healthy provider."""
    redis_result = await _check_redis(redis_client)
    if redis_result["status"] != "healthy":
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "Redis is not available"},
        )

    for name in registry.list_providers():
        try:
            provider = registry.get(name)
            if await provider.health_check():
                return {"status": "healthy"}
        except Exception:
            continue

    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "No healthy providers available"},
    )
