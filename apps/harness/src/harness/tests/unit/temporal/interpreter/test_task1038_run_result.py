"""TASK-1038 D-I (producer) — ``workflow.run.completed`` carries the run's RESULT.

Before: no terminal path carried the result, so ``WorkflowRun.resultRef`` stayed null and a
business-plane caller could start a workflow and never read what it produced.

After: the completed event's payload carries ``result``, read by lane A2:

* ``{"kind": "inline", "value": <result>}`` when the serialized result is at most
  ``HARNESS_CLAIM_CHECK_RESULT_INLINE_MAX_BYTES`` (64 KiB);
* ``{"kind": "ref", "bucket", "key", "sizeBytes", "sha256"}`` (a claim-check object the gateway
  turns into a short-lived signed URL) when it is larger;
* absent when the run produced no output.

The result is what the ``core.output`` node published (its ``payload``, or its own
``resultRef``); with several ``core.output`` nodes it is keyed by node id.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from harness.temporal.claim_check import _MEMORY_STORE
from harness.temporal.interpreter import activities as interpreter_activities
from harness.tests.unit.temporal.interpreter import _task1038_harness as h
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture
def stream(monkeypatch):
    fake = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", fake, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    h.reset()
    yield fake
    h.reset()


def _completed(stream: FakeRunStreamRedis) -> dict:
    """The terminal run event's data (TASK-1038 R6: a run-protocol v2 `run.*` event)."""
    return stream.terminal()["data"]


def _graph(text_bytes: int | None, *, outputs: int = 1) -> dict:
    agent = (
        h.agent(
            "n_agent",
            _stub="big",
            _stub_bytes=text_bytes,
            inputs=[h.edge("n_trigger", "out", "in")],
        )
        if text_bytes is not None
        else h.agent("n_agent", inputs=[h.edge("n_trigger", "out", "in")])
    )
    sinks = [h.output([h.edge("n_agent", "out", "in")])]
    if outputs == 2:
        second = h.output([h.edge("n_trigger", "out", "in")])
        second["nodeId"] = "n_output_2"
        sinks.append(second)
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {"stageIndex": 1, "nodes": [agent]},
            {"stageIndex": 2, "nodes": sinks},
        ]
    )


class TestRunResult:
    @pytest.mark.asyncio
    async def test_a_small_result_is_inline(self, stream):
        result, _, _ = await h.run_graph(_graph(None), payload={"q": 1})

        assert result.status == "SUCCEEDED"
        assert _completed(stream)["result"] == {"kind": "inline", "value": "agent-n_agent"}

    @pytest.mark.asyncio
    async def test_a_result_offloaded_between_nodes_is_still_inline_under_the_limit(self, stream):
        # 30 KB: claim-checked as a NODE output (> 20 KiB) yet under the 64 KiB inline limit.
        await h.run_graph(_graph(30_000), payload={"q": 1})

        assert _completed(stream)["result"] == {"kind": "inline", "value": "x" * 30_000}

    @pytest.mark.asyncio
    async def test_a_large_result_is_a_claim_check_reference(self, stream):
        await h.run_graph(_graph(200_000), payload={"q": 1})

        result = _completed(stream)["result"]
        assert result["kind"] == "ref"
        assert set(result) == {"kind", "bucket", "key", "sizeBytes", "sha256"}
        stored = await _MEMORY_STORE.get(result["bucket"], result["key"])
        assert json.loads(stored.decode("utf-8")) == "x" * 200_000
        assert result["sizeBytes"] == len(stored)
        assert result["sha256"] == hashlib.sha256(stored).hexdigest()

    @pytest.mark.asyncio
    async def test_several_outputs_are_keyed_by_node_id(self, stream):
        await h.run_graph(_graph(None, outputs=2), payload={"q": 1})

        assert _completed(stream)["result"] == {
            "kind": "inline",
            "value": {"n_output": "agent-n_agent", "n_output_2": {"q": 1}},
        }

    @pytest.mark.asyncio
    async def test_a_run_without_an_output_carries_no_result(self, stream):
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {"stageIndex": 1, "nodes": [h.agent("n_agent")]},
            ]
        )
        await h.run_graph(graph, payload={"q": 1})

        assert "result" not in _completed(stream)

    @pytest.mark.asyncio
    async def test_a_failed_output_carries_no_result(self, stream):
        graph = _graph(None)
        graph["stages"][2]["nodes"][0]["config"]["outputSchema"] = {
            "type": "object",
            "required": ["case_note"],
        }
        result, _, _ = await h.run_graph(graph, payload={"q": 1})

        assert result.status == "FAILED"
        assert "result" not in _completed(stream)
