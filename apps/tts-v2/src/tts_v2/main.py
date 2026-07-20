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

    # Sarvam (cloud; best ml code-switch) — register gated by TTS_SARVAM_ENABLED.
    if settings.sarvam.enabled and "sarvam" not in registry:
        from tts_v2.providers.sarvam import SarvamProvider

        registry.register("sarvam", SarvamProvider(settings.sarvam))
        logger.info("tts_v2.provider_registered", provider="sarvam", model=settings.sarvam.model)

    # TASK-529 (D-09) — local engines register UNCONDITIONALLY and load their
    # weights on the first synth request; an idle model is then released by the
    # cache's TTL sweep. Before this, `warm_and_register` loaded every enabled
    # engine at boot and nothing ever unloaded it.
    #
    # Health-semantics shift: a broken model now surfaces as a first-request 503
    # instead of a missing provider. TTS_WARMUP_ENABLED=true restores boot-warm
    # for operators who prefer to fail at boot (the provider still registers).
    # See docs/operations/inference/model-retention.md.
    if settings.kokoro.enabled or settings.indic_parler.enabled or settings.indic_f5.enabled:
        from tts_v2.providers.registration import register_local_provider

        warmup = settings.warmup_enabled

        if settings.kokoro.enabled and "kokoro" not in registry:
            from tts_v2.providers.kokoro import KokoroProvider

            await register_local_provider(
                registry,
                "kokoro",
                KokoroProvider(settings.kokoro, ttl_seconds=settings.model_cache_ttl_seconds),
                warmup=warmup,
                logger=logger,
            )

        if settings.indic_parler.enabled and "indic_parler" not in registry:
            from tts_v2.providers.indic_parler import IndicParlerProvider

            await register_local_provider(
                registry, "indic_parler", IndicParlerProvider(settings.indic_parler), warmup=warmup, logger=logger
            )

        # IndicF5 — EXPERIMENTAL, prod enablement NO-GO pending license review (TASK-494).
        if settings.indic_f5.enabled and "indic_f5" not in registry:
            from tts_v2.providers.indic_f5 import IndicF5Provider

            await register_local_provider(
                registry, "indic_f5", IndicF5Provider(settings.indic_f5), warmup=warmup, logger=logger
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
    from tts_v2.api.endpoints.stream_ws import router as stream_ws_router
    from tts_v2.api.endpoints.voices import router as voices_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(voices_router, prefix="/api/v1")
    app.include_router(speech_router, prefix="/api/v1")
    app.include_router(stream_ws_router, prefix="/api/v1")

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
