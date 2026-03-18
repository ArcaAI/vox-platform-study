"""Integration test fixtures — real Redis (fakeredis), mock providers, full app.

Every fixture creates a fully wired FastAPI app with:
- fakeredis.aioredis.FakeRedis for Redis (supports Lua scripts)
- Mock LLM providers that implement the LLMProvider protocol
- Full middleware stack (auth, request-id, logging)
- Real TaskManager backed by fakeredis
"""

from __future__ import annotations

import asyncio
from typing import AsyncGenerator

import fakeredis.aioredis
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.main import create_app
from smr_v2.models.provider import ProviderInfo
from smr_v2.models.stream import StreamChunk
from smr_v2.providers.base import ProviderRegistry
from smr_v2.services.task_manager import TaskManager


class MockProvider:
    """Mock LLM provider that satisfies the LLMProvider protocol."""

    def __init__(
        self,
        *,
        content: str = "Mock response",
        fail: bool = False,
        slow: bool = False,
    ) -> None:
        self._content = content
        self._fail = fail
        self._slow = slow

    async def generate(self, request):
        if self._fail:
            raise RuntimeError("Provider failed")
        if self._slow:
            await asyncio.sleep(0.5)
        return self._content, {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        }

    async def generate_stream(self, request):
        if self._fail:
            raise RuntimeError("Provider stream failed")
        for word in self._content.split():
            yield StreamChunk(type="chunk", content=word + " ")
        yield StreamChunk(
            type="usage",
            data={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    async def health_check(self) -> bool:
        return not self._fail

    async def get_info(self) -> ProviderInfo:
        return ProviderInfo(
            name="mock",
            display_name="Mock Provider",
            status="available",
            default_model="mock-model",
        )


class FailingMockProvider(MockProvider):
    """Provider that always fails — for error-path tests."""

    def __init__(self) -> None:
        super().__init__(fail=True)

    async def get_info(self) -> ProviderInfo:
        return ProviderInfo(
            name="mock_fail",
            display_name="Failing Mock",
            status="unavailable",
            default_model="mock-model",
        )


@pytest.fixture
def integration_settings() -> Settings:
    """Settings tuned for integration tests: auth disabled, guardrails off, metrics off."""
    return Settings(
        guardrail_enabled=False,
        guardrail_mode="log",
        metrics_enabled=False,
        otel_enabled=False,
    )


@pytest.fixture
def guardrail_settings() -> Settings:
    """Settings with guardrails in block mode."""
    return Settings(
        guardrail_enabled=True,
        guardrail_mode="block",
        metrics_enabled=False,
        otel_enabled=False,
    )


@pytest_asyncio.fixture
async def redis_client() -> AsyncGenerator:
    """Standalone fakeredis client shared across fixtures for direct assertions."""
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    yield client
    await client.aclose()


def _wire_app(
    settings: Settings,
    redis,
    *,
    extra_providers: dict | None = None,
) -> tuple:
    """Create a fully wired app, injecting Redis and providers before lifespan."""
    app = create_app(settings_override=settings)

    registry = ProviderRegistry()
    registry.register("mock", MockProvider())
    if extra_providers:
        for name, prov in extra_providers.items():
            registry.register(name, prov)

    app.state.redis = redis
    app.state.provider_registry = registry
    app.state.task_manager = TaskManager(
        redis=redis, task_ttl=3600, stream_max_len=10_000
    )

    return app, registry


@pytest_asyncio.fixture
async def integration_client(
    integration_settings: Settings, redis_client
) -> AsyncGenerator:
    """Yield (AsyncClient, app) with healthy mock provider."""
    app, _ = _wire_app(integration_settings, redis_client)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, app


@pytest_asyncio.fixture
async def integration_app_with_failing_provider(
    integration_settings: Settings,
) -> AsyncGenerator:
    """Yield (AsyncClient, app, redis) with only a failing provider."""
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    app, _ = _wire_app(
        integration_settings,
        redis,
        extra_providers={"mock_fail": FailingMockProvider()},
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, app, redis
    await redis.aclose()


@pytest_asyncio.fixture
async def integration_client_with_guardrails(
    guardrail_settings: Settings,
) -> AsyncGenerator:
    """Yield (AsyncClient, app) with guardrails in block mode."""
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    app, _ = _wire_app(guardrail_settings, redis)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, app
    await redis.aclose()
