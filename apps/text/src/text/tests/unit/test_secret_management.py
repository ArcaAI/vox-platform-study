"""Secrets survive no `repr()`, no `str()` and no `model_dump()`.

The guarantee is unchanged; what carries a secret is not. Provider credentials
used to live on `AzureOpenAIConfig.api_key` and friends, and this file checked
that those fields were `SecretStr`. Since TASK-799 lane B there is no provider
credential field at all — a key arrives per request on a `ProviderOverride`, and
the process holds exactly one secret of its own, the shared
``INTERNAL_ACCESS_TOKEN``.

So the coverage moves with the secret:

* ``ProviderOverride.api_key`` — the credential that now exists — must be a
  ``SecretStr``, and ``funding`` deliberately must NOT be, because attribution has
  to survive serialisation for metering to work (F-01 hop 6).
* ``InternalAccessConfig.token`` — the one process secret.
* The auth middleware still compares the real value correctly.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import InternalAccessConfig, Settings
from text.main import create_app
from text.models.provider import ModelInfo, ProviderInfo
from text.models.requests import GenerateRequest, ProviderOverride

_SECRET = "sk-super-secret-key"


def _override(key: str = _SECRET) -> ProviderOverride:
    return ProviderOverride(api_key=SecretStr(key), base_url="https://tenant.example/v1")


# ── the credential that actually exists: ProviderOverride.api_key ──


class TestProviderOverrideApiKeyIsSecret:
    def test_api_key_is_secret_str(self):
        assert isinstance(_override().api_key, SecretStr)

    def test_api_key_hidden_in_repr_and_str(self):
        override = _override()
        assert _SECRET not in repr(override.api_key)
        assert _SECRET not in str(override.api_key)
        # And from the whole model, which is what a log line would render.
        assert _SECRET not in repr(override)
        assert _SECRET not in str(override)

    def test_api_key_readable_only_through_get_secret_value(self):
        assert _override().api_key.get_secret_value() == _SECRET

    def test_model_dump_hides_the_key(self):
        assert _SECRET not in str(_override().model_dump())

    def test_model_dump_json_hides_the_key(self):
        """The path a request body actually takes on the wire."""
        assert _SECRET not in _override().model_dump_json()

    def test_a_request_carrying_the_override_never_renders_the_key(self):
        request = GenerateRequest(
            prompt="hi",
            provider="openai_compat",
            model="m",
            provider_overrides={"openai_compat": _override()},
        )
        assert _SECRET not in repr(request)
        assert _SECRET not in str(request.model_dump())

    def test_funding_is_deliberately_not_secret(self):
        """Attribution must SURVIVE serialisation.

        `funding` decides BYOK-vs-CLOUD metering, so wrapping it as a secret would
        strip the label at exactly the point the billing plane reads it — the
        mirror image of the mistake the key guards against (F-01 hop 6).
        """
        override = ProviderOverride(api_key=SecretStr(_SECRET), funding="platform")
        assert override.model_dump()["funding"] == "platform"


# ── the one process secret: INTERNAL_ACCESS_TOKEN ──


class TestInternalAccessTokenIsSecret:
    def test_token_is_secret_str(self):
        assert isinstance(InternalAccessConfig(token=SecretStr("t")).token, SecretStr)

    def test_settings_model_dump_hides_the_token(self):
        settings = Settings(internal_access=InternalAccessConfig(token=SecretStr("top-secret-999")))
        assert "top-secret-999" not in str(settings.model_dump())

    def test_settings_repr_hides_the_token(self):
        settings = Settings(internal_access=InternalAccessConfig(token=SecretStr("top-secret-999")))
        assert "top-secret-999" not in repr(settings)

    def test_the_token_is_readable_through_the_helper(self):
        settings = Settings(internal_access=InternalAccessConfig(token=SecretStr("shared")))
        assert settings.peer_service_token() == "shared"


# ── Auth middleware integration with SecretStr ──


@pytest.fixture
def _mock_provider_registry():
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.health_check = AsyncMock(return_value=True)
    mock_provider.get_info = AsyncMock(
        return_value=ProviderInfo(
            name="ollama",
            display_name="Ollama",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest")],
            supports_streaming=True,
        )
    )
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def _mock_task_manager():
    return AsyncMock()


class TestAuthMiddlewareWithSecretStr:
    """Auth middleware must work correctly when the token is a SecretStr."""

    SERVICE_TOKEN = "my-secret"

    @pytest_asyncio.fixture
    async def client(self, _mock_provider_registry, _mock_task_manager):
        settings = Settings(
            port=5099,
            log_level="debug",
            internal_access=InternalAccessConfig(token=SecretStr(self.SERVICE_TOKEN)),
        )
        app = create_app(settings_override=settings)
        app.state.provider_registry = _mock_provider_registry
        app.state.task_manager = _mock_task_manager
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_auth_middleware_accepts_correct_token(self, client):
        resp = await client.get(
            "/api/v1/providers",
            headers={"X-Service-Token": self.SERVICE_TOKEN},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_auth_middleware_rejects_wrong_token(self, client):
        resp = await client.get(
            "/api/v1/providers",
            headers={"X-Service-Token": "wrong-token"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_auth_middleware_rejects_missing_token(self, client):
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 401
