"""TDD tests for SecretStr protection of sensitive config fields.

Ensures api_key and service_token are Pydantic SecretStr instances,
preventing accidental logging of secrets via repr/model_dump.

RED: Written before implementation — all tests should FAIL initially.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from smr.core.config import AzureOpenAIConfig, Settings
from smr.main import create_app
from smr.models.provider import ModelInfo, ProviderInfo

# ── AzureOpenAIConfig.api_key ──


class TestAzureApiKeySecretStr:
    """AzureOpenAIConfig.api_key must be a SecretStr."""

    def test_azure_api_key_is_secret_str(self):
        cfg = AzureOpenAIConfig(api_key="sk-super-secret-key")
        assert isinstance(cfg.api_key, SecretStr)

    def test_azure_api_key_repr_hidden(self):
        cfg = AzureOpenAIConfig(api_key="sk-super-secret-key")
        assert "sk-super-secret-key" not in repr(cfg.api_key)
        assert "sk-super-secret-key" not in str(cfg.api_key)

    def test_azure_api_key_get_secret_value(self):
        cfg = AzureOpenAIConfig(api_key="sk-super-secret-key")
        assert cfg.api_key.get_secret_value() == "sk-super-secret-key"


# ── Settings.service_token ──


class TestServiceTokenSecretStr:
    """Settings.service_token must be a SecretStr."""

    def test_service_token_is_secret_str(self):
        s = Settings(service_token="my-service-token-xyz")
        assert isinstance(s.service_token, SecretStr)

    def test_service_token_repr_hidden(self):
        s = Settings(service_token="my-service-token-xyz")
        assert "my-service-token-xyz" not in repr(s.service_token)
        assert "my-service-token-xyz" not in str(s.service_token)

    def test_service_token_get_secret_value(self):
        s = Settings(service_token="my-service-token-xyz")
        assert s.service_token.get_secret_value() == "my-service-token-xyz"


# ── model_dump hides secrets ──


class TestModelDumpHidesSecrets:
    """model_dump() must not expose raw secret values."""

    def test_settings_model_dump_hides_secrets(self):
        s = Settings(service_token="top-secret-token-999")
        dumped = s.model_dump()
        dumped_str = str(dumped)
        assert "top-secret-token-999" not in dumped_str

    def test_azure_model_dump_hides_api_key(self):
        cfg = AzureOpenAIConfig(api_key="sk-azure-key-hidden")
        dumped = cfg.model_dump()
        dumped_str = str(dumped)
        assert "sk-azure-key-hidden" not in dumped_str


# ── Auth middleware integration with SecretStr ──


@pytest.fixture
def _mock_provider_registry():
    from smr.providers.base import ProviderRegistry

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
    """Auth middleware must work correctly when service_token is SecretStr."""

    SERVICE_TOKEN = "my-secret"

    @pytest_asyncio.fixture
    async def client(self, _mock_provider_registry, _mock_task_manager):
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            debug=True,
            log_level="debug",
            service_token=SecretStr(self.SERVICE_TOKEN),
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
