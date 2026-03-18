"""Tests for main.py lifespan and create_app."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=False)


class TestCreateApp:
    def test_creates_app_with_default_settings(self):
        from smr_v2.main import create_app
        app = create_app(settings_override=Settings())
        assert app.title == "SMR V2 — Text Generation Service"

    def test_creates_app_with_custom_settings(self, settings):
        from smr_v2.main import create_app
        app = create_app(settings_override=settings)
        assert app.state.settings.debug is True

    def test_app_registers_all_routers(self, settings):
        from smr_v2.main import create_app
        app = create_app(settings_override=settings)
        routes = [r.path for r in app.routes]
        assert "/api/v1/health" in routes
        assert "/api/v1/generate" in routes
        assert "/api/v1/providers" in routes

    def test_state_defaults_to_none(self, settings):
        from smr_v2.main import create_app
        app = create_app(settings_override=settings)
        assert app.state.redis is None
        assert app.state.task_manager is None
        assert app.state.provider_registry is None

    def test_metrics_disabled_when_false(self):
        from smr_v2.main import create_app
        s = Settings(metrics_enabled=False)
        app = create_app(settings_override=s)
        routes = [r.path for r in app.routes]
        assert "/metrics" not in routes

    def test_metrics_enabled_when_true(self):
        from smr_v2.main import create_app
        s = Settings(metrics_enabled=True)
        app = create_app(settings_override=s)
        routes = [r.path for r in app.routes]
        assert "/metrics" in routes


class TestLifespan:
    @pytest.mark.asyncio
    async def test_lifespan_initializes_resources(self, settings):
        """Verify lifespan sets http_client, redis, task_manager, provider_registry on app.state."""
        from smr_v2.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()

        with patch("smr_v2.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)

            async with app.router.lifespan_context(app):
                assert app.state.http_client is not None
                assert app.state.task_manager is not None
                assert app.state.provider_registry is not None

    @pytest.mark.asyncio
    async def test_lifespan_preserves_injected_state(self, settings):
        """When task_manager/registry are pre-set (in tests), lifespan should not overwrite them."""
        from smr_v2.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()
        from smr_v2.providers.base import ProviderRegistry
        sentinel_tm = object()
        sentinel_reg = ProviderRegistry()

        with patch("smr_v2.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)
            app.state.redis = mock_redis
            app.state.task_manager = sentinel_tm
            app.state.provider_registry = sentinel_reg

            async with app.router.lifespan_context(app):
                assert app.state.task_manager is sentinel_tm
                assert app.state.provider_registry is sentinel_reg

    @pytest.mark.asyncio
    async def test_lifespan_cleanup_closes_http_client(self, settings):
        """Verify http_client.aclose() is called on shutdown."""
        from smr_v2.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()

        with patch("smr_v2.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)

            async with app.router.lifespan_context(app):
                http_client = app.state.http_client

        assert http_client.is_closed
