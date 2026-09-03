"""Tests for the SSE subscription endpoints (api/endpoints/stream.py).

**Rewritten for ** The endpoint is no longer a poller over
``read_chunk_entries_blocking``; it is a *subscriber* onto a producer that is
already running ( What is exercised here therefore changed shape:

* the cursor is a **sequence number**, not a Redis message id — the id a client
  holds must survive a router restart, and a Redis id does not;
* the id: is {generation_id}:{seq} (replacing the
  opaque resume token on this path, because that token wrapped a Redis cursor
  which is no longer what a client resumes from;
* the backlog comes from batched entries via ``TaskManager.read_events``.

``/tasks/{id}/stream`` keeps its 404 for an unknown id (the gateway still calls
it); ``/generations/{gid}/stream`` returns 204, per the spec. Live-producer
behaviour, reconnection and the no-gap/no-duplicate guarantee are covered in
``test_task818_resumable_streaming.py``; this file covers the endpoint surface.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.api.endpoints.stream import parse_cursor
from text.core.config import Settings
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry
from text.routing.hub import GenerationEvent


@pytest.fixture
def settings():
    return Settings(port=5099, log_level="debug")


def _build_app(settings, task_manager):
    from text.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = ProviderRegistry()
    app.state.task_manager = task_manager
    app.state.settings = settings
    return app


def _task_manager(events: list[GenerationEvent], *, state: TaskState | None) -> AsyncMock:
    """A TaskManager double with no live producer — the cross-process path.

    Models ``XREAD``, not ``XRANGE``: since the cross-process fix the endpoint
    tails the buffer rather than reading it once, so a double that only answers
    ``read_events`` would exercise a code path the service no longer takes. The
    buffer here is exhausted after one read and then reports empty forever, which
    is what a real ``XREAD BLOCK`` does for a stream nobody is writing to.
    """
    tm = AsyncMock()
    tm.get_task = AsyncMock(return_value=state)
    tm.stream_exists = AsyncMock(return_value=bool(events))

    async def _read_events(_gid: str, after_seq: int = 0) -> list[GenerationEvent]:
        return [event for event in events if event.seq > after_seq]

    async def _read_events_blocking(
        _gid: str, last_id: str = "0-0", block_ms: int = 1000
    ) -> tuple[str, list[GenerationEvent]]:
        if last_id != "0-0":
            return last_id, []
        return "1-0", list(events)

    tm.read_events = AsyncMock(side_effect=_read_events)
    tm.read_events_blocking = AsyncMock(side_effect=_read_events_blocking)
    return tm


def _running(task_id: str = "t1") -> TaskState:
    return TaskState(task_id=task_id, status=TaskStatus.RUNNING, provider="p", model="m")


def _chunk(seq: int, content: str) -> GenerationEvent:
    return GenerationEvent(seq=seq, event="chunk", payload=f'{{"content":"{content}"}}')


def _frames(text: str) -> list[tuple[str, str, str]]:
    out = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        event_id = event = data = ""
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        if event:
            out.append((event_id, event, data))
    return out


async def _get(app: Any, url: str, **kwargs: Any):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.get(url, **kwargs)


class TestStreamEndpointReplay:
    @pytest.mark.asyncio
    async def test_stream_yields_backlog_and_done(self, settings):
        events = [
            _chunk(1, "Hello"),
            _chunk(2, " world"),
            GenerationEvent(3, "done", '{"finish_reason":"stop"}'),
        ]
        app = _build_app(settings, _task_manager(events, state=_running()))
        resp = await _get(app, "/api/v1/tasks/t1/stream")

        assert resp.status_code == 200
        assert [e for _i, e, _d in _frames(resp.text)] == ["meta", "chunk", "chunk", "done"]
        assert "Hello" in resp.text
        assert " world" in resp.text

    @pytest.mark.asyncio
    async def test_stream_stops_at_the_error_frame(self, settings):
        events = [
            _chunk(1, "partial"),
            GenerationEvent(2, "error", '{"error":"provider crashed"}'),
            _chunk(3, "never delivered"),
        ]
        app = _build_app(settings, _task_manager(events, state=_running()))
        resp = await _get(app, "/api/v1/tasks/t1/stream")

        assert "partial" in resp.text
        assert "provider crashed" in resp.text
        assert "never delivered" not in resp.text

    @pytest.mark.asyncio
    async def test_finished_task_with_no_events_closes_cleanly(self, settings):
        state = TaskState(task_id="t1", status=TaskStatus.COMPLETED, provider="p", model="m")
        app = _build_app(settings, _task_manager([], state=state))
        resp = await _get(app, "/api/v1/tasks/t1/stream")

        assert resp.status_code == 200
        assert [e for _i, e, _d in _frames(resp.text)] == ["meta"]

    @pytest.mark.asyncio
    async def test_stream_resumes_from_last_event_id_header(self, settings):
        events = [_chunk(1, "a"), _chunk(2, "b"), GenerationEvent(3, "done", "{}")]
        app = _build_app(settings, _task_manager(events, state=_running()))
        resp = await _get(app, "/api/v1/tasks/t1/stream", headers={"Last-Event-ID": "t1:2"})

        frames = _frames(resp.text)
        assert [e for _i, e, _d in frames] == ["meta", "done"]
        assert '"a"' not in resp.text and '"b"' not in resp.text

    @pytest.mark.asyncio
    async def test_ids_are_generation_id_and_sequence(self, settings):
        """The cursor is a sequence number, so it survives a restart."""
        events = [_chunk(1, "a"), GenerationEvent(7, "done", "{}")]
        app = _build_app(settings, _task_manager(events, state=_running()))
        resp = await _get(app, "/api/v1/tasks/t1/stream")

        assert [i for i, _e, _d in _frames(resp.text)] == ["t1:0", "t1:1", "t1:7"]

    @pytest.mark.asyncio
    async def test_first_frame_carries_the_generation_id(self, settings):
        # COMPLETED, not RUNNING: this asserts the meta frame, and a RUNNING task
        # whose buffer holds no terminal frame is now (correctly) tailed rather
        # than closed, which would just make this test wait for no reason.
        state = TaskState(task_id="t1", status=TaskStatus.COMPLETED, provider="p", model="m")
        app = _build_app(settings, _task_manager([_chunk(1, "a")], state=state))
        resp = await _get(app, "/api/v1/tasks/t1/stream")

        first_id, first_event, first_data = _frames(resp.text)[0]
        assert first_event == "meta"
        assert first_data == '{"generation_id":"t1"}'
        assert first_id == "t1:0"


class TestUnknownIdStatus:
    @pytest.mark.asyncio
    async def test_task_route_keeps_its_404(self, settings):
        """The gateway's error handling depends on it; migrating it is Lane E's."""
        app = _build_app(settings, _task_manager([], state=None))
        resp = await _get(app, "/api/v1/tasks/nope/stream")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_generation_route_returns_204(self, settings):
        """nothing to stream is not an error."""
        app = _build_app(settings, _task_manager([], state=None))
        resp = await _get(app, "/api/v1/generations/nope/stream")
        assert resp.status_code == 204

    @pytest.mark.asyncio
    async def test_a_buffer_without_task_state_is_still_replayable(self, settings):
        """Task state expires before the replay buffer does; either one counts."""
        tm = _task_manager([_chunk(1, "survivor"), GenerationEvent(2, "done", "{}")], state=None)
        app = _build_app(settings, tm)
        resp = await _get(app, "/api/v1/generations/t1/stream")

        assert resp.status_code == 200
        assert "survivor" in resp.text


class TestCursorParsing:
    """``Last-Event-ID`` is canonical, ``?from_seq=`` the header-stripped fallback."""

    def test_qualified_id_is_parsed(self):
        assert parse_cursor("gen-1", "gen-1:42", None) == 42

    def test_bare_sequence_is_accepted(self):
        assert parse_cursor("gen-1", "42", None) == 42

    def test_id_from_another_generation_still_yields_its_sequence(self):
        assert parse_cursor("gen-1", "gen-9:7", None) == 7

    def test_from_seq_is_the_fallback(self):
        assert parse_cursor("gen-1", None, 12) == 12

    @pytest.mark.parametrize("spelling", ["from", "from_seq"])
    def test_both_query_spellings_bind_to_the_cursor(self, spelling: str):
        """`?from=` and `?from_seq=` must BOTH resolve.

        They did not always. The docstring advertised `?from=` while FastAPI bound
        only `from_seq` — `from` is a Python keyword and no alias was declared — so a
        client following the documentation was silently ignored and resumed from 0.
        A resume that quietly restarts looks like success until a clinician sees a
        duplicated prefix, which is why this is pinned rather than left to the
        docstring. Found by -stream.
        """
        import inspect

        from text.api.endpoints.stream import stream_generation_events, stream_task

        for route in (stream_generation_events, stream_task):
            alias = inspect.signature(route).parameters["from_seq"].default.validation_alias
            assert spelling in alias.choices, f"{route.__name__} does not accept ?{spelling}="

    def test_header_wins_over_the_query_fallback(self):
        assert parse_cursor("gen-1", "gen-1:3", 99) == 3

    def test_unparseable_replays_from_the_beginning_rather_than_skipping(self):
        """Replaying costs a discardable duplicate; guessing "now" loses tokens."""
        assert parse_cursor("gen-1", "not-a-cursor", None) == 0
        assert parse_cursor("gen-1", "gen-1:garbage", None) == 0

    def test_negative_values_clamp_to_zero(self):
        assert parse_cursor("gen-1", "gen-1:-5", None) == 0
        assert parse_cursor("gen-1", None, -5) == 0

    def test_absent_cursor_is_the_beginning(self):
        assert parse_cursor("gen-1", None, None) == 0
