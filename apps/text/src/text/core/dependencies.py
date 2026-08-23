"""FastAPI dependency injection using app.state."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from fastapi import Request

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from text.core.config import Settings
    from text.core.effective_config import EffectiveConfigClient
    from text.providers.base import ProviderRegistry
    from text.providers.embedding import EmbeddingProviderRegistry
    from text.services.circuit_breaker import CircuitBreaker
    from text.services.external_guardrail import ExternalGuardrailClient
    from text.services.generation_audit import GenerationAuditLogger
    from text.services.pool_health import PoolHealthTracker
    from text.services.provider_queue import ProviderQueue
    from text.services.rate_limiter import RateLimitTracker
    from text.services.resizable_semaphore import ResizableSemaphore
    from text.services.shutdown_manager import ShutdownManager
    from text.services.task_manager import TaskManager
    from text.services.worker_pool_queue import WorkerPoolQueue
    from text.translation.base import TranslateProviderRegistry


def get_settings(request: Request) -> Settings:
    """Retrieve settings from app.state (set during lifespan)."""
    return cast("Settings", request.app.state.settings)


def get_http_client(request: Request) -> httpx.AsyncClient:
    """Retrieve shared httpx AsyncClient from app.state."""
    return cast("httpx.AsyncClient", request.app.state.http_client)


def get_redis(request: Request) -> aioredis.Redis:
    """Retrieve shared Redis client from app.state."""
    return cast("aioredis.Redis", request.app.state.redis)


def get_provider_registry(request: Request) -> ProviderRegistry:
    """Retrieve provider registry from app.state."""
    return cast("ProviderRegistry", request.app.state.provider_registry)


def get_task_manager(request: Request) -> TaskManager:
    """Retrieve task manager from app.state."""
    return cast("TaskManager", request.app.state.task_manager)


def get_translate_registry(request: Request) -> TranslateProviderRegistry:
    """Retrieve the translate-provider registry from app.state."""
    return cast("TranslateProviderRegistry", request.app.state.translate_registry)


def get_generation_audit_logger(request: Request) -> GenerationAuditLogger:
    """Retrieve a GenerationAuditLogger instance."""
    from text.services.generation_audit import GenerationAuditLogger

    return GenerationAuditLogger()


def get_circuit_breakers(request: Request) -> dict[str, CircuitBreaker]:
    """Retrieve per-provider circuit breakers from app.state."""
    return cast("dict[str, CircuitBreaker]", request.app.state.circuit_breakers)


def get_shutdown_manager(request: Request) -> ShutdownManager | None:
    """Retrieve shutdown manager from app.state."""
    return cast("ShutdownManager | None", request.app.state.shutdown_manager)


def get_rate_limiters(request: Request) -> dict[str, RateLimitTracker]:
    """Retrieve per-provider rate limiters from app.state."""
    return getattr(request.app.state, "rate_limiters", {})


def get_provider_queues(request: Request) -> dict[str, ProviderQueue]:
    """Retrieve per-provider request queues from app.state."""
    return getattr(request.app.state, "provider_queues", {})


def get_provider_semaphores(request: Request) -> dict[str, ResizableSemaphore]:
    """Retrieve per-provider concurrency semaphores from app.state.

    These are `ResizableSemaphore`s whose capacity tracks the control
    plane. The objects are stable for the process's lifetime — never rebind an
    entry here, or in-flight permits and waiters are stranded.
    """

    return getattr(request.app.state, "provider_semaphores", {})


def get_judge_semaphores(request: Request) -> dict[str, ResizableSemaphore]:
    """Per-provider concurrency semaphores for the INTERNAL judge lane.

    A SEPARATE keyspace from ``provider_semaphores`` above, deliberately: the
    safety plane's judgement calls must not queue behind (or drain) the
    user-facing budget, and vice versa. Same objects, same rules — only the dict
    differs. Entries are created on first use by the judge endpoint, so a
    provider that no request has judged with yet is not preallocated.

    Materialised onto ``app.state`` when absent rather than returning a throwaway
    dict: a per-request dict would hand every judge call its OWN semaphore, which
    looks like it works and silently means no concurrency bound at all.
    """
    state = request.app.state
    if getattr(state, "judge_semaphores", None) is None:
        state.judge_semaphores = {}
    return cast("dict[str, ResizableSemaphore]", state.judge_semaphores)


def get_judge_circuit_breakers(request: Request) -> dict[str, CircuitBreaker]:
    """Per-provider circuit breakers for the INTERNAL judge lane.

    Separate instances from ``circuit_breakers``: a judge engine failing must not
    open the user-facing circuit for the same provider name, nor the reverse.

    Materialised onto ``app.state`` when absent — see ``get_judge_semaphores``.
    """
    state = request.app.state
    if getattr(state, "judge_circuit_breakers", None) is None:
        state.judge_circuit_breakers = {}
    return cast("dict[str, CircuitBreaker]", state.judge_circuit_breakers)


def get_effective_config_client(request: Request) -> EffectiveConfigClient | None:
    """Retrieve the control-plane pull client from app.state (None if unwired)."""
    return getattr(request.app.state, "effective_config_client", None)


async def get_runtime_limits(request: Request) -> dict[str, int]:
    """Refresh control-plane limits (cached; cheap) and return timeout overrides.

    Used as a route dependency so limits track the control plane without a
    background poller. Never raises: a request must not fail because the config
    plane is unavailable — an absent override simply leaves the env value in force.
    """
    from text.services.runtime_limits import refresh_runtime_limits

    await refresh_runtime_limits(request.app.state)
    return getattr(request.app.state, "provider_timeouts", {}) or {}


def get_app_state(request: Request) -> Any:
    """The live app state, for the values the control plane REPLACES at runtime.

    A route that reads a resolved posture or lane budget must read it when the
    request arrives, not when the process booted — that is the whole difference
    between a control-plane value and the env var it replaced.
    """
    return request.app.state


def get_guardrail_client(request: Request) -> ExternalGuardrailClient | None:
    """Retrieve the external guardrail client from app.state (None if unwired)."""
    return getattr(request.app.state, "guardrail_client", None)


def get_pool_health_tracker(request: Request) -> PoolHealthTracker:
    """Retrieve the degrade-routing health cache from app.state (TASK-725 Task 2).

    Always present (constructed eagerly in ``create_app()``, not lazily in
    ``lifespan``) so tests that build the app without running lifespan still
    get a valid, empty tracker rather than ``None`` — see
    ``services/pool_health.py``.
    """
    return cast("PoolHealthTracker", request.app.state.pool_health_tracker)


def get_embedding_registry(request: Request) -> EmbeddingProviderRegistry:
    """Retrieve the embedding-provider registry from app.state (TASK-725 Task 4)."""
    return cast("EmbeddingProviderRegistry", request.app.state.embedding_registry)


def get_worker_pool_queue(request: Request) -> WorkerPoolQueue:
    """Retrieve the async worker-pool dispatch queue from app.state (TASK-725)."""
    return cast("WorkerPoolQueue", request.app.state.worker_pool_queue)
