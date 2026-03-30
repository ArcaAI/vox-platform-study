"""TDD tests for TaskManager with mocked Redis.

The TaskManager wraps Redis Streams for task state + chunk persistence.
We mock the redis client to avoid requiring a running Redis.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskState, TaskStatus


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.set = AsyncMock()
    r.get = AsyncMock(return_value=None)
    r.delete = AsyncMock()
    r.xadd = AsyncMock(return_value=b"1234567890-0")
    r.xrange = AsyncMock(return_value=[])
    r.xread = AsyncMock(return_value=[])
    r.xlen = AsyncMock(return_value=0)
    return r


class TestTaskManagerCreate:
    @pytest.mark.asyncio
    async def test_create_task_returns_state(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        tm = TaskManager(redis=mock_redis)
        state = await tm.create_task(provider="ollama", model="llama3.2:latest")
        assert isinstance(state, TaskState)
        assert state.status == TaskStatus.PENDING
        assert state.provider == "ollama"

    @pytest.mark.asyncio
    async def test_create_task_generates_unique_id(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        tm = TaskManager(redis=mock_redis)
        s1 = await tm.create_task(provider="ollama", model="m")
        s2 = await tm.create_task(provider="ollama", model="m")
        assert s1.task_id != s2.task_id

    @pytest.mark.asyncio
    async def test_create_task_stores_in_redis(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        tm = TaskManager(redis=mock_redis)
        state = await tm.create_task(provider="ollama", model="m")
        mock_redis.set.assert_called_once()
        call_args = mock_redis.set.call_args
        assert state.task_id in str(call_args)


class TestTaskManagerGet:
    @pytest.mark.asyncio
    async def test_get_existing_task(self, mock_redis):

        from smr_v2.services.task_manager import TaskManager
        task_data = TaskState(
            task_id="abc", status=TaskStatus.RUNNING, provider="ollama", model="m"
        ).model_dump_json()
        mock_redis.get = AsyncMock(return_value=task_data.encode())
        tm = TaskManager(redis=mock_redis)
        state = await tm.get_task("abc")
        assert state is not None
        assert state.task_id == "abc"

    @pytest.mark.asyncio
    async def test_get_nonexistent_task_returns_none(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        mock_redis.get = AsyncMock(return_value=None)
        tm = TaskManager(redis=mock_redis)
        state = await tm.get_task("nonexistent")
        assert state is None


class TestTaskManagerUpdate:
    @pytest.mark.asyncio
    async def test_update_status(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        updated_state = TaskState(
            task_id="abc", status=TaskStatus.RUNNING, provider="ollama", model="m"
        )
        mock_redis.eval = AsyncMock(return_value=updated_state.model_dump_json().encode())
        tm = TaskManager(redis=mock_redis)
        updated = await tm.update_task("abc", status=TaskStatus.RUNNING)
        assert updated is not None
        assert updated.status == TaskStatus.RUNNING

    @pytest.mark.asyncio
    async def test_update_nonexistent_returns_none(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        mock_redis.eval = AsyncMock(return_value=None)
        tm = TaskManager(redis=mock_redis)
        result = await tm.update_task("nope", status=TaskStatus.RUNNING)
        assert result is None


class TestTaskManagerStreamChunks:
    @pytest.mark.asyncio
    async def test_append_chunk(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        tm = TaskManager(redis=mock_redis)
        chunk = StreamChunk(type="chunk", content="Hello")
        await tm.append_chunk("task-1", chunk)
        mock_redis.xadd.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_chunks(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        mock_redis.xrange = AsyncMock(return_value=[
            (b"1-0", {b"data": b'{"type":"chunk","content":"Hello"}'}),
            (b"2-0", {b"data": b'{"type":"chunk","content":" world"}'}),
        ])
        tm = TaskManager(redis=mock_redis)
        chunks = await tm.get_chunks("task-1")
        assert len(chunks) == 2
        assert chunks[0].content == "Hello"

    @pytest.mark.asyncio
    async def test_get_chunks_from_offset(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        mock_redis.xrange = AsyncMock(return_value=[
            (b"2-0", {b"data": b'{"type":"chunk","content":"world"}'}),
        ])
        tm = TaskManager(redis=mock_redis)
        chunks = await tm.get_chunks("task-1", after_id="1-0")
        assert len(chunks) == 1


class TestTaskManagerCancel:
    @pytest.mark.asyncio
    async def test_cancel_task(self, mock_redis):
        from smr_v2.services.task_manager import TaskManager
        cancelled_state = TaskState(
            task_id="abc", status=TaskStatus.CANCELLED, provider="ollama", model="m"
        )
        mock_redis.eval = AsyncMock(return_value=cancelled_state.model_dump_json().encode())
        tm = TaskManager(redis=mock_redis)
        result = await tm.cancel_task("abc")
        assert result is not None
        assert result.status == TaskStatus.CANCELLED
