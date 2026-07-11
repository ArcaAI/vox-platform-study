"""Health, liveness, and readiness endpoints (HOPE health contract).

  - ``/health``        detailed status (service, version, uptime, checks)
  - ``/health/live``   liveness probe (process up)
  - ``/health/ready``  readiness probe

Phase 1 has no providers yet, so readiness reports process-up. Phase 2 gates
readiness on the provider registry (>= 1 registered provider) + provider health.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(tags=["health"])

_SERVICE_NAME = "tts-v2"
_SERVICE_VERSION = "0.1.0"
_startup_time = time.monotonic()


@router.get("/health")
async def health_check() -> dict[str, Any]:
    """Detailed health check."""
    return {
        "status": "healthy",
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": {},
    }


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    """Kubernetes liveness probe — 200 while the process is running."""
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness(request: Request) -> dict[str, str] | JSONResponse:
    """Kubernetes readiness probe — 503 until >= 1 registered provider is healthy."""
    registry = getattr(request.app.state, "provider_registry", None)
    if registry is None or not registry.list_providers():
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "no providers registered"},
        )
    for name in registry.list_providers():
        try:
            if await registry.get(name).health():
                return {"status": "healthy"}
        except Exception:
            continue
    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "no healthy providers"},
    )
