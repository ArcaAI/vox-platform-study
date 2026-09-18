"""Health check endpoints for the NLP service.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Four endpoints (TASK-990): /health (detailed, informational, ALWAYS 200),
    /health/live, /health/ready and /health/startup (the three probe routes,
    which are the only ones allowed to refuse)
  - Consistent response shape with service, version, timestamp, checks
"""

import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from hope_env import BuildInfoReader

from nlp.core.config import settings
from nlp.core.logging import get_logger
from nlp.dependencies import get_text_corrector, model_cache_snapshot

logger = get_logger(__name__)

router = APIRouter(prefix="", tags=["NLP REST Monitoring"])

_SERVICE_NAME = settings.service.name
_startup_time = time.monotonic()

#: Distinguishes "attribute absent" from "attribute present and None". The
#: startup marker `app.state.service_release_task` is legitimately ``None`` when
#: gateway registration is disabled, so ``getattr(..., None)`` would read a
#: fully initialised app as still starting.
_UNSET = object()


@lru_cache(maxsize=1)
def _service_version() -> str:
    """The RUNNING artifact's version, read from ``/app/build-info.json``.

    TASK-990 F6. ``settings.service.version`` is a pydantic-settings field with
    a literal default, i.e. a build-time fact wearing a config costume — it
    answered the same string for every image ever built, so during a rollout you
    could not tell which build replied. CI bakes the real identity into every
    image (``docs/operations/build-info.schema.json``) and the gateway already
    reports it this way (``apps/api/src/modules/health/health.controller.ts``).

    ``BuildInfoReader`` NEVER raises: an absent or malformed file (local dev,
    ``pnpm nlp:dev``) degrades to ``0.0.0-<branch-slug>.<sha8>`` derived from
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
async def health_check(request: Request) -> dict[str, Any]:
    """Detailed health check with per-model component status.

    ML models load lazily through per-request caches, so a component that holds
    no weights is reported as `lazy` (never `unhealthy`) and never degrades the
    overall status — mirroring the guardrail service's GLiNER contract. Crucially
    the cache-backed components read their state from the SAME ModelCache that
    serves inference, not from the `get_*` singletons that REST inference never
    touches (BUG-010).
    """
    checks: dict[str, dict[str, Any]] = {}

    # Cache-backed components: resident model ids come from the live cache.
    for name, loaded_models in model_cache_snapshot().items():
        checks[name] = {
            "status": "lazy",
            "loaded": bool(loaded_models),
            "loaded_models": loaded_models,
        }

    # The text corrector is a genuine process singleton (SymSpell dictionaries),
    # loaded lazily on first `/correct`. Report its load state without degrading.
    corrector = get_text_corrector()
    checks["text_corrector"] = {
        "status": "lazy",
        "loaded": bool(getattr(corrector, "is_initialized", False)),
    }

    # A booted process with lazy components is healthy. This endpoint has no hard
    # dependencies whose failure would degrade it.
    payload: dict[str, Any] = {
        "status": "healthy",
        "service": _SERVICE_NAME,
        "version": _service_version(),
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }

    # Which config lane is live. Health is auth-exempt, so this
    # carries SOURCE LABELS and timestamps only, never resolved values. It never
    # affects `overall`: a config-plane outage degrades to env values, which is
    # a healthy state.
    effective_config = getattr(request.app.state, "effective_config_client", None)
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


@router.get("/health/ready")
async def readiness(request: Request) -> Any:
    """Kubernetes readiness probe.

    Readiness does NOT gate on lazy model loading — models load on first request,
    so requiring a warmed model would leave a fully-functional worker permanently
    unready and pulled from the gateway/k8s pool (BUG-010). The process is ready
    once startup has completed (the control-plane client is constructed in the
    lifespan); it lazy-loads weights on demand thereafter.
    """
    if getattr(request.app.state, "effective_config_client", None) is not None:
        return {"status": "healthy"}

    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "Service is starting"},
    )
