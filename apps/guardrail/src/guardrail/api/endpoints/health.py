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

    # Classification / NER / entailment are delegated too (TASK-735 Phases 3 & 6):
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
