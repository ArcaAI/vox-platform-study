"""FastAPI dependency injection for Guardrail service."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Depends, Request

if TYPE_CHECKING:
    import httpx
    import redis.asyncio as aioredis

    from guardrail.core.config import Settings
    from guardrail.providers.ollama import OllamaProvider
    from guardrail.providers.guardian import GuardianProvider
    from guardrail.services.job_processor import JobProcessor


def get_settings(request: Request) -> "Settings":
    """Retrieve settings from app.state (set during lifespan)."""
    return request.app.state.settings


def get_http_client(request: Request) -> "httpx.AsyncClient":
    """Retrieve shared httpx AsyncClient from app.state."""
    return request.app.state.http_client


def get_redis(request: Request) -> "aioredis.Redis":
    """Retrieve shared Redis client from app.state."""
    return request.app.state.redis


def get_ollama_provider(request: Request) -> "OllamaProvider":
    """Retrieve Ollama provider from app.state."""
    return request.app.state.ollama_provider


def get_guardian_provider(request: Request) -> "GuardianProvider":
    """Retrieve Guardian provider from app.state."""
    return request.app.state.guardian_provider


def get_job_processor(request: Request) -> "JobProcessor":
    """Retrieve job processor from app.state."""
    return request.app.state.job_processor
