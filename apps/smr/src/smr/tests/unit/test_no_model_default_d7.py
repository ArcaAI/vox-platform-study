"""SMR is a stateless gateway with NO model default.

RED-first tests for the fail-closed contract:
  * POST /api/v1/generate with a missing/blank model ⇒ HTTP 422 (no silent default).
  * A caller-supplied model is honored verbatim.
  * Providers no longer fall back to ``self._default_model`` in the generation
    path (``_resolve_model`` returns exactly ``request.model``).
  * ``ProviderInfo.default_model`` / config ``default_model`` are retained as
    informational only (decision 3) — NOT used as a runtime fallback.

These must fail BEFORE the GREEN edits and pass after.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr.models.requests import GenerateRequest
from smr.tests.conftest import keyed

# ── Endpoint: fail-closed 422 when the model cannot be resolved ──


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "Generated text",
            "",
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-d7"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest.fixture
def app(mock_registry, mock_task_manager):
    from smr.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestGenerateRequiresModel:
    """The gateway rejects requests it cannot resolve a model for."""

    @pytest.mark.asyncio
    async def test_missing_model_returns_422(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "ollama"})
        assert resp.status_code == 422
        assert "model" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_missing_model_does_not_call_provider(self, client, mock_provider):
        await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "ollama"})
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_blank_model_returns_422(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": "ollama", "model": "   "},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_streaming_missing_model_returns_422(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": "ollama", "stream": True},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_caller_supplied_model_is_honored(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": "ollama", "model": "caller-model"},
        )
        assert resp.status_code == 200
        assert resp.json()["model"] == "caller-model"


# ── Providers: no in-gateway default fallback in the generation path ──


def _ollama():
    from smr.core.config import OllamaConfig
    from smr.providers.ollama import OllamaProvider

    return OllamaProvider(
        OllamaConfig(base_url="http://localhost:11434", default_model="ollama-default"),
        MagicMock(),
    )


def _openai_compat():
    from smr.core.config import OpenAICompatConfig
    from smr.providers.openai_compat import OpenAICompatProvider

    return OpenAICompatProvider(OpenAICompatConfig(default_model="compat-default"))


def _azure():
    from smr.core.config import AzureOpenAIConfig
    from smr.providers.azure_openai import AzureOpenAIProvider

    # deployment_name explicitly forced empty (not merely omitted — some test
    # environments leak SMR_AZURE_DEPLOYMENT_NAME, e.g. the e2e conftest's
    # module-level os.environ mutation from the monorepo-root .env) so this
    # suite reliably pins the "no silent default_model substitution"
    # contract, which is orthogonal to deployment_name's own precedence
    # contract (covered by TestAzureDeploymentName in
    # test_azure_provider.py) — when set, deployment_name is *meant* to
    # override request.model.
    return AzureOpenAIProvider(
        keyed(
            AzureOpenAIConfig(
                endpoint="https://test.openai.azure.com",
                default_model="azure-default",
                deployment_name="",
            ),
            "k",
        )
    )


def _bedrock():
    from smr.core.config import BedrockConfig
    from smr.providers.bedrock import BedrockProvider

    with patch("boto3.client"):
        return BedrockProvider(BedrockConfig(region="us-east-1", default_model="bedrock-default"))


_PROVIDER_FACTORIES = [
    ("ollama", _ollama, "ollama-default"),
    ("openai_compat", _openai_compat, "compat-default"),
    ("azure", _azure, "azure-default"),
    ("bedrock", _bedrock, "bedrock-default"),
]


class TestProviderResolveModelNoFallback:
    @pytest.mark.parametrize("name,factory,default", _PROVIDER_FACTORIES)
    def test_resolve_model_uses_request_model(self, name, factory, default):
        provider = factory()
        req = GenerateRequest(prompt="hi", model="caller-model")
        assert provider._resolve_model(req) == "caller-model"

    @pytest.mark.parametrize("name,factory,default", _PROVIDER_FACTORIES)
    def test_resolve_model_does_not_fall_back_to_default(self, name, factory, default):
        provider = factory()
        req = GenerateRequest(prompt="hi")  # model omitted
        # The generation path no longer substitutes the configured default.
        assert provider._resolve_model(req) != default
        assert provider._resolve_model(req) is None


class TestDefaultModelRetainedAsInformational:
    """Decision 3: keep the informational ``default_model`` field — do not drop it."""

    @pytest.mark.parametrize("name,factory,default", _PROVIDER_FACTORIES)
    def test_default_model_field_retained(self, name, factory, default):
        provider = factory()
        assert provider._default_model == default
