"""vllm — FastAPI application factory.

Run with the FACTORY form (``uvicorn --factory hope_vllm.main:create_app``): there is no
module-level ``app``, so importing this module never loads an env file or builds
settings as a side effect.

The process is stateless per request: every request names its model (``model=<slug>``,
resolved by the gateway for the calling tenant), engines are resident per runtime key,
and nothing ties a stream to a replica — so N replicas of one POOL (``VLLM_POOL``) behind
one k8s Service scale out horizontally.

Its only peer is the gateway's ``/internal/*`` surface, reached with the shared
``INTERNAL_ACCESS_TOKEN``: the platform settings (``vllm.*``), the serving spec of a slug
(C-2), and, for a HuggingFace pull, the model owner's registry credential (OD-7). Building
the app opens no connection.

STARTUP. The lifespan pulls the control plane once (``vllm.pools`` may declare this
process's pool), refuses to start when ``VLLM_POOL`` is undeclared, then loads the pool's
PINS in the background — ``/health/startup`` answers 503 until every pin is resident, while
``/health/live`` keeps answering.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Protocol

from fastapi import FastAPI
from hope_obs import (
    ObservabilityConfig,
    configure_observability,
    get_logger,
    shutdown_observability,
)

from hope_vllm.api.endpoints.health import SERVICE_NAME, service_version
from hope_vllm.core.config import Settings, get_settings
from hope_vllm.core.effective_config import (
    EffectiveConfigClient,
    close_control_plane,
    refresh_control_plane,
)
from hope_vllm.core.service_auth import is_local_environment
from hope_vllm.core.serving_spec_client import ServingSpecClient
from hope_vllm.engine.base import EngineFactory
from hope_vllm.engine.pool import SYSTEM_TENANT_ID, EnginePool
from hope_vllm.spec import ResolvedServingSpec

logger = get_logger(__name__)


class SpecResolver(Protocol):
    """``model=<slug>`` → spec for a tenant (``ServingSpecClient``; a fake in tests)."""

    async def resolve(self, slug: str, tenant_id: str) -> ResolvedServingSpec: ...


async def _warm_pins(app: FastAPI) -> None:
    """Load every pin, then set the startup marker. A failure keeps startup at 503."""
    resolver: SpecResolver = app.state.serving_spec_client

    async def resolve_for_platform(slug: str) -> ResolvedServingSpec:
        # A pin is platform configuration: it names a SYSTEM row, never a customer's.
        return await resolver.resolve(slug, SYSTEM_TENANT_ID)

    try:
        await app.state.engine_pool.warm_pins(resolve_for_platform)
    except Exception as exc:  # noqa: BLE001 — reported by /health/startup staying 503
        logger.error(
            "vllm.pins.warm_failed",
            pool=app.state.settings.pool,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return
    # Startup marker of the fleet health contract (see api/endpoints/health.py). This
    # service does NOT self-register with the gateway, so the marker is None — its
    # PRESENCE is what `/health/startup` reads.
    app.state.service_release_task = None
    logger.info("vllm.started", pool=app.state.settings.pool)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    # The control plane may declare this process's pool; give it its chance first. Never
    # raises (no gateway / unreachable ⇒ the defaults stay in force).
    await refresh_control_plane(app.state)
    pool_config = settings.pool_config()  # PoolNotConfiguredError ⇒ refuse to start
    logger.info(
        "vllm.starting",
        backend=app.state.engine_factory.name,
        backend_unavailable_reason=app.state.engine_factory.availability(),
        pool=settings.pool,
        accepted_kinds=sorted(pool_config.accepted_kinds),
        pins=list(pool_config.pins),
        vram_budget_gib=pool_config.vram_budget_gib,
        max_resident_engines=pool_config.max_resident,
        control_plane=app.state.effective_config_client is not None,
    )
    if pool_config.pins:
        app.state.pins_task = asyncio.create_task(_warm_pins(app))
    else:
        app.state.pins_task = None
        app.state.service_release_task = None  # nothing to warm: started
        logger.info("vllm.started", pool=settings.pool)
    yield
    pins_task = app.state.pins_task
    if pins_task is not None and not pins_task.done():
        pins_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pins_task
    await close_control_plane(app.state)
    await app.state.engine_pool.close()
    shutdown_observability(app)
    logger.info("vllm.shutdown_complete")


def create_app(
    settings: Settings | None = None,
    *,
    engine_factory: EngineFactory | None = None,
    effective_config_client: EffectiveConfigClient | None = None,
    serving_spec_client: SpecResolver | None = None,
) -> FastAPI:
    # OD-7: no AMBIENT HuggingFace token (`HF_TOKEN`, a cached `huggingface-cli login`)
    # may ever fund a pull — only the model owner's registry credential, passed
    # explicitly. Set before anything can import `huggingface_hub`, which reads it once
    # at import; the Dockerfile sets it too.
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    settings = settings or get_settings()
    gateway_url = settings.api_gateway_url.strip()
    if effective_config_client is None and gateway_url:
        # Construction performs NO I/O: the first build (or the first stale request)
        # pulls, and a failed pull negative-caches into the bootstrap values.
        effective_config_client = EffectiveConfigClient(
            base_url=gateway_url, token=settings.peer_service_token()
        )
    if effective_config_client is None:
        logger.warning(
            "vllm.control_plane.no_gateway_configured",
            detail="VLLM_API_GATEWAY_URL is blank; vllm.* platform settings stay at their "
            "defaults and no model=<slug> can be resolved",
        )
    if engine_factory is None:
        from hope_vllm.engine.vllm_backend import VllmEngineFactory

        engine_factory = VllmEngineFactory(settings)

    app = FastAPI(
        title="vllm — Whisper decode on vLLM",
        description="Stateless per-window Whisper transcription on vLLM continuous batching",
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine_factory = engine_factory
    app.state.effective_config_client = effective_config_client
    app.state.control_plane_refresh = None
    app.state.config_invalidation_task = None
    app.state.config_invalidation_redis = None
    # Construction performs NO I/O. With no gateway every resolve is a named 503.
    app.state.serving_spec_client = serving_spec_client or ServingSpecClient(
        base_url=gateway_url, token=settings.peer_service_token()
    )

    async def pull_control_plane() -> None:
        await refresh_control_plane(app.state)

    # `settings` is overlaid IN PLACE by the control plane, so the pool reads the
    # platform's current `vllm.pools` entry at every admission.
    app.state.engine_pool = EnginePool(
        engine_factory,
        pool_config=settings.pool_config,
        before_build=pull_control_plane,
    )

    from hope_vllm.api.middleware.auth import ServiceAuthMiddleware

    if not settings.accepted_service_tokens and not is_local_environment():
        logger.error(
            "vllm.auth.no_internal_token_configured",
            detail="INTERNAL_ACCESS_TOKEN is unset in a deployed environment; "
            "all non-exempt traffic will be rejected",
        )
    app.add_middleware(ServiceAuthMiddleware)

    from hope_vllm.api.endpoints.health import router as health_router
    from hope_vllm.api.endpoints.transcriptions import router as transcriptions_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(transcriptions_router, prefix="/api/v1")

    # Logging, request/tenant context, access log and tracing (TASK-987) — from the app
    # factory, never the lifespan (middleware cannot be added once serving starts).
    configure_observability(
        app, ObservabilityConfig.from_env(SERVICE_NAME, service_version=service_version())
    )

    from prometheus_fastapi_instrumentator import Instrumentator

    Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
    return app
