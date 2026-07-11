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

    registry = app.state.provider_registry
    if settings.azure.enabled and "azure" not in registry:
        from tts_v2.providers.azure_speech import AzureSpeechProvider

        azure_provider = AzureSpeechProvider(settings.azure)
        registry.register("azure", azure_provider)
        logger.info(
            "tts_v2.provider_registered", provider="azure", region=settings.azure.region
        )
        try:
            await azure_provider.prewarm()
        except Exception as exc:  # noqa: BLE001 — prewarm is best-effort
            logger.warning("tts_v2.azure_prewarm_failed", error=str(exc))

    # Local engines register only after their model warms successfully — a load
    # failure leaves them unregistered (degraded, not dead).
    if settings.kokoro.enabled or settings.indic_parler.enabled:
        from tts_v2.providers.registration import warm_and_register

        if settings.kokoro.enabled and "kokoro" not in registry:
            from tts_v2.providers.kokoro import KokoroProvider

            await warm_and_register(registry, "kokoro", KokoroProvider(settings.kokoro), logger=logger)

        if settings.indic_parler.enabled and "indic_parler" not in registry:
            from tts_v2.providers.indic_parler import IndicParlerProvider

            await warm_and_register(
                registry, "indic_parler", IndicParlerProvider(settings.indic_parler), logger=logger
            )

    logger.info("tts_v2.started", providers=registry.list_providers())
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

    from tts_v2.catalog.voices import VoiceCatalog
    from tts_v2.providers.base import ProviderRegistry
    from tts_v2.routing.router import TTSRouter

    registry = ProviderRegistry()
    catalog = VoiceCatalog()
    app.state.provider_registry = registry
    app.state.voice_catalog = catalog
    app.state.router = TTSRouter(registry, catalog, settings)

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
    from tts_v2.api.endpoints.speech import router as speech_router
    from tts_v2.api.endpoints.voices import router as voices_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(voices_router, prefix="/api/v1")
    app.include_router(speech_router, prefix="/api/v1")

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
