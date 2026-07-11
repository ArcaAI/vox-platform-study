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

from fastapi import APIRouter

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


@router.get("/health/ready")
async def readiness() -> dict[str, str]:
    """Kubernetes readiness probe.

    Phase 1: process-up. Phase 2 will return 503 until >= 1 provider is
    registered and at least one reports healthy.
    """
    return {"status": "healthy"}
