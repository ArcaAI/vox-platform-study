"""TDD tests for XREAD-based blocking stream reads (Task 4.3).

Tests cover:
  - TaskManager.read_chunks_blocking() using XREAD BLOCK
  - SSE endpoint updated to use blocking reads with message IDs

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.stream import StreamChunk
from text.models.task import TaskState, TaskStatus
from text.services.task_manager import TaskManager

# ── Helpers ──


def _chunk_json(type_: str, content: str | None = None, data: dict | None = None) -> str:
    chunk = StreamChunk(type=type_, content=content, data=data)
    return chunk.model_dump_json()


def _make_task_manager_mock(**overrides) -> AsyncMock:
    """Build a TaskManager double.

    NOTE: `read_chunks_blocking` overrides are mirrored onto
    `read_chunk_entries_blocking` (as 3-tuples) so existing call sites that
    only know the 2-tuple shape keep working after """
    tm = AsyncMock(spec=TaskManager)
    tm.get_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.read_chunks_blocking = AsyncMock(return_value=[])
    # The SSE endpoint now calls the trace-aware variant, which
    # returns (msg_id, chunk, carrier) triples. Without this the AsyncMock(spec=)
    # returns a mock instead of a list and the stream loop misbehaves.
    tm.read_chunk_entries_blocking = AsyncMock(return_value=[])
    tm.get_chunks = AsyncMock(return_value=[])
    for k, v in overrides.items():
        setattr(tm, k, v)

    # A test that overrides the 2-tuple reader must also
    # drive the 3-tuple one the SSE endpoint actually calls, or the
    # override is silently ignored and the AsyncMock(spec=) default wins.
    if 'read_chunks_blocking' in overrides and 'read_chunk_entries_blocking' not in overrides:
        _inner = overrides['read_chunks_blocking']
        async def _as_entries(*a, **kw):
            return [(mid, ch, {}) for mid, ch in await _inner(*a, **kw)]
        tm.read_chunk_entries_blocking = AsyncMock(side_effect=_as_entries)
    return tm


def _build_app(settings, task_manager):
    from text.main import create_app
    from text.providers.base import ProviderRegistry

    app = create_app(settings_override=settings)
    app.state.provider_registry = ProviderRegistry()
    app.state.task_manager = task_manager
    app.state.settings = settings
    return app


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=False
    )


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
# SSE endpoint tests (using XREAD-based blocking reads)
# ═══════════════════════════════════════════════════════════════════════


class TestSSEXreadStreaming:
    """Tests for the SSE endpoint updated to use read_chunks_blocking()."""

    @pytest.mark.asyncio
    async def test_sse_streams_chunks_via_xread(self, settings):
        """SSE endpoint delivers chunks using the new blocking read."""
        call_count = 0

        async def _mock_read_blocking(task_id, last_id="0-0", block_ms=5000):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [
                    ("1-0", StreamChunk(type="chunk", content="Hello")),
                    ("2-0", StreamChunk(type="done", data={"finish_reason": "stop"})),
                ]
            return []

        tm = _make_task_manager_mock(
            read_chunks_blocking=AsyncMock(side_effect=_mock_read_blocking),
        )
        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/task-123/stream")

        assert resp.status_code == 200
        body = resp.text
        assert "Hello" in body

    @pytest.mark.asyncio
    async def test_sse_includes_message_id(self, settings):
        """Each SSE event includes the Redis stream message ID."""

        async def _mock_read_blocking(task_id, last_id="0-0", block_ms=5000):
            if last_id == "0-0":
                return [
                    ("100-0", StreamChunk(type="chunk", content="data")),
                    ("101-0", StreamChunk(type="done", data={"finish_reason": "stop"})),
                ]
            return []

        tm = _make_task_manager_mock(
            read_chunks_blocking=AsyncMock(side_effect=_mock_read_blocking),
        )
        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/task-123/stream")

        body = resp.text
        assert "id: 100-0" in body
        assert "id: 101-0" in body

    @pytest.mark.asyncio
    async def test_sse_stops_on_done_chunk(self, settings):
        """SSE stream ends when a 'done' chunk is received."""

        async def _mock_read_blocking(task_id, last_id="0-0", block_ms=5000):
            if last_id == "0-0":
                return [
                    ("1-0", StreamChunk(type="chunk", content="partial")),
                    ("2-0", StreamChunk(type="done", data={"finish_reason": "stop"})),
                ]
            return []

        tm = _make_task_manager_mock(
            read_chunks_blocking=AsyncMock(side_effect=_mock_read_blocking),
        )
        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/task-123/stream")

        body = resp.text
        assert "partial" in body
        assert "done" in body

    @pytest.mark.asyncio
    async def test_sse_stops_on_task_completion(self, settings):
        """SSE stream ends when task status is COMPLETED and no more chunks."""
        call_count = 0

        async def _mock_read_blocking(task_id, last_id="0-0", block_ms=5000):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [("1-0", StreamChunk(type="chunk", content="data"))]
            return []

        completed_task = TaskState(
            task_id="task-123",
            status=TaskStatus.COMPLETED,
            provider="ollama",
            model="llama3.2:latest",
        )
        running_task = TaskState(
            task_id="task-123",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )

        get_task_calls = 0

        async def _mock_get_task(task_id):
            nonlocal get_task_calls
            get_task_calls += 1
            if get_task_calls <= 1:
                return running_task
            return completed_task

        tm = _make_task_manager_mock(
            read_chunks_blocking=AsyncMock(side_effect=_mock_read_blocking),
            get_task=AsyncMock(side_effect=_mock_get_task),
        )
        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/task-123/stream")

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_sse_resumes_from_last_event_id(self, settings):
        """When last_event_id is provided, only sends chunks after that ID."""

        async def _mock_read_blocking(task_id, last_id="0-0", block_ms=5000):
            if last_id == "50-0":
                return [
                    ("51-0", StreamChunk(type="chunk", content="resumed")),
                    ("52-0", StreamChunk(type="done", data={"finish_reason": "stop"})),
                ]
            return []

        tm = _make_task_manager_mock(
            read_chunks_blocking=AsyncMock(side_effect=_mock_read_blocking),
        )
        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/task-123/stream?last_event_id=50-0")

        body = resp.text
        assert "resumed" in body
        assert "id: 51-0" in body
