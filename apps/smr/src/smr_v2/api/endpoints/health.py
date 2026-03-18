"""Health check, liveness, and readiness endpoints.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Three endpoints: /health (detailed), /health/live, /health/ready
  - Consistent response shape with service, version, timestamp, checks
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from smr_v2.core.dependencies import get_provider_registry
from smr_v2.core.metrics import HEALTH_CHECK_LATENCY, PROVIDER_HEALTH
from smr_v2.providers.base import ProviderRegistry

router = APIRouter(tags=["health"])

_SERVICE_NAME = "smr"
_SERVICE_VERSION = "2.0.0"
_startup_time = time.monotonic()


@router.get("/health")
async def health_check(
    registry: ProviderRegistry = Depends(get_provider_registry),
) -> dict:
    """Detailed health check with per-provider component status."""
    checks: dict[str, dict] = {}
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

    return {
        "status": overall,
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }


@router.get("/health/live")
async def liveness() -> dict:
    """Kubernetes liveness probe — always returns 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness(
    registry: ProviderRegistry = Depends(get_provider_registry),
) -> dict:
    """Kubernetes readiness probe — returns 200 only if at least one provider is healthy."""
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
