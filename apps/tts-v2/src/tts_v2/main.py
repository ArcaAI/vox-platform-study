"""TTS V2 — Text-to-Speech Service.

FastAPI application factory with a lifespan-managed context. Phase 1 scaffold
(TASK-488): configuration, inter-service auth, health/liveness/readiness, and
Prometheus metrics. Provider registry, voice catalog, routing, and the
``/api/v1/audio/speech`` synthesis surface arrive in later phases.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tts_v2.core.config import Settings, get_settings
from tts_v2.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources. Phase 1: logging only."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)
    logger.info(
        "tts_v2.starting",
        host=settings.host,
        port=settings.port,
        debug=settings.debug,
    )

    # Provider registry / routing / warmup are registered in later phases.

    logger.info("tts_v2.started")
    yield
    logger.info("tts_v2.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="TTS V2 — Text-to-Speech Service",
        description="Realtime multi-provider text-to-speech (English + Malayalam)",
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url="/api/v1/redoc",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )

    app.state.settings = settings

    from tts_v2.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)

    if settings.cors_enabled and settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    from tts_v2.api.endpoints.health import router as health_router

    app.include_router(health_router, prefix="/api/v1")

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
