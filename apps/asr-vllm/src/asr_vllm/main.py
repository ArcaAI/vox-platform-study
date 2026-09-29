"""asr-vllm — FastAPI application factory.

Run with the FACTORY form (``uvicorn --factory asr_vllm.main:create_app``): there is no
module-level ``app``, so importing this module never loads an env file or builds
settings as a side effect.

The process is stateless per request: every window names its model (the resolved
spec), engines are resident per runtime key, and nothing ties a stream to a replica —
so N replicas behind one k8s Service scale out horizontally.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from hope_obs import (
    ObservabilityConfig,
    configure_observability,
    get_logger,
    shutdown_observability,
)

from asr_vllm.api.endpoints.health import SERVICE_NAME, service_version
from asr_vllm.core.config import Settings, get_settings
from asr_vllm.core.service_auth import is_local_environment
from asr_vllm.engine.base import EngineFactory
from asr_vllm.engine.pool import EnginePool

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    logger.info(
        "asr_vllm.starting",
        backend=app.state.engine_factory.name,
        backend_unavailable_reason=app.state.engine_factory.availability(),
        max_resident_engines=settings.max_resident_engines,
        max_num_seqs=settings.max_num_seqs,
        gpu_memory_utilization=settings.gpu_memory_utilization,
    )
    # Startup marker of the fleet health contract (see api/endpoints/health.py). This
    # spike does NOT self-register with the gateway (no gateway URL, no peer calls), so
    # the marker is None — its PRESENCE is what `/health/startup` reads.
    app.state.service_release_task = None
    logger.info("asr_vllm.started")
    yield
    await app.state.engine_pool.close()
    shutdown_observability(app)
    logger.info("asr_vllm.shutdown_complete")


def create_app(
    settings: Settings | None = None,
    *,
    engine_factory: EngineFactory | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    if engine_factory is None:
        from asr_vllm.engine.vllm_backend import VllmEngineFactory

        engine_factory = VllmEngineFactory(settings)

    app = FastAPI(
        title="asr-vllm — Whisper decode on vLLM",
        description="Stateless per-window Whisper transcription on vLLM continuous batching",
        version="0.1.0",
        docs_url="/api/v1/docs",
        redoc_url=None,
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine_factory = engine_factory
    app.state.engine_pool = EnginePool(engine_factory, max_resident=settings.max_resident_engines)

    from asr_vllm.api.middleware.auth import ServiceAuthMiddleware

    if not settings.accepted_service_tokens and not is_local_environment():
        logger.error(
            "asr_vllm.auth.no_internal_token_configured",
            detail="INTERNAL_ACCESS_TOKEN is unset in a deployed environment; "
            "all non-exempt traffic will be rejected",
        )
    app.add_middleware(ServiceAuthMiddleware)

    from asr_vllm.api.endpoints.health import router as health_router
    from asr_vllm.api.endpoints.transcriptions import router as transcriptions_router

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
