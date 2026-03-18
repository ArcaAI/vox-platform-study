"""SMR V2 — Text Generation Service.

FastAPI application with lifespan-managed shared resources.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from smr_v2.core.config import Settings, get_settings
from smr_v2.core.logging import get_logger, setup_logging

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage shared resources: httpx client, Redis, providers."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    logger.info("smr_v2.starting", host=settings.host, port=settings.port, debug=settings.debug)

    http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=settings.httpx_max_connections,
            max_keepalive_connections=settings.httpx_max_keepalive,
        ),
        timeout=httpx.Timeout(300.0),
    )
    app.state.http_client = http_client

    if not hasattr(app.state, "redis") or app.state.redis is None:
        redis_client = aioredis.from_url(settings.redis.redis_url, decode_responses=True)
        app.state.redis = redis_client
    else:
        redis_client = app.state.redis

    if not hasattr(app.state, "task_manager") or app.state.task_manager is None:
        from smr_v2.services.task_manager import TaskManager
        app.state.task_manager = TaskManager(
            redis=redis_client,
            task_ttl=settings.redis.task_ttl_seconds,
            stream_max_len=settings.redis.stream_max_len,
        )

    if not hasattr(app.state, "provider_registry") or app.state.provider_registry is None:
        from smr_v2.providers.base import ProviderRegistry
        app.state.provider_registry = ProviderRegistry()

    registry = app.state.provider_registry
    if settings.ollama.enabled and "ollama" not in registry.list_providers():
        from smr_v2.providers.ollama import OllamaProvider
        registry.register("ollama", OllamaProvider(settings.ollama, http_client))
        logger.info("smr_v2.provider_registered", provider="ollama", base_url=settings.ollama.base_url, model=settings.ollama.default_model)

    if settings.azure.enabled and "azure-openai" not in registry.list_providers():
        from smr_v2.providers.azure_openai import AzureOpenAIProvider
        provider_instance = AzureOpenAIProvider(settings.azure)
        registry.register("azure-openai", provider_instance)
        registry.register("azure", provider_instance)  # backward-compatible alias
        logger.info("smr_v2.provider_registered", provider="azure-openai")

    if settings.bedrock.enabled and "bedrock" not in registry.list_providers():
        from smr_v2.providers.bedrock import BedrockProvider
        registry.register("bedrock", BedrockProvider(settings.bedrock))
        logger.info("smr_v2.provider_registered", provider="bedrock")

    if settings.openai_compat.enabled and "lm-studio" not in registry.list_providers():
        from smr_v2.providers.openai_compat import OpenAICompatProvider
        provider_instance = OpenAICompatProvider(settings.openai_compat)
        registry.register("lm-studio", provider_instance)
        registry.register("openai_compat", provider_instance)  # backward-compatible alias
        logger.info("smr_v2.provider_registered", provider="lm-studio", base_url=settings.openai_compat.base_url)

    from smr_v2.services.rate_limiter import RateLimitTracker

    rate_limiters: dict[str, RateLimitTracker] = {}
    provider_configs = {
        "ollama": settings.ollama,
        "azure-openai": settings.azure,
        "azure": settings.azure,
        "bedrock": settings.bedrock,
        "lm-studio": settings.openai_compat,
        "openai_compat": settings.openai_compat,
    }
    for name in registry.list_providers():
        cfg = provider_configs.get(name)
        rpm = getattr(cfg, "rpm_limit", 0) if cfg else 0
        tpm = getattr(cfg, "tpm_limit", 0) if cfg else 0
        rate_limiters[name] = RateLimitTracker(rpm_limit=rpm, tpm_limit=tpm)
    app.state.rate_limiters = rate_limiters

    if not app.state.provider_queues:
        from smr_v2.services.provider_queue import ProviderQueue

        queues: dict[str, ProviderQueue] = {}
        for name in registry.list_providers():
            queues[name] = ProviderQueue(max_size=settings.queue.max_size)
        app.state.provider_queues = queues

    if not app.state.circuit_breakers:
        from smr_v2.services.circuit_breaker import CircuitBreaker

        cb_cfg = settings.circuit_breaker
        cbs: dict[str, CircuitBreaker] = {}
        for name in registry.list_providers():
            cbs[name] = CircuitBreaker(
                failure_threshold=cb_cfg.failure_threshold,
                recovery_timeout=cb_cfg.recovery_timeout_s,
            )
        app.state.circuit_breakers = cbs

    if not app.state.provider_semaphores:
        provider_configs = {
            "ollama": settings.ollama,
            "azure-openai": settings.azure,
            "azure": settings.azure,
            "bedrock": settings.bedrock,
            "lm-studio": settings.openai_compat,
            "openai_compat": settings.openai_compat,
        }
        sems: dict[str, asyncio.Semaphore] = {}
        for name in registry.list_providers():
            cfg = provider_configs.get(name)
            max_conc = getattr(cfg, "max_concurrent", 10) if cfg else 10
            sems[name] = asyncio.Semaphore(max_conc)
        app.state.provider_semaphores = sems

    if app.state.shutdown_manager is None:
        from smr_v2.services.shutdown_manager import ShutdownManager

        app.state.shutdown_manager = ShutdownManager()

    logger.info("smr_v2.started", providers=registry.list_providers())
    yield

    shutdown_mgr = app.state.shutdown_manager
    if shutdown_mgr is not None:
        logger.info("smr_v2.draining_tasks", active=shutdown_mgr.active_count)
        timed_out = await shutdown_mgr.wait_for_shutdown(timeout=30.0)
        if timed_out:
            logger.warning("smr_v2.drain_timeout", remaining=shutdown_mgr.active_count)

    logger.info("smr_v2.shutting_down")
    await http_client.aclose()
    if redis_client and hasattr(redis_client, "aclose"):
        try:
            await redis_client.aclose()
        except (ConnectionError, OSError, RuntimeError) as exc:
            logger.warning("redis.close_failed", error=str(exc))
        except Exception as exc:
            logger.error("redis.close_unexpected_error", error=str(exc))
    logger.info("smr_v2.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="SMR V2 — Text Generation Service",
        description="General-purpose text generation API with multi-provider LLM support",
        version="2.0.0",
        docs_url="/api/v1/docs",
        redoc_url="/api/v1/redoc",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.redis = None
    app.state.task_manager = None
    app.state.provider_registry = None
    app.state.rate_limiters = {}
    app.state.circuit_breakers = {}
    app.state.provider_queues = {}
    app.state.shutdown_manager = None
    app.state.provider_semaphores = {}

    from smr_v2.core.exception_handlers import register_exception_handlers
    register_exception_handlers(app)

    from smr_v2.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)
    if settings.cors_enabled and settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # LIFO order: last-added runs first.
    # RequestLoggingMiddleware added before RequestIDMiddleware in code
    # so it executes AFTER request_id is bound to contextvars.
    from smr_v2.api.middleware.logging import RequestLoggingMiddleware
    app.add_middleware(RequestLoggingMiddleware)

    from smr_v2.api.middleware.request_id import RequestIDMiddleware
    app.add_middleware(RequestIDMiddleware)

    from smr_v2.api.endpoints.health import router as health_router
    from smr_v2.api.endpoints.generate import router as generate_router
    from smr_v2.api.endpoints.tasks import router as tasks_router
    from smr_v2.api.endpoints.providers import router as providers_router
    from smr_v2.api.endpoints.stream import router as stream_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(generate_router, prefix="/api/v1")
    app.include_router(tasks_router, prefix="/api/v1")
    app.include_router(providers_router, prefix="/api/v1")
    app.include_router(stream_router, prefix="/api/v1")

    if settings.otel_enabled:
        from smr_v2.core.telemetry import setup_telemetry
        setup_telemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
        )

    if settings.metrics_enabled:
        from prometheus_fastapi_instrumentator import Instrumentator
        Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
