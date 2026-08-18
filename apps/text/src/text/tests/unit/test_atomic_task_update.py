"""TDD tests for atomic TaskManager.update_task() via Redis Lua script.

The current GET+SET pattern in update_task() has a race condition: concurrent
updates can overwrite each other. These tests verify that the Lua-script-based
atomic update fixes that.

Uses fakeredis[lua] which supports EVAL with cjson.

RED: Written before the Lua implementation.
"""

from __future__ import annotations

import asyncio

import fakeredis.aioredis as fakeasync
import pytest
import pytest_asyncio

from text.models.task import TaskStatus
from text.services.task_manager import TaskManager


@pytest_asyncio.fixture
async def redis_client():
    """Real-ish Redis via fakeredis (supports Lua scripts)."""
    r = fakeasync.FakeRedis()
    yield r
    await r.flushall()
    await r.aclose()


@pytest_asyncio.fixture
async def task_manager(redis_client):
    return TaskManager(redis=redis_client, task_ttl=3600)


class TestAtomicUpdateBasic:
    """Core update_task behaviour with the atomic implementation."""

    @pytest.mark.asyncio
    async def test_update_task_returns_updated_state(self, task_manager):
        task = await task_manager.create_task(provider="ollama", model="llama3")
        updated = await task_manager.update_task(task.task_id, status=TaskStatus.RUNNING)

        assert updated is not None
        assert updated.task_id == task.task_id
        assert updated.status == TaskStatus.RUNNING

    @pytest.mark.asyncio
    async def test_update_task_returns_none_for_missing(self, task_manager):
        result = await task_manager.update_task("nonexistent-id", status=TaskStatus.RUNNING)
        assert result is None

    @pytest.mark.asyncio
    async def test_update_task_preserves_existing_fields(self, task_manager):
        task = await task_manager.create_task(provider="azure", model="gpt-4o", max_retries=5)

        updated = await task_manager.update_task(task.task_id, status=TaskStatus.RUNNING)

        assert updated is not None
        assert updated.provider == "azure"
        assert updated.model == "gpt-4o"
        assert updated.max_retries == 5
        assert updated.status == TaskStatus.RUNNING

    @pytest.mark.asyncio
    async def test_update_status_field(self, task_manager):
        task = await task_manager.create_task(provider="ollama", model="m")

        for target_status in (
            TaskStatus.RUNNING,
            TaskStatus.COMPLETED,
        ):
            updated = await task_manager.update_task(task.task_id, status=target_status)
            assert updated is not None
            assert updated.status == target_status

            persisted = await task_manager.get_task(task.task_id)
            assert persisted is not None
            assert persisted.status == target_status


class TestAtomicUpdateTTL:
    """TTL must survive atomic updates."""

    @pytest.mark.asyncio
    async def test_update_task_sets_ttl(self, redis_client):
        tm = TaskManager(redis=redis_client, task_ttl=120)
        task = await tm.create_task(provider="ollama", model="m")

        await tm.update_task(task.task_id, status=TaskStatus.RUNNING)

        ttl = await redis_client.ttl(f"text:task:{task.task_id}")
        assert ttl > 0
        assert ttl <= 120


class TestAtomicUpdateConcurrency:
    """The whole point: concurrent updates must not lose data."""

    @pytest.mark.asyncio
    async def test_update_task_is_atomic(self, redis_client):
        """Simulate interleaved GET+SET to prove atomicity.

        We wrap redis.get so that the first call yields control after reading,
        giving the second update a chance to complete its full GET+SET cycle
        before the first one writes.  With the old non-atomic code this causes
        the second update's changes to be overwritten.  With the Lua-based
        atomic update both fields survive.
        """
        tm = TaskManager(redis=redis_client, task_ttl=3600)
        task = await tm.create_task(provider="test", model="test-model")

        call_count = 0
        original_get = redis_client.get

        async def interleaving_get(key):
            nonlocal call_count
            call_count += 1
            result = await original_get(key)
            if call_count == 1:
                # Yield control so the second update can run its GET+SET
                await asyncio.sleep(0)
            return result

        redis_client.get = interleaving_get

        _results = await asyncio.gather(
            tm.update_task(task.task_id, status=TaskStatus.RUNNING),
            tm.update_task(task.task_id, total_tokens=100),
        )

        redis_client.get = original_get

        final = await tm.get_task(task.task_id)
        assert final is not None
        assert (
            final.status == TaskStatus.RUNNING
        ), "status update was lost — race condition in GET+SET"
        assert final.total_tokens == 100, "total_tokens update was lost — race condition in GET+SET"

    @pytest.mark.asyncio
    async def test_update_task_uses_eval_not_get_set(self, redis_client):
        """The implementation must use redis.eval() (Lua), not GET+SET."""
        tm = TaskManager(redis=redis_client, task_ttl=3600)
        task = await tm.create_task(provider="test", model="m")

        original_eval = redis_client.eval
        eval_called = False

        async def tracking_eval(*args, **kwargs):
            nonlocal eval_called
            eval_called = True
            return await original_eval(*args, **kwargs)

        redis_client.eval = tracking_eval

        await tm.update_task(task.task_id, status=TaskStatus.RUNNING)

        redis_client.eval = original_eval

        assert eval_called, "update_task must use redis.eval() for atomic Lua-based updates"


class TestCancelUsesAtomicUpdate:
    """cancel_task() delegates to update_task(); must still work."""

    @pytest.mark.asyncio
    async def test_cancel_task_uses_atomic_update(self, task_manager):
        task = await task_manager.create_task(provider="ollama", model="m")
        result = await task_manager.cancel_task(task.task_id)

        assert result is not None
        assert result.status == TaskStatus.CANCELLED

        persisted = await task_manager.get_task(task.task_id)
        assert persisted is not None
        assert persisted.status == TaskStatus.CANCELLED
