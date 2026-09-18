"""Health check, liveness, and readiness endpoints.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Four endpoints (TASK-990): /health (detailed, informational, ALWAYS 200),
    /health/live, /health/ready and /health/startup (the three probe routes,
    which are the only ones allowed to refuse)
  - Consistent response shape with service, version, timestamp, checks

``/health`` reports process health and echoes the configured Temporal substrate
without dialing it (so it is dependency-free and deterministic). ``/health/ready``
actually probes the Temporal frontend and returns 503 when it is unreachable.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, cast

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader

from harness.core.config import Settings

router = APIRouter(tags=["health"])

_SERVICE_NAME = "harness"
_startup_time = time.monotonic()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. ``harness.__version__`` is a source literal: it answered the
    same string for every image ever built, so during a rollout you could not
    tell which build replied. CI bakes the real identity into every image
    (``docs/operations/build-info.schema.json``) and the gateway already reports
    it this way (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm harness:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived
    from git, or to ``0.0.0-unknown.unknown`` outside a checkout. Version
    reporting must never become a new way for ``/health`` to fail.

    Cached for the process lifetime: build identity is immutable artifact data,
    not configuration — read once, never re-read per request.

    Only ``version`` is surfaced. This route is public; branch, SHA and pipeline
    id are operator data that belong behind an admin-gated surface, not on a
    probe endpoint.
    """
    return BuildInfoReader().get_build_info().version


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
        "version": _service_version(),
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    """Kubernetes liveness probe — always 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/startup", response_model=None)
async def startup(request: Request) -> dict[str, str] | JSONResponse:
    """Kubernetes startup probe — has application initialisation finished?

    TASK-990 F7: the fourth route of the gateway's health contract
    (``apps/api/src/modules/health/health.controller.ts``), which the six Python
    services were missing. It sits in a four-route contract where only THIS
    route, ``/health/live`` and ``/health/ready`` may fail: ``/health`` is the
    informational, ops-facing endpoint and is always 200.

    The marker is ``app.state.service_release_task``. Every one of the six
    services assigns it UNCONDITIONALLY inside its lifespan (it is ``None`` when
    gateway registration is disabled, so the value says nothing — only its
    PRESENCE does), and no ``create_app`` assigns it. So the attribute existing
    means "this app's lifespan startup body ran to the point of announcing the
    service", and its absence means the app was assembled without one. The same
    marker is used by all six on purpose: six bespoke markers is six things to
    get wrong, and ``tests/contracts/test_health_contract_parity.py`` pins this
    one by name so removing it is a reviewed change rather than a silent
    downgrade to an always-200 route.

    Honest limitation, stated rather than buried: over HTTP in a normally
    assembled app the 503 is not reachable, because Starlette does not route a
    request until the lifespan's startup phase has RETURNED. While the app is
    still starting the kubelet gets a connection that never answers and the
    probe fails on ``timeoutSeconds`` — a probe failure either way, just not a
    503 body. The branch earns its place on an app built WITHOUT its lifespan
    (``uvicorn --lifespan off``, or a router mounted on a bare ``FastAPI()`` —
    which is exactly how several of these services' own suites build test apps).

    Deliberately NOT gated on model residency or on any dependency. Those are
    ``/health/ready``'s job; re-checking them here would make a slow dependency
    or a lazy model load look like a failed START and restart a healthy pod.
    """
    if getattr(request.app.state, "service_release_task", _UNSET) is _UNSET:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "Service is still initializing"},
        )
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
