"""Health, liveness, readiness and startup endpoints (HOPE health contract).

  - ``/health``          detailed status (service, version, uptime, checks) —
                         informational, ALWAYS 200, never probed
  - ``/health/live``     liveness probe (process up)
  - ``/health/ready``    readiness probe (provider registry + provider health)
  - ``/health/startup``  startup probe (initialisation complete) — TASK-990 F7

Only the three probe routes may refuse; ``/health`` carries its verdict in the
body so a misconfigured pod can still report that it is unwell.
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

_SERVICE_NAME = "tts"
_startup_time = time.monotonic()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. A literal here ("0.1.0") answered the same string for every
    image ever built, so during a rollout you could not tell which build
    replied. CI bakes the real identity into every image
    (``docs/operations/build-info.schema.json``) and the gateway already reports
    it this way (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm tts:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived from
    git, or to ``0.0.0-unknown.unknown`` outside a checkout. Version reporting
    must never become a new way for ``/health`` to fail.

    Cached for the process lifetime: build identity is immutable artifact data,
    not configuration — read once, never re-read per request.

    Only ``version`` is surfaced. This route is auth-exempt and public; branch,
    SHA and pipeline id are operator data that belong behind an admin-gated
    surface, not on a probe endpoint.
    """
    return BuildInfoReader().get_build_info().version


@router.get("/health")
async def health_check() -> dict[str, Any]:
    """Detailed health check."""
    return {
        "status": "healthy",
        "service": _SERVICE_NAME,
        "version": _service_version(),
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": {},
    }


@router.get("/health/live")
async def liveness() -> dict[str, str]:
    """Kubernetes liveness probe — 200 while the process is running."""
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
    """Kubernetes readiness probe — 503 until the service can serve a request.

    Four states, not two (the fourth added by TASK-990 F5):

    * a registered provider whose ``health`` is true → **healthy**;
    * a registered provider that is unhealthy *solely* because it holds no
      platform credential (``is_configured is False``) → **degraded, but ready**.
      That is the BYOK contract established: the platform is not allowed
      to hold the key, the gateway decrypts and injects it per request, and the
      router builds a keyed engine from that override
      (``TTSRouter._build_override_engine``). Such a provider is exactly as
      serviceable as its callers' credentials — the process itself is not broken,
      so it must not be held out of the k8s Service endpoints. Before this, a
      keyless cloud deployment could never become Ready at all;
    * a SELF-HOSTED provider that loads its weights on demand and has not loaded
      them yet (``loads_on_demand is True``) → **degraded, but ready**.
      TASK-990 F5: ``KokoroProvider.health()`` used to answer ``True``
      unconditionally, so a pod went Ready — and took traffic — before the
      weights were resident, and the first real request paid the whole cold
      load. ``health()`` now reports actual residency, which makes that visible
      here. It must NOT become a 503: local engines are lazy by design
      (``TTS_WARMUP_ENABLED`` defaults to false), so "not yet loaded" is a
      normal, serviceable state, and gating on it would hold the pod out of the
      Service endpoints forever whenever warmup is off. "Not yet loaded" is not
      "broken": a genuinely broken engine still lands in the unhealthy state
      below, because ``loads_on_demand`` says nothing about whether the load
      will succeed — only that it has not been attempted yet;
    * anything else (a credentialled, non-lazy provider reporting unhealthy, or a
      probe that raises) → **unhealthy**. Keylessness and laziness each excuse a
      ``False`` health probe, never an erroring one.

    The degraded body is deliberately distinguishable from the healthy one, and
    names WHICH degradation applies: k8s reads only the status code, but an
    operator reading the payload must be able to tell "ready and able to
    synthesize" from "ready, but every request needs to bring its own key" from
    "ready, but the weights are not resident yet" — three states with three
    different remedies. The router will still refuse a request that arrives
    without a credential (``candidates`` skips ``is_configured is False``
    providers unless the request carries an override).

    With warmup ENABLED the new state costs nothing and gains exactly the check
    the operator asked for: ``warmup()`` runs inside the lifespan, so by the
    time this route can be reached at all the weights are resident and the
    provider answers plain healthy.
    """
    registry = getattr(request.app.state, "provider_registry", None)
    if registry is None or not registry.list_providers():
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "no providers registered"},
        )
    awaiting_credentials: list[str] = []
    awaiting_warm_load: list[str] = []
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
        elif getattr(provider, "loads_on_demand", False) is True:
            awaiting_warm_load.append(name)
    if awaiting_credentials or awaiting_warm_load:
        return {
            "status": "degraded",
            "message": _degraded_message(awaiting_credentials, awaiting_warm_load),
            "awaiting_credentials": awaiting_credentials,
            "awaiting_warm_load": awaiting_warm_load,
        }
    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "no healthy providers"},
    )


def _degraded_message(awaiting_credentials: list[str], awaiting_warm_load: list[str]) -> str:
    """Name WHICH degradation applies, so the body stays diagnostic.

    k8s reads only the status code, but an operator reading this payload has to
    be able to tell "every request must bring its own key" from "the weights are
    not resident yet" — the two have completely different remedies.
    """
    reasons = []
    if awaiting_credentials:
        reasons.append("awaiting per-request credentials")
    if awaiting_warm_load:
        reasons.append("weights not yet resident (lazy load)")
    return "providers registered but " + " and ".join(reasons)
