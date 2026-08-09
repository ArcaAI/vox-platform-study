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

_SERVICE_NAME = "tts"
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
async def readiness(request: Request) -> dict[str, Any] | JSONResponse:
    """Kubernetes readiness probe — 503 until the service can serve a request.

    Three states, not two (TASK-642):

    * a registered provider whose ``health()`` is true → **healthy**;
    * a registered provider that is unhealthy *solely* because it holds no
      platform credential (``is_configured is False``) → **degraded, but ready**.
      That is the BYOK contract TASK-602 established: the platform is not allowed
      to hold the key, the gateway decrypts and injects it per request, and the
      router builds a keyed engine from that override
      (``TTSRouter._build_override_engine``). Such a provider is exactly as
      serviceable as its callers' credentials — the process itself is not broken,
      so it must not be held out of the k8s Service endpoints. Before this, a
      keyless cloud deployment could never become Ready at all;
    * anything else (a credentialled provider reporting unhealthy, or a probe that
      raises) → **unhealthy**. Keylessness excuses a ``False`` health probe, never
      an erroring one.

    The degraded body is deliberately distinguishable from the healthy one: k8s
    reads only the status code, but an operator reading the payload must be able
    to tell "ready and able to synthesize" from "ready, but every request needs to
    bring its own key" — the router will still refuse a request that arrives
    without one (``candidates()`` skips ``is_configured is False`` providers
    unless the request carries an override).
    """
    registry = getattr(request.app.state, "provider_registry", None)
    if registry is None or not registry.list_providers():
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "no providers registered"},
        )
    awaiting_credentials: list[str] = []
    for name in registry.list_providers():
        provider = registry.get(name)
        try:
            healthy = await provider.health()
        except Exception:
            continue
        if healthy:
            return {"status": "healthy"}
        if getattr(provider, "is_configured", True) is False:
            awaiting_credentials.append(name)
    if awaiting_credentials:
        return {
            "status": "degraded",
            "message": "providers registered but awaiting per-request credentials",
            "awaiting_credentials": awaiting_credentials,
        }
    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "no healthy providers"},
    )
