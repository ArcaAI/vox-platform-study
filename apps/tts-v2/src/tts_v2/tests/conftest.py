"""Shared test fixtures for tts_v2."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts_v2.core.config import Settings
from tts_v2.main import create_app


@pytest.fixture
def settings() -> Settings:
    """Default test settings (auth disabled)."""
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def app(settings: Settings):
    """Create a test FastAPI app."""
    return create_app(settings_override=settings)


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client bound to the test app via ASGI transport."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
