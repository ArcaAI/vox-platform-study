"""Text cloud providers are BYOK-only: no env credential fallback, no ambient chain.

The unified provider-connection plane (AiProviderConnection) is the sole store for
cloud credentials; the gateway resolves tenant → SYSTEM and injects the result as a
per-request ``ProviderOverride``. This suite locks the guarantees that make that true
end-to-end in Text.

TASK-799 F-01 — **this suite iterates the provider registry and the settings tree; it
enumerates NOTHING by name.** The previous version listed three adapters (azure /
openai / anthropic) by hand, which is precisely why two ambient credential chains
survived underneath it: ``bedrock`` built a ``boto3`` client with no credentials
(``AWS_ACCESS_KEY_ID`` / ``AWS_PROFILE`` / instance metadata) and ``vertex`` built a
``genai`` client with no ``credentials=`` (Google ADC). Neither adapter was on the
list, so neither was ever asked to fail closed. A hand-written list can only lock the
adapters someone remembered; iteration locks the ones nobody has written yet.

The four guarantees:

  1. No provider config sources ``api_key`` from env — checked across EVERY
     credential-bearing sub-config on ``Settings``, derived from the model fields.
  2. Every registered adapter DECLARES its credential posture. An adapter that
     declares nothing fails here — that is the default-deny that makes (3) survive
     the next provider.
  3. Every ``BYOK`` adapter fails CLOSED with ``ProviderCredentialsError`` when
     neither a request override nor an explicit platform credential exists — it never
     builds a client that would authenticate from the ambient process environment.
  4. The handler maps ``ProviderCredentialsError`` to 503
     ``PROVIDER_CREDENTIALS_MISSING``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import (
    AzureOpenAIConfig,
    Settings,
)
from text.core.exceptions import ProviderCredentialsError, TextError
from text.main import _register_provider_factories
from text.models.requests import GenerateRequest
from text.providers.base import CredentialPosture, ProviderRegistry


def _bare_settings() -> Settings:
    """Settings with no env file — the production posture (no platform credential)."""
    return Settings(_env_file=None, host="127.0.0.1", port=5099, metrics_enabled=False)


def _credential_configs() -> list[tuple[str, Any]]:
    """Every sub-config on ``Settings`` that carries an ``api_key``, discovered from
    the model fields rather than named here."""
    settings = _bare_settings()
    found: list[tuple[str, Any]] = []
    for field_name in type(settings).model_fields:
        sub = getattr(settings, field_name, None)
        if sub is None or not hasattr(type(sub), "model_fields"):
            continue
        if "api_key" in type(sub).model_fields:
            found.append((field_name, type(sub)))
    return found


def _registered_providers() -> list[tuple[str, Any]]:
    """Every provider the LLM registry exposes, built from a credential-free
    ``Settings`` — i.e. exactly what a production pod holds before any tenant
    override arrives."""
    registry = ProviderRegistry()
    _register_provider_factories(registry, _bare_settings(), MagicMock())
    return [(name, registry.get(name)) for name in sorted(registry.list_providers())]


# ---------------------------------------------------------------------------
# 1 — api_key is never sourced from env, for EVERY credential-bearing config
# ---------------------------------------------------------------------------


class TestApiKeyNotEnvSourced:
    """The prefixed env var must NOT populate ``api_key`` for any provider config.

    Parametrized off the settings tree: adding a provider config with an ``api_key``
    automatically adds a case here, so a new adapter cannot quietly reopen an env
    credential path.
    """

    @pytest.mark.parametrize(
        ("attr", "config_cls"),
        _credential_configs(),
        ids=[attr for attr, _ in _credential_configs()],
    )
    def test_api_key_not_read_from_env(self, attr, config_cls, monkeypatch):
        prefix = config_cls.model_config.get("env_prefix", "")
        monkeypatch.setenv(f"{prefix}API_KEY", "leaked-from-env")
        assert config_cls().api_key.get_secret_value() != "leaked-from-env", (
            f"{config_cls.__name__}.api_key was populated from {prefix}API_KEY — "
            "provider credentials are BYOK-only and must have no env path "
            "(dead validation_alias + populate_by_name off)."
        )


# ---------------------------------------------------------------------------
# 2 — every registered adapter declares a credential posture (default-deny)
# ---------------------------------------------------------------------------


class TestEveryAdapterDeclaresPosture:
    @pytest.mark.parametrize(
        ("name", "provider"),
        _registered_providers(),
        ids=[name for name, _ in _registered_providers()],
    )
    def test_posture_is_declared(self, name, provider):
        posture = getattr(provider, "credential_posture", None)
        assert isinstance(posture, CredentialPosture), (
            f"Provider '{name}' ({type(provider).__name__}) declares no "
            "`credential_posture`. Every adapter must state whether it needs a "
            "vendor credential (BYOK) or is an operator-run engine reached by "
            "topology base_url (SELF_HOST) — the fail-closed lock below is driven "
            "by that declaration, not by a hand-written list."
        )


# ---------------------------------------------------------------------------
# 3 — every BYOK adapter fails CLOSED with no override and no platform credential
# ---------------------------------------------------------------------------


_BYOK_PROVIDERS = [(n, p) for n, p in _registered_providers() if getattr(p, "credential_posture", None) is CredentialPosture.BYOK]


class TestByokAdaptersFailClosed:
    """No override + no explicit platform credential ⇒ ``ProviderCredentialsError``.

    A model IS supplied so the guard under test is the credential, not the separate
    ``ModelNotSelectedError`` contract. This is the assertion that would have caught
    bedrock's ambient ``boto3`` chain and vertex's ADC chain: both used to build a
    perfectly usable client here — authenticated as the PLATFORM, from the process
    environment, with no credential ever having been configured.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("name", "provider"), _BYOK_PROVIDERS, ids=[n for n, _ in _BYOK_PROVIDERS]
    )
    async def test_generate_raises(self, name, provider):
        with pytest.raises(ProviderCredentialsError) as exc:
            await provider.generate(GenerateRequest(prompt="hi", provider=name, model="m"))
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("name", "provider"), _BYOK_PROVIDERS, ids=[n for n, _ in _BYOK_PROVIDERS]
    )
    async def test_generate_stream_raises(self, name, provider):
        with pytest.raises(ProviderCredentialsError) as exc:
            async for _ in provider.generate_stream(
                GenerateRequest(prompt="hi", provider=name, model="m", stream=True)
            ):
                pass
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    def test_at_least_the_five_cloud_adapters_are_byok(self):
        """Sanity floor on the iteration itself: if the registry ever returns an
        empty/short BYOK set the parametrized cases above would silently pass by
        vacuity. Bedrock and Vertex are named ONLY here, as the two chains F-01
        found — never as the source of the assertions."""
        names = {n for n, _ in _BYOK_PROVIDERS}
        assert {"bedrock", "vertex", "openai", "anthropic", "azure-openai"} <= names

    def test_provider_credentials_error_is_text_error(self):
        exc = ProviderCredentialsError("nope", provider="openai")
        assert isinstance(exc, TextError)
        assert exc.error_code == "PROVIDER_CREDENTIALS_MISSING"
        assert exc.provider == "openai"


