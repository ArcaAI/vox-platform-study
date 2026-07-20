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
from nlp.dependencies import (
    get_medical_suggester,
    get_text_classifier,
    get_text_corrector,
    get_token_classifier,
)

logger = get_logger(__name__)

router = APIRouter(prefix="", tags=["NLP REST Monitoring"])

_SERVICE_NAME = settings.service.name
_SERVICE_VERSION = settings.service.version
_startup_time = time.monotonic()

_MODELS = {
    "text_classifier": get_text_classifier,
    "token_classifier": get_token_classifier,
    "text_corrector": get_text_corrector,
    "medical_suggester": get_medical_suggester,
}


@router.get("/health")
async def health_check(request: Request) -> dict[str, Any]:
    """Detailed health check with per-model component status."""
    checks: dict[str, dict[str, Any]] = {}
    overall = "healthy"

    for name, get_svc in _MODELS.items():
        start = time.monotonic()
        try:
            svc = get_svc()
            loaded = getattr(svc, "is_initialized", False)
            status = "healthy" if loaded else "unhealthy"
        except Exception:
            status = "unhealthy"
        duration_ms = round((time.monotonic() - start) * 1000, 2)
        checks[name] = {"status": status, "duration_ms": duration_ms}

        if status == "unhealthy":
            overall = "unhealthy" if overall == "unhealthy" else "degraded"

    payload: dict[str, Any] = {
        "status": overall,
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(UTC).isoformat(),
        "checks": checks,
    }

    # TASK-525 §3.7 — which config lane is live. Health is auth-exempt, so this
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
async def readiness() -> Any:
    """Kubernetes readiness probe — returns 200 only if at least one model is loaded."""
    for _name, get_svc in _MODELS.items():
        try:
            svc = get_svc()
            if getattr(svc, "is_initialized", False):
                return {"status": "healthy"}
        except Exception:
            continue

    return JSONResponse(
        status_code=503,
        content={"status": "unhealthy", "message": "No models loaded"},
    )
