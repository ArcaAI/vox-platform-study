"""Shared test fixtures for smr_v2."""

from __future__ import annotations

import asyncio
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.main import create_app


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
def app(settings: Settings):
    """Create a test FastAPI app."""
    application = create_app()
    application.state.settings = settings
    return application


@pytest_asyncio.fixture
async def async_client(app) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client for testing endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
