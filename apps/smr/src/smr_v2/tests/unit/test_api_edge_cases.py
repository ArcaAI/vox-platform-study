"""Edge case tests for API endpoints.

Covers: generate 502, streaming background task error path,
health with unhealthy/erroring providers, stream endpoint 404,
cancel nonexistent task, providers empty registry.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.models.provider import ProviderInfo
from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=False)


def _make_provider(*, generate_exc=None, health_result=True, health_exc=None, info=None):
    """Create a mock provider with controllable behavior."""
    p = AsyncMock()
    if generate_exc:
        p.generate = AsyncMock(side_effect=generate_exc)
    else:
        p.generate = AsyncMock(return_value="ok")
    if health_exc:
        p.health_check = AsyncMock(side_effect=health_exc)
    else:
        p.health_check = AsyncMock(return_value=health_result)
    p.get_info = AsyncMock(return_value=info or ProviderInfo(
        name="test", display_name="Test", status="available",
        default_model="m", models=[], supports_streaming=True,
    ))
    return p


def _make_task_manager(**overrides):
    tm = AsyncMock()
    tm.create_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.PENDING, provider="test", model="m",
    ))
    tm.get_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.COMPLETED, provider="test", model="m",
    ))
    tm.update_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.RUNNING, provider="test", model="m",
    ))
    tm.cancel_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.CANCELLED, provider="test", model="m",
    ))
    tm.get_chunks = AsyncMock(return_value=[])
    tm.read_chunks_blocking = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    for k, v in overrides.items():
        setattr(tm, k, v)
    return tm


def _build_app(settings, registry, task_manager):
    from smr_v2.main import create_app
    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.settings = settings
    return app


# ── Generate: provider error → 502 ──


class TestGenerateProviderError:
    @pytest_asyncio.fixture
    async def client(self, settings):
        registry = ProviderRegistry()
        registry.register("broken", _make_provider(generate_exc=RuntimeError("GPU OOM")))
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_generate_returns_502_on_provider_exception(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hi", "provider": "broken"})
        assert resp.status_code == 502
        assert "internal error" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_generate_updates_task_to_failed(self, client, settings):
        """Verify that when provider fails, task manager is called with FAILED status."""
        registry = ProviderRegistry()
        registry.register("broken", _make_provider(generate_exc=ValueError("bad")))
        tm = _make_task_manager()
        app = _build_app(settings, registry, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.post("/api/v1/generate", json={"prompt": "hi", "provider": "broken"})
        tm.update_task.assert_any_call("t-1", status=TaskStatus.FAILED, error="bad")


# ── Generate: missing body fields ──


class TestGenerateValidation:
    @pytest_asyncio.fixture
    async def client(self, settings):
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_missing_prompt_returns_422(self, client):
        resp = await client.post("/api/v1/generate", json={"provider": "ollama"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_invalid_json_returns_422(self, client):
        resp = await client.post("/api/v1/generate", content=b"not json",
                                  headers={"content-type": "application/json"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_temperature_out_of_range_returns_422(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hi", "temperature": 5.0})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_max_tokens_negative_returns_422(self, client):
        resp = await client.post("/api/v1/generate", json={"prompt": "hi", "max_tokens": -10})
        assert resp.status_code == 422


# ── Health: unhealthy and erroring providers ──


class TestHealthEdgeCases:
    @pytest_asyncio.fixture
    async def client(self, settings):
        registry = ProviderRegistry()
        registry.register("healthy", _make_provider(health_result=True))
        registry.register("unhealthy", _make_provider(health_result=False))
        registry.register("erroring", _make_provider(health_exc=ConnectionError("down")))
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_mixed_provider_health(self, client):
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["checks"]["healthy"]["status"] == "healthy"
        assert data["checks"]["unhealthy"]["status"] == "unhealthy"
        assert data["checks"]["erroring"]["status"] == "unhealthy"

    @pytest.mark.asyncio
    async def test_health_degraded_when_all_down(self, settings):
        """Health endpoint returns 200 with 'unhealthy' when all providers are down."""
        registry = ProviderRegistry()
        registry.register("down", _make_provider(health_result=False))
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/v1/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "unhealthy"


# ── Health: empty registry ──


class TestHealthNoProviders:
    @pytest.mark.asyncio
    async def test_health_with_no_providers(self, settings):
        registry = ProviderRegistry()
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/v1/health")
        assert resp.status_code == 200
        assert resp.json()["checks"] == {}


# ── Providers: empty registry ──


class TestProvidersEmpty:
    @pytest.mark.asyncio
    async def test_list_providers_empty(self, settings):
        registry = ProviderRegistry()
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/v1/providers")
        assert resp.status_code == 200
        assert resp.json() == []


# ── Tasks: cancel nonexistent ──


class TestTasksEdgeCases:
    @pytest.mark.asyncio
    async def test_cancel_nonexistent_returns_404(self, settings):
        tm = _make_task_manager(cancel_task=AsyncMock(return_value=None))
        registry = ProviderRegistry()
        app = _build_app(settings, registry, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/v1/tasks/nonexistent/cancel")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_get_task_returns_all_fields(self, settings):
        """Verify the response includes all task state fields."""
        tm = _make_task_manager(get_task=AsyncMock(return_value=TaskState(
            task_id="t-1", status=TaskStatus.RUNNING, provider="ollama", model="m",
            retry_count=1, max_retries=3, total_chunks=50, total_tokens=1000,
        )))
        app = _build_app(settings, ProviderRegistry(), tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/v1/tasks/t-1")
        data = resp.json()
        assert data["retry_count"] == 1
        assert data["total_chunks"] == 50
        assert data["total_tokens"] == 1000


# ── Stream: 404 ──


class TestStreamEndpoint:
    @pytest.mark.asyncio
    async def test_stream_nonexistent_task_returns_404(self, settings):
        tm = _make_task_manager(get_task=AsyncMock(return_value=None))
        app = _build_app(settings, ProviderRegistry(), tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/api/v1/tasks/nope/stream")
        assert resp.status_code == 404


# ── Background streaming task error path ──


class TestStreamingGenerationBackground:
    @pytest.mark.asyncio
    async def test_streaming_error_appends_error_chunk_and_fails_task(self):
        from smr_v2.api.endpoints.generate import _run_streaming_generation
        from smr_v2.models.requests import GenerateRequest

        tm = AsyncMock()
        tm.update_task = AsyncMock()
        tm.append_chunk = AsyncMock()

        provider = AsyncMock()

        async def _failing_stream(req):
            yield StreamChunk(type="chunk", content="partial")
            raise RuntimeError("Mid-stream failure")

        provider.generate_stream = _failing_stream

        req = GenerateRequest(prompt="hi", stream=True)
        await _run_streaming_generation(tm, provider, "t-1", req)

        tm.update_task.assert_any_call("t-1", status=TaskStatus.RUNNING)
        tm.update_task.assert_any_call("t-1", status=TaskStatus.FAILED, error="Mid-stream failure")

        error_calls = [c for c in tm.append_chunk.call_args_list if c.args[1].type == "error"]
        assert len(error_calls) == 1
        assert "internal error" in error_calls[0].args[1].data["error"].lower()

    @pytest.mark.asyncio
    async def test_streaming_success_completes_task(self):
        from smr_v2.api.endpoints.generate import _run_streaming_generation
        from smr_v2.models.requests import GenerateRequest

        tm = AsyncMock()
        tm.update_task = AsyncMock()
        tm.append_chunk = AsyncMock()

        provider = AsyncMock()

        async def _ok_stream(req):
            yield StreamChunk(type="chunk", content="hello")
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider.generate_stream = _ok_stream

        req = GenerateRequest(prompt="hi", stream=True)
        await _run_streaming_generation(tm, provider, "t-1", req)

        tm.update_task.assert_any_call("t-1", status=TaskStatus.RUNNING)
        tm.update_task.assert_any_call("t-1", status=TaskStatus.COMPLETED)
        assert tm.append_chunk.call_count == 2
