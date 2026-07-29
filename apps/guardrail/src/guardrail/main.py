"""Guardrail - AI-powered content safety service.

FastAPI application with Ollama integration and job queue processing.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from guardrail.core.config import (
    OllamaConfig,
    OpenAICompatConfig,
    Settings,
    get_settings,
)
from guardrail.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources: httpx client, Redis, Ollama provider."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    logger.info("guardrail.starting", host=settings.host, port=settings.port, debug=settings.debug)

    # HTTP client for external calls
    http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=settings.httpx_max_connections,
            max_keepalive_connections=settings.httpx_max_keepalive,
        ),
        timeout=httpx.Timeout(300.0),
    )
    app.state.http_client = http_client

    # Redis client for job queue and caching
    redis_client = aioredis.from_url(settings.redis.redis_url, decode_responses=True)
    app.state.redis = redis_client

    # The control-plane pull client for aux-cache retention.
    # Construction performs NO I/O, so boot never blocks on (or fails because of)
    # the gateway; the first analyze/groundedness request triggers the first
    # fetch, and a failure negative-caches into env behaviour.
    if not hasattr(app.state, "effective_config_client"):
        from guardrail.core.effective_config import EffectiveConfigClient

        app.state.effective_config_client = EffectiveConfigClient(
            base_url=settings.gateway_url,
            token=settings.service_token.get_secret_value(),
        )

    # Per-tenant config resolver. Only initialized when DB-config
    # is enabled; otherwise the env-only engine path below is used unchanged.
    if not hasattr(app.state, "tenant_config_resolver"):
        app.state.tenant_config_resolver = None
    if settings.db.db_config_enabled and app.state.tenant_config_resolver is None:
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from guardrail.core.tenant_config import TenantConfigResolver

        db_engine = create_async_engine(
            settings.db.database_url,
            pool_size=settings.db.pool_size,
            max_overflow=settings.db.max_overflow,
            pool_pre_ping=True,
        )
        app.state.tenant_config_engine = db_engine
        session_factory = async_sessionmaker(bind=db_engine, expire_on_commit=False)
        app.state.tenant_config_resolver = TenantConfigResolver(
            session_factory=session_factory,
            default_tenant_id=settings.db.default_tenant_id,
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )
        logger.info(
            "guardrail.tenant_config_enabled",
            default_tenant_id=settings.db.default_tenant_id,
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )

    # Initialize the LLM engine providers based on the selected provider.
    # lm-studio (default) | vllm | llama-cpp | azure | bedrock run over the
    # OpenAI-compatible chat API; ollama uses its native API. The content
    # provider keeps the historical `ollama_provider` app.state slot so
    # endpoints/job_processor stay engine-agnostic. the self-host
    # production engines (vllm/llama-cpp) serve Granite Guardian, so the Granite
    # BYOC protocol applies to them as it does for lm-studio.
    _GRANITE_ENGINES = {"lm-studio", "vllm", "llama-cpp"}
    engine_cfg = settings.engine
    if not hasattr(app.state, "ollama_provider") or app.state.ollama_provider is None:
        if settings.provider == "ollama":
            from guardrail.providers.ollama import OllamaProvider

            app.state.ollama_provider = OllamaProvider(
                settings=cast(OllamaConfig, engine_cfg),
                http_client=http_client,
            )
        else:
            from guardrail.providers.openai_compat import OpenAICompatProvider

            app.state.ollama_provider = OpenAICompatProvider(
                settings=cast(OpenAICompatConfig, engine_cfg),
                http_client=http_client,
                use_granite=(settings.provider in _GRANITE_ENGINES),
            )
        logger.info(
            "guardrail.content_provider_initialized",
            provider=settings.provider,
            base_url=engine_cfg.base_url,
            model=engine_cfg.guardrail_model,
        )

    # Initialize Guardian provider for medical validation
    if not hasattr(app.state, "guardian_provider") or app.state.guardian_provider is None:
        if settings.provider == "ollama":
            from guardrail.providers.guardian import GuardianProvider

            app.state.guardian_provider = GuardianProvider(
                settings=cast(OllamaConfig, engine_cfg),
                http_client=http_client,
            )
        else:
            from guardrail.providers.openai_compat import OpenAICompatGuardianProvider

            app.state.guardian_provider = OpenAICompatGuardianProvider(
                settings=cast(OpenAICompatConfig, engine_cfg),
                http_client=http_client,
            )
        logger.info(
            "guardrail.guardian_provider_initialized",
            provider=settings.provider,
            base_url=engine_cfg.base_url,
            model=engine_cfg.guardian_model,
            enabled=engine_cfg.guardian_enabled,
        )

    # GLiNER is NO LONGER loaded here. Its runtime model id is
    # DB-selected (SYSTEM `guardrail.safety`) and loaded lazily on first
    # `/guardrail/analyze` through the idle-TTL aux-model cache, so a freshly
    # booted worker holds ZERO GLiNER weights. The cache lives on app.state and
    # is created on first use by the request/job resolvers.

    # Initialize job queue processor
    if not hasattr(app.state, "job_processor") or app.state.job_processor is None:
        from guardrail.core.dependencies import pinned_gliner_provider
        from guardrail.services.job_processor import JobProcessor

        # Jobs carry no tenant; SYSTEM selection resolves regardless of tenant.
        def _gliner_for_job() -> object:
            return pinned_gliner_provider(app.state, tenant_id=None)

        app.state.job_processor = JobProcessor(
            redis=redis_client,
            gliner_provider_resolver=_gliner_for_job,  # type: ignore[arg-type]
            max_concurrent=settings.engine.max_concurrent,
        )

        # Start background job processing
        app.state.job_processor_task = asyncio.create_task(
            app.state.job_processor.start_processing()
        )
        logger.info("guardrail.job_processor_started")

    yield

    # Cleanup
    logger.info("guardrail.shutting_down")

    if hasattr(app.state, "job_processor") and app.state.job_processor:
        await app.state.job_processor.stop()

    if hasattr(app.state, "job_processor_task") and app.state.job_processor_task:
        await app.state.job_processor_task

    # release any lazily-loaded aux models (GLiNER / MiniCheck).
    if getattr(app.state, "gliner_cache", None) is not None:
        await app.state.gliner_cache.clear()
    if getattr(app.state, "groundedness_scorer_cache", None) is not None:
        await app.state.groundedness_scorer_cache.clear()

    if hasattr(app.state, "http_client") and app.state.http_client:
        await app.state.http_client.aclose()

    if hasattr(app.state, "redis") and app.state.redis:
        await app.state.redis.aclose()

    if getattr(app.state, "tenant_config_engine", None) is not None:
        await app.state.tenant_config_engine.dispose()


def create_app() -> FastAPI:
    """Create FastAPI application with middleware and routes."""
    settings = get_settings()

    app = FastAPI(
        title="Guardrail",
        description="AI-powered content safety service with Ollama integration",
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS middleware
    if settings.cors_enabled:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Store settings in app state (read by ServiceAuthMiddleware at dispatch).
    app.state.settings = settings

    # Inter-service auth: enforce X-Service-Token on non-exempt paths.
    # An empty service_token is a dev / hermetic-CI bypass.
    from guardrail.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)

    # Include routers
    from guardrail.api.endpoints.groundedness import router as groundedness_router
    from guardrail.api.endpoints.guardrails import router as guardrails_router
    from guardrail.api.endpoints.health import router as health_router
    from guardrail.api.endpoints.jobs import router as jobs_router
    from guardrail.api.endpoints.medical import router as medical_router

    app.include_router(health_router, prefix="/api", tags=["health"])
    # Every other python service exposes health at /api/v1/health; alias it here
    # too (same router/handler) so callers using the v1 path don't 404 while
    # /api/health keeps working for existing callers.
    app.include_router(health_router, prefix="/api/v1", tags=["health"])
    app.include_router(medical_router, prefix="/api", tags=["medical"])  # Primary endpoint
    app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])
    # Live output-side groundedness gate — behind X-Service-Token.
    app.include_router(groundedness_router, prefix="/api", tags=["groundedness"])
    app.include_router(jobs_router, prefix="/api", tags=["jobs"])

    # Metrics endpoint
    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator

        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "guardrail.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level,
    )
