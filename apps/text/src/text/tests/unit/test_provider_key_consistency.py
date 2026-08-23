"""TDD tests for provider key consistency.

Ensures the Text runtime uses tenant-facing provider keys
(azure-openai, lm-studio) instead of internal-only keys (azure, openai_compat).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient



class TestProviderRegistryTenantKeys:
    """Registry should accept and resolve tenant-facing provider keys."""

    def test_registry_accepts_azure_openai_key(self):
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("azure-openai", mock_provider)
        assert "azure-openai" in registry.list_providers()
        assert registry.get("azure-openai") is mock_provider

    def test_registry_accepts_lm_studio_key(self):
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        mock_provider = AsyncMock()
        registry.register("lm-studio", mock_provider)
        assert "lm-studio" in registry.list_providers()
        assert registry.get("lm-studio") is mock_provider


class TestProviderTimeoutMapping:
    """Timeout resolution should use provider-specific config, not the global default."""

    def test_azure_openai_timeout_uses_azure_config(self):
        from text.api.endpoints.generate import _get_provider_timeout
        from text.core.config import Settings

        settings = Settings(_env_file=None, port=8862)
        timeout = _get_provider_timeout(settings, "azure-openai")
        assert timeout == float(settings.azure.timeout_s), (
            f"azure-openai should use azure config timeout ({settings.azure.timeout_s}), "
            f"got {timeout}"
        )

    def test_lm_studio_timeout_uses_openai_compat_config(self):
        from text.api.endpoints.generate import _get_provider_timeout
        from text.core.config import Settings

        settings = Settings(_env_file=None, port=8862)
        timeout = _get_provider_timeout(settings, "lm-studio")
        assert timeout == float(settings.openai_compat.timeout_s), (
            f"lm-studio should use openai_compat config timeout ({settings.openai_compat.timeout_s}), "
            f"got {timeout}"
        )


class TestMainLifespanProviderKeys:
    """Lifespan should register providers under tenant-facing keys."""

    def test_azure_factory_registered_under_tenant_key(self):
        """a connection-configured Azure registers BOTH the tenant-facing
        'azure-openai' key and its legacy 'azure' alias as lazy factories."""
        from text.core.config import Settings
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        settings = Settings(_env_file=None, port=8862)
        registry = ProviderRegistry()
        _register_provider_factories(registry, settings, MagicMock())
        assert "azure-openai" in registry.list_providers()
        assert "azure" in registry.list_providers()

    def test_openai_compat_factory_registered_under_lm_studio_key(self):
        """LM Studio always has a default base_url, so the lazy factory is
        registered under both the 'lm-studio' key and the 'openai_compat' alias."""
        from text.core.config import Settings
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        settings = Settings(_env_file=None, port=8862)
        registry = ProviderRegistry()
        _register_provider_factories(registry, settings, MagicMock())
        assert "lm-studio" in registry.list_providers()
        assert "openai_compat" in registry.list_providers()

    def test_unconfigured_azure_registers_but_fails_closed_on_use(self, monkeypatch):
        """Unconfigured Azure is REGISTERED but unusable — fail-closed moved.

        Azure used to be gated on ``settings.azure.endpoint`` at registration
        time, and this test asserted it was absent. The BYOK model inverted
        that: a pure-BYOK tenant has no platform endpoint (its credential
        arrives per request as a provider override), so gating registration
        made Text answer 404 for a VALID override. Azure/openai/anthropic/vertex
        now register unconditionally and fail closed where the credential is
        actually needed — ``_client_for`` raises ProviderCredentialsError (503)
        when there is neither an override nor a platform client.

        So the safety property is unchanged, only its location: an unconfigured
        Azure must never serve a request. A stale TEXT_AZURE_ENABLED still
        cannot force anything on — no such field exists.
        """
        monkeypatch.setenv("TEXT_AZURE_ENABLED", "true")  # inert: no such field now
        # Hermetic: a real Azure CONNECTION config can leak into os.environ from the
        # dev .env or the e2e conftest's import-time overrides; scrub it so the
        # "unconfigured" assertion is deterministic regardless of test order.
        monkeypatch.delenv("TEXT_AZURE_ENDPOINT", raising=False)
        monkeypatch.delenv("TEXT_AZURE_API_KEY", raising=False)
        from text.core.config import Settings
        from text.core.exceptions import ProviderCredentialsError
        from text.main import _register_provider_factories
        from text.models.requests import GenerateRequest
        from text.providers.base import ProviderRegistry

        settings = Settings(_env_file=None, port=8862)
        registry = ProviderRegistry()
        _register_provider_factories(registry, settings, MagicMock())

        # Registered, so a per-request BYOK override can reach it.
        assert "azure-openai" in registry.list_providers()
        provider = registry.get("azure-openai")

        # ...but with no override and no platform key it fails CLOSED (503),
        # rather than 401-ing an empty-keyed client downstream.
        assert provider._client is None
        with pytest.raises(ProviderCredentialsError):
            provider._client_for(GenerateRequest(prompt="hello"))


class TestGenerateEndpointWithTenantKeys:
    """Generate endpoint should resolve providers using tenant-facing keys."""

    @pytest.fixture
    def mock_provider(self):
        provider = AsyncMock()
        provider.generate = AsyncMock(
            return_value=(
                "Generated text",
                "",
                {
                    "prompt_tokens": 10,
                    "completion_tokens": 20,
                    "total_tokens": 30,
                },
            )
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
        from text.main import create_app

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
            json={"prompt": "summarize this", "provider": "azure-openai", "model": "test-model"},
        )
        assert resp.status_code == 200
        mock_registry.get.assert_called_with("azure-openai")

    @pytest.mark.asyncio
    async def test_generate_with_lm_studio_provider(self, client, mock_registry):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "summarize this", "provider": "lm-studio", "model": "test-model"},
        )
        assert resp.status_code == 200
        mock_registry.get.assert_called_with("lm-studio")
