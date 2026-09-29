"""The HOPE four-route health contract (``tests/contracts/test_health_contract_parity.py``).

* ``/health``         detailed, ALWAYS 200 — the verdict is in the body.
* ``/health/live``    process alive. Reads NOTHING — no pool, no engine, no lock — so a
                      replica busy decoding (or loading weights in a worker thread) is
                      never restarted for being busy (TASK-1007 D-2 / F-3).
* ``/health/ready``   can this replica serve? 503 only when the engine backend is absent
                      from the image. No engine loaded yet is ``degraded`` but READY:
                      engines are lazy because the model is only known per request, and a
                      router warms a new replica through ``POST /engines/warm``.
* ``/health/startup`` lifespan finished (the shared ``service_release_task`` marker).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader

router = APIRouter(tags=["health"])

SERVICE_NAME = "asr-vllm"
_startup_time = time.monotonic()
_UNSET = object()


@lru_cache(maxsize=1)
def service_version() -> str:
    """The running artifact's version from ``/app/build-info.json`` (never raises)."""
    return BuildInfoReader().get_build_info().version


def _engines(request: Request) -> dict[str, Any]:
    snapshot: dict[str, Any] = request.app.state.engine_pool.snapshot()
    return snapshot


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    reason = request.app.state.engine_factory.availability()
    engines = _engines(request)
    return {
        "status": "degraded" if reason or not engines["loaded"] else "healthy",
        "service": SERVICE_NAME,
        "version": service_version(),
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": {
            "backend": request.app.state.engine_factory.name,
            "backend_available": reason is None,
            "engines": engines,
        },
    }


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    return {"status": "healthy"}


@router.get("/health/startup", response_model=None)
async def startup(request: Request) -> dict[str, str] | JSONResponse:
    if getattr(request.app.state, "service_release_task", _UNSET) is _UNSET:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "Service is still initializing"},
        )
    return {"status": "healthy"}


@router.get("/health/ready", response_model=None)
async def readiness(request: Request) -> dict[str, Any] | JSONResponse:
    factory = request.app.state.engine_factory
    reason = factory.availability()
    if reason is not None:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": reason, "backend": factory.name},
        )
    engines = _engines(request)
    if engines["loaded"]:
        return {"status": "healthy", "backend": factory.name, "engines": engines}
    return {
        "status": "degraded",
        "message": "no engine resident yet; the first request (or POST /engines/warm) loads one",
        "backend": factory.name,
        "engines": engines,
    }
