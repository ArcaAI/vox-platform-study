"""asr-vllm — FastAPI application factory.

Run with the FACTORY form (``uvicorn --factory asr_vllm.main:create_app``): there is no
module-level ``app``, so importing this module never loads an env file or builds
settings as a side effect.

The process is stateless per request: every window names its model (the resolved
spec), engines are resident per runtime key, and nothing ties a stream to a replica —
so N replicas behind one k8s Service scale out horizontally.

Its only peer is the gateway's ``/internal/*`` surface, reached with the shared
``INTERNAL_ACCESS_TOKEN``: the platform settings (``asrVllm.*``, OD-6) and, for a
HuggingFace pull, the model owner's registry credential (OD-7). Building the app opens
no connection; both are pulled on first use.
"""

from __future__ import annotations

import os
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
from asr_vllm.core.effective_config import (
    EffectiveConfigClient,
    close_control_plane,
    refresh_control_plane,
)
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
        control_plane=app.state.effective_config_client is not None,
    )
    # Startup marker of the fleet health contract (see api/endpoints/health.py). This
    # service does NOT self-register with the gateway (it is reached through STT, never
    # routed by the gateway), so the marker is None — its PRESENCE is what
    # `/health/startup` reads.
    app.state.service_release_task = None
    logger.info("asr_vllm.started")
    yield
    await close_control_plane(app.state)
    await app.state.engine_pool.close()
    shutdown_observability(app)
    logger.info("asr_vllm.shutdown_complete")


def create_app(
    settings: Settings | None = None,
    *,
    engine_factory: EngineFactory | None = None,
    effective_config_client: EffectiveConfigClient | None = None,
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
            "asr_vllm.control_plane.no_gateway_configured",
            detail="ASR_VLLM_API_GATEWAY_URL is blank; asrVllm.* platform settings stay at "
            "their defaults",
        )
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
    app.state.effective_config_client = effective_config_client
    app.state.control_plane_refresh = None
    app.state.config_invalidation_task = None
    app.state.config_invalidation_redis = None

    async def pull_control_plane() -> None:
        await refresh_control_plane(app.state)

    # `settings` is overlaid IN PLACE by the control plane, so both hooks read the
    # platform's current values: the bound at every eviction check, the engine knobs
    # right after the pull that precedes every build.
    app.state.engine_pool = EnginePool(
        engine_factory,
        max_resident=lambda: settings.max_resident_engines,
        before_build=pull_control_plane,
    )

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
