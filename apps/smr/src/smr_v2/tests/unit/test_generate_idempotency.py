"""TASK-469 (C1-04): idempotent synchronous ``/generate``.

A deterministic ``Idempotency-Key`` (set by the harness from ``workflow_run:activity_id``)
lets a worker-crash re-delivery return the FIRST generation from SMR's Redis instead of
re-invoking — and re-billing — the model. TASK-458 narrowed the in-process re-send paths;
this closes the cross-process replay path on the receiver.

RED-first: written before the endpoint reads the key or dedups via Redis. With no dedup,
the same key twice bills the model twice and nothing is cached.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import fakeredis.aioredis as fakeasync
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def mock_provider():
    """A provider whose ``generate`` returns a ``(content, usage)`` tuple."""
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "Generated summary",
            {"prompt_tokens": 50, "completion_tokens": 100, "total_tokens": 150},
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
    task_state.task_id = "test-task-123"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest_asyncio.fixture
async def redis_client():
    """Real-ish Redis via fakeredis (the receiver's dedup store)."""
    r = fakeasync.FakeRedis(decode_responses=True)
    yield r
    await r.flushall()
    await r.aclose()


@pytest.fixture
def app(mock_registry, mock_task_manager, redis_client):
    from smr_v2.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    application.state.redis = redis_client
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


_BODY = {"prompt": "hello", "model": "test-model"}


class TestGenerateIdempotency:
    """C1-04: the synchronous generate endpoint dedups on the ``Idempotency-Key`` header."""

    @pytest.mark.asyncio
    async def test_same_key_twice_invokes_provider_once(self, client, mock_provider):
        headers = {"Idempotency-Key": "wf-run:act-1"}
        r1 = await client.post("/api/v1/generate", json=_BODY, headers=headers)
        r2 = await client.post("/api/v1/generate", json=_BODY, headers=headers)

        assert r1.status_code == 200
        assert r2.status_code == 200
        # The model was billed EXACTLY once — the replay returned the cached result.
        assert mock_provider.generate.await_count == 1
        # The second (replayed) call returns the identical first response.
        assert r2.json()["content"] == "Generated summary"
        assert r2.json()["usage"]["total_tokens"] == 150
        assert r2.json()["model"] == "test-model"
        # Same created_at ⇒ it is genuinely the cached FIRST generation, not a re-run.
        assert r2.json()["created_at"] == r1.json()["created_at"]

    @pytest.mark.asyncio
    async def test_no_key_always_generates(self, client, mock_provider):
        r1 = await client.post("/api/v1/generate", json=_BODY)
        r2 = await client.post("/api/v1/generate", json=_BODY)

        assert r1.status_code == 200
        assert r2.status_code == 200
        # No key → no dedup → each call bills the model (current behavior preserved).
        assert mock_provider.generate.await_count == 2

    @pytest.mark.asyncio
    async def test_different_key_generates_again(self, client, mock_provider):
        r1 = await client.post(
            "/api/v1/generate", json=_BODY, headers={"Idempotency-Key": "wf-run:act-1"}
        )
        r2 = await client.post(
            "/api/v1/generate", json=_BODY, headers={"Idempotency-Key": "wf-run:act-2"}
        )

        assert r1.status_code == 200
        assert r2.status_code == 200
        # Distinct logical generates → distinct keys → the model runs for each.
        assert mock_provider.generate.await_count == 2

    @pytest.mark.asyncio
    async def test_cache_hit_returns_full_response_shape(self, client, mock_provider, redis_client):
        headers = {"Idempotency-Key": "wf-run:act-1"}
        r1 = await client.post("/api/v1/generate", json=_BODY, headers=headers)

        # The completed response is cached under smr:idem:{key} with a bounded TTL.
        assert await redis_client.get("smr:idem:wf-run:act-1") is not None
        assert await redis_client.ttl("smr:idem:wf-run:act-1") > 0

        r2 = await client.post("/api/v1/generate", json=_BODY, headers=headers)
        data = r2.json()
        # The full GenerateResponse shape survives the cache round-trip.
        assert data["content"] == "Generated summary"
        assert data["usage"] == {
            "prompt_tokens": 50,
            "completion_tokens": 100,
            "total_tokens": 150,
        }
        assert data["model"] == "test-model"
        assert data["provider"] == "lm-studio"
        assert data["status"] == "completed"
        assert data["finish_reason"] == "stop"
        assert data["task_id"] == r1.json()["task_id"]
        assert mock_provider.generate.await_count == 1
