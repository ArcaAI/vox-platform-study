"""TTS — Text-to-Speech Service.

FastAPI application factory with a lifespan-managed context: configuration,
inter-service auth, health/liveness/readiness, Prometheus metrics, the
provider registry, voice catalog, routing, and the
``/api/v1/audio/speech`` synthesis surface.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from tts.core.config import Settings, get_settings
from tts.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources. Phase 1: logging only."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)
    logger.info(
        "tts.starting",
        host=settings.host,
        port=settings.port,
        debug=settings.debug,
    )

    # The control-plane pull client for local-engine retention.
    # Construction performs NO I/O, so boot never blocks on (or fails because of)
    # the gateway; the first synth request triggers the first fetch, and a
    # failure negative-caches into env behaviour.
    if not hasattr(app.state, "effective_config_client"):
        from tts.core.effective_config import EffectiveConfigClient

        # `peer_service_token()`, not a raw field read. This call site used to
        # pass `settings.service_token` directly — the legacy per-service
        # credential — so a deployment configured the way owner decision D-D
        # specifies (shared `INTERNAL_ACCESS_TOKEN` set, legacy empty) sent an
        # EMPTY token here and 401'd every config pull, negative-cached it, and
        # degraded silently to env values with one warning per minute. That is
        # assessment F-06, and it was live in tts at two call sites. The legacy
        # field is now gone, so there is nothing left to bypass.
        app.state.effective_config_client = EffectiveConfigClient(
            base_url=settings.gateway_url,
            token=settings.peer_service_token(),
        )

    # NOTE there is deliberately NO control-plane fetch here. The settings
    # overlay rides the READ-TRIGGERED path instead
    # (`effective_config.refresh_model_cache_retention`, called from the speech
    # endpoint), preserving this service's boot contract: construction performs
    # no I/O, so a process starts even with the gateway down and a service that
    # never synthesises never polls. Pulling at boot would also put a network
    # round-trip into every test that exercises the lifespan.

    # Push invalidation (owner decision D-5) is NOT started here. The connection
    # and its subscriber are opened LAZILY, on the first config refresh — i.e.
    # the first synthesis — by `effective_config.ensure_invalidation_listener`.
    #
    # That is not a stylistic choice. `test_keyless_readiness_task642` pins the
    # invariant that reaching `/health/ready` opens ZERO network connections,
    # because a keyless deployment must become Ready without any I/O at all; a
    # Redis connect in the lifespan breaks it directly. Deferring also keeps the
    # existing "a service that never synthesizes never polls" property, and any
    # process actually serving traffic gets the listener on its first request.
    app.state.config_invalidation_task = None
    app.state.config_invalidation_redis = None

    # PROVIDER REGISTRATION — image-driven, not config-driven (TASK-879).
    #
    # Every engine this image can import registers, unconditionally. That is a real change of
    # authority, not a loosening: which engines a deployment may ROUTE TO is now the SYSTEM
    # `AiProviderConnection(tts, <engine>).enabled` row, resolved by the gateway per request into
    # the spec's `connection` block, and the router walks past a candidate whose row did not
    # answer. Registration answers a different question — which engines this PROCESS contains —
    # and the honest answer to that is "the ones the image installed".
    #
    # The five `TTS_*_ENABLED` flags that used to gate this are gone with the settings keys they
    # mirrored. Three properties this preserves, each of which a test pins:
    #
    #  * BOOT DOES NO I/O. Local engines load weights on the first synthesis, never here, and a
    #    keyless cloud engine is not pre-warmed (`is_configured` is False, so `prewarm` would open
    #    a connection with an empty subscription key). `test_keyless_readiness_task642` fails on
    #    any outbound socket.
    #  * A MISSING EXTRA IS NOT A BOOT FAILURE. `[indic-parler]` / `[indic-f5]` are optional image
    #    variants, so an ImportError here means "this image does not contain that engine" and is
    #    logged, never raised.
    #  * READINESS STILL DISTINGUISHES healthy from awaiting-credentials: a self-hosted engine
    #    reports healthy, a keyless cloud engine reports `is_configured=False`, and
    #    `/health/ready` answers 200 degraded rather than 503.
    registry = app.state.provider_registry

    def _azure() -> Any:
        from tts.providers.azure_speech import AzureSpeechProvider

        return AzureSpeechProvider(settings.azure)

    def _sarvam() -> Any:
        from tts.providers.sarvam import SarvamProvider

        return SarvamProvider(settings.sarvam)

    def _kokoro() -> Any:
        from tts.providers.kokoro import KokoroProvider

        return KokoroProvider(
            settings.kokoro,
            ttl_seconds=settings.model_cache_ttl_seconds,
            warmup_voice=app.state.voice_catalog.default_binding("kokoro", "en"),
        )

    def _indic_parler() -> Any:
        from tts.providers.indic_parler import IndicParlerProvider

        return IndicParlerProvider(
            settings.indic_parler,
            ttl_seconds=settings.model_cache_ttl_seconds,
            warmup_speaker=app.state.voice_catalog.default_binding("indic_parler", "ml"),
        )

    def _indic_f5() -> Any:
        from tts.providers.indic_f5 import IndicF5Provider

        return IndicF5Provider(settings.indic_f5, ttl_seconds=settings.model_cache_ttl_seconds)

    from tts.providers.registration import register_local_provider

    for name, build in (
        ("azure", _azure),
        ("sarvam", _sarvam),
        ("kokoro", _kokoro),
        ("indic_parler", _indic_parler),
        ("indic_f5", _indic_f5),
    ):
        if name in registry:
            continue
        try:
            engine = build()
        except ImportError as exc:
            logger.info(
                "tts.provider_not_in_image",
                provider=name,
                error=str(exc),
                detail="the image variant that ships this engine is not installed; it will not be registered",
            )
            continue
        except Exception as exc:  # noqa: BLE001 — a broken engine must not take the process down
            logger.warning("tts.provider_registration_failed", provider=name, error=str(exc))
            continue
        # Optional boot warm-up (`tts.warmupEnabled`, OFF by default). A warm-up failure is NOT a
        # registration failure: the engine stays registered and the failure surfaces as a 503 on
        # the affected route rather than silently removing a route from the service. A KEYLESS
        # cloud engine is never warmed — with no credential there is nothing to warm, and opening
        # a vendor connection with an empty subscription key is the outbound socket
        # `test_keyless_readiness_task642` forbids at boot.
        warmable = settings.warmup_enabled and getattr(engine, "is_configured", True)
        await register_local_provider(registry, name, engine, warmup=warmable, logger=logger)

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Dedicated short-lived httpx client, closed below.
    app.state.service_release_task = None
    app.state.service_release_http_client = None
    try:
        registration_client = httpx.AsyncClient()
        app.state.service_release_http_client = registration_client
        app.state.service_release_task = start_registration(
            http_client=registration_client,
            gateway_url=settings.gateway_url,
            # The shared internal credential, via the accessor — see the note on
            # the effective-config client above (assessment F-06).
            service_token=settings.peer_service_token(),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.otel_deployment_environment,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("tts.service_release_registration_failed", error=str(exc))

    logger.info("tts.started", providers=registry.list_providers())
    yield

    invalidation_task = getattr(app.state, "config_invalidation_task", None)
    if invalidation_task is not None:
        invalidation_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await invalidation_task
    invalidation_redis = getattr(app.state, "config_invalidation_redis", None)
    if invalidation_redis is not None:
        with contextlib.suppress(Exception):
            await invalidation_redis.aclose()

    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()

    from tts.core.observability import shutdown_opentelemetry

    shutdown_opentelemetry(app)

    logger.info("tts.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="TTS — Text-to-Speech Service",
        description="Realtime multi-provider text-to-speech (English + Malayalam)",
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url="/api/v1/redoc",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.tracer_provider = None
    app.state.logger_provider = None

    from tts.catalog.voices import VoiceCatalog
    from tts.providers.base import ProviderRegistry
    from tts.routing.router import TTSRouter

    registry = ProviderRegistry()
    catalog = VoiceCatalog()
    app.state.provider_registry = registry
    app.state.voice_catalog = catalog
    app.state.router = TTSRouter(registry, settings)

    from tts.api.middleware.auth import ServiceAuthMiddleware
    from tts.core.service_auth import is_local_environment

    # A deployed process with no internal credential serves NOTHING but its
    # probes (HTTP 401, WS close 4401). Say so loudly at boot: the operator's
    # symptom is otherwise a uniformly 401-ing service with no explanation.
    if not settings.accepted_service_tokens and not is_local_environment():
        logger.error(
            "tts.auth.no_internal_token_configured",
            detail=(
                "INTERNAL_ACCESS_TOKEN is unset in a deployed environment; "
                "all non-exempt HTTP and WebSocket traffic will be rejected"
            ),
        )

    app.add_middleware(ServiceAuthMiddleware)

    if settings.cors_enabled and settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    from tts.api.endpoints.health import router as health_router
    from tts.api.endpoints.models import router as model_resolvable_router
    from tts.api.endpoints.providers import router as providers_router
    from tts.api.endpoints.speech import router as speech_router
    from tts.api.endpoints.stream_ws import router as stream_ws_router
    from tts.api.endpoints.voices import router as voices_router

    app.include_router(health_router, prefix="/api/v1")
    # TASK-890 J1 MAJOR-A — the runtime resolvability probe the gateway readiness
    # sweep asks. Service-token gated like every other non-exempt route.
    app.include_router(model_resolvable_router, prefix="/api/v1")
    app.include_router(providers_router, prefix="/api/v1")
    app.include_router(voices_router, prefix="/api/v1")
    app.include_router(speech_router, prefix="/api/v1")
    app.include_router(stream_ws_router, prefix="/api/v1")

    # Default OFF — activates only when BOTH the master
    # switch AND an endpoint are set (never require a
    # reachable observability backend to start or serve traffic). The
    # WebSocket streaming surface is deliberately NOT instrumented here.
    if settings.otel_enabled and settings.otel_exporter_endpoint:
        from tts.core.observability import setup_opentelemetry

        setup_opentelemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
            service_namespace=settings.otel_service_namespace,
            deployment_environment=settings.otel_deployment_environment,
            insecure=settings.otel_insecure,
            logs_enabled=settings.otel_logs_enabled,
        )

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
