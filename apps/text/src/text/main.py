"""Text — Text Generation Service.

FastAPI application with lifespan-managed shared resources.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from text.core.config import Settings, get_settings
from text.core.logging import get_logger, setup_logging

if TYPE_CHECKING:
    from text.providers.base import LLMProvider, ProviderRegistry

logger = get_logger(__name__)


def _register_provider_factories(
    registry: ProviderRegistry, settings: Settings, http_client: httpx.AsyncClient
) -> None:
    """Register LAZY provider factories gated ONLY by connection config.

    Text selects nothing from env: the gateway injects the DB-resolved
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
        from text.providers.openai_compat import OpenAICompatProvider

        _register(
            ("lm-studio", "openai_compat"),
            _shared(lambda: OpenAICompatProvider(settings.openai_compat)),
        )

    if settings.ollama.base_url:
        from text.providers.ollama import OllamaProvider

        _register(("ollama",), lambda: OllamaProvider(settings.ollama, http_client))

    if settings.bedrock.region:
        from text.providers.bedrock import BedrockProvider

        _register(("bedrock",), lambda: BedrockProvider(settings.bedrock))

    # Cloud BYO providers (azure / openai / anthropic / vertex) — governed by the
    # unified provider plane (C5). These are BYO-FIRST: the tenant credential
    # (AND, for Azure, the endpoint) arrives per request as a ``provider_overrides``
    # entry injected by the gateway, so they must be AVAILABLE even when no platform
    # env credential/endpoint is configured. They are therefore registered
    # UNCONDITIONALLY (env config is only the platform fallback / fail-open target).
    #
    # Azure was previously gated on ``settings.azure.endpoint`` — but a
    # pure-BYOK tenant has NO platform endpoint (it lives in the tenant's
    # AiProviderConnection row and rides the per-request override), so the gate
    # made Text answer 404 for a valid BYOK override — the exact failure openai/
    # anthropic/vertex already avoid by registering unconditionally. A keyless/
    # endpoint-less call with no override fails closed with
    # ProviderCredentialsError (503), never a 404.
    from text.providers.anthropic import AnthropicProvider
    from text.providers.azure_openai import AzureOpenAIProvider
    from text.providers.openai import OpenAIProvider
    from text.providers.vertex import VertexProvider

    _register(("azure-openai", "azure"), _shared(lambda: AzureOpenAIProvider(settings.azure)))
    _register(("openai",), _shared(lambda: OpenAIProvider(settings.openai)))
    _register(("anthropic",), _shared(lambda: AnthropicProvider(settings.anthropic)))
    _register(("vertex",), _shared(lambda: VertexProvider(settings.vertex)))

    if settings.vllm.base_url:
        from text.providers.vllm import VllmProvider

        _register(("vllm",), lambda: VllmProvider(settings.vllm, http_client))

    if settings.llama_cpp.base_url:
        from text.providers.llama_cpp import LlamaCppProvider

        _register(("llama-cpp",), lambda: LlamaCppProvider(settings.llama_cpp, http_client))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources: httpx client, Redis, providers."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    logger.info("text.starting", host=settings.host, port=settings.port, debug=settings.debug)

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
        from text.services.task_manager import TaskManager

        app.state.task_manager = TaskManager(
            redis=redis_client,
            task_ttl=settings.redis.task_ttl_seconds,
            stream_max_len=settings.redis.stream_max_len,
        )

    # External Guardrail client — invoked per generate to
    # validate medical content. Degrade-safe → fail-CLOSED posture is
    # enforced inside the client (bounded retry, then a not-allowed verdict).
    if not hasattr(app.state, "guardrail_client") or app.state.guardrail_client is None:
        from text.services.external_guardrail import ExternalGuardrailClient

        app.state.guardrail_client = ExternalGuardrailClient(
            settings=settings.external_guardrail,
            http_client=http_client,
            # Owner decision D-D: PRESENT the one shared `INTERNAL_ACCESS_TOKEN`;
            # the legacy per-pair `TEXT_EXTERNAL_GUARDRAIL_SERVICE_TOKEN` is only
            # the fallback for an environment that has not migrated yet.
            service_token=settings.peer_service_token(settings.external_guardrail.service_token),
        )
        logger.info(
            "text.guardrail_client_initialized",
            enabled=settings.external_guardrail.enabled,
            base_url=settings.external_guardrail.base_url,
            max_retries=settings.external_guardrail.max_retries,
        )

    if not hasattr(app.state, "provider_registry") or app.state.provider_registry is None:
        from text.providers.base import ProviderRegistry

        app.state.provider_registry = ProviderRegistry()

    registry = app.state.provider_registry
    # register LAZY, connection-gated provider factories (no ENABLE
    # flag, no eager instantiation). The named provider is built on the first
    # request that selects it; the companion state below is keyed on the set of
    # AVAILABLE providers (factory-registered), so a request-driven build slots
    # straight into its rate limiter / queue / breaker / semaphore.
    _register_provider_factories(registry, settings, http_client)

    # Translate capability: a SEPARATE registry (its providers are not LLMs and
    # carry no rate-limit/circuit-breaker/queue companion state). Sarvam is
    # registered unconditionally (BYO-first, like openai/anthropic): a tenant key
    # arrives per request as a provider override, so it must be available even
    # without a platform env key.
    if not hasattr(app.state, "translate_registry") or app.state.translate_registry is None:
        from text.translation.base import TranslateProviderRegistry

        app.state.translate_registry = TranslateProviderRegistry()

    translate_registry = app.state.translate_registry
    if "sarvam" not in translate_registry.list_providers():
        from text.translation.sarvam import SarvamTranslateProvider

        translate_registry.register_factory(
            "sarvam", lambda: SarvamTranslateProvider(settings.sarvam)
        )

    # Embedding capability (TASK-725 Task 4) — a SEPARATE registry namespace
    # from the LLM `provider_registry` above (design-notes.md §(a)). `tei-embed`
    # always carries a topology-level default `base_url`, same convention as
    # the other local engines, so it registers unconditionally.
    if not hasattr(app.state, "embedding_registry") or app.state.embedding_registry is None:
        from text.providers.embedding import EmbeddingProviderRegistry

        app.state.embedding_registry = EmbeddingProviderRegistry()

    embedding_registry = app.state.embedding_registry
    if "tei-embed" not in embedding_registry.list_providers():
        from text.providers.tei_embed import TeiEmbedProvider

        embedding_registry.register_factory(
            "tei-embed", lambda: TeiEmbedProvider(settings.tei_embed, http_client)
        )

    from text.services.rate_limiter import RateLimitTracker

    rate_limiters: dict[str, RateLimitTracker] = {}
    provider_configs = {
        "ollama": settings.ollama,
        "azure-openai": settings.azure,
        "azure": settings.azure,
        "bedrock": settings.bedrock,
        "openai": settings.openai,
        "anthropic": settings.anthropic,
        "vertex": settings.vertex,
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
        from text.services.provider_queue import ProviderQueue

        queues: dict[str, ProviderQueue] = {}
        for name in registry.list_providers():
            queues[name] = ProviderQueue(max_size=settings.queue.max_size)
        app.state.provider_queues = queues

    if not app.state.circuit_breakers:
        from text.services.circuit_breaker import CircuitBreaker

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
            "openai": settings.openai,
            "anthropic": settings.anthropic,
            "vertex": settings.vertex,
            "lm-studio": settings.openai_compat,
            "openai_compat": settings.openai_compat,
            "vllm": settings.vllm,
            "llama-cpp": settings.llama_cpp,
        }
        # ResizableSemaphore, not asyncio.Semaphore: an admin changing
        # `maxConcurrent` must move the ceiling of the LIVE object rather than
        # swap in a new one (which would strand in-flight permits and waiters).
        from text.services.resizable_semaphore import ResizableSemaphore

        sems: dict[str, ResizableSemaphore] = {}
        for name in registry.list_providers():
            cfg = provider_configs.get(name)
            max_conc = getattr(cfg, "max_concurrent", 10) if cfg else 10
            sems[name] = ResizableSemaphore(max_conc)
        app.state.provider_semaphores = sems

    # The control-plane pull client. Construction performs NO I/O, so
    # boot never blocks on (or fails because of) the gateway; the first request
    # triggers the first fetch, and a failure negative-caches into env behaviour.
    if getattr(app.state, "effective_config_client", None) is None:
        from text.core.effective_config import EffectiveConfigClient

        app.state.effective_config_client = EffectiveConfigClient(
            base_url=settings.gateway_url,
            token=settings.service_token.get_secret_value(),
            service="text",
        )

    if app.state.shutdown_manager is None:
        from text.services.shutdown_manager import ShutdownManager

        app.state.shutdown_manager = ShutdownManager()

    # Async worker-pool dispatch queue (TASK-725) — cross-pod, Redis-Streams
    # backed; distinct from the in-process `provider_queues` above (see
    # services/worker_pool_queue.py module docstring). Constructed AFTER
    # `shutdown_manager` so submission can fail closed during drain (Task 6).
    if not hasattr(app.state, "worker_pool_queue") or app.state.worker_pool_queue is None:
        from text.services.worker_pool_queue import WorkerPoolQueue

        app.state.worker_pool_queue = WorkerPoolQueue(
            redis=redis_client, shutdown_manager=app.state.shutdown_manager
        )

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Reuses the shared `http_client` above (already
    # closed on shutdown below) rather than opening a second one.
    app.state.service_release_task = None
    try:
        app.state.service_release_task = start_registration(
            http_client=http_client,
            gateway_url=settings.gateway_url,
            service_token=settings.service_token.get_secret_value(),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.otel_deployment_environment,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("text.service_release_registration_failed", error=str(exc))

    logger.info("text.started", providers=registry.list_providers())
    yield

    shutdown_mgr = app.state.shutdown_manager
    if shutdown_mgr is not None:
        logger.info("text.draining_tasks", active=shutdown_mgr.active_count)
        timed_out = await shutdown_mgr.wait_for_shutdown(timeout=30.0)
        if timed_out:
            logger.warning("text.drain_timeout", remaining=shutdown_mgr.active_count)

    logger.info("text.shutting_down")
    await stop_registration(app.state.service_release_task)
    await http_client.aclose()
    if redis_client and hasattr(redis_client, "aclose"):
        try:
            await redis_client.aclose()
        except (ConnectionError, OSError, RuntimeError) as exc:
            logger.warning("redis.close_failed", error=str(exc))
        except Exception as exc:
            logger.error("redis.close_unexpected_error", error=str(exc))

    from text.core.observability import shutdown_opentelemetry

    shutdown_opentelemetry(app)

    logger.info("text.shutdown_complete")


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""
    settings = settings_override or get_settings()

    app = FastAPI(
        title="Text — Text Generation Service",
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
    app.state.translate_registry = None
    app.state.embedding_registry = None
    app.state.worker_pool_queue = None
    app.state.rate_limiters = {}
    app.state.circuit_breakers = {}
    app.state.provider_queues = {}
    app.state.shutdown_manager = None
    app.state.provider_semaphores = {}
    # Isolated resource budget for the INTERNAL judge lane
    # (`endpoints/judge.py`). Separate dicts, same classes — a saturated
    # user-facing pool must not starve a safety-plane judgement and a wedged
    # judgement must not consume the user-facing budget. Entries are created on
    # first use by the judge endpoint (there is no eager per-provider
    # preallocation: most providers are never judged with), so these start empty
    # here AND stay valid in tests that build the app without running lifespan.
    app.state.judge_semaphores = {}
    app.state.judge_circuit_breakers = {}
    # Eager, not lifespan-gated: it's a plain in-process cache (no I/O, no
    # event-loop dependency), and generate()'s degrade-routing check must see
    # a real tracker even in tests that build the app without running
    # lifespan (see core/dependencies.py::get_pool_health_tracker).
    from text.services.pool_health import PoolHealthTracker

    app.state.pool_health_tracker = PoolHealthTracker()
    # Control-plane overrides; empty ⇒ every provider keeps its env timeout.
    app.state.provider_timeouts = {}
    app.state.effective_config_client = None
    app.state.tracer_provider = None
    app.state.logger_provider = None

    from text.core.exception_handlers import register_exception_handlers

    register_exception_handlers(app)

    from text.api.middleware.auth import ServiceAuthMiddleware

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
    from text.api.middleware.logging import RequestLoggingMiddleware

    app.add_middleware(RequestLoggingMiddleware)

    from text.api.middleware.request_id import RequestIDMiddleware

    app.add_middleware(RequestIDMiddleware)

    from text.api.endpoints.embeddings import router as embeddings_router
    from text.api.endpoints.generate import router as generate_router
    from text.api.endpoints.health import router as health_router
    from text.api.endpoints.judge import router as judge_router
    from text.api.endpoints.providers import router as providers_router
    from text.api.endpoints.stream import router as stream_router
    from text.api.endpoints.tasks import router as tasks_router
    from text.api.endpoints.translate import router as translate_router
    from text.api.endpoints.worker_pools import router as worker_pools_router

    app.include_router(health_router, prefix="/api/v1")
    app.include_router(generate_router, prefix="/api/v1")
    # The internal judge lane. A SEPARATE route rather than a flag on
    # `/generate`, so the moderation bypass cannot be reached by shaping a public
    # request — see `endpoints/judge.py` and `services/judge_guard.py`.
    app.include_router(judge_router, prefix="/api/v1")
    app.include_router(tasks_router, prefix="/api/v1")
    app.include_router(providers_router, prefix="/api/v1")
    app.include_router(stream_router, prefix="/api/v1")
    app.include_router(translate_router, prefix="/api/v1")
    app.include_router(embeddings_router, prefix="/api/v1")
    app.include_router(worker_pools_router, prefix="/api/v1")

    if settings.otel_enabled:
        from text.core.observability import setup_opentelemetry

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