# ---------------------------------------------------------------------------
# 3b — a tenant override is honoured (the other half of the BYOK contract)
# ---------------------------------------------------------------------------


_CREDENTIALLED_PROVIDERS = [
    (n, p)
    for n, p in _registered_providers()
    if "api_key" in type(getattr(p, "_config", None)).model_fields
]


class TestCredentialledAdaptersAcceptTenantOverride:
    """An adapter whose config carries an ``api_key`` MUST have an override path.

    Derived from the config, not listed: a credential field with no
    ``_resolve_override`` beside it means the ONLY way to set a key is the
    process-wide env/config value, which no tenant can override — the exact shape
    §Configuration Principles forbids, and exactly what ``openai_compat`` (and the
    ``vllm`` subclass inheriting its ``api_key``) looked like before TASK-799.
    Adapters with no credential at all (Ollama, llama.cpp) are correctly absent.
    """

    @pytest.mark.parametrize(
        ("name", "provider"),
        _CREDENTIALLED_PROVIDERS,
        ids=[n for n, _ in _CREDENTIALLED_PROVIDERS],
    )
    def test_resolve_override_exists(self, name, provider):
        assert hasattr(provider, "_resolve_override"), (
            f"Provider '{name}' has a configured `api_key` but no "
            "`_resolve_override` — a tenant can never bring its own credential "
            "for it, so the config value is a process-wide credential."
        )

    def test_openai_compat_and_vllm_are_covered(self):
        """Sanity floor on the derivation: the two adapters F-01 found without an
        override path must actually appear in the parametrization above."""
        names = {n for n, _ in _CREDENTIALLED_PROVIDERS}
        assert {"openai_compat", "vllm"} <= names

    def test_openai_compat_override_builds_a_request_scoped_client(self):
        from text.core.config import OpenAICompatConfig
        from text.models.requests import ProviderOverride
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(OpenAICompatConfig())
        request = GenerateRequest(
            prompt="hi",
            provider="openai_compat",
            model="m",
            provider_overrides={
                "openai_compat": ProviderOverride(
                    api_key=SecretStr("tenant-key"), base_url="https://tenant.example/v1"
                )
            },
        )
        client = provider._client_for(request)
        assert client is not provider._client
        assert str(client.base_url).rstrip("/") == "https://tenant.example/v1"


# ---------------------------------------------------------------------------
# 4 — the handler maps ProviderCredentialsError to 503
# ---------------------------------------------------------------------------


def _make_task_manager():
    from text.models.task import TaskState, TaskStatus

    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="t-1", status=TaskStatus.PENDING, provider="openai", model="m"
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="t-1", status=TaskStatus.RUNNING, provider="openai", model="m"
        )
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
# 5 — Azure OpenAI is BYO-first (registers on endpoint alone, no key required)
# ---------------------------------------------------------------------------


class TestAzureByoFirstRegistration:
    def test_azure_registers_with_endpoint_and_no_key(self, monkeypatch):
        """The main.py gate must NOT require an api_key — an endpoint-only Azure
        connection registers so a tenant BYOK override can reach it (was a 404
        before TASK-602)."""
        monkeypatch.delenv("TEXT_AZURE_API_KEY", raising=False)

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
