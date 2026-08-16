"""Degrade-away-from-unhealthy routing at the /generate endpoint (TASK-725 Task 2).

Hermetic: registry/task-manager are stubs, no live engines. RED: written before
`generate.py`'s routing check existed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.stream import StreamChunk
from text.services.pool_health import PoolHealthTracker


def _make_provider(name: str) -> AsyncMock:
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            f"served by {name}",
            "",
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
    )

    async def _stream(_request):
        yield StreamChunk(type="chunk", content=f"served by {name}")
        yield StreamChunk(type="done", data={})

    provider.generate_stream = _stream
    return provider


@pytest.fixture
def providers():
    return {"ollama": _make_provider("ollama"), "lm-studio": _make_provider("lm-studio")}


@pytest.fixture
def mock_registry(providers):
    registry = MagicMock()
    registry.get.side_effect = lambda name: providers[name]
    registry.list_providers.return_value = list(providers.keys())
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "test-task-degrade"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest.fixture
def app(mock_registry, mock_task_manager):
    from text.main import create_app

    application = create_app()
    # Explicit plain Settings() — never the env-file-loading default (see
    # tests/conftest.py's leak warning: `.env.dev` on the machine running
    # this suite can carry a real TEXT_SERVICE_TOKEN, which would make the
    # auth middleware reject every unauthenticated test request with 401).
    application.state.settings = Settings(host="127.0.0.1", port=5099, debug=True)
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.app_ref = app  # type: ignore[attr-defined]
        yield c


class TestDegradeRouting:
    @pytest.mark.asyncio
    async def test_healthy_provider_unaffected(self, client, providers):
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "model": "m", "provider": "ollama"},
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "served by ollama"
        providers["ollama"].generate.assert_awaited_once()
        providers["lm-studio"].generate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unhealthy_provider_no_fallback_fails_fast(self, client, app):
        app.state.pool_health_tracker.record("ollama", False)
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "model": "m", "provider": "ollama"},
        )
        assert resp.status_code == 503
        assert resp.json()["error_code"] == "POOL_UNHEALTHY"
        assert resp.headers["retry-after"] == "30"

    @pytest.mark.asyncio
    async def test_unhealthy_provider_with_registered_fallback_reroutes(
        self, client, app, providers
    ):
        app.state.pool_health_tracker.record("ollama", False)
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "hello",
                "model": "m",
                "provider": "ollama",
                "fallback_provider": "lm-studio",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "served by lm-studio"
        assert resp.json()["provider"] == "lm-studio"
        providers["lm-studio"].generate.assert_awaited_once()
        providers["ollama"].generate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unhealthy_provider_with_unregistered_fallback_fails_fast(self, client, app):
        app.state.pool_health_tracker.record("ollama", False)
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "hello",
                "model": "m",
                "provider": "ollama",
                "fallback_provider": "does-not-exist",
            },
        )
        assert resp.status_code == 503
        assert resp.json()["error_code"] == "POOL_UNHEALTHY"

    @pytest.mark.asyncio
    async def test_unknown_health_state_dispatches_normally(self, client, providers):
        """A provider nobody has health-checked yet is not blocked (fail-open on
        unknown — see services/pool_health.py)."""
        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "model": "m", "provider": "lm-studio"},
        )
        assert resp.status_code == 200
        providers["lm-studio"].generate.assert_awaited_once()


class TestPoolHealthTrackerFixture:
    def test_tracker_always_present_without_lifespan(self, app):
        """create_app() eagerly constructs the tracker — see main.py."""
        assert isinstance(app.state.pool_health_tracker, PoolHealthTracker)
