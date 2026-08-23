import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
import redis.asyncio as aioredis
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


async def _load_into_cache(model_name: str, model_path: str | None) -> None:
    """Pull one model into its cache slot so the first request finds it resident."""
    from nlp.dependencies import pinned_gliner2_guard

    async with pinned_gliner2_guard(model_name, model_path):
        pass


async def warm_models(
    client: Any,
    load: Callable[[str, str | None], Awaitable[None]] = _load_into_cache,
) -> None:
    """Load the control-plane warm set. NEVER raises — warming is an optimisation.

    Sequential on purpose: a cold GLiNER2 load is CPU- and IO-heavy, and racing
    several of them at boot lengthens the wall-clock time to the FIRST usable
    model, which is the number that actually matters to readiness.
    """
    try:
        snapshot = await client.get()
        warm = snapshot.warm_models()
    except Exception as exc:  # noqa: BLE001 — a config outage leaves the service lazy
        logger.warning(f"nlp.warm_models.config_unavailable error={type(exc).__name__} {exc}")
        return

    if not warm:
        logger.info("nlp.warm_models.none_configured")
        return

    for model_name, model_path in warm:
        try:
            await load(model_name, model_path)
            logger.info(f"nlp.warm_models.loaded model={model_name}")
        except Exception as exc:  # noqa: BLE001 — one bad row must not cancel the rest
            logger.warning(
                f"nlp.warm_models.failed model={model_name} " f"error={type(exc).__name__} {exc}"
            )


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
        # Owner decision D-D: PRESENT the one shared `INTERNAL_ACCESS_TOKEN`, with
        # the legacy per-service token only as the migration fallback. Reading
        # `service_token` directly sent an EMPTY token whenever the platform was
        # configured the way D-D specifies, so this pull 401'd and every node
        # silently degraded to its env values.
        token=settings.service.peer_service_token(settings.service.service_token),
        service="nlp",
    )

    # ── Push invalidation for that client (owner decision D-5) ─────────────
    #
    # Rule 09 §"Config caches": *invalidation is the propagation path; the TTL
    # is a bounded-staleness safety net.* Round 2 built the subscriber and the
    # gateway's publisher, but this service held no Redis client — so the
    # handler existed with no wire under it and every control-plane write took
    # a full TTL window to be seen here.
    #
    # Both halves degrade rather than fail: constructing the client is guarded
    # because a service that cannot reach its cache is DEGRADED, not broken —
    # taking the NLP plane down because a propagation optimisation is
    # unavailable inverts the priority — and the listener task itself never
    # raises (every failure inside it falls back to the TTL). A process that
    # boots while Redis is down still starts, and still converges.
    app.state.redis = None
    app.state.config_invalidation_task = None
    try:
        app.state.redis = aioredis.from_url(
            settings.service.redis_url, decode_responses=True
        )
        app.state.config_invalidation_task = asyncio.create_task(
            app.state.effective_config_client.run_invalidation_listener(app.state.redis)
        )
    except Exception as exc:  # noqa: BLE001 — propagation degrades to the TTL backstop
        logger.warning(
            f"nlp.config_invalidation.unavailable error={type(exc).__name__} {exc}"
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
            # Owner decision D-D — see the effective-config client above.
            service_token=settings.service.peer_service_token(settings.service.service_token),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.service.environment.value,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("nlp.service_release_registration_failed: %s", exc)

    # Warm the control-plane-configured models. Detached on purpose: a cold
    # GLiNER2 load measured ~220s on developer hardware, and blocking `lifespan`
    # on it would fail every readiness probe for that whole window. Requests that
    # arrive first still load lazily through the same cache, so warming can only
    # make the first request faster, never slower or wrong.
    app.state.warm_models_task = asyncio.create_task(warm_models(app.state.effective_config_client))

    logger.info("Medical NLP Service started successfully")

    yield

    warm_task = getattr(app.state, "warm_models_task", None)
    if warm_task is not None and not warm_task.done():
        warm_task.cancel()

    # Stop the subscriber before dropping the connection it listens on, or the
    # cancelled task wakes onto a closed client and logs a spurious error.
    invalidation_task = getattr(app.state, "config_invalidation_task", None)
    if invalidation_task is not None and not invalidation_task.done():
        invalidation_task.cancel()

    redis_client = getattr(app.state, "redis", None)
    if redis_client is not None:
        try:
            await redis_client.aclose()
        except Exception as exc:  # noqa: BLE001 — shutdown must not raise
            logger.warning(f"nlp.redis.close_failed error={type(exc).__name__} {exc}")

    # Drain the guard batchers so no request is left waiting on a dead loop.
    from nlp.services.guard_dispatch import reset_guard_batchers

    await reset_guard_batchers()

    await websocket_service.shutdown()

    await stop_registration(app.state.service_release_task)
    if app.state.service_release_http_client is not None:
        await app.state.service_release_http_client.aclose()

    await app.state.external_text_http_client.aclose()

    shutdown_opentelemetry(app)

    logger.info("Medical NLP Service shutdown complete")
