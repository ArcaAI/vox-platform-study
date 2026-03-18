"""TDD tests for TASK-240 — provider key consistency.

Ensures the SMR runtime uses tenant-facing provider keys
(azure-openai, lm-studio) instead of internal-only keys (azure, openai_compat).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


class TestProviderRegistryTenantKeys:
    """Registry should accept and resolve tenant-facing provider keys."""

    def test_registry_accepts_azure_openai_key(self):
        from smr_v2.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("azure-openai", mock_provider)
        assert "azure-openai" in registry.list_providers()
        assert registry.get("azure-openai") is mock_provider

    def test_registry_accepts_lm_studio_key(self):
        from smr_v2.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("lm-studio", mock_provider)
        assert "lm-studio" in registry.list_providers()
        assert registry.get("lm-studio") is mock_provider


class TestProviderTimeoutMapping:
    """Timeout resolution should use provider-specific config, not the global default."""

    def test_azure_openai_timeout_uses_azure_config(self):
        from smr_v2.api.endpoints.generate import _get_provider_timeout
        from smr_v2.core.config import Settings

        settings = Settings(
            _env_file=None,
            host="0.0.0.0",
            port=8862,
        )
        timeout = _get_provider_timeout(settings, "azure-openai")
        assert timeout == float(settings.azure.timeout_s), (
            f"azure-openai should use azure config timeout ({settings.azure.timeout_s}), "
            f"got {timeout}"
        )

    def test_lm_studio_timeout_uses_openai_compat_config(self):
        from smr_v2.api.endpoints.generate import _get_provider_timeout
        from smr_v2.core.config import Settings

        settings = Settings(
            _env_file=None,
            host="0.0.0.0",
            port=8862,
        )
        timeout = _get_provider_timeout(settings, "lm-studio")
        assert timeout == float(settings.openai_compat.timeout_s), (
            f"lm-studio should use openai_compat config timeout ({settings.openai_compat.timeout_s}), "
            f"got {timeout}"
        )


class TestMainLifespanProviderKeys:
    """Lifespan should register providers under tenant-facing keys."""

    def test_azure_provider_registered_as_azure_openai(self):
        """When azure is enabled, it should be registered as 'azure-openai'."""
        from smr_v2.core.config import Settings

        settings = Settings(
            _env_file=None,
            host="0.0.0.0",
            port=8862,
        )
        if settings.azure.enabled:
            from smr_v2.main import create_app

            app = create_app(settings)
            registry = app.state.provider_registry
            if registry is not None:
                providers = registry.list_providers()
                assert "azure" not in providers, (
                    "Provider should be registered as 'azure-openai', not 'azure'"
                )

    def test_openai_compat_registered_as_lm_studio(self):
        """When openai_compat is enabled, it should be registered as 'lm-studio'."""
        from smr_v2.core.config import Settings

        settings = Settings(
            _env_file=None,
            host="0.0.0.0",
            port=8862,
        )
        if settings.openai_compat.enabled:
            from smr_v2.main import create_app

            app = create_app(settings)
            registry = app.state.provider_registry
            if registry is not None:
                providers = registry.list_providers()
                assert "openai_compat" not in providers, (
                    "Provider should be registered as 'lm-studio', not 'openai_compat'"
                )


class TestGenerateEndpointWithTenantKeys:
    """Generate endpoint should resolve providers using tenant-facing keys."""

    @pytest.fixture
    def mock_provider(self):
        provider = AsyncMock()
        provider.generate = AsyncMock(
            return_value=("Generated text", {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
            })
        )
        return provider

    @pytest.fixture
    def mock_registry(self, mock_provider):
        registry = MagicMock()
        registry.get.return_value = mock_provider
        return registry

    @pytest.fixture
    def mock_task_manager(self):
        tm = AsyncMock()
        task_state = MagicMock()
        task_state.task_id = "test-task-240"
        tm.create_task = AsyncMock(return_value=task_state)
        tm.update_task = AsyncMock()
        return tm

    @pytest.fixture
    def app(self, mock_registry, mock_task_manager):
        from smr_v2.main import create_app

        application = create_app()
        application.state.provider_registry = mock_registry
        application.state.task_manager = mock_task_manager
        return application

    @pytest_asyncio.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_generate_with_azure_openai_provider(self, client, mock_registry):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "summarize this", "provider": "azure-openai"},
        )
        assert resp.status_code == 200
        mock_registry.get.assert_called_with("azure-openai")

    @pytest.mark.asyncio
    async def test_generate_with_lm_studio_provider(self, client, mock_registry):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "summarize this", "provider": "lm-studio"},
        )
        assert resp.status_code == 200
        mock_registry.get.assert_called_with("lm-studio")
