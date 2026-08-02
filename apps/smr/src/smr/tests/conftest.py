"""Shared test fixtures for smr."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import TypeVar
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from smr.core.config import Settings
from smr.main import create_app

_C = TypeVar("_C")


def keyed(config: _C, key: str = "test-key") -> _C:
    """Return a copy of a cloud provider config with an explicit ``api_key``.

    TASK-602: the cloud configs (Azure OpenAI / OpenAI / Anthropic) are BYOK-only
    — ``api_key`` is no longer name- or env-populatable, so tests can no longer
    pass ``api_key=`` to the constructor. This mirrors exactly how the gateway/
    router applies a credential in production: ``model_copy(update=...)`` sets the
    field without re-opening a validation/env path. Use for any test that needs a
    provider built with a live platform key.
    """
    return config.model_copy(update={"api_key": SecretStr(key)})


@pytest.fixture
def settings() -> Settings:
    """Default test settings with all providers disabled."""
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        cors_origins=["http://localhost:8868/api/v1"],
    )


@pytest.fixture
def mock_redis():
    """Mock Redis client that responds to ping()."""
    redis = AsyncMock()
    redis.ping = AsyncMock(return_value=True)
    return redis


@pytest.fixture
def app(settings: Settings, mock_redis):
    """Create a test FastAPI app with mock Redis."""
    application = create_app()
    application.state.settings = settings
    application.state.redis = mock_redis
    return application


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client for testing endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
