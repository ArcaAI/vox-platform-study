"""Health check endpoint for Guardrail service."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends

from guardrail.core.config import Settings
from guardrail.core.dependencies import get_gliner_provider, get_ollama_provider, get_redis, get_settings

router = APIRouter()


@router.get("/health", response_model=dict[str, Any])
async def health_check(
    settings: Settings = Depends(get_settings),
    ollama_provider=Depends(get_ollama_provider),
    gliner_provider=Depends(get_gliner_provider),
    redis=Depends(get_redis),
) -> dict[str, Any]:
    """Comprehensive health check for all services."""
    health_status = {
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

    # Check Ollama (medical validation)
    if settings.ollama.enabled:
        ollama_health = await ollama_provider.health_check()
        health_status["checks"]["ollama"] = ollama_health
        if not ollama_health.get("healthy", False):
            health_status["status"] = "degraded"
    else:
        health_status["checks"]["ollama"] = {"status": "disabled"}

    # Check GLiNER (content safety)
    gliner_health = gliner_provider.health_check()
    health_status["checks"]["gliner"] = gliner_health
    if not gliner_health.get("healthy", False):
        health_status["status"] = "degraded"

    return health_status


@router.get("/health/ready", response_model=dict[str, Any])
async def readiness_check(
    gliner_provider=Depends(get_gliner_provider),
    redis=Depends(get_redis),
) -> dict[str, Any]:
    """Readiness check - service is ready to accept traffic."""
    try:
        await redis.ping()

        gliner_health = gliner_provider.health_check()
        if not gliner_health.get("healthy", False):
            return {
                "ready": False,
                "reason": "GLiNER provider not healthy",
                "timestamp": datetime.now(UTC).isoformat(),
            }

        return {
            "ready": True,
            "timestamp": datetime.now(UTC).isoformat(),
        }

    except Exception as e:
        return {
            "ready": False,
            "reason": str(e),
            "timestamp": datetime.now(UTC).isoformat(),
        }


@router.get("/health/live", response_model=dict[str, Any])
async def liveness_check() -> dict[str, Any]:
    """Liveness check - service is alive."""
    return {
        "alive": True,
        "timestamp": datetime.now(UTC).isoformat(),
    }
