"""Health check endpoints for the NLP service.

Follows the HOPE standardized health contract:
  - Three status values: "healthy", "degraded", "unhealthy"
  - Three endpoints: /health (detailed), /health/live, /health/ready
  - Consistent response shape with service, version, timestamp, checks
"""

import time
from datetime import datetime, timezone
from typing import Dict, Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from nlp.core.logging import get_logger
from nlp.core.config import settings
from nlp.dependencies import (
    get_text_classifier,
    get_token_classifier,
    get_text_corrector,
    get_medical_suggester,
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
async def health_check() -> Dict[str, Any]:
    """Detailed health check with per-model component status."""
    checks: Dict[str, Dict[str, Any]] = {}
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

    return {
        "status": overall,
        "service": _SERVICE_NAME,
        "version": _SERVICE_VERSION,
        "uptime_seconds": round(time.monotonic() - _startup_time, 1),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
    }


@router.get("/health/live")
async def liveness() -> Dict[str, str]:
    """Kubernetes liveness probe — always returns 200 if the process is running."""
    return {"status": "healthy"}


@router.get("/health/ready")
async def readiness() -> Any:
    """Kubernetes readiness probe — returns 200 only if at least one model is loaded."""
    for name, get_svc in _MODELS.items():
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
