"""SMR V2 — Text Generation Service.

FastAPI application with lifespan-managed shared resources.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from smr_v2.core.config import Settings, get_settings
from smr_v2.core.logging import get_logger, setup_logging

if TYPE_CHECKING:
    from smr_v2.providers.base import LLMProvider, ProviderRegistry

logger = get_logger(__name__)


def _register_provider_factories(
    registry: ProviderRegistry, settings: Settings, http_client: httpx.AsyncClient
) -> None:
    """Register LAZY provider factories gated ONLY by connection config.

    SMR selects nothing from env: the gateway injects the DB-resolved
    ``{provider, model}`` on each request. Here we register a *factory* per
    provider whose CONNECTION config is present; the (network/SDK-bearing)
    instance is built on the first request that selects it (``registry.get``),
    never at startup. A provider with no connection config is never registered,
    so a request naming it fails closed with a 404 — there is no ENABLE flag.

    Local engines (LM Studio / Ollama / vLLM / llama.cpp) always carry a default
    ``base_url`` so they are always available; Azure additionally requires an
    endpoint + api_key; Bedrock requires a region.
    """

    def _shared(builder: Callable[[], LLMProvider]) -> Callable[[], LLMProvider]:
        """Memoize a builder so aliased keys resolve to ONE shared instance."""
        box: dict[str, LLMProvider] = {}

        def factory() -> LLMProvider:
            if "v" not in box:
                box["v"] = builder()
            return box["v"]

        return factory

    def _register(keys: tuple[str, ...], factory: Callable[[], LLMProvider]) -> None:
        for key in keys:
            if key not in registry.list_providers():
                registry.register_factory(key, factory)

    # LM Studio (OpenAI-compatible) — primary local engine; product key + alias.
    if settings.openai_compat.base_url:
        from smr_v2.providers.openai_compat import OpenAICompatProvider

        _register(
            ("lm-studio", "openai_compat"),
            _shared(lambda: OpenAICompatProvider(settings.openai_compat)),
        )

    if settings.ollama.base_url:
        from smr_v2.providers.ollama import OllamaProvider

        _register(("ollama",), lambda: OllamaProvider(settings.ollama, http_client))

    # Azure needs a real endpoint + api_key (no default) to be a usable connection.
    if settings.azure.endpoint and settings.azure.api_key.get_secret_value():
        from smr_v2.providers.azure_openai import AzureOpenAIProvider

        _register(
            ("azure-openai", "azure"),
            _shared(lambda: AzureOpenAIProvider(settings.azure)),
        )

    if settings.bedrock.region:
        from smr_v2.providers.bedrock import BedrockProvider

        _register(("bedrock",), lambda: BedrockProvider(settings.bedrock))

    if settings.vllm.base_url:
        from smr_v2.providers.vllm import VllmProvider

        _register(("vllm",), lambda: VllmProvider(settings.vllm, http_client))

    if settings.llama_cpp.base_url:
        from smr_v2.providers.llama_cpp import LlamaCppProvider

        _register(("llama-cpp",), lambda: LlamaCppProvider(settings.llama_cpp, http_client))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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

    # External Guardrail client (TASK-338 Phase 4b) — invoked per generate to
    # validate medical content. Degrade-safe → fail-CLOSED posture (TASK-478) is
    # enforced inside the client (bounded retry, then a not-allowed verdict).
    if not hasattr(app.state, "guardrail_client") or app.state.guardrail_client is None:
        from smr_v2.services.external_guardrail import ExternalGuardrailClient
        app.state.guardrail_client = ExternalGuardrailClient(
            settings=settings.external_guardrail,
            http_client=http_client,
        )
        logger.info(
            "smr_v2.guardrail_client_initialized",
            enabled=settings.external_guardrail.enabled,
            base_url=settings.external_guardrail.base_url,
            max_retries=settings.external_guardrail.max_retries,
        )

    if not hasattr(app.state, "provider_registry") or app.state.provider_registry is None:
        from smr_v2.providers.base import ProviderRegistry
        app.state.provider_registry = ProviderRegistry()

    registry = app.state.provider_registry
    # register LAZY, connection-gated provider factories (no ENABLE
    # flag, no eager instantiation). The named provider is built on the first
    # request that selects it; the companion state below is keyed on the set of
    # AVAILABLE providers (factory-registered), so a request-driven build slots
    # straight into its rate limiter / queue / breaker / semaphore.
    _register_provider_factories(registry, settings, http_client)

    from smr_v2.services.rate_limiter import RateLimitTracker

    rate_limiters: dict[str, RateLimitTracker] = {}
    provider_configs = {
        "ollama": settings.ollama,
        "azure-openai": settings.azure,
        "azure": settings.azure,
        "bedrock": settings.bedrock,
        "lm-studio": settings.openai_compat,
        "openai_compat": settings.openai_compat,
        "vllm": settings.vllm,
        "llama-cpp": settings.llama_cpp,
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
                half_open_max_calls=cb_cfg.half_open_max_calls,
                reset_timeout_s=cb_cfg.reset_timeout_s,
                count_rate_limits=cb_cfg.count_rate_limits,
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
            "vllm": settings.vllm,
            "llama-cpp": settings.llama_cpp,
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

    from smr_v2.core.observability import shutdown_opentelemetry
    shutdown_opentelemetry(app)

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
    app.state.guardrail_client = None
    app.state.provider_registry = None
    app.state.rate_limiters = {}
    app.state.circuit_breakers = {}
    app.state.provider_queues = {}
    app.state.shutdown_manager = None
    app.state.provider_semaphores = {}
    app.state.tracer_provider = None
    app.state.logger_provider = None

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

    from smr_v2.api.endpoints.generate import router as generate_router
    from smr_v2.api.endpoints.health import router as health_router
    from smr_v2.api.endpoints.providers import router as providers_router
    from smr_v2.api.endpoints.stream import router as stream_router
    from smr_v2.api.endpoints.tasks import router as tasks_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(generate_router, prefix="/api/v1")
    app.include_router(tasks_router, prefix="/api/v1")
    app.include_router(providers_router, prefix="/api/v1")
    app.include_router(stream_router, prefix="/api/v1")

    if settings.otel_enabled:
        from smr_v2.core.observability import setup_opentelemetry
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
