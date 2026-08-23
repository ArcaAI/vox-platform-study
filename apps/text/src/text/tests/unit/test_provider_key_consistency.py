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
    """Timeouts come from the control plane, keyed by the SAME provider name.

    This used to read one of ten `TEXT_<PROVIDER>_TIMEOUT_S` env vars through a
    hand-maintained alias map — and the map was the bug this file is named after,
    one level up: it silently dropped `ollama`, `openai`, `anthropic` and `vertex`
    onto a module default nobody noticed, because a dictionary entry is easy to
    forget. There is one source now (`AiRuntimeProfile` via effective-config) and
    one fallback (the resource-safety floor), so no provider can be missed.
    """

    def test_a_served_timeout_is_used_for_the_tenant_facing_key(self):
        from text.api.endpoints.generate import _get_provider_timeout

        assert _get_provider_timeout({"azure-openai": 42}, "azure-openai") == 42.0
        assert _get_provider_timeout({"lm-studio": 17}, "lm-studio") == 17.0

    def test_an_unserved_provider_falls_back_to_the_safety_floor(self):
        from text.api.endpoints.generate import _get_provider_timeout
        from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S

        assert _get_provider_timeout({}, "ollama") == float(PROVIDER_TIMEOUT_FLOOR_S)
        assert _get_provider_timeout({"azure-openai": 42}, "vertex") == float(
            PROVIDER_TIMEOUT_FLOOR_S
        )

    def test_no_provider_is_reachable_only_through_an_alias_map(self):
        """The regression guard: EVERY registered provider resolves a timeout."""
        from unittest.mock import MagicMock

        from text.api.endpoints.generate import _get_provider_timeout
        from text.core.runtime_defaults import PROVIDER_TIMEOUT_FLOOR_S
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        _register_provider_factories(registry, MagicMock())
        served = dict.fromkeys(registry.list_providers(), 99)
        for name in registry.list_providers():
            assert _get_provider_timeout(served, name) == 99.0
            assert _get_provider_timeout({}, name) == float(PROVIDER_TIMEOUT_FLOOR_S)


class TestMainLifespanProviderKeys:
    """Lifespan should register providers under tenant-facing keys."""

    def test_azure_factory_registered_under_tenant_key(self):
        """Azure registers BOTH the tenant-facing 'azure-openai' key and its
        legacy 'azure' alias as lazy factories."""
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        _register_provider_factories(registry, MagicMock())
        assert "azure-openai" in registry.list_providers()
        assert "azure" in registry.list_providers()

    def test_openai_compat_factory_registered_under_lm_studio_key(self):
        """The lazy factory is registered under both the 'lm-studio' key and the
        'openai_compat' alias, and both resolve to ONE shared instance."""
        from text.main import _register_provider_factories
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        _register_provider_factories(registry, MagicMock())
        assert "lm-studio" in registry.list_providers()
        assert "openai_compat" in registry.list_providers()
        assert registry.get("lm-studio") is registry.get("openai_compat")

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
        Azure must never serve a request. And there is no longer ANY env var —
        enable flag, endpoint or key — that could change either half.
        """
        for stale in (
            "TEXT_AZURE_ENABLED",
            "TEXT_AZURE_ENDPOINT",
            "TEXT_AZURE_API_KEY",
            "TEXT_AZURE_DEPLOYMENT_NAME",
        ):
            monkeypatch.setenv(stale, "definitely-set")
        from text.core.exceptions import ProviderCredentialsError
        from text.main import _register_provider_factories
        from text.models.requests import GenerateRequest
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        _register_provider_factories(registry, MagicMock())

        # Registered, so a per-request BYOK connection can reach it.
        assert "azure-openai" in registry.list_providers()
        provider = registry.get("azure-openai")

        # ...but with no connection it fails CLOSED (503), rather than 401-ing an
        # empty-keyed client downstream — and none of those env vars helped.
        assert not hasattr(provider, "_client")
        with pytest.raises(ProviderCredentialsError):
            provider._client_for(GenerateRequest(prompt="hello", model="m"))


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
