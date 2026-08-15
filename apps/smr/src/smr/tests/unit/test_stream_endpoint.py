"""Tests for the SSE stream endpoint (api/endpoints/stream.py).

These tests exercise the event_generator coroutine logic:
- yielding chunks via XREAD BLOCK (read_chunk_entries_blocking)

Entries are ``(msg_id, chunk, carrier)``; the carrier is ``{}`` when the
producer was untraced. Stubbing the older two-tuple ``read_chunks_blocking``
instead leaves the real method unstubbed on the AsyncMock, which then returns a
MagicMock — truthy, but it iterates empty — so the generator loops forever and
the process is eventually OOM-killed rather than failing.
- stopping on done/error
- stopping on completed/failed/cancelled task with no new chunks
- resume via last_event_id
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from smr.core.config import Settings
from smr.models.stream import StreamChunk
from smr.models.task import TaskState, TaskStatus
from smr.providers.base import ProviderRegistry


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=False
    )


def _build_app(settings, task_manager):
    from smr.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = ProviderRegistry()
    app.state.task_manager = task_manager
    app.state.settings = settings
    return app


class TestStreamEndpointSSE:
    @pytest.mark.asyncio
    async def test_stream_yields_chunks_and_done(self, settings):
        """When chunks exist including a 'done', the SSE stream should emit them and close."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(task_id="t1", status=TaskStatus.RUNNING, provider="p", model="m")
        )
        tm.read_chunk_entries_blocking = AsyncMock(
            return_value=[
                ("1-0", StreamChunk(type="chunk", content="Hello"), {}),
                ("2-0", StreamChunk(type="chunk", content=" world"), {}),
                ("3-0", StreamChunk(type="done", data={"finish_reason": "stop"}), {}),
            ]
        )

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200
        body = resp.text
        assert "Hello" in body
        assert " world" in body
        assert "done" in body

    @pytest.mark.asyncio
    async def test_stream_stops_on_error_chunk(self, settings):
        """When an error chunk is encountered, the stream should stop."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(task_id="t1", status=TaskStatus.RUNNING, provider="p", model="m")
        )
        tm.read_chunk_entries_blocking = AsyncMock(
            return_value=[
                ("1-0", StreamChunk(type="chunk", content="partial"), {}),
                ("2-0", StreamChunk(type="error", data={"error": "provider crashed"}), {}),
            ]
        )

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200
        assert "partial" in resp.text
        assert "error" in resp.text

    @pytest.mark.asyncio
    async def test_stream_completes_when_task_done_no_chunks(self, settings):
        """When task is COMPLETED and there are no new chunks, stream should end."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(
                task_id="t1", status=TaskStatus.COMPLETED, provider="p", model="m"
            )
        )
        tm.read_chunk_entries_blocking = AsyncMock(return_value=[])

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_stream_completes_when_task_failed_no_chunks(self, settings):
        """When task is FAILED and there are no new chunks, stream should end."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(task_id="t1", status=TaskStatus.FAILED, provider="p", model="m")
        )
        tm.read_chunk_entries_blocking = AsyncMock(return_value=[])

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_stream_completes_when_task_cancelled_no_chunks(self, settings):
        """When task is CANCELLED and there are no new chunks, stream should end."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(
                task_id="t1", status=TaskStatus.CANCELLED, provider="p", model="m"
            )
        )
        tm.read_chunk_entries_blocking = AsyncMock(return_value=[])

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_stream_resumes_from_last_event_id_header(self, settings):
        """A Last-Event-ID header should be used as the resume cursor when no query param is given."""
        tm = AsyncMock()
        tm.get_task = AsyncMock(
            return_value=TaskState(task_id="t1", status=TaskStatus.RUNNING, provider="p", model="m")
        )
        tm.read_chunk_entries_blocking = AsyncMock(
            return_value=[
                ("3-0", StreamChunk(type="done", data={"finish_reason": "stop"}), {}),
            ]
        )

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream", headers={"Last-Event-ID": "2-0"})
        assert resp.status_code == 200
        tm.read_chunk_entries_blocking.assert_any_call("t1", last_id="2-0", block_ms=5000)

    @pytest.mark.asyncio
    async def test_stream_404_for_nonexistent_task(self, settings):
        tm = AsyncMock()
        tm.get_task = AsyncMock(return_value=None)

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/nope/stream")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_stream_emits_chunks_then_stops_on_completed_task(self, settings):
        """First call returns chunks; second call returns nothing and task is completed -> stream ends."""
        call_count = 0

        async def _read_blocking(task_id, last_id="0-0", block_ms=5000):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [("1-0", StreamChunk(type="chunk", content="data"), {})]
            return []

        async def _get_task(task_id):
            if call_count >= 2:
                return TaskState(task_id="t1", status=TaskStatus.COMPLETED, provider="p", model="m")
            return TaskState(task_id="t1", status=TaskStatus.RUNNING, provider="p", model="m")

        tm = AsyncMock()
        tm.get_task = _get_task
        tm.read_chunk_entries_blocking = _read_blocking

        app = _build_app(settings, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/tasks/t1/stream")
        assert resp.status_code == 200
        assert "data" in resp.text
