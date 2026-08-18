from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from nlp.core.config import settings
from nlp.core.effective_config import EffectiveConfigClient
from nlp.core.logging import get_logger
from nlp.core.observability import setup_opentelemetry, shutdown_opentelemetry
from nlp.dependencies import get_websocket_manager
from nlp.services.external_text_client import ExternalTextClient

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info("Starting Medical NLP Service...")

    # ML models load lazily on first request through the idle-TTL
    # cache (pinned per-request, evicted on idle). A freshly booted process
    # holds ZERO ML weights; only the websocket manager (no ML weights) is
    # initialized eagerly here.
    websocket_service = get_websocket_manager()

    # The control-plane pull client. Construction performs NO I/O, so
    # boot never blocks on (or fails because of) the gateway; the first inference
    # triggers the first fetch, and a failure negative-caches into env behaviour.
    app.state.effective_config_client = EffectiveConfigClient(
        base_url=settings.service.gateway_url,
        token=settings.service.service_token.get_secret_value(),
        service="nlp",
    )

    # apps/nlp's first peer-service client (TASK-729): a dedicated,
    # long-lived httpx.AsyncClient for calling `text`'s /generate — mirrors
    # apps/text's own `guardrail_client`/`http_client` app.state wiring.
    # Construction performs no I/O; closed in shutdown below.
    app.state.external_text_http_client = httpx.AsyncClient()
    app.state.external_text_client = ExternalTextClient(
        settings=settings.external_text,
        http_client=app.state.external_text_http_client,
        # Owner decision D-D: PRESENT the one shared `INTERNAL_ACCESS_TOKEN`; the
        # legacy `NLP_EXTERNAL_TEXT_SERVICE_TOKEN` is only the migration fallback.
        service_token=settings.service.peer_service_token(settings.external_text.service_token),
    )

    setup_opentelemetry(app)

    await websocket_service.initialize()

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Dedicated short-lived httpx client, closed below.
    app.state.service_release_task = None
    app.state.service_release_http_client = None
    try:
        registration_client = httpx.AsyncClient()
        app.state.service_release_http_client = registration_client
        app.state.service_release_task = start_registration(
            http_client=registration_client,
            gateway_url=settings.service.gateway_url,
            service_token=settings.service.service_token.get_secret_value(),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.service.environment.value,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("nlp.service_release_registration_failed: %s", exc)

    logger.info("Medical NLP Service started successfully")

    yield

    await websocket_service.shutdown()

    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()

    await app.state.external_text_http_client.aclose()

    shutdown_opentelemetry(app)

    logger.info("Medical NLP Service shutdown complete")
