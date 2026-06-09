"""Health check, liveness, and readiness endpoints.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Three endpoints: /health (detailed), /health/live, /health/ready
  - Consistent response shape with service, version, timestamp, checks

``/health`` reports process health and echoes the configured Temporal substrate
without dialing it (so it is dependency-free and deterministic). ``/health/ready``
actually probes the Temporal frontend and returns 503 when it is unreachable.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from harness import __version__
from harness.core.config import Settings

router = APIRouter(tags=["health"])

_SERVICE_NAME = "harness"
_SERVICE_VERSION = __version__
_startup_time = time.monotonic()


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    """Detailed health check.

    Reports process liveness and surfaces the configured Temporal substrate
    (address/namespace/task-queue) as informational config — it does not dial
    Temporal, keeping this endpoint dependency-free.
    """
    settings = _settings(request)

    checks: dict[str, dict[str, Any]] = {
        "process": {"status": "healthy"},
        "temporal": {
            "status": "configured",
            "address": settings.temporal.address,
            "namespace": settings.temporal.namespace,
            "task_queue": settings.temporal.task_queue,
        },
    }

    return {
        "status": "healthy",
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    """Kubernetes liveness probe — always 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness(request: Request) -> dict[str, Any] | JSONResponse:
    """Kubernetes readiness probe — requires a reachable Temporal frontend."""
    settings = _settings(request)
    try:
        # Imported lazily so the module has no hard dependency on a running
        # Temporal server at import time (keeps /health and tests dependency-free).
        from harness.temporal.client import get_temporal_client

        client = await get_temporal_client(settings)
        # A cheap RPC that confirms the frontend is actually serving.
        await client.service_client.check_health()
        return {
            "status": "healthy",
            "checks": {"temporal": {"status": "healthy", "address": settings.temporal.address}},
        }
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "checks": {
                    "temporal": {
                        "status": "unhealthy",
                        "address": settings.temporal.address,
                        "error": str(exc),
                    }
                },
            },
        )
