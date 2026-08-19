"""Health check endpoint for Guardrail service."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from guardrail.core.config import Settings
from guardrail.core.dependencies import (
    get_redis,
    get_settings,
)

router = APIRouter()


def _gliner_status(request: Request) -> dict[str, Any]:
    """Report the lazy GLiNER cache state.

    GLiNER is loaded lazily on first `/guardrail/analyze`, so a booted worker
    intentionally holds no weights — this is NEVER a degraded condition. Report
    which DB-selected model ids are currently resident.
    """
    cache = getattr(request.app.state, "gliner_cache", None)
    loaded = cache.cached_models() if cache is not None else []
    return {"status": "lazy", "loaded_models": loaded, "loaded": bool(loaded)}


@router.get("/health", response_model=dict[str, Any])
async def health_check(
    request: Request,
    settings: Settings = Depends(get_settings),
    redis: aioredis.Redis = Depends(get_redis),
) -> dict[str, Any]:
    """Comprehensive health check for all services."""
    health_status: dict[str, Any] = {
        "status": "healthy",
        "timestamp": datetime.now(UTC).isoformat(),
        "version": "1.0.0",
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

    # LLM judgement is DELEGATED to `apps/text` (TASK-735 Phase 2b), so there is
    # no engine of guardrail's own to probe here. Report the delegation target as
    # configuration, not as a health verdict: the per-tenant provider/model is
    # resolved per request, and probing `text` on every liveness poll would make a
    # peer's slowness look like guardrail being unhealthy.
    health_status["checks"]["llm_judge"] = {
        "status": "delegated",
        "delegate": "text",
        "base_url": settings.text_url,
    }

    # GLiNER is lazy — report cache state without degrading health.
    health_status["checks"]["gliner"] = _gliner_status(request)

    return health_status


@router.get("/health/ready", response_model=None)
async def readiness_check(
    redis: aioredis.Redis = Depends(get_redis),
) -> dict[str, Any] | JSONResponse:
    """Readiness check - service is ready to accept traffic.

    readiness no longer depends on GLiNER being loaded (it loads
    lazily on first request); only the Redis dependency is checked.

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
