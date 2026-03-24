"""Health check endpoint for Guardrail service."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends

from guardrail.core.dependencies import get_settings, get_ollama_provider, get_redis
from guardrail.core.config import Settings

router = APIRouter()


@router.get("/health", response_model=dict[str, Any])
async def health_check(
    settings: Settings = Depends(get_settings),
    ollama_provider = Depends(get_ollama_provider),
    redis = Depends(get_redis),
) -> dict[str, Any]:
    """Comprehensive health check for all services."""
    
    health_status = {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
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
    
    # Check Ollama
    if settings.ollama.enabled:
        ollama_health = await ollama_provider.health_check()
        health_status["checks"]["ollama"] = ollama_health
        if not ollama_health.get("healthy", False):
            health_status["status"] = "degraded"
    else:
        health_status["checks"]["ollama"] = {"status": "disabled"}
    
    return health_status


@router.get("/health/ready", response_model=dict[str, Any])
async def readiness_check(
    ollama_provider = Depends(get_ollama_provider),
    redis = Depends(get_redis),
) -> dict[str, Any]:
    """Readiness check - service is ready to accept traffic."""
    
    try:
        # Check Redis connectivity
        await redis.ping()
        
        # Check Ollama if enabled
        ollama_health = await ollama_provider.health_check()
        if not ollama_health.get("healthy", False):
            return {
                "ready": False,
                "reason": "Ollama not healthy",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        
        return {
            "ready": True,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        
    except Exception as e:
        return {
            "ready": False,
            "reason": str(e),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


@router.get("/health/live", response_model=dict[str, Any])
async def liveness_check() -> dict[str, Any]:
    """Liveness check - service is alive."""
    return {
        "alive": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
