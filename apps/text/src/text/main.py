"""Text — Text Generation Service.

FastAPI application with lifespan-managed shared resources.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration

from text.core.config import Settings, get_settings
from text.core.logging import get_logger, setup_logging
from text.core.runtime_defaults import (
    HTTPX_MAX_CONNECTIONS,
    HTTPX_MAX_KEEPALIVE,
    PROVIDER_RPM_FLOOR,
    PROVIDER_TPM_FLOOR,
    TASK_STREAM_MAX_LEN,
    TASK_TTL_S,
    USER_LANE_FLOOR,
)

if TYPE_CHECKING:
    from text.providers.base import LLMProvider, ProviderRegistry

logger = get_logger(__name__)


def _register_provider_factories(
    registry: ProviderRegistry, http_client: httpx.AsyncClient
) -> None:
    """Register LAZY provider factories — one per adapter, unconditionally.

    Availability used to be gated on "is this provider's ``base_url`` non-empty",
    which meant an ENV VAR decided which providers existed. That is backwards in
    two ways at once: it made a pure-BYOK tenant's provider 404 because the
    PLATFORM had no endpoint (fixed for the cloud four, still true for the local
    engines), and it made a provider's existence un-reconfigurable without a
    redeploy.

    A provider is available iff a CONNECTION resolves for it — and since Text is
    stateless, that resolution happens per request, not at boot. So registration
    is unconditional and resolution is fail-closed at call time
    (`core/connection.py`): a request naming a provider with no resolved
    connection gets a typed 503 that names the missing `AiProviderConnection`
    row, instead of a 404 that says the provider does not exist.

    The (network/SDK-bearing) instance is still built on the first request that
    selects it (``registry.get``), never at startup.
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

    from text.providers.anthropic import AnthropicProvider
    from text.providers.azure_openai import AzureOpenAIProvider
    from text.providers.bedrock import BedrockProvider
    from text.providers.llama_cpp import LlamaCppProvider
    from text.providers.lmstudio import LMStudioProvider
    from text.providers.ollama import OllamaProvider
    from text.providers.openai import OpenAIProvider
    from text.providers.openai_compat import OpenAICompatProvider
    from text.providers.vertex import VertexProvider
    from text.providers.vllm import VllmProvider

    # LM Studio — a FIRST-CLASS engine with its own adapter, not an alias of the
    # generic OpenAI-wire one. These two keys used to share ONE instance built
    # with the DEFAULT `provider_name`, so a request that said `lm-studio` was
    # served by an object that reported `openai_compat`, never sent LM Studio's
    # `ttl` retention hint, and forced the native `/api/v0/models` probe to be
    # widened onto generic endpoints to stay reachable at all.
    #
    # `openai_compat` REMAINS registered and generic: it is the portability
    # adapter for any other OpenAI-wire server (TGI, Groq, a `llama-server` on
    # its `/v1` surface), and it must never be handed LM Studio's non-standard
    # body fields.
    _register(("lm-studio",), _shared(LMStudioProvider))
    _register(("openai_compat",), _shared(OpenAICompatProvider))
    _register(("ollama",), lambda: OllamaProvider(http_client))
    _register(("bedrock",), _shared(BedrockProvider))
    _register(("azure-openai", "azure"), _shared(AzureOpenAIProvider))
    _register(("openai",), _shared(OpenAIProvider))
    _register(("anthropic",), _shared(AnthropicProvider))
    _register(("vertex",), _shared(VertexProvider))
    _register(("vllm",), lambda: VllmProvider(http_client))
    _register(("llama-cpp",), lambda: LlamaCppProvider(http_client))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage shared resources: httpx client, Redis, providers."""
    settings: Settings = app.state.settings

    setup_logging(settings.log_level)

    logger.info("text.starting", port=settings.port, environment=settings.node_env)

    http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=HTTPX_MAX_CONNECTIONS,
            max_keepalive_connections=HTTPX_MAX_KEEPALIVE,
        ),
        timeout=httpx.Timeout(300.0),
    )
    app.state.http_client = http_client

    if not hasattr(app.state, "redis") or app.state.redis is None:
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        app.state.redis = redis_client
    else:
        redis_client = app.state.redis

    if not hasattr(app.state, "task_manager") or app.state.task_manager is None:
        from text.services.task_manager import TaskManager

        app.state.task_manager = TaskManager(
            redis=redis_client,
            task_ttl=TASK_TTL_S,
            stream_max_len=TASK_STREAM_MAX_LEN,
        )

    # External Guardrail client — invoked per generate to
    # validate medical content. Degrade-safe → fail-CLOSED posture is
    # enforced inside the client (bounded retry, then a not-allowed verdict).
    if not hasattr(app.state, "guardrail_client") or app.state.guardrail_client is None:
        from text.services.external_guardrail import ExternalGuardrailClient

        app.state.guardrail_client = ExternalGuardrailClient(
            base_url=settings.external_guardrail.base_url,
            http_client=http_client,
            # Owner decision D-D: PRESENT the one shared `INTERNAL_ACCESS_TOKEN`.
            service_token=settings.peer_service_token(),
            app_state=app.state,
        )
        logger.info(
            "text.guardrail_client_initialized",
            base_url=settings.external_guardrail.base_url,
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
    _register_provider_factories(registry, http_client)

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

        translate_registry.register_factory("sarvam", SarvamTranslateProvider)

    # Embedding capability (TASK-725 Task 4) — a SEPARATE registry namespace
    # from the LLM `provider_registry` above (design-notes.md §(a)). Registration
    # is unconditional because the registry is LAZY — registering a name costs
    # nothing and opens no connection. `tei-embed` carries NO default endpoint:
    # like every self-hosted adapter it is fail-closed on a caller-supplied
    # base_url (`providers/tei_embed.py` → `require_base_url`).
    if not hasattr(app.state, "embedding_registry") or app.state.embedding_registry is None:
        from text.providers.embedding import EmbeddingProviderRegistry

        app.state.embedding_registry = EmbeddingProviderRegistry()

    embedding_registry = app.state.embedding_registry
    if "tei-embed" not in embedding_registry.list_providers():
        from text.providers.tei_embed import TeiEmbedProvider

        embedding_registry.register_factory("tei-embed", lambda: TeiEmbedProvider(http_client))

    # Companion per-provider state. Every one of these used to be seeded from a
    # per-provider env block; they now start at the resource-safety FLOOR
    # (`core/runtime_defaults.py`) and are moved to their real values by the
    # control plane on the first effective-config refresh
    # (`services/runtime_limits.py`). A gateway that never answers leaves the
    # floors in place, which is the documented degraded posture.
    from text.services.rate_limiter import RateLimitTracker

    app.state.rate_limiters = {
        name: RateLimitTracker(rpm_limit=PROVIDER_RPM_FLOOR, tpm_limit=PROVIDER_TPM_FLOOR)
        for name in registry.list_providers()
    }

    if not app.state.provider_queues:
        from text.services.provider_queue import ProviderQueue

        app.state.provider_queues = {
            name: ProviderQueue(max_size=USER_LANE_FLOOR.queue_max_size)
            for name in registry.list_providers()
        }

    if not app.state.circuit_breakers:
        from text.services.circuit_breaker import CircuitBreaker

        app.state.circuit_breakers = {
            name: CircuitBreaker(
                failure_threshold=USER_LANE_FLOOR.failure_threshold,
                recovery_timeout=USER_LANE_FLOOR.recovery_timeout_s,
                half_open_max_calls=USER_LANE_FLOOR.half_open_max_calls,
                reset_timeout_s=USER_LANE_FLOOR.reset_timeout_s,
                count_rate_limits=USER_LANE_FLOOR.count_rate_limits,
            )
            for name in registry.list_providers()
        }

    if not app.state.provider_semaphores:
        # ResizableSemaphore, not asyncio.Semaphore: an admin changing
        # `maxConcurrent` must move the ceiling of the LIVE object rather than
        # swap in a new one (which would strand in-flight permits and waiters).
        from text.services.resizable_semaphore import ResizableSemaphore

        app.state.provider_semaphores = {
            name: ResizableSemaphore(USER_LANE_FLOOR.max_concurrent)
            for name in registry.list_providers()
        }

    # The control-plane pull client. Construction performs NO I/O, so
    # boot never blocks on (or fails because of) the gateway; the first request
    # triggers the first fetch, and a failure negative-caches into env behaviour.
    if getattr(app.state, "effective_config_client", None) is None:
        from text.core.effective_config import EffectiveConfigClient

        app.state.effective_config_client = EffectiveConfigClient(
            base_url=settings.gateway_url,
            # Owner decision D-D: PRESENT the one shared `INTERNAL_ACCESS_TOKEN`.
            # Sending an empty token 401s the gateway, the failure is
            # negative-cached, and the pod silently degrades to its floors with
            # one warning per minute — so this must never be the legacy field.
            token=settings.peer_service_token(),
            service="text",
        )

    # Push invalidation for that client. Rule 09 §"Config caches":
    # invalidation is the propagation path, the TTL is only a bounded-staleness
    # backstop — before this, a control-plane write took up to 60s to be seen
    # here. The task never raises (every failure degrades to the TTL), so it is
    # safe to start unconditionally.
    app.state.config_invalidation_task = asyncio.create_task(
        app.state.effective_config_client.run_invalidation_listener(redis_client)
    )

    if app.state.shutdown_manager is None:
        from text.services.shutdown_manager import ShutdownManager

        app.state.shutdown_manager = ShutdownManager()

    # Self-registration: fire-and-forget, bounded-timeout, NEVER
    # blocks or fails boot. Reuses the shared `http_client` above (already
    # closed on shutdown below) rather than opening a second one.
    app.state.service_release_task = None
    try:
        app.state.service_release_task = start_registration(
            http_client=http_client,
            gateway_url=settings.gateway_url,
            # D-D, as above: the shared token first, legacy only as fallback.
            service_token=settings.peer_service_token(),
            build_info=BuildInfoReader().get_build_info(),
            environment=settings.otel_deployment_environment,
        )
    except Exception as exc:  # noqa: BLE001 - registration must never block boot
        logger.warning("text.service_release_registration_failed", error=str(exc))

    logger.info("text.started", providers=registry.list_providers())
    yield

    # TASK-818 Lane B: drain generation producers FIRST, and before the redis
    # client closes below — a producer still coalescing its final batch needs the
    # replay buffer to write to, or the tail of a generation a client could still
    # resume is lost. Producers also register with `shutdown_manager`, so this is
    # a refinement of the drain below rather than the only one.
    generation_hub = getattr(app.state, "generation_hub", None)
    if generation_hub is not None:
        with contextlib.suppress(Exception):
            await generation_hub.drain(timeout=30.0)

    shutdown_mgr = app.state.shutdown_manager
    if shutdown_mgr is not None:
        logger.info("text.draining_tasks", active=shutdown_mgr.active_count)
        timed_out = await shutdown_mgr.wait_for_shutdown(timeout=30.0)
        if timed_out:
            logger.warning("text.drain_timeout", remaining=shutdown_mgr.active_count)

    logger.info("text.shutting_down")

    invalidation_task = getattr(app.state, "config_invalidation_task", None)
    if invalidation_task is not None:
        invalidation_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await invalidation_task

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

    # TASK-818 Lane B: the generation hub owns producers that deliberately
    # OUTLIVE the HTTP response subscribed to them — that is what makes a
    # reconnect resumable. Constructed eagerly for the same reason as the tracker
    # above (no I/O, and tests build the app without lifespan), and drained on
    # shutdown below so a rolling restart does not abandon in-flight producers.
    from text.routing.hub import GenerationHub

    app.state.generation_hub = GenerationHub()
    # Control-plane overrides; empty ⇒ every provider keeps its safety floor.
    app.state.provider_timeouts = {}
    # `(provider, lane)` -> served budget overrides; empty ⇒ the lane floors.
    app.state.lane_budgets = {}
    # The platform input-moderation posture; replaced on the first refresh.
    app.state.guardrail_posture = None
    app.state.effective_config_client = None
    app.state.config_invalidation_task = None
    app.state.tracer_provider = None
    app.state.logger_provider = None

    from text.core.exception_handlers import register_exception_handlers

    register_exception_handlers(app)

    from text.api.middleware.auth import ServiceAuthMiddleware

    app.add_middleware(ServiceAuthMiddleware)
    # No CORS middleware. Text is an INTERNAL service: every browser-facing call
    # reaches it through the gateway (`.claude/rules/06-python-services.md`
    # §"Gateway Integration"), which owns the browser's origin policy. The
    # `TEXT_CORS_ENABLED` / `TEXT_CORS_ORIGINS` pair defaulted to off and no
    # deployment ever turned it on; keeping it would leave a way to widen a PHI
    # service's origin policy from an env file.

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

    if settings.otel_enabled:
        from text.core.observability import setup_opentelemetry

        setup_opentelemetry(
            app,
            endpoint=settings.otel_exporter_endpoint,
            service_name=settings.otel_service_name,
            service_namespace=settings.otel_service_namespace,
            deployment_environment=settings.otel_deployment_environment,
            insecure=settings.otel_insecure,
            logs_enabled=True,
        )

    # Prometheus is always exposed. `/metrics` is scrape-only and carries no PHI,
    # and a metrics endpoint that can be switched off from an env file is an
    # observability gap nobody notices until they need it.
    from prometheus_fastapi_instrumentator import Instrumentator

    Instrumentator().instrument(app).expose(app, endpoint="/metrics")

    return app


app = create_app()
