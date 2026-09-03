"""TDD tests for XREAD-based blocking stream reads (Task 4.3).

Tests cover:
  - TaskManager.read_chunks_blocking() using XREAD BLOCK
  - SSE endpoint updated to use blocking reads with message IDs

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from text.models.stream import StreamChunk
from text.services.task_manager import TaskManager

# ── Helpers ──


def _chunk_json(type_: str, content: str | None = None, data: dict | None = None) -> str:
    chunk = StreamChunk(type=type_, content=content, data=data)
    return chunk.model_dump_json()


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xread = AsyncMock(return_value=[])
    r.xrange = AsyncMock(return_value=[])
    r.get = AsyncMock(return_value=None)
    r.set = AsyncMock()
    return r


# ═══════════════════════════════════════════════════════════════════════
# TaskManager.read_chunks_blocking() unit tests
# ═══════════════════════════════════════════════════════════════════════


class TestReadChunksBlocking:
    """Tests for the new TaskManager.read_chunks_blocking() method."""

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_returns_chunks(self, mock_redis):
        """When chunks exist, returns them as (msg_id, chunk) tuples."""
        mock_redis.xread = AsyncMock(
            return_value=[
                (
                    b"text:stream:task-123",
                    [
                        (b"1-0", {b"data": _chunk_json("chunk", content="Hello")}),
                        (b"2-0", {b"data": _chunk_json("done", data={"finish_reason": "stop"})}),
                    ],
                )
            ]
        )

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-123", last_id="0-0", block_ms=5000)

        assert len(result) == 2
        msg_id_0, chunk_0 = result[0]
        msg_id_1, chunk_1 = result[1]

        assert msg_id_0 == "1-0"
        assert chunk_0.type == "chunk"
        assert chunk_0.content == "Hello"

        assert msg_id_1 == "2-0"
        assert chunk_1.type == "done"
        assert chunk_1.data == {"finish_reason": "stop"}

        mock_redis.xread.assert_awaited_once_with(
            {"text:stream:task-123": "0-0"},
            block=5000,
            count=100,
        )

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_returns_empty_on_timeout(self, mock_redis):
        """When no chunks arrive within block timeout, returns empty list."""
        mock_redis.xread = AsyncMock(return_value=None)

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-456", last_id="0-0", block_ms=1000)

        assert result == []
        mock_redis.xread.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_resumes_from_last_id(self, mock_redis):
        """Only returns chunks after the given last_id."""
        mock_redis.xread = AsyncMock(
            return_value=[
                (
                    b"text:stream:task-789",
                    [
                        (b"5-0", {b"data": _chunk_json("chunk", content="World")}),
                    ],
                )
            ]
        )

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-789", last_id="4-0", block_ms=5000)

        assert len(result) == 1
        assert result[0][0] == "5-0"
        assert result[0][1].content == "World"

        mock_redis.xread.assert_awaited_once_with(
            {"text:stream:task-789": "4-0"},
            block=5000,
            count=100,
        )

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_handles_bytes(self, mock_redis):
        """Handles both bytes and string field values from Redis."""
        mock_redis.xread = AsyncMock(
            return_value=[
                (
                    b"text:stream:task-b",
                    [
                        (b"10-0", {b"data": b'{"type":"chunk","content":"bytes data"}'}),
                    ],
                )
            ]
        )

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-b", last_id="0-0")

        assert len(result) == 1
        msg_id, chunk = result[0]
        assert msg_id == "10-0"
        assert chunk.type == "chunk"
        assert chunk.content == "bytes data"

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_handles_string_keys(self, mock_redis):
        """Handles string (decoded) field keys from Redis."""
        mock_redis.xread = AsyncMock(
            return_value=[
                (
                    "text:stream:task-s",
                    [
                        ("20-0", {"data": '{"type":"chunk","content":"string keys"}'}),
                    ],
                )
            ]
        )

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-s", last_id="0-0")

        assert len(result) == 1
        msg_id, chunk = result[0]
        assert msg_id == "20-0"
        assert chunk.type == "chunk"
        assert chunk.content == "string keys"

    @pytest.mark.asyncio
    async def test_read_chunks_blocking_empty_result_list(self, mock_redis):
        """When xread returns an empty list, returns empty."""
        mock_redis.xread = AsyncMock(return_value=[])

        tm = TaskManager(redis=mock_redis)
        result = await tm.read_chunks_blocking("task-e", last_id="0-0")

        assert result == []


# ═══════════════════════════════════════════════════════════════════════
# The replay buffer
# ═══════════════════════════════════════════════════════════════════════
#
# The SSE endpoint no longer polls `read_chunks_blocking`: it subscribes to a
# producer that outlives it and replays the durable BACKLOG through
# `TaskManager.read_events` — batched entries, addressed by sequence number.
# The `TaskManager` tests above are unchanged and still cover the blocking
# reader itself; what moved is who calls it.
#
# The endpoint's own surface is covered in `test_stream_endpoint.py`, and the
# live-producer / reconnect guarantees in `test_task818_resumable_streaming.py`.
# What is kept here is the property this file was written for — a stream written
# into Redis reads back, in order, addressable by cursor — restated against the
# batched entries the producer now writes.


def _replaying_redis(mock_redis):
    """Wire xadd/xrange so writes read back, in write order."""
    writes: list[tuple[str, dict]] = []

    async def _xadd(key, fields, **_kw):
        writes.append((key, fields))
        return f"{len(writes)}-0"

    async def _xrange(key, min="-", max="+"):
        return [(f"{i}-0", f) for i, (k, f) in enumerate(writes, 1) if k == key]

    mock_redis.xadd = AsyncMock(side_effect=_xadd)
    mock_redis.xrange = AsyncMock(side_effect=_xrange)
    return writes


class TestBatchedEntriesReadBackInOrder:
    @pytest.mark.asyncio
    async def test_batched_writes_replay_every_delta_in_order(self, mock_redis):
        from text.routing.hub import GenerationEvent

        writes = _replaying_redis(mock_redis)
        tm = TaskManager(redis=mock_redis)

        await tm.append_batch("task-123", [GenerationEvent(1, "chunk", '{"content":"Hello"}')])
        await tm.append_batch(
            "task-123",
            [
                GenerationEvent(2, "chunk", '{"content":" world"}'),
                GenerationEvent(3, "done", '{"finish_reason":"stop"}'),
            ],
        )

        # Two durable writes for three deltas — the coalescing AC-5 asks for.
        assert len(writes) == 2

        events = await tm.read_events("task-123")
        assert [(e.seq, e.event) for e in events] == [(1, "chunk"), (2, "chunk"), (3, "done")]
        assert events[0].payload == '{"content":"Hello"}'

    @pytest.mark.asyncio
    async def test_read_events_resumes_from_a_sequence_cursor(self, mock_redis):
        from text.routing.hub import GenerationEvent

        _replaying_redis(mock_redis)
        tm = TaskManager(redis=mock_redis)
        await tm.append_batch(
            "task-789",
            [GenerationEvent(s, "chunk", f'{{"content":"c{s}"}}') for s in range(1, 6)],
        )

        assert [e.seq for e in await tm.read_events("task-789", after_seq=3)] == [4, 5]

    @pytest.mark.asyncio
    async def test_a_per_chunk_entry_still_replays_alongside_batches(self, mock_redis):
        """The terminal frame is written per-chunk; a mixed stream must read back."""
        from text.models.stream import StreamChunk
        from text.routing.hub import GenerationEvent

        _replaying_redis(mock_redis)
        tm = TaskManager(redis=mock_redis)
        await tm.append_batch(
            "task-mix",
            [GenerationEvent(s, "chunk", f'{{"content":"c{s}"}}') for s in (1, 2)],
        )
        await tm.append_chunk("task-mix", StreamChunk(type="done", data={"finish_reason": "stop"}))

        events = await tm.read_events("task-mix")
        assert [(e.seq, e.event) for e in events] == [(1, "chunk"), (2, "chunk"), (3, "done")]
