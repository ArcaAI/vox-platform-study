"""Text cloud providers are BYOK-only: no env credential fallback.

The unified provider-connection plane (AiProviderConnection) is the sole store for
Azure OpenAI / OpenAI / Anthropic credentials; the gateway resolves tenant → SYSTEM
and injects the result as a per-request ``ProviderOverride``. This suite locks the
three guarantees that make that true end-to-end in Text:

  1. The three cloud configs NEVER source ``api_key`` from env (the ``TEXT_*_API_KEY``
     vars are dead — removed from turbo globalEnv / Vault policies in this ticket).
  2. A cloud ``generate`` with neither a request override nor a configured
     platform key fails CLOSED with ``ProviderCredentialsError`` (503) — it never
     builds an empty-keyed SDK client that would 401 downstream.
  3. Azure OpenAI is BYO-FIRST: it registers whenever an ENDPOINT is configured
     (credential is not required at registration), matching openai/anthropic/vertex
     — the fix for the old ``main.py`` gate that hid Azure behind a 404 for a tenant
     that had a valid BYOK override.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.core.config import (
    AnthropicConfig,
    AzureOpenAIConfig,
    OpenAIConfig,
    Settings,
)
from text.core.exceptions import ProviderCredentialsError, TextError
from text.models.requests import GenerateRequest
from text.providers.anthropic import AnthropicProvider
from text.providers.azure_openai import AzureOpenAIProvider
from text.providers.base import ProviderRegistry
from text.providers.openai import OpenAIProvider

# ---------------------------------------------------------------------------
# 1 — api_key is never sourced from env
# ---------------------------------------------------------------------------


class TestApiKeyNotEnvSourced:
    """The prefixed env var must NOT populate api_key for any cloud config."""

    def test_azure_api_key_not_read_from_env(self, monkeypatch):
        monkeypatch.setenv("TEXT_AZURE_API_KEY", "leaked-from-env")
        assert AzureOpenAIConfig().api_key.get_secret_value() == ""

    def test_openai_api_key_not_read_from_env(self, monkeypatch):
        monkeypatch.setenv("TEXT_OPENAI_API_KEY", "leaked-from-env")
        assert OpenAIConfig().api_key.get_secret_value() == ""

    def test_anthropic_api_key_not_read_from_env(self, monkeypatch):
        monkeypatch.setenv("TEXT_ANTHROPIC_API_KEY", "leaked-from-env")
        assert AnthropicConfig().api_key.get_secret_value() == ""


# ---------------------------------------------------------------------------
# 2 — fail-closed: generate() raises ProviderCredentialsError when unconfigured
# ---------------------------------------------------------------------------


class TestGenerateFailsClosedWithoutCredential:
    """No override + no platform key ⇒ ProviderCredentialsError (never a keyless
    client that 401s). A model IS supplied so the guard is the credential, not the
    separate ModelNotSelectedError contract."""

    @pytest.mark.asyncio
    async def test_azure_generate_raises(self):
        provider = AzureOpenAIProvider(AzureOpenAIConfig(endpoint="https://x.openai.azure.com"))
        with pytest.raises(ProviderCredentialsError):
            await provider.generate(
                GenerateRequest(prompt="hi", provider="azure_openai", model="m")
            )

    @pytest.mark.asyncio
    async def test_openai_generate_raises(self):
        provider = OpenAIProvider(OpenAIConfig())
        with pytest.raises(ProviderCredentialsError):
            await provider.generate(GenerateRequest(prompt="hi", provider="openai", model="m"))

    @pytest.mark.asyncio
    async def test_anthropic_generate_raises(self):
        provider = AnthropicProvider(AnthropicConfig())
        with pytest.raises(ProviderCredentialsError):
            await provider.generate(GenerateRequest(prompt="hi", provider="anthropic", model="m"))

    @pytest.mark.asyncio
    async def test_openai_stream_raises(self):
        provider = OpenAIProvider(OpenAIConfig())
        with pytest.raises(ProviderCredentialsError):
            async for _ in provider.generate_stream(
                GenerateRequest(prompt="hi", provider="openai", model="m", stream=True)
            ):
                pass

    def test_provider_credentials_error_is_text_error(self):
        exc = ProviderCredentialsError("nope", provider="openai")
        assert isinstance(exc, TextError)
        assert exc.error_code == "PROVIDER_CREDENTIALS_MISSING"
        assert exc.provider == "openai"


# ---------------------------------------------------------------------------
# 2b — the handler maps ProviderCredentialsError to 503
# ---------------------------------------------------------------------------


def _make_task_manager():
    from text.models.task import TaskState, TaskStatus

    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(task_id="t-1", status=TaskStatus.PENDING, provider="openai", model="m")
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(task_id="t-1", status=TaskStatus.RUNNING, provider="openai", model="m")
    )
    return tm


class TestHandlerMaps503:
    @pytest.mark.asyncio
    async def test_generate_returns_503_on_provider_credentials_error(self):
        from text.main import create_app

        settings = Settings(
            _env_file=None, host="127.0.0.1", port=5099, debug=True, metrics_enabled=False
        )
        registry = ProviderRegistry()
        provider = AsyncMock()
        provider.generate = AsyncMock(
            side_effect=ProviderCredentialsError("no key", provider="openai")
        )
        provider.health_check = AsyncMock(return_value=True)
        provider.get_info = AsyncMock()
        registry.register("openai", provider)

        app = create_app(settings_override=settings)
        app.state.provider_registry = registry
        app.state.task_manager = _make_task_manager()
        app.state.settings = settings
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "openai", "model": "m"},
            )
        assert resp.status_code == 503
        assert resp.json()["error_code"] == "PROVIDER_CREDENTIALS_MISSING"


# ---------------------------------------------------------------------------
# 3 — Azure OpenAI is BYO-first (registers on endpoint alone, no key required)
# ---------------------------------------------------------------------------


class TestAzureByoFirstRegistration:
    def test_azure_registers_with_endpoint_and_no_key(self, monkeypatch):
        """The main.py gate must NOT require an api_key — an endpoint-only Azure
        connection registers so a tenant BYOK override can reach it (was a 404
        before this ticket)."""
        monkeypatch.delenv("TEXT_AZURE_API_KEY", raising=False)
        from text.main import _register_provider_factories

        settings = Settings(
            _env_file=None,
            host="0.0.0.0",
            port=8862,
            azure=AzureOpenAIConfig(endpoint="https://x.openai.azure.com"),
        )
        registry = ProviderRegistry()
        _register_provider_factories(registry, settings, MagicMock())
        assert "azure-openai" in registry.list_providers()
        assert "azure" in registry.list_providers()
