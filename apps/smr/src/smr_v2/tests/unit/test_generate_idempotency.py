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

from smr_v2.models.task import TaskStatus


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


class TestGenerateIdempotencyFailurePosture:
    """The dedup cache is STRICTLY best-effort — a Redis outage must degrade to normal
    generation, NEVER fail an otherwise-serviceable request. A cache-write failure on an
    already-billed generation that flipped to 502 + task-FAILED + a false circuit-breaker
    failure would make the harness retry and re-invoke the model = the very C1-04 double-bill
    this ticket closes (review CRITICAL)."""

    @pytest.mark.asyncio
    async def test_cache_write_failure_does_not_fail_billed_generation(
        self, app, client, mock_provider, mock_task_manager
    ):
        # MISS on read (so we generate) but the idempotency WRITE fails — e.g. Redis OOM under
        # maxmemory+noeviction on a large SOAP note, or a dropped connection.
        erroring_redis = AsyncMock()
        erroring_redis.get = AsyncMock(return_value=None)
        erroring_redis.set = AsyncMock(side_effect=ConnectionError("redis OOM"))
        app.state.redis = erroring_redis
        # A circuit breaker that must NOT see a failure from a swallowed cache-write error
        # (a false failure could trip it OPEN → 503s for healthy traffic).
        cb = MagicMock()
        cb.allow_request.return_value = True
        app.state.circuit_breakers = {"lm-studio": cb}

        resp = await client.post(
            "/api/v1/generate", json=_BODY, headers={"Idempotency-Key": "wf-run:act-1"}
        )

        # The already-billed generation is returned intact — NOT discarded into a 502.
        assert resp.status_code == 200
        assert resp.json()["content"] == "Generated summary"
        assert resp.json()["status"] == "completed"
        # The model was invoked exactly once (no re-bill).
        assert mock_provider.generate.await_count == 1
        # The write was attempted (and swallowed).
        erroring_redis.set.assert_awaited_once()
        # The task is COMPLETED, never flipped to FAILED by the swallowed cache error.
        statuses = [c.kwargs.get("status") for c in mock_task_manager.update_task.call_args_list]
        assert TaskStatus.COMPLETED in statuses
        assert TaskStatus.FAILED not in statuses
        # No FALSE circuit-breaker failure; the successful generation recorded a success.
        cb.record_failure.assert_not_called()
        cb.record_success.assert_called_once()

    @pytest.mark.asyncio
    async def test_cache_read_failure_falls_through_to_generation(self, app, client, mock_provider):
        # A live-but-erroring Redis on the READ must NOT 500 — it degrades to normal generation.
        erroring_redis = AsyncMock()
        erroring_redis.get = AsyncMock(side_effect=ConnectionError("redis unreachable"))
        erroring_redis.set = AsyncMock(return_value=True)
        app.state.redis = erroring_redis

        resp = await client.post(
            "/api/v1/generate", json=_BODY, headers={"Idempotency-Key": "wf-run:act-1"}
        )

        # Falls through to a normal 200 generation (not a 500 from the unguarded read).
        assert resp.status_code == 200
        assert resp.json()["content"] == "Generated summary"
        assert mock_provider.generate.await_count == 1
        # The read was attempted; after it failed we still cached the fresh generation.
        erroring_redis.get.assert_awaited_once()
        erroring_redis.set.assert_awaited_once()
