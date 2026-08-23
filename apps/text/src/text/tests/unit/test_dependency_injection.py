"""TDD tests for FastAPI dependency injection wiring.

Verifies that all endpoints use Depends() for shared resources
instead of accessing request.app.state directly.

RED phase: test_dependency_override_works should FAIL before
endpoints are updated to use Depends().
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.core.dependencies import get_provider_registry, get_task_manager
from text.models.provider import ModelInfo, ProviderInfo
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry


@pytest.fixture
def settings():
    return Settings(port=5099, log_level="debug")


@pytest.fixture
def mock_provider_registry():
    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        )
    )
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


class TestGenerateUsesInjectedRegistry:
    @pytest.mark.asyncio
    async def test_generate_uses_injected_registry(self, client):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "Hello", "provider": "ollama", "model": "test-model", "stream": False},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated text!"
        assert data["provider"] == "ollama"


class TestHealthUsesInjectedRegistry:
    @pytest.mark.asyncio
    async def test_health_uses_injected_registry(self, client):
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert "ollama" in data["checks"]
        assert data["checks"]["ollama"]["status"] == "healthy"


class TestTasksUsesInjectedTaskManager:
    @pytest.mark.asyncio
    async def test_get_task_uses_injected_task_manager(self, client):
        resp = await client.get("/api/v1/tasks/task-123")
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] == "task-123"

    @pytest.mark.asyncio
    async def test_cancel_task_uses_injected_task_manager(self, client):
        resp = await client.post("/api/v1/tasks/task-123/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"


class TestProvidersUsesInjectedRegistry:
    @pytest.mark.asyncio
    async def test_providers_uses_injected_registry(self, client):
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        assert data[0]["name"] == "ollama"


class TestStreamUsesInjectedTaskManager:
    @pytest.mark.asyncio
    async def test_stream_uses_injected_task_manager(self, client, mock_task_manager):
        mock_task_manager.get_task = AsyncMock(
            return_value=TaskState(
                task_id="task-123",
                status=TaskStatus.COMPLETED,
                provider="ollama",
                model="llama3.2:latest",
            )
        )
        # The SSE endpoint reads via read_chunk_ENTRIES_blocking (TASK-636 added
        # it to carry the message id + trace carrier alongside each chunk).
        # Stubbing the older read_chunks_blocking left the real name unstubbed,
        # so the AsyncMock auto-created it and returned a MagicMock — which is
        # TRUTHY but iterates EMPTY. The generator's `for` body never ran and
        # `if not entries:` was never true, so the endpoint looped forever,
        # accumulating mock call records until the OOM killer took the process
        # (~15 min of silence, then exit 137 in CI).
        mock_task_manager.read_chunk_entries_blocking = AsyncMock(return_value=[])
        resp = await client.get("/api/v1/tasks/task-123/stream")
        assert resp.status_code == 200


class TestDependencyOverrideWorks:
    """Key test: verifies endpoints use Depends() so overrides work.

    This test MUST FAIL before the refactor (endpoints use app.state directly)
    and PASS after (endpoints use Depends()).
    """

    @pytest.mark.asyncio
    async def test_dependency_override_replaces_registry(self, app):
        override_registry = ProviderRegistry()
        override_provider = AsyncMock()
        override_provider.health_check = AsyncMock(return_value=True)
        override_provider.get_info = AsyncMock(
            return_value=ProviderInfo(
                name="override-provider",
                display_name="Override",
                status="available",
                default_model="override-model",
                models=[ModelInfo(name="override-model")],
                supports_streaming=False,
            )
        )
        override_registry.register("override-provider", override_provider)

        app.dependency_overrides[get_provider_registry] = lambda: override_registry

        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                resp = await c.get("/api/v1/health")
                assert resp.status_code == 200
                data = resp.json()
                assert "override-provider" in data["checks"]
                assert "ollama" not in data["checks"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_dependency_override_replaces_task_manager(self, app):
        override_tm = AsyncMock()
        override_tm.get_task = AsyncMock(
            return_value=TaskState(
                task_id="override-task-999",
                status=TaskStatus.COMPLETED,
                provider="test",
                model="test-model",
            )
        )

        app.dependency_overrides[get_task_manager] = lambda: override_tm

        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                resp = await c.get("/api/v1/tasks/override-task-999")
                assert resp.status_code == 200
                data = resp.json()
                assert data["task_id"] == "override-task-999"
        finally:
            app.dependency_overrides.clear()
