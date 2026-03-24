"""Guardrail - AI-powered content safety service.

FastAPI application with Ollama integration and job queue processing.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from guardrail.core.config import Settings, get_settings
from guardrail.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage shared resources: httpx client, Redis, Ollama provider."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    logger.info(
        "guardrail.starting", 
        host=settings.host, 
        port=settings.port, 
        debug=settings.debug
    )

    # HTTP client for external calls
    http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=settings.httpx_max_connections,
            max_keepalive_connections=settings.httpx_max_keepalive,
        ),
        timeout=httpx.Timeout(300.0),
    )
    app.state.http_client = http_client

    # Redis client for job queue and caching
    redis_client = aioredis.from_url(settings.redis.redis_url, decode_responses=True)
    app.state.redis = redis_client

    # Initialize Ollama provider
    if not hasattr(app.state, "ollama_provider") or app.state.ollama_provider is None:
        from guardrail.providers.ollama import OllamaProvider
        app.state.ollama_provider = OllamaProvider(
            settings=settings.ollama,
            http_client=http_client,
        )
        logger.info(
            "guardrail.ollama_provider_initialized",
            base_url=settings.ollama.base_url,
            model=settings.ollama.guardrail_model,
        )

    # Initialize Guardian provider for medical validation
    if not hasattr(app.state, "guardian_provider") or app.state.guardian_provider is None:
        from guardrail.providers.guardian import GuardianProvider
        app.state.guardian_provider = GuardianProvider(
            settings=settings.ollama,
            http_client=http_client,
        )
        logger.info(
            "guardrail.guardian_provider_initialized",
            base_url=settings.ollama.base_url,
            model=settings.ollama.guardian_model,
            enabled=settings.ollama.guardian_enabled,
        )

    # Initialize job queue processor
    if not hasattr(app.state, "job_processor") or app.state.job_processor is None:
        from guardrail.services.job_processor import JobProcessor
        app.state.job_processor = JobProcessor(
            redis=redis_client,
            ollama_provider=app.state.ollama_provider,
            max_concurrent=settings.ollama.max_concurrent,
        )
        
        # Start background job processing
        asyncio.create_task(app.state.job_processor.start_processing())
        logger.info("guardrail.job_processor_started")

    yield

    # Cleanup
    logger.info("guardrail.shutting_down")
    
    if hasattr(app.state, "job_processor") and app.state.job_processor:
        await app.state.job_processor.stop()
    
    if hasattr(app.state, "http_client") and app.state.http_client:
        await app.state.http_client.aclose()
    
    if hasattr(app.state, "redis") and app.state.redis:
        await app.state.redis.close()


def create_app() -> FastAPI:
    """Create FastAPI application with middleware and routes."""
    settings = get_settings()

    app = FastAPI(
        title="Guardrail",
        description="AI-powered content safety service with Ollama integration",
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS middleware
    if settings.cors_enabled:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Store settings in app state
    app.state.settings = settings

    # Include routers
    from guardrail.api.endpoints.health import router as health_router
    from guardrail.api.endpoints.medical import router as medical_router
    from guardrail.api.endpoints.guardrails import router as guardrails_router
    from guardrail.api.endpoints.jobs import router as jobs_router

    app.include_router(health_router, prefix="/api", tags=["health"])
    app.include_router(medical_router, prefix="/api", tags=["medical"])  # Primary endpoint
    app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])
    app.include_router(jobs_router, prefix="/api", tags=["jobs"])

    # Metrics endpoint
    if settings.metrics_enabled:
        from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
        from fastapi import Response

        @app.get("/metrics")
        async def metrics():
            return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "guardrail.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level,
    )
