"""Tests for main.py lifespan and create_app."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from text.core.config import Settings


@pytest.fixture
def settings():
    return Settings(port=5099, log_level="debug")


def collect_route_paths(app):
    """Return the effective HTTP route paths served by the app.

    FastAPI >= 0.139 includes routers lazily (``app.routes`` holds opaque
    ``_IncludedRouter`` wrappers instead of flattened ``APIRoute``s), so walk
    the OpenAPI schema — the public view of the effective routing table — and
    add any plain routes that are excluded from the schema.
    """
    paths = list(app.openapi()["paths"].keys())
    for route in app.routes:
        path = getattr(route, "path", None)
        if isinstance(path, str) and path not in paths:
            paths.append(path)
    return paths


class TestCreateApp:
    def test_creates_app_with_default_settings(self):
        from text.main import create_app

        app = create_app(settings_override=Settings())
        assert app.title == "Text — Text Generation Service"

    def test_creates_app_with_custom_settings(self, settings):
        from text.main import create_app

        app = create_app(settings_override=settings)
        assert app.state.settings.debug is True

    def test_app_registers_all_routers(self, settings):
        from text.main import create_app

        app = create_app(settings_override=settings)
        routes = collect_route_paths(app)
        assert "/api/v1/health" in routes
        assert "/api/v1/generate" in routes
        assert "/api/v1/providers" in routes

    def test_state_defaults_to_none(self, settings):
        from text.main import create_app

        app = create_app(settings_override=settings)
        assert app.state.redis is None
        assert app.state.task_manager is None
        assert app.state.provider_registry is None

    def test_metrics_is_always_exposed(self):
        """`TEXT_METRICS_ENABLED` is gone — `/metrics` is scrape-only, carries no
        PHI, and an observability surface that can be switched off from an env
        file is a gap nobody notices until they need it."""
        from text.core.config import Settings as _Settings
        from text.main import create_app

        assert "metrics_enabled" not in _Settings.model_fields
        app = create_app(settings_override=Settings())
        assert "/metrics" in collect_route_paths(app)

    def test_metrics_enabled_when_true(self):
        from text.main import create_app

        s = Settings()
        app = create_app(settings_override=s)
        routes = collect_route_paths(app)
        assert "/metrics" in routes


class TestLifespan:
    @pytest.mark.asyncio
    async def test_lifespan_initializes_resources(self, settings):
        """Verify lifespan sets http_client, redis, task_manager, provider_registry on app.state."""
        from text.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()

        with patch("text.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)

            async with app.router.lifespan_context(app):
                assert app.state.http_client is not None
                assert app.state.task_manager is not None
                assert app.state.provider_registry is not None

    @pytest.mark.asyncio
    async def test_lifespan_registers_lm_studio_compatibility_alias(self):
        # both keys are AVAILABLE from the connection-gated lazy factory
        # (LM Studio always has a default base_url), and resolving either key builds
        # and shares ONE instance.
        from text.main import create_app

        settings = Settings(port=5099, log_level="debug")
        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()

        with patch("text.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)

            async with app.router.lifespan_context(app):
                registry = app.state.provider_registry
                assert "openai_compat" in registry.list_providers()
                assert "lm-studio" in registry.list_providers()
                # Lazy: not built until first resolution.
                assert registry.is_instantiated("lm-studio") is False
                assert registry.get("lm-studio") is registry.get("openai_compat")

    @pytest.mark.asyncio
    async def test_lifespan_preserves_injected_state(self, settings):
        """When task_manager/registry are pre-set (in tests), lifespan should not overwrite them."""
        from text.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()
        from text.providers.base import ProviderRegistry

        sentinel_tm = object()
        sentinel_reg = ProviderRegistry()

        with patch("text.main.aioredis") as mock_aioredis:
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
        from text.main import create_app

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()

        with patch("text.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)

            async with app.router.lifespan_context(app):
                http_client = app.state.http_client

        assert http_client.is_closed
