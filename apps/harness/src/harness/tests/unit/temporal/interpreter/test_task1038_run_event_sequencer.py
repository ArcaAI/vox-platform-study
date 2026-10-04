"""TASK-1038 R6 (lane B1) — the harness appends EVERY run event through the ONE sequencer.

``RunEventProducer.append`` builds the frozen ``EVAL`` arguments and runs ``RUN_APPEND_LUA``; the
fake executes the script's documented semantics. Asserted: v2 entries only (``seq`` first, ``body``
not ``data``), contiguous seqs, a dedupe key makes a retried activity's append a no-op, a terminal
append carries the run's retention and CLOSES the stream, a refused or failing append is
swallowed (the stream is a mirror), and deltas carry no dedupe key.
"""

from __future__ import annotations

import pytest

from harness.temporal.interpreter.run_events import RunEventProducer
from harness.tests.unit.temporal.interpreter._run_stream_fake import (
    ExplodingRunStreamRedis,
    FakeRunStreamRedis,
)

RUN = "run-1"


@pytest.fixture
def redis() -> FakeRunStreamRedis:
    return FakeRunStreamRedis()


@pytest.mark.asyncio
async def test_appends_are_v2_entries_with_contiguous_seqs(redis: FakeRunStreamRedis) -> None:
    producer = RunEventProducer(redis)
    assert (
        await producer.append(
            run_id=RUN,
            type="run.started",
            data={"kind": "workflow", "slug": "s", "versionNumber": 1},
        )
        == 1
    )
    assert (
        await producer.append(
            run_id=RUN, type="node.started", node_id="n1", data={"kind": "core.agent", "attempt": 1}
        )
        == 2
    )
    entries = redis.entries(RUN)
    assert entries[0][:2] == ["seq", "1"] and "body" in entries[0] and "data" not in entries[0]
    assert [e["seq"] for e in redis.events(RUN)] == [1, 2]
    assert redis.events(RUN)[1]["nodeId"] == "n1"


@pytest.mark.asyncio
async def test_a_retried_append_with_the_same_dedupe_key_writes_nothing(
    redis: FakeRunStreamRedis,
) -> None:
    producer = RunEventProducer(redis)
    key = f"wf:run:{RUN}:node:n1:1:started"
    first = await producer.append(
        run_id=RUN, type="node.started", node_id="n1", data={"kind": "k"}, dedupe_key=key
    )
    again = await producer.append(
        run_id=RUN, type="node.started", node_id="n1", data={"kind": "k"}, dedupe_key=key
    )
    assert first == again == 1
    assert len(redis.entries(RUN)) == 1


@pytest.mark.asyncio
async def test_a_terminal_append_carries_retention_and_closes_the_stream(
    redis: FakeRunStreamRedis,
) -> None:
    producer = RunEventProducer(redis)
    await producer.append(
        run_id=RUN,
        type="run.cancelled",
        data={"status": "CANCELED", "durationMs": 5},
        dedupe_key=f"wf:run:{RUN}:completed",
        retention_seconds=86_400,
    )
    assert redis.calls[-1][1][1] == "86400"
    assert set(redis.expiry.values()) == {86_400} and len(redis.expiry) == 3
    # Closed: a late append is refused by the script and swallowed by the producer.
    late = await producer.append(run_id=RUN, type="node.started", node_id="n9", data={"kind": "k"})
    assert late is None
    assert len(redis.entries(RUN)) == 1


@pytest.mark.asyncio
async def test_a_terminal_append_without_injected_retention_leaves_the_clock_to_the_gateway(
    redis: FakeRunStreamRedis,
) -> None:
    producer = RunEventProducer(redis)
    seq = await producer.append(
        run_id=RUN,
        type="run.cancelled",
        data={"status": "CANCELED", "durationMs": 5},
        allow_missing_retention=True,
    )
    assert seq == 1
    assert redis.calls[-1][1][1] == "0"
    assert redis.expiry == {}


@pytest.mark.asyncio
async def test_an_invalid_event_is_never_written(redis: FakeRunStreamRedis) -> None:
    producer = RunEventProducer(redis)
    assert await producer.append(run_id=RUN, type="node.started", data={"kind": "k"}) is None
    assert redis.calls == []


@pytest.mark.asyncio
async def test_a_dead_redis_is_swallowed() -> None:
    producer = RunEventProducer(ExplodingRunStreamRedis())
    assert (
        await producer.append(run_id=RUN, type="node.started", node_id="n", data={"kind": "k"})
        is None
    )
    assert await RunEventProducer(None).append(run_id=RUN, type="ping", data={}) is None


@pytest.mark.asyncio
async def test_deltas_carry_their_field_and_no_dedupe_key(redis: FakeRunStreamRedis) -> None:
    producer = RunEventProducer(redis)
    await producer.text_delta(run_id=RUN, node_id="n1", field="text", text="Hel")
    await producer.audio_delta(
        run_id=RUN, node_id="n2", field="audio", chunk=b"\x00\x01\x02", audio_format="wav"
    )
    assert all(args[2] == "" for _keys, args in redis.calls)
    text, audio = redis.events(RUN)
    assert text["type"] == "output.text.delta" and text["data"] == {"field": "text", "text": "Hel"}
    assert audio["type"] == "output.audio.delta"
    assert audio["data"] == {"field": "audio", "chunk": "AAEC", "format": "wav"}
