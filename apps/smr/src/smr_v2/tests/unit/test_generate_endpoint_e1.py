"""TDD tests for E1.6 — Generate endpoint with token usage from providers.

Tests that the /generate endpoint correctly handles tuple (content, usage)
returns from providers and includes usage in the response.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def mock_provider():
    """Create a mock provider that returns (content, usage) tuple."""
    from smr_v2.models.stream import StreamChunk

    provider = AsyncMock()
    provider.generate = AsyncMock(return_value=("Generated summary", "", {
        "prompt_tokens": 50,
        "completion_tokens": 100,
        "total_tokens": 150,
    }))

    async def _generate_stream(_request):
        yield StreamChunk(type="chunk", content="Generated summary")
        yield StreamChunk(type="usage", data={
            "prompt_tokens": 50,
            "completion_tokens": 100,
            "total_tokens": 150,
        })
        yield StreamChunk(type="done", data={})

    provider.generate_stream = _generate_stream
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
    task_state.task_id = "test-task-123"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest.fixture
def app(mock_registry, mock_task_manager):
    from smr_v2.main import create_app
    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestGenerateEndpointTokenUsage:
    """The /generate endpoint should include token usage in response."""

    @pytest.mark.asyncio
    async def test_sync_generate_includes_usage(self, client, mock_provider):
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["usage"]["prompt_tokens"] == 50
        assert data["usage"]["completion_tokens"] == 100
        assert data["usage"]["total_tokens"] == 150

    @pytest.mark.asyncio
    async def test_sync_generate_includes_content(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated summary"

    @pytest.mark.asyncio
    async def test_sync_generate_with_response_format(self, client, mock_provider):
        mock_provider.generate = AsyncMock(return_value=('{"plan":"rest"}', "", {
            "prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40,
        }))
        resp = await client.post("/api/v1/generate", json={
            "prompt": "hello",
            "model": "test-model",
            "response_format": {"type": "json_schema", "json_schema": {"type": "object"}, "strict": True},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == '{"plan":"rest"}'
        assert data["usage"]["total_tokens"] == 40

    @pytest.mark.asyncio
    async def test_sync_generate_with_explicit_hyperparams(self, client, mock_provider):
        resp = await client.post("/api/v1/generate", json={
            "prompt": "hello",
            "model": "test-model",
            "temperature": 0.1,
            "max_tokens": 6000,
            "top_p": 0.95,
        })
        assert resp.status_code == 200
        call_args = mock_provider.generate.call_args[0][0]
        assert call_args.temperature == 0.1
        assert call_args.max_tokens == 6000
        assert call_args.top_p == 0.95

    @pytest.mark.asyncio
    async def test_sync_generate_with_none_hyperparams(self, client, mock_provider):
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})
        assert resp.status_code == 200
        call_args = mock_provider.generate.call_args[0][0]
        assert call_args.temperature is None
        assert call_args.max_tokens is None
        assert call_args.top_p is None

    @pytest.mark.asyncio
    async def test_streaming_generate_returns_202(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model", "stream": True})
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "running"
        assert "stream_url" in data

    @pytest.mark.asyncio
    async def test_provider_not_found_returns_404(self, client, mock_registry):
        from smr_v2.providers.base import ProviderNotFoundError
        mock_registry.get.side_effect = ProviderNotFoundError("not found")
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_provider_error_returns_502(self, client, mock_provider):
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("LLM error"))
        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "test-model"})
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_empty_prompt_returns_422(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": ""})
        assert resp.status_code == 422
