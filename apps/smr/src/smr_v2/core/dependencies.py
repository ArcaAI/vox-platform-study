"""FastAPI dependency injection using app.state."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Depends, Request

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from smr_v2.core.config import Settings
    from smr_v2.providers.base import ProviderRegistry
    from smr_v2.services.audit import GuardrailAuditLogger
    from smr_v2.services.generation_audit import GenerationAuditLogger
    from smr_v2.services.circuit_breaker import CircuitBreaker
    from smr_v2.services.guardrails import PromptInjectionScanner
    from smr_v2.services.provider_queue import ProviderQueue
    from smr_v2.services.rate_limiter import RateLimitTracker
    from smr_v2.services.shutdown_manager import ShutdownManager
    from smr_v2.services.task_manager import TaskManager


def get_settings(request: Request) -> "Settings":
    """Retrieve settings from app.state (set during lifespan)."""
    return request.app.state.settings


def get_http_client(request: Request) -> "httpx.AsyncClient":
    """Retrieve shared httpx AsyncClient from app.state."""
    return request.app.state.http_client


def get_redis(request: Request) -> "aioredis.Redis":
    """Retrieve shared Redis client from app.state."""
    return request.app.state.redis


def get_provider_registry(request: Request) -> "ProviderRegistry":
    """Retrieve provider registry from app.state."""
    return request.app.state.provider_registry


def get_task_manager(request: Request) -> "TaskManager":
    """Retrieve task manager from app.state."""
    return request.app.state.task_manager


def get_guardrail_scanner(request: Request) -> "PromptInjectionScanner":
    """Create a PromptInjectionScanner from current settings."""
    from smr_v2.services.guardrails import PromptInjectionScanner as Scanner

    settings = request.app.state.settings
    return Scanner(
        enabled=settings.guardrail_enabled,
        mode=settings.guardrail_mode,
    )


def get_audit_logger(request: Request) -> "GuardrailAuditLogger":
    """Retrieve a GuardrailAuditLogger instance."""
    from smr_v2.services.audit import GuardrailAuditLogger

    return GuardrailAuditLogger()


def get_generation_audit_logger(request: Request) -> "GenerationAuditLogger":
    """Retrieve a GenerationAuditLogger instance."""
    from smr_v2.services.generation_audit import GenerationAuditLogger

    return GenerationAuditLogger()


def get_circuit_breakers(request: Request) -> dict[str, "CircuitBreaker"]:
    """Retrieve per-provider circuit breakers from app.state."""
    return request.app.state.circuit_breakers


def get_shutdown_manager(request: Request) -> "ShutdownManager | None":
    """Retrieve shutdown manager from app.state."""
    return request.app.state.shutdown_manager


def get_rate_limiters(request: Request) -> dict[str, "RateLimitTracker"]:
    """Retrieve per-provider rate limiters from app.state."""
    return getattr(request.app.state, "rate_limiters", {})


def get_provider_queues(request: Request) -> dict[str, "ProviderQueue"]:
    """Retrieve per-provider request queues from app.state."""
    return getattr(request.app.state, "provider_queues", {})


def get_provider_semaphores(request: Request) -> dict[str, "asyncio.Semaphore"]:
    """Retrieve per-provider concurrency semaphores from app.state."""
    import asyncio  # noqa: F811

    return getattr(request.app.state, "provider_semaphores", {})
