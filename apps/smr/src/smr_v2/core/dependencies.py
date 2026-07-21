"""FastAPI dependency injection using app.state."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from fastapi import Request

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from smr_v2.core.config import Settings
    from smr_v2.core.effective_config import EffectiveConfigClient
    from smr_v2.providers.base import ProviderRegistry
    from smr_v2.services.circuit_breaker import CircuitBreaker
    from smr_v2.services.external_guardrail import ExternalGuardrailClient
    from smr_v2.services.generation_audit import GenerationAuditLogger
    from smr_v2.services.provider_queue import ProviderQueue
    from smr_v2.services.rate_limiter import RateLimitTracker
    from smr_v2.services.resizable_semaphore import ResizableSemaphore
    from smr_v2.services.shutdown_manager import ShutdownManager
    from smr_v2.services.task_manager import TaskManager


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


def get_generation_audit_logger(request: Request) -> GenerationAuditLogger:
    """Retrieve a GenerationAuditLogger instance."""
    from smr_v2.services.generation_audit import GenerationAuditLogger

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


def get_effective_config_client(request: Request) -> EffectiveConfigClient | None:
    """Retrieve the control-plane pull client from app.state (None if unwired)."""
    return getattr(request.app.state, "effective_config_client", None)


async def get_runtime_limits(request: Request) -> dict[str, int]:
    """Refresh control-plane limits (cached; cheap) and return timeout overrides.

    Used as a route dependency so limits track the control plane without a
    background poller. Never raises: a request must not fail because the config
    plane is unavailable — an absent override simply leaves the env value in force.
    """
    from smr_v2.services.runtime_limits import refresh_runtime_limits

    await refresh_runtime_limits(request.app.state)
    return getattr(request.app.state, "provider_timeouts", {}) or {}


def get_guardrail_client(request: Request) -> ExternalGuardrailClient | None:
    """Retrieve the external guardrail client from app.state (None if unwired)."""
    return getattr(request.app.state, "guardrail_client", None)
