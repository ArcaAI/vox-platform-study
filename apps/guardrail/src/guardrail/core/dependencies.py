"""FastAPI dependency injection for Guardrail service."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Request

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from guardrail.core.config import Settings
    from guardrail.providers.gliner import GlinerProvider
    from guardrail.providers.guardian import GuardianProvider
    from guardrail.providers.ollama import OllamaProvider
    from guardrail.providers.openai_compat import (
        OpenAICompatGuardianProvider,
        OpenAICompatProvider,
    )
    from guardrail.services.job_processor import JobProcessor

    # The active content/guardian providers depend on the selected LLM engine.
    ContentProvider = OllamaProvider | OpenAICompatProvider
    GuardianLike = GuardianProvider | OpenAICompatGuardianProvider


def get_settings(request: Request) -> Settings:
    """Retrieve settings from app.state (set during lifespan)."""
    return request.app.state.settings


def get_http_client(request: Request) -> httpx.AsyncClient:
    """Retrieve shared httpx AsyncClient from app.state."""
    return request.app.state.http_client


def get_redis(request: Request) -> aioredis.Redis:
    """Retrieve shared Redis client from app.state."""
    return request.app.state.redis


def get_ollama_provider(request: Request) -> ContentProvider:
    """Retrieve the active content-analysis provider for the selected engine."""
    return request.app.state.ollama_provider


def get_guardian_provider(request: Request) -> GuardianLike:
    """Retrieve the env-configured guardian provider for the selected engine."""
    return request.app.state.guardian_provider


async def get_resolved_guardian_provider(request: Request) -> GuardianLike:
    """Resolve the guardian provider for the request tenant (TASK-338, Q3c).

    When ``db_config_enabled`` is false (default), this returns the env-configured
    guardian provider unchanged — behavior is identical to before. When enabled,
    it reads the per-tenant guardrail provider/model from ``core.GlobalSetting``
    (via the X-Tenant-Id header, with TTL cache + default-tenant/env fallback) and
    builds a guardian provider for the resolved engine.
    """
    settings = request.app.state.settings
    default_provider = request.app.state.guardian_provider

    if not settings.db.db_config_enabled:
        return default_provider

    resolver = getattr(request.app.state, "tenant_config_resolver", None)
    if resolver is None:
        return default_provider

    from guardrail.core.tenant_config import (
        build_guardian_provider,
        resolve_guardian_engine,
    )

    tenant_id = request.headers.get("X-Tenant-Id")
    tenant_cfg = await resolver.resolve(tenant_id)

    # Nothing admin-configured for this tenant (or its default) — keep env engine.
    if tenant_cfg.provider is None and tenant_cfg.model is None:
        return default_provider

    provider_name, engine_cfg = resolve_guardian_engine(settings, tenant_cfg)
    return build_guardian_provider(  # type: ignore[return-value]
        provider_name, engine_cfg, request.app.state.http_client
    )


def get_gliner_provider(request: Request) -> GlinerProvider:
    """Retrieve GLiNER provider from app.state."""
    return request.app.state.gliner_provider


def get_job_processor(request: Request) -> JobProcessor:
    """Retrieve job processor from app.state."""
    return request.app.state.job_processor
