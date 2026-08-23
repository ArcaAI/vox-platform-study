"""Text is a stateless gateway with NO model default.

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

from text.models.requests import GenerateRequest

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
    from text.main import create_app

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


def _openai_compat():
    from text.providers.openai_compat import OpenAICompatProvider

    return OpenAICompatProvider()


def _azure():
    from text.providers.azure_openai import AzureOpenAIProvider

    # No environment can leak a deployment into this any more: a deployment
    # arrives on the connection, and this provider is built without one. (Its own
    # precedence contract — a pinned deployment overrides `request.model` — is
    # covered by TestAzureDeploymentName in test_azure_provider.py.)
    return AzureOpenAIProvider()


def _bedrock():
    from text.providers.bedrock import BedrockProvider

    with patch("boto3.client"):
        return BedrockProvider()


_PROVIDER_FACTORIES = [
    ("openai_compat", _openai_compat),
    ("azure", _azure),
    ("bedrock", _bedrock),
]


class TestProviderResolveModelNoFallback:
    @pytest.mark.parametrize("name,factory", _PROVIDER_FACTORIES)
    def test_resolve_model_uses_request_model(self, name, factory):
        provider = factory()
        req = GenerateRequest(prompt="hi", model="caller-model")
        assert provider._resolve_model(req) == "caller-model"

    @pytest.mark.parametrize("name,factory", _PROVIDER_FACTORIES)
    def test_resolve_model_returns_none_when_the_caller_supplied_none(self, name, factory):
        provider = factory()
        req = GenerateRequest(prompt="hi")  # model deliberately omitted
        assert provider._resolve_model(req) is None


class TestNoInformationalDefaultSurvives:
    """Decision 3 kept an informational ``default_model`` field. TASK-799 lane B
    removed it.

    Keeping it was defensible while it only decorated the `/providers` listing —
    but a typed, named field holding a real engine-specific id is one edit away
    from being read on a generation path, and one drift away from being wrong:
    `TEXT_OPENAI_COMPAT_DEFAULT_MODEL` carried a stale `google/gemma-4-e4b` that
    LM Studio never served, 400ing every request that reached it, and the same id
    had already propagated into the AiModel catalogue. The catalogue is the
    single place a model id belongs.
    """

    @pytest.mark.parametrize("name,factory", _PROVIDER_FACTORIES)
    def test_no_adapter_holds_a_default_model(self, name, factory):
        assert not hasattr(factory(), "_default_model")

    @pytest.mark.parametrize("name,factory", _PROVIDER_FACTORIES)
    def test_no_adapter_advertises_one_either(self, name, factory):
        import asyncio

        info = asyncio.run(factory().get_info())
        assert info.default_model == ""
