from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from nlp.core.config import settings
from nlp.core.effective_config import EffectiveConfigClient
from nlp.core.logging import get_logger
from nlp.core.observability import setup_opentelemetry, setup_prometheus, shutdown_opentelemetry
from nlp.dependencies import get_websocket_manager

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    logger.info("Starting Medical NLP Service...")

    # ML models load lazily on first request through the idle-TTL
    # cache (pinned per-request, evicted on idle). A freshly booted process
    # holds ZERO ML weights; only the websocket manager (no ML weights) is
    # initialized eagerly here.
    websocket_service = get_websocket_manager()

    # TASK-525 — the control-plane pull client. Construction performs NO I/O, so
    # boot never blocks on (or fails because of) the gateway; the first inference
    # triggers the first fetch, and a failure negative-caches into env behaviour.
    app.state.effective_config_client = EffectiveConfigClient(
        base_url=settings.service.gateway_url,
        token=settings.service.service_token.get_secret_value(),
        service="nlp",
    )

    setup_opentelemetry(app)
    setup_prometheus(app)

    await websocket_service.initialize()

    logger.info("Medical NLP Service started successfully")

    yield

    await websocket_service.shutdown()

    shutdown_opentelemetry(app)

    logger.info("Medical NLP Service shutdown complete")
