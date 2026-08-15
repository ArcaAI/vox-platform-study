"""TDD tests for API endpoints.

Tests use httpx.AsyncClient with ASGITransport to hit the FastAPI app.
All external deps (providers, redis, task manager) are mocked.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.provider import ModelInfo, ProviderInfo
from text.models.task import TaskState, TaskStatus


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def mock_provider_registry():
    from text.models.stream import StreamChunk
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        )
    )

    async def _generate_stream(_request):
        yield StreamChunk(type="chunk", content="Generated text!")
        yield StreamChunk(type="done", data={})

    mock_provider.generate_stream = _generate_stream
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
    mock_provider.health_check = AsyncMock(return_value=True)
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.get_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.COMPLETED,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.cancel_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.CANCELLED,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


@pytest_asyncio.fixture
async def app(settings, mock_provider_registry, mock_task_manager):
    from text.main import create_app

    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    application.state.settings = settings
    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(return_value=True)
    application.state.redis = mock_redis
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Health endpoint ──


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_200(self, client):
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_health_includes_providers(self, client):
        resp = await client.get("/api/v1/health")
        data = resp.json()
        assert "checks" in data


# ── Providers endpoint ──


class TestProvidersEndpoint:
    @pytest.mark.asyncio
    async def test_list_providers(self, client):
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert data[0]["name"] == "ollama"


# ── Generate endpoint ──


class TestGenerateEndpoint:
    @pytest.mark.asyncio
    async def test_generate_non_streaming(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] is not None
        assert data["content"] == "Generated text!"

    @pytest.mark.asyncio
    async def test_generate_streaming_returns_task_urls(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello",
                "provider": "ollama",
                "model": "test-model",
                "stream": True,
            },
        )
        assert resp.status_code == 202
        data = resp.json()
        assert "task_id" in data
        assert "stream_url" in data
        assert "ws_url" not in data

    @pytest.mark.asyncio
    async def test_generate_empty_prompt_returns_422(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "",
                "provider": "ollama",
            },
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_generate_unknown_provider_returns_404(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello",
                "provider": "nonexistent",
                "model": "test-model",
            },
        )
        assert resp.status_code == 404


# ── Tasks endpoint ──


class TestTasksEndpoint:
    @pytest.mark.asyncio
    async def test_get_task_status(self, client):
        resp = await client.get("/api/v1/tasks/task-123")
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] == "task-123"

    @pytest.mark.asyncio
    async def test_get_task_not_found(self, client, mock_task_manager):
        mock_task_manager.get_task = AsyncMock(return_value=None)
        resp = await client.get("/api/v1/tasks/nonexistent")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_cancel_task(self, client):
        resp = await client.post("/api/v1/tasks/task-123/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"
