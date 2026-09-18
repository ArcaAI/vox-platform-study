"""Health check, liveness, and readiness endpoints.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Four endpoints (TASK-990): /health (detailed, informational, ALWAYS 200),
    /health/live, /health/ready and /health/startup (the three probe routes,
    which are the only ones allowed to refuse)
  - Consistent response shape with service, version, timestamp, checks
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader

from text.core.dependencies import (
    get_effective_config_client,
    get_pool_health_tracker,
    get_provider_registry,
    get_redis,
)
from text.core.effective_config import EffectiveConfigClient
from text.core.metrics import HEALTH_CHECK_LATENCY, PROVIDER_HEALTH
from text.providers.base import ProviderRegistry
from text.services.pool_health import PoolHealthTracker

router = APIRouter(tags=["health"])

_SERVICE_NAME = "text"
_startup_time = time.monotonic()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. A literal here ("2.0.0") answered the same string for every
    image ever built, so during a rollout you could not tell which build
    replied — verified live: ``hope-text``'s image carried
    ``0.0.0-dev-2-2.96bf9a52`` while its ``/health`` said ``2.0.0``. CI bakes
    the real identity into every image
    (``docs/operations/build-info.schema.json``) and the gateway already
    reports it this way (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm text:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived from
    git, or to ``0.0.0-unknown.unknown`` outside a checkout. Version reporting
    must never become a new way for ``/health`` to fail.

    Cached for the process lifetime: build identity is immutable artifact data,
    not configuration — read once, never re-read per request.

    Only ``version`` is surfaced. This route is auth-exempt and public; branch,
    SHA and pipeline id are operator data that belong behind an admin-gated
    surface, not on a probe endpoint.
    """
    return BuildInfoReader().get_build_info().version


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
    pool_health_tracker: PoolHealthTracker = Depends(get_pool_health_tracker),
) -> dict[str, Any]:
    """Detailed health check with per-provider component status.

    INFORMATIONAL ONLY, and deliberately **always HTTP 200** — the verdict lives
    in the body's ``status``, never in the status line, so no probe may point
    here. A misconfigured pod has to stay able to REPORT that it is unwell,
    which is the same reason ``EXEMPT_PATHS`` keeps this route reachable when
    the service is failing closed; the gateway answers the same way. Failure is
    expressed on ``/health/live`` (process), ``/health/ready`` (Redis + at least
    one healthy provider) and ``/health/startup`` (initialisation) — TASK-990 F9.
    """

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
            # the SAME result feeds the degrade-routing cache
            # `/generate` consults before dispatch — see services/pool_health.py.
            pool_health_tracker.record(name, healthy)
        except Exception:
            status = "unhealthy"
            PROVIDER_HEALTH.labels(provider=name).set(0)
            pool_health_tracker.record(name, False)
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
        "version": _service_version(),
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }

    # Which config lane is live, so operators can see per-group
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
