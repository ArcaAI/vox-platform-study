"""Health check endpoints for the Guardrail service.

The HOPE four-route health contract (TASK-990): ``/health`` is the detailed,
informational endpoint and is ALWAYS 200; ``/health/live``, ``/health/ready``
and ``/health/startup`` are the three probe routes, and are the only ones
allowed to refuse. This router is mounted at BOTH ``/api`` and ``/api/v1``
(``guardrail.main``), so every route here exists under two prefixes and both
must be listed in ``api/middleware/auth.py``'s ``EXEMPT_PATHS``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader

from guardrail.core.config import Settings
from guardrail.core.dependencies import (
    get_redis,
    get_settings,
)

router = APIRouter()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. The inline ``"1.0.0"`` answered the same string for every image
    ever built, so during a rollout you could not tell which build replied. CI
    bakes the real identity into every image
    (``docs/operations/build-info.schema.json``) and the gateway already reports
    it this way (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm guardrail:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived
    from git, or to ``0.0.0-unknown.unknown`` outside a checkout. Version
    reporting must never become a new way for ``/health`` to fail.

    Cached for the process lifetime: build identity is immutable artifact data,
    not configuration — read once, never re-read per request.

    Only ``version`` is surfaced. This route is auth-exempt and public; branch,
    SHA and pipeline id are operator data that belong behind an admin-gated
    surface, not on a probe endpoint.
    """
    return BuildInfoReader().get_build_info().version


@router.get("/health", response_model=dict[str, Any])
async def health_check(
    request: Request,
    settings: Settings = Depends(get_settings),
    redis: aioredis.Redis = Depends(get_redis),
) -> dict[str, Any]:
    """Comprehensive health check for all services.

    INFORMATIONAL ONLY, and deliberately **always HTTP 200** — the verdict lives
    in the body's ``status``, never in the status line. No probe points here and
    none may: a misconfigured pod has to stay able to REPORT that it is unwell,
    which is the same reason ``EXEMPT_PATHS`` keeps this route reachable when the
    service is failing closed (``api/middleware/auth.py``). The gateway answers
    the same way (200 with ``status: "degraded"`` in the body,
    ``apps/api/src/modules/health/health.controller.ts``).

    The probe contract lives on the other three routes and is where failure is
    expressed: ``/health/live`` (process), ``/health/ready`` (dependencies —
    503s without Redis), ``/health/startup`` (initialisation). TASK-990 F9
    recorded this endpoint as "returns 200 even when Redis is unhealthy"; the
    resolution was to keep it that way and pin the contract, so please do not
    "fix" it into a 503.
    """
    health_status: dict[str, Any] = {
        "status": "healthy",
        "timestamp": datetime.now(UTC).isoformat(),
        "version": _service_version(),
        "service": "guardrail",
        "checks": {},
    }

    # Check Redis
    try:
        await redis.ping()
        health_status["checks"]["redis"] = {"status": "healthy"}
    except Exception as e:
        health_status["checks"]["redis"] = {
            "status": "unhealthy",
            "error": str(e),
        }
        health_status["status"] = "degraded"

    # LLM judgement is DELEGATED to `apps/text`, so there is
    # no engine of guardrail's own to probe here. Report the delegation target as
    # configuration, not as a health verdict: the per-tenant provider/model is
    # resolved per request, and probing `text` on every liveness poll would make a
    # peer's slowness look like guardrail being unhealthy.
    health_status["checks"]["llm_judge"] = {
        "status": "delegated",
        "delegate": "text",
        "base_url": settings.text_url,
    }

    # Classification / NER / entailment are delegated too ( Phases 3 & 6):
    # guardrail holds ZERO resident model weights. Same posture as the judge above —
    # report the delegation target, never probe a peer on a liveness poll.
    health_status["checks"]["classification"] = {
        "status": "delegated",
        "delegate": "nlp",
        "base_url": settings.nlp_url,
    }

    return health_status


@router.get("/health/ready", response_model=None)
async def readiness_check(
    redis: aioredis.Redis = Depends(get_redis),
) -> dict[str, Any] | JSONResponse:
    """Readiness check - service is ready to accept traffic.

    Readiness does not depend on any model: guardrail loads none (every model runs
    in `apps/nlp` or `apps/text`). Only the Redis dependency is checked.

    Must return a non-200 status on failure — the k8s readiness probe only
    inspects the status code, not the body, so a 200 with `ready: false`
    never pulls the pod from Service endpoints.
    """
    try:
        await redis.ping()

        return {
            "ready": True,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={
                "ready": False,
                "reason": str(e),
                "timestamp": datetime.now(UTC).isoformat(),
            },
        )


@router.get("/health/live", response_model=dict[str, Any])
async def liveness_check() -> dict[str, Any]:
    """Liveness check - service is alive."""
    return {
        "alive": True,
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.get("/health/startup", response_model=None)
async def startup_check(request: Request) -> dict[str, str] | JSONResponse:
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
