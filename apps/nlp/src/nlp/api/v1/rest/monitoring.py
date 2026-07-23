"""Health check endpoints for the NLP service.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Three endpoints: /health (detailed), /health/live, /health/ready
  - Consistent response shape with service, version, timestamp, checks
"""

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from nlp.core.config import settings
from nlp.core.logging import get_logger
from nlp.dependencies import get_text_corrector, model_cache_snapshot

logger = get_logger(__name__)

router = APIRouter(prefix="", tags=["NLP REST Monitoring"])

_SERVICE_NAME = settings.service.name
_SERVICE_VERSION = settings.service.version
_startup_time = time.monotonic()


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
        "version": _SERVICE_VERSION,
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
