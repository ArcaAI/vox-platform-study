"""Cross-process resume — TASK-818 §3C.3(5), Lane G-R1.

The defect these pin: :class:`GenerationHub` is process-local, so a reconnect
served by a worker that never held the producer found ``producer is None``. That
branch read the durable backlog once and returned, which is right for a FINISHED
generation and wrong for one still RUNNING elsewhere — the client got HTTP 200,
the flushed prefix, and **no terminal frame**, in about two milliseconds.

Measured before the fix with `uvicorn text.main:app --workers 4` and real shared
Redis, 20 resume trials on a 60-token generation: **6 truncated**, each 5-6 of 60
chunks with no terminal frame. After: 20/20 terminal.

What is exercised here is the logic that probe cannot isolate — the seam between
replay and tail, the numbering of a terminal frame that carries no sequence of its
own, and the deadline that stops an abandoned tail from leaking a task per
reconnect. The multi-process behaviour itself belongs to the probe; a `fakeredis`
is per-process and cannot reproduce it at all.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from text.api.endpoints.stream import _replay_then_tail, stream_generation
from text.models.task import TaskState, TaskStatus
from text.routing.hub import GenerationEvent, GenerationHub, GenerationPolicy


def _chunk(seq: int, content: str) -> GenerationEvent:
    return GenerationEvent(seq=seq, event="chunk", payload=f'{{"content":"{content}"}}')


def _done(seq: int) -> GenerationEvent:
    return GenerationEvent(seq=seq, event="done", payload='{"finish_reason":"stop"}')


def _state(status: TaskStatus, *, started_ago_s: float = 0.0) -> TaskState:
    return TaskState(
        task_id="gen-1",
        status=status,
        provider="p",
        model="m",
        started_at=datetime.now(UTC) - timedelta(seconds=started_ago_s),
    )


class _Buffer:
    """A TaskManager double whose ``XREAD`` hands out one scripted round per call.

    ``rounds`` is a list of batches. Each ``read_events_blocking`` returns the next
    one; once they run out it returns empty, which is what a real ``XREAD BLOCK``
    does when nothing is being written. ``status`` may be a list, so a test can
    make the task flip to terminal partway through.
    """

    def __init__(
        self,
        rounds: list[list[GenerationEvent]],
        *,
        status: TaskStatus | list[TaskStatus] = TaskStatus.RUNNING,
        started_ago_s: float = 0.0,
    ) -> None:
        self.rounds = list(rounds)
        self.statuses = status if isinstance(status, list) else [status]
        self.started_ago_s = started_ago_s
        self.reads: list[str] = []

    async def read_events_blocking(
        self, _gid: str, last_id: str = "0-0", block_ms: int = 1000
    ) -> tuple[str, list[GenerationEvent]]:
        self.reads.append(last_id)
        if not self.rounds:
            return last_id, []
        batch = self.rounds.pop(0)
        return f"{len(self.reads)}-0", batch

    async def get_task(self, _gid: str) -> TaskState:
        status = self.statuses[0] if len(self.statuses) == 1 else self.statuses.pop(0)
        return _state(status, started_ago_s=self.started_ago_s)


async def _collect(buffer: _Buffer, after_seq: int = 0, **policy_kw) -> list[dict[str, str]]:
    policy = GenerationPolicy(**policy_kw)
    return [f async for f in _replay_then_tail(buffer, "gen-1", after_seq, policy)]


class TestTerminalFrameIsAlwaysDelivered:
    """The defect itself: a generation running elsewhere must still terminate."""

    @pytest.mark.asyncio
    async def test_a_generation_still_running_elsewhere_is_tailed_to_its_terminal_frame(self):
        """Before the fix this returned after round 1 with no terminal frame."""
        buffer = _Buffer([[_chunk(1, "a"), _chunk(2, "b")], [_chunk(3, "c")], [_done(4)]])
        frames = await _collect(buffer)

        assert [f["event"] for f in frames] == ["chunk", "chunk", "chunk", "done"]

    @pytest.mark.asyncio
    async def test_a_finished_generation_still_replays_and_closes_in_one_read(self):
        """The path that already worked must not regress into a tail."""
        buffer = _Buffer([[_chunk(1, "a"), _done(2)]], status=TaskStatus.COMPLETED)
        frames = await _collect(buffer)

        assert [f["event"] for f in frames] == ["chunk", "done"]
        assert buffer.reads == ["0-0"], "a finished generation must not block for more"

    @pytest.mark.asyncio
    async def test_the_reader_stops_at_the_first_terminal_frame(self):
        buffer = _Buffer([[_chunk(1, "a"), _done(2), _chunk(3, "never")]])
        frames = await _collect(buffer)

        assert [f["event"] for f in frames] == ["chunk", "done"]


class TestTheSeamHasNoGapAndNoDuplicate:
    """AC-15 across the replay→tail boundary, which is where a seam could hide."""

    @pytest.mark.asyncio
    async def test_an_overlapping_round_is_deduplicated_not_redelivered(self):
        """Redis re-delivering an already-seen batch must not duplicate output.

        `dedupe_by_seq` is not what protects this path — it is used on the live
        path — so the equivalent monotonic-cursor filter here is asserted directly.
        """
        buffer = _Buffer(
            [
                [_chunk(1, "a"), _chunk(2, "b")],
                [_chunk(1, "a"), _chunk(2, "b"), _chunk(3, "c")],
                [_done(4)],
            ]
        )
        frames = await _collect(buffer)

        assert [f["id"] for f in frames] == ["gen-1:1", "gen-1:2", "gen-1:3", "gen-1:4"]

    @pytest.mark.asyncio
    async def test_no_sequence_is_skipped_across_the_boundary(self):
        buffer = _Buffer([[_chunk(i, str(i)) for i in range(1, 34)], [_done(34)]])
        frames = await _collect(buffer)

        assert [f["id"] for f in frames] == [f"gen-1:{i}" for i in range(1, 35)]

    @pytest.mark.asyncio
    async def test_the_client_cursor_is_honoured_and_nothing_before_it_is_resent(self):
        buffer = _Buffer([[_chunk(1, "a"), _chunk(2, "b"), _chunk(3, "c")], [_done(4)]])
        frames = await _collect(buffer, after_seq=2)

        assert [f["id"] for f in frames] == ["gen-1:3", "gen-1:4"]


class TestTerminalFrameNumbering:
    """A per-chunk entry carries ``seq=0`` and must be numbered, not dropped.

    ``max_generation_seconds`` is tiny throughout this class on purpose. Losing
    the numbering does not make the reader return the wrong frames — it makes the
    terminal frame get filtered as already-seen, so the tail runs to its DEADLINE.
    With the production default that regression would surface as a 30-minute hang
    instead of a failed assertion.
    """

    @pytest.mark.asyncio
    async def test_an_unnumbered_terminal_frame_is_numbered_from_the_running_total(self):
        """The terminal frame is written by ``append_chunk``, so it decodes seq=0.

        Matching :meth:`TaskManager.read_events`' rule is what keeps the two
        readers agreeing on the frame's sequence.
        """
        unnumbered_done = GenerationEvent(0, "done", '{"finish_reason":"stop"}')
        buffer = _Buffer([[_chunk(1, "a"), _chunk(2, "b")], [unnumbered_done]])
        frames = await _collect(buffer, max_generation_seconds=0.001)

        assert [f["id"] for f in frames] == ["gen-1:1", "gen-1:2", "gen-1:3"]
        assert frames[-1]["event"] == "done"

    @pytest.mark.asyncio
    async def test_it_is_still_delivered_to_a_client_resuming_near_the_end(self):
        """The frame a resuming client came back for is the one at risk."""
        unnumbered_done = GenerationEvent(0, "done", "{}")
        buffer = _Buffer([[_chunk(1, "a"), _chunk(2, "b")], [unnumbered_done]])
        frames = await _collect(buffer, after_seq=2, max_generation_seconds=0.001)

        assert [f["event"] for f in frames] == ["done"]
        assert frames[0]["id"] == "gen-1:3"


class TestTheTailIsBounded:
    """An unbounded blocking read is a leaked task per abandoned reconnect."""

    @pytest.mark.asyncio
    async def test_it_gives_up_at_max_generation_seconds(self):
        """A producer killed mid-flight leaves the task RUNNING forever."""
        buffer = _Buffer([], status=TaskStatus.RUNNING, started_ago_s=10_000)
        frames = await _collect(buffer, max_generation_seconds=1800.0)

        assert frames == []

    @pytest.mark.asyncio
    async def test_the_bound_is_measured_from_the_generation_not_from_the_reconnect(self):
        """A second reconnect must not buy the generation another full budget."""
        nearly_spent = _Buffer([], status=TaskStatus.RUNNING, started_ago_s=1799.5)
        assert await _collect(nearly_spent, max_generation_seconds=1800.0) == []

        fresh = _Buffer([[_done(1)]], status=TaskStatus.RUNNING, started_ago_s=1.0)
        assert len(await _collect(fresh, max_generation_seconds=1800.0)) == 1

    @pytest.mark.asyncio
    async def test_a_terminal_status_with_no_terminal_frame_ends_the_tail(self):
        """A crashed producer must not hold the reader for the whole budget."""
        buffer = _Buffer([[_chunk(1, "a")]], status=TaskStatus.FAILED)
        frames = await _collect(buffer, max_generation_seconds=1800.0)

        assert [f["event"] for f in frames] == ["chunk"]

    @pytest.mark.asyncio
    async def test_a_terminal_status_does_not_race_the_error_frame_behind_it(self):
        """``routing/streaming.py`` writes ``status=FAILED`` BEFORE the error frame.

        Stopping the instant the status flips would drop the very frame the
        client is waiting for, so the tail requires an EMPTY read after seeing a
        terminal status — not the status alone.
        """
        buffer = _Buffer(
            [[_chunk(1, "a")], [], [GenerationEvent(2, "error", '{"error":"boom"}')]],
            status=TaskStatus.FAILED,
        )
        frames = await _collect(buffer, max_generation_seconds=1800.0)

        assert [f["event"] for f in frames] == ["chunk", "error"]


class TestTheLiveProducerPathIsUnchanged:
    @pytest.mark.asyncio
    async def test_a_producer_in_this_process_never_reaches_the_tail(self):
        """The cross-process tail is a fallback, not a replacement."""
        hub = GenerationHub()
        producer = hub.start("gen-1", lambda _p: _never())
        producer.publish(_chunk(1, "a"))
        producer.publish(_done(2))
        producer.finish()

        tm = AsyncMock()
        tm.read_events = AsyncMock(return_value=[])
        tm.read_events_blocking = AsyncMock(
            side_effect=AssertionError("the live path must not tail Redis")
        )

        frames = [f async for f in stream_generation(hub, tm, "gen-1", 0)]
        assert [f["event"] for f in frames] == ["meta", "chunk", "done"]


async def _never() -> None:
    return None
