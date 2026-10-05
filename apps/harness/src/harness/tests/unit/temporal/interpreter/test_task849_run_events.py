"""lane A step 1 — the run-event PRODUCER, as amended by TASK-1038 R6 (run protocol v2).

What TASK-849 pinned still holds, on the v2 shapes: ONE stream per run (never a shared stream
partitioned by a field), every append ``MAXLEN``-bounded, keys derived from INTENT (a retry of
the same intent is a no-op), and a best-effort posture (a Redis failure costs the live view and
never raises). What changed: entries are v2 (``seq`` first, ``body``), appended through the one
sequencer; the async-contract envelope (``data``) is no longer written by the harness.
"""

from __future__ import annotations

import pytest

from harness.temporal.interpreter.run_events import (
    RUN_EVENT_STREAM_MAX_LEN,
    RunEventProducer,
    run_event_stream_key,
    v2_node_key,
    v2_run_key,
)
from harness.temporal.interpreter.run_protocol import RUN_STREAM_MAX_LEN, run_events_key
from harness.tests.unit.temporal.interpreter._run_stream_fake import (
    ExplodingRunStreamRedis,
    FakeRunStreamRedis,
)

RUN = "11111111-1111-1111-1111-111111111111"


class TestStreamIdentity:
    def test_one_stream_per_run_never_a_shared_partitioned_stream(self) -> None:
        assert run_event_stream_key(RUN) == f"wf:run:{RUN}:events" == run_events_key(RUN)
        assert run_event_stream_key("a") != run_event_stream_key("b")

    @pytest.mark.asyncio
    async def test_every_append_is_maxlen_bounded(self) -> None:
        redis = FakeRunStreamRedis()
        await RunEventProducer(redis).text_delta(run_id=RUN, node_id="n1", field="text", text="x")
        assert RUN_EVENT_STREAM_MAX_LEN == RUN_STREAM_MAX_LEN
        assert redis.calls[0][1][0] == str(RUN_STREAM_MAX_LEN)


class TestKeysAreDerivedFromIntent:
    def test_the_same_intent_reproduces_the_same_key(self) -> None:
        assert v2_node_key(RUN, "n1", 1, "started") == v2_node_key(RUN, "n1", 1, "started")
        assert v2_run_key(RUN, "completed") == f"wf:run:{RUN}:completed"

    def test_different_intents_attempts_and_iterations_never_collapse(self) -> None:
        assert v2_node_key(RUN, "n1", 1, "started") != v2_node_key(RUN, "n1", 1, "settled")
        assert v2_node_key(RUN, "n1", 1, "started") != v2_node_key(RUN, "n1", 2, "started")
        assert v2_node_key(RUN, "n1", 1, "bound", "iter:0") != v2_node_key(
            RUN, "n1", 1, "bound", "iter:1"
        )


class TestBestEffortPosture:
    @pytest.mark.asyncio
    async def test_a_redis_failure_returns_none_and_does_not_raise(self) -> None:
        producer = RunEventProducer(ExplodingRunStreamRedis())
        assert await producer.text_delta(run_id=RUN, node_id="n1", field="text", text="x") is None

    @pytest.mark.asyncio
    async def test_no_redis_client_at_all_is_a_supported_outcome(self) -> None:
        producer = RunEventProducer(None)
        assert await producer.text_delta(run_id=RUN, node_id="n1", field="text", text="x") is None


@pytest.mark.asyncio
async def test_a_text_delta_names_its_node_and_field() -> None:
    redis = FakeRunStreamRedis()
    await RunEventProducer(redis).text_delta(run_id=RUN, node_id="n1", field="text", text="Hi")
    (event,) = redis.events(RUN)
    assert event["type"] == "output.text.delta"
    assert event["nodeId"] == "n1"
    assert event["data"] == {"field": "text", "text": "Hi"}
