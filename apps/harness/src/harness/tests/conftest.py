"""Shared test fixtures for the harness service."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from harness.core.config import Settings
from harness.main import create_app


@pytest.fixture(autouse=True)
def _llm_governor_test_defaults(monkeypatch):
    """Neutralise the per-endpoint LLM governor for the unit suite.

    Production defaults add bounded rate-limit-aware retry + backoff to every LLM
    client; in unit tests a mocked 5xx is now "transient", so without this the
    existing client failure-path cases would retry+sleep for seconds. Force a single
    attempt with no backoff and a high concurrency cap so client tests behave exactly
    as before, and reset the (loop-bound) per-endpoint semaphores between tests. Tests
    that *specifically* exercise the governor pass an explicit ``config=`` (see
    ``tests/unit/core/test_llm_concurrency.py``) or set ``HARNESS_LLM_*`` themselves.
    """
    from harness.core.llm_concurrency import reset_endpoint_limiters

    monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_BASE_S", "0")
    monkeypatch.setenv("HARNESS_LLM_BACKOFF_JITTER_S", "0")
    monkeypatch.setenv("HARNESS_LLM_MAX_CONCURRENCY", "8")
    reset_endpoint_limiters()
    yield
    reset_endpoint_limiters()


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
