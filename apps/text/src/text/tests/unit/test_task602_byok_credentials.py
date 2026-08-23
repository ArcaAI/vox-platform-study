"""Text providers are connection-only: no env credential, no endpoint, no ambient chain.

The unified provider-connection plane (``AiProviderConnection``) is the sole store for
every provider connection; the gateway resolves tenant → SYSTEM and injects the result
as a per-request ``ProviderOverride``. This suite locks the guarantees that make that
true end-to-end in Text.

**This suite iterates the provider registry and the settings tree; it enumerates
NOTHING by name.** An earlier version listed three adapters (azure / openai /
anthropic) by hand, which is precisely why two ambient credential chains survived
underneath it: ``bedrock`` built a ``boto3`` client with no credentials
(``AWS_ACCESS_KEY_ID`` / ``AWS_PROFILE`` / instance metadata) and ``vertex`` built a
``genai`` client with no ``credentials=`` (Google ADC). Neither adapter was on the
list, so neither was ever asked to fail closed. A hand-written list can only lock the
adapters someone remembered; iteration locks the ones nobody has written yet.

TASK-799 lane B widened the guarantee in two directions:

* **From credentials to CONNECTIONS.** ``TEXT_<PROVIDER>_BASE_URL`` was the same defect
  one field over — a process-wide value no tenant could override and no admin could
  change without a redeploy. So the fail-closed assertion below now covers the
  ``SELF_HOST`` adapters too, not just ``BYOK``: an adapter with no injected connection
  has nowhere to send the request and must say so.
* **From "not populated" to "cannot exist".** There is no longer a credential FIELD to
  check for env leakage; `test_task799_config_surface.py` locks the whole settings tree
  down to nine bootstrap values. What remains here is the runtime half: that no adapter
  can build a client without an explicitly injected credential.

The five guarantees:

  1. No settings field anywhere can carry a credential, an endpoint or a model.
  2. Every registered adapter DECLARES its credential posture. An adapter that
     declares nothing fails here — that is the default-deny that makes (3) survive
     the next provider.
  3. EVERY adapter fails CLOSED when no connection is injected — it never builds a
     client that would authenticate from, or route by, the process environment.
  4. An injected connection is honoured, and the client it builds is REQUEST-SCOPED.
  5. The handler maps the failure to 503 ``PROVIDER_CREDENTIALS_MISSING``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel, SecretStr

from text.core.config import Settings
from text.core.exceptions import ProviderCredentialsError, TextError
from text.main import _register_provider_factories
from text.models.requests import GenerateRequest, ProviderOverride
from text.providers.base import CredentialPosture, ProviderRegistry


def _bare_settings() -> Settings:
    """Settings with no env file — the production posture (no platform credential)."""
    return Settings(_env_file=None, port=5099)


def _settings_fields() -> list[str]:
    """Every leaf field of the settings tree, dotted by sub-config."""

    def walk(model: type[BaseModel], prefix: str = "") -> list[str]:
        out: list[str] = []
        for name, field in model.model_fields.items():
            annotation = field.annotation
            if isinstance(annotation, type) and issubclass(annotation, BaseModel):
                out.extend(walk(annotation, f"{prefix}{name}."))
            else:
                out.append(f"{prefix}{name}")
        return out

    return walk(Settings)


def _registered_providers() -> list[tuple[str, Any]]:
    """Every provider the LLM registry exposes — i.e. exactly what a production pod
    holds before any connection arrives."""
    registry = ProviderRegistry()
    _register_provider_factories(registry, MagicMock())
    return [(name, registry.get(name)) for name in sorted(registry.list_providers())]


_ALL_PROVIDERS = _registered_providers()
_PROVIDER_IDS = [name for name, _ in _ALL_PROVIDERS]


# ---------------------------------------------------------------------------
# 1 — no settings field can carry a credential, an endpoint or a model
# ---------------------------------------------------------------------------


class TestNoCredentialFieldExists:
    """The env credential path is closed by ABSENCE, not by a dead alias.

    The previous generation of this guarantee asserted that
    ``TEXT_<PREFIX>_API_KEY`` did not populate a field that still existed. That
    is a weaker statement than it looks: the field was still there, still typed
    ``SecretStr``, and one ``populate_by_name=True`` away from working again.
    """

    def test_no_api_key_field_anywhere_in_settings(self):
        offenders = [f for f in _settings_fields() if f.rsplit(".", 1)[-1] == "api_key"]
        assert offenders == [], (
            f"Settings declares credential field(s) {offenders}. Provider "
            "credentials live in AiProviderConnection and arrive per request; "
            "there must be no field for one to be assigned to."
        )

    def test_no_env_var_can_produce_a_credential_bearing_config(self, monkeypatch):
        """Belt and braces: set every plausible key-shaped var and prove that
        nothing in the constructed settings tree holds a secret."""
        for var in (
            "TEXT_API_KEY",
            "TEXT_AZURE_API_KEY",
            "TEXT_BEDROCK_API_KEY",
            "TEXT_OPENAI_API_KEY",
            "TEXT_ANTHROPIC_API_KEY",
            "TEXT_VERTEX_API_KEY",
            "TEXT_OPENAI_COMPAT_API_KEY",
            "TEXT_VLLM_API_KEY",
            "TEXT_SARVAM_API_KEY",
        ):
            monkeypatch.setenv(var, "leaked-from-env")

        settings = _bare_settings()
        leaked = [
            name
            for name in _settings_fields()
            if _resolve(settings, name) == "leaked-from-env"
            or getattr(_resolve(settings, name), "get_secret_value", lambda: None)()
            == "leaked-from-env"
        ]
        assert leaked == [], f"env credential leaked into settings field(s) {leaked}"


def _resolve(obj: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        obj = getattr(obj, part, None)
    return obj


# ---------------------------------------------------------------------------
# 2 — every registered adapter declares a credential posture (default-deny)
# ---------------------------------------------------------------------------


class TestEveryAdapterDeclaresPosture:
    @pytest.mark.parametrize(("name", "provider"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
    def test_posture_is_declared(self, name, provider):
        posture = getattr(provider, "credential_posture", None)
        assert isinstance(posture, CredentialPosture), (
            f"Provider '{name}' ({type(provider).__name__}) declares no "
            "`credential_posture`. Every adapter must state whether it needs a "
            "vendor credential (BYOK) or is an operator-run engine reached by a "
            "connection `base_url` (SELF_HOST) — the fail-closed lock below is "
            "driven by that declaration, not by a hand-written list."
        )


# ---------------------------------------------------------------------------
# 3 — EVERY adapter fails CLOSED with no injected connection
# ---------------------------------------------------------------------------


class TestAdaptersFailClosedWithoutAConnection:
    """No injected connection ⇒ ``ProviderCredentialsError`` (503), for every adapter.

    A model IS supplied so the guard under test is the connection, not the separate
    ``ModelNotSelectedError`` contract. This is the assertion that would have caught
    bedrock's ambient ``boto3`` chain and vertex's ADC chain: both used to build a
    perfectly usable client here — authenticated as the PLATFORM, from the process
    environment, with no credential ever having been configured.

    ``SELF_HOST`` adapters are included deliberately. Their old escape hatch was an
    endpoint rather than a key, but the consequence was identical: a process-wide value
    that decided where every tenant's traffic went.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("name", "provider"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
    async def test_generate_raises(self, name, provider):
        with pytest.raises(ProviderCredentialsError) as exc:
            await provider.generate(GenerateRequest(prompt="hi", provider=name, model="m"))
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("name", "provider"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
    async def test_generate_stream_raises(self, name, provider):
        with pytest.raises(ProviderCredentialsError) as exc:
            async for _ in provider.generate_stream(
                GenerateRequest(prompt="hi", provider=name, model="m", stream=True)
            ):
                pass
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    def test_the_registry_is_not_empty(self):
        """Sanity floor on the iteration itself: an empty/short registry would make
        every parametrized case above pass by vacuity. Bedrock and Vertex are named
        ONLY here, as the two ambient chains F-01 found — never as the source of the
        assertions."""
        names = set(_PROVIDER_IDS)
        assert {
            "bedrock",
            "vertex",
            "openai",
            "anthropic",
            "azure-openai",
            "lm-studio",
            "ollama",
            "vllm",
            "llama-cpp",
        } <= names

    def test_provider_credentials_error_is_text_error(self):
        exc = ProviderCredentialsError("nope", provider="openai")
        assert isinstance(exc, TextError)
        assert exc.error_code == "PROVIDER_CREDENTIALS_MISSING"
        assert exc.provider == "openai"


# ---------------------------------------------------------------------------
# 4 — an injected connection is honoured, request-scoped
# ---------------------------------------------------------------------------


class TestInjectedConnectionIsHonoured:
    """The other half of the contract: a resolved connection must actually be used,
    and the client it builds must belong to THAT REQUEST.

    Request scoping is the property that keeps two tenants apart. It used to be
    stated as "the shared client is never mutated"; there is no shared client any
    more, so it is stated directly — two requests carrying different credentials
    must not receive the same client object.
    """

    @pytest.mark.parametrize(("name", "provider"), _ALL_PROVIDERS, ids=_PROVIDER_IDS)
    def test_resolve_override_exists(self, name, provider):
        assert hasattr(provider, "_resolve_override") or hasattr(provider, "_endpoint"), (
            f"Provider '{name}' has no way to read an injected connection. Every "
            "adapter must resolve one per request — otherwise the only place a "
            "connection could come from is process-wide config, which no tenant "
            "can override."
        )

    def test_openai_compat_connection_builds_a_request_scoped_client(self):
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider()

        def request_for(key: str, url: str) -> GenerateRequest:
            return GenerateRequest(
                prompt="hi",
                provider="openai_compat",
                model="m",
                provider_overrides={
                    "openai_compat": ProviderOverride(api_key=SecretStr(key), base_url=url)
                },
            )

        first = provider._client_for(request_for("tenant-a", "https://a.example/v1"))
        second = provider._client_for(request_for("tenant-b", "https://b.example/v1"))

        assert first is not second
        assert str(first.base_url).rstrip("/") == "https://a.example/v1"
        assert str(second.base_url).rstrip("/") == "https://b.example/v1"


# ---------------------------------------------------------------------------
# 5 — the handler maps ProviderCredentialsError to 503
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

        settings = Settings(_env_file=None, port=5099)
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
# 6 — registration is unconditional; availability is not an env var
# ---------------------------------------------------------------------------


class TestRegistrationIsUnconditional:
    """A provider's existence must not depend on the process environment.

    Azure used to be gated on ``TEXT_AZURE_ENDPOINT`` and the four local engines on
    their ``*_BASE_URL``, so a pure-BYO tenant got a 404 saying the provider did not
    exist — when what was actually missing was the PLATFORM's connection, which that
    tenant was never going to use. Registering unconditionally turns that into a 503
    naming the row an admin has to create.
    """

    def test_every_adapter_registers_with_a_bare_environment(self, monkeypatch):
        for var in (
            "TEXT_AZURE_ENDPOINT",
            "TEXT_BEDROCK_REGION",
            "TEXT_OPENAI_COMPAT_BASE_URL",
            "TEXT_OLLAMA_BASE_URL",
            "TEXT_VLLM_BASE_URL",
            "TEXT_LLAMA_CPP_BASE_URL",
        ):
            monkeypatch.delenv(var, raising=False)

        registry = ProviderRegistry()
        _register_provider_factories(registry, MagicMock())
        assert {
            "azure-openai",
            "azure",
            "bedrock",
            "openai",
            "anthropic",
            "vertex",
            "lm-studio",
            "openai_compat",
            "ollama",
            "vllm",
            "llama-cpp",
        } <= set(registry.list_providers())
