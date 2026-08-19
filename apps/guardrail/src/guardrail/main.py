"""Guardrail - AI-powered content safety service.

FastAPI application with OpenAI-compatible LLM engines and job queue processing.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from guardrail.core.config import Settings, get_settings
from guardrail.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources: httpx client, Redis, LLM providers."""
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
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )
        logger.info(
            "guardrail.tenant_config_enabled",
            cache_ttl_s=settings.db.config_cache_ttl_s,
        )

    # No engine providers are initialized here. Guardrail hosts no LLM
    # (TASK-735 Phase 2b): medical validation delegates to `apps/text`'s judge
    # lane through a per-request client built from the tenant's own
    # `AiTaskDefault` selection, so there is nothing process-wide to construct —
    # and no env-configured engine to fall back to.

    # GLiNER is NO LONGER loaded here. Its runtime model id is
    # DB-selected (SYSTEM `guardrail.safety`) and loaded lazily on first
    # `/guardrail/analyze` through the idle-TTL aux-model cache, so a freshly
    # booted worker holds ZERO GLiNER weights. The cache lives on app.state and
    # is created on first use by the request/job resolvers.

    # Initialize job queue processor
    if not hasattr(app.state, "job_processor") or app.state.job_processor is None:
        from guardrail.core.dependencies import pinned_gliner_provider
        from guardrail.services.job_processor import JobProcessor

        # A job carries the tenant that SUBMITTED it (stamped by
        # `/guardrail/analyze/async`, which now refuses an absent `X-Tenant-Id` with
        # 428). Model selection therefore resolves tenant-first for deferred work too,
        # instead of the old `tenant_id=None` that silently pinned every job to SYSTEM.
        def _gliner_for_job(tenant_id: str | None) -> object:
            return pinned_gliner_provider(app.state, tenant_id=tenant_id)

        app.state.job_processor = JobProcessor(
            redis=redis_client,
            gliner_provider_resolver=_gliner_for_job,  # type: ignore[arg-type]
            max_concurrent=settings.queue.max_concurrent,
        )

        # Start background job processing
        app.state.job_processor_task = asyncio.create_task(
            app.state.job_processor.start_processing()
        )
        logger.info("guardrail.job_processor_started")

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Reuses the shared `http_client` above. Guardrail
    # has no dedicated `environment` settings field; `DEPLOYMENT_ENVIRONMENT`
    # / `NODE_ENV` is the same repo-wide convention `_deployment_environment()`
    # uses for OTel elsewhere.
    app.state.service_release_task = None
    try:
        app.state.service_release_task = start_registration(
            http_client=http_client,
            gateway_url=settings.gateway_url,
            service_token=settings.service_token.get_secret_value(),
            build_info=BuildInfoReader().get_build_info(),
            environment=os.getenv("DEPLOYMENT_ENVIRONMENT")
            or os.getenv("NODE_ENV")
            or "development",
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("guardrail.service_release_registration_failed", error=str(exc))

    yield

    # Cleanup
    logger.info("guardrail.shutting_down")

    await stop_registration(app.state.service_release_task)

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

    from guardrail.core.observability import shutdown_opentelemetry

    shutdown_opentelemetry(app)


def create_app() -> FastAPI:
    """Create FastAPI application with middleware and routes."""
    settings = get_settings()

    app = FastAPI(
        title="Guardrail",
        description="AI-powered content safety service",
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
    from guardrail.api.endpoints.redact import router as redact_router

    app.include_router(health_router, prefix="/api", tags=["health"])
    # Every other python service exposes health at /api/v1/health; alias it here
    # too (same router/handler) so callers using the v1 path don't 404 while
    # /api/health keeps working for existing callers.
    app.include_router(health_router, prefix="/api/v1", tags=["health"])
    app.include_router(medical_router, prefix="/api", tags=["medical"])  # Primary endpoint
    app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])
    # Live output-side groundedness gate — behind X-Service-Token.
    app.include_router(groundedness_router, prefix="/api", tags=["groundedness"])
    # Tenant-facing PHI redactor (TASK-710) — behind X-Service-Token.
    app.include_router(redact_router, prefix="/api", tags=["guardrails"])
    app.include_router(jobs_router, prefix="/api", tags=["jobs"])

    # OpenTelemetry tracing. Default-OFF: both the master
    # switch AND a non-empty collector endpoint are required, so an unset
    # endpoint can never make a truthy flag start dialing a collector that
    # was never configured.
    if settings.otel_enabled and settings.otel_exporter_endpoint:
        from guardrail.core.observability import setup_opentelemetry

        setup_opentelemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
        )
    else:
        app.state.tracer_provider = None

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
