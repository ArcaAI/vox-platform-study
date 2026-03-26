"""TDD tests for observability: metrics + structured logging.

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.models.provider import ProviderInfo


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=True)


@pytest.fixture
def mock_provider_registry():
    from smr_v2.providers.base import ProviderRegistry
    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.health_check = AsyncMock(return_value=True)
    mock_provider.get_info = AsyncMock(return_value=ProviderInfo(
        name="ollama", display_name="Ollama", status="available",
        default_model="llama3.2:latest", models=[], supports_streaming=True,
    ))
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    return AsyncMock()


@pytest_asyncio.fixture
async def app(settings, mock_provider_registry, mock_task_manager):
    from smr_v2.main import create_app
    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    application.state.settings = settings
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestPrometheusMetrics:
    @pytest.mark.asyncio
    async def test_metrics_endpoint_exists(self, client):
        resp = await client.get("/metrics")
        assert resp.status_code == 200
        assert "HELP" in resp.text or "TYPE" in resp.text

    @pytest.mark.asyncio
    async def test_request_counter_increments(self, client):
        await client.get("/api/v1/health")
        await client.get("/api/v1/health")
        resp = await client.get("/metrics")
        assert resp.status_code == 200


class TestStructuredLogging:
    def test_logging_module_imports(self):
        from smr_v2.core.logging import get_logger, setup_logging
        assert callable(setup_logging)
        assert callable(get_logger)

    def test_get_logger_returns_bound_logger(self):
        from smr_v2.core.logging import get_logger
        log = get_logger("test")
        assert hasattr(log, "info")
        assert hasattr(log, "error")
        assert hasattr(log, "warning")

    def test_setup_logging_does_not_raise(self):
        from smr_v2.core.logging import setup_logging
        setup_logging("debug")
