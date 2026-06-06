"""Shared test fixtures for the harness service."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from harness.core.config import Settings
from harness.main import create_app


@pytest.fixture
def settings() -> Settings:
    """Default test settings (process-local, no external dependencies)."""
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
    )


@pytest.fixture
def app(settings: Settings):
    """Create a test FastAPI app."""
    return create_app(settings_override=settings)


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client bound to the ASGI app for endpoint tests."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
