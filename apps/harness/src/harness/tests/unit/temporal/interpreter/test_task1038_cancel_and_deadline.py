"""TASK-1038 R-4 (cancel stops in-flight work) and D-B (every run has a bounded duration).

R-4. Before: the ``cancel`` signal set a flag the walk read BETWEEN stages. A node already
running kept running — an LLM generation, a review child parked for an hour — while the run
already read as cancelled. Now cancel interrupts the stage in flight: its activities are
cancelled (delivered to the activity through heartbeats), its child workflows are cancelled, and
the run settles CANCELLED at once.

D-B. Before: ``caps.maxTotalSeconds`` was parsed and enforced nowhere. Now the walk carries a
deadline: at ``maxTotalSeconds`` of COMPUTE the stage in flight is interrupted and the run settles
``TIMED_OUT`` — visible on the result, on the ``state`` query, and on ``workflow.run.completed``.
Durable waits on a clinician (the live-handoff poll, a human review, the HITL gate) are not
compute and are not charged to the budget; they carry their own bounds.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import timedelta

import pytest
from temporalio.api.enums.v1 import EventType

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import CancelSignal, LiveOutputsRequest, LiveOutputsResult
from harness.temporal.interpreter.run_events import EVENT_RUN_COMPLETED
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event
from harness.tests.unit.temporal.interpreter import _task1038_harness as h

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_FAST_HEARTBEATS = {
    "max_heartbeat_throttle_interval": timedelta(milliseconds=200),
    "default_heartbeat_throttle_interval": timedelta(milliseconds=200),
}


class _FakeStream:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self.events.append(json.loads(fields["data"]))
        return f"{len(self.events)}-0"


@pytest.fixture(autouse=True)
def stream(monkeypatch):
    fake = _FakeStream()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", fake, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    h.reset()
    yield fake
    h.reset()


def _completed_status(stream: _FakeStream) -> str:
    (event,) = [e for e in stream.events if e["type"] == EVENT_RUN_COMPLETED]
    return event["payload"]["status"]


def _sleeping_graph(seconds: float, *, max_total: int = 3600) -> dict:
    graph = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    h.agent(
                        "n_slow",
                        _stub="sleep",
                        _stub_seconds=seconds,
                        _timeout=600,
                        inputs=[h.edge("n_trigger", "out", "in")],
                    )
                ],
            },
            {
                "stageIndex": 2,
                "nodes": [h.agent("n_after", inputs=[h.edge("n_slow", "out", "in")])],
            },
        ]
    )
    graph["caps"]["maxTotalSeconds"] = max_total
    return graph


def _activity_started(activity_type: str):
    scheduled: dict[int, str] = {}

    def predicate(event) -> bool:  # noqa: ANN001
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
            scheduled[event.event_id] = (
                event.activity_task_scheduled_event_attributes.activity_type.name
            )
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED:
            attrs = event.activity_task_started_event_attributes
            return scheduled.get(attrs.scheduled_event_id) == activity_type
        return False

    return predicate


async def _until(predicate, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.05)


class TestCancelStopsInFlightWork:
    @pytest.mark.asyncio
    async def test_cancel_interrupts_a_running_node_and_settles_cancelled(self, stream):
        async def cancel_once_running(env, handle):  # noqa: ANN001
            await _until(lambda: h.ATTEMPTS["n_slow"] >= 1)
            await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="test"))

        started = time.monotonic()
        result, nodes, _ = await h.run_graph(
            _sleeping_graph(60), during=cancel_once_running, worker_options=_FAST_HEARTBEATS
        )

        assert result.status == "CANCELLED"
        # Settled long before the 60 s node would have finished on its own.
        assert time.monotonic() - started < 30
        assert nodes["n_slow"].status == "SKIPPED"
        assert nodes["n_slow"].reason == "cancelled"
        # The next stage never started.
        assert "n_after" not in nodes
        assert _completed_status(stream) == "CANCELLED"

    @pytest.mark.asyncio
    async def test_the_cancellation_reaches_the_activity_itself(self, stream):
        """Through the envelope's heartbeats: the activity's own task is cancelled, rather than
        running to completion on a worker after the run already settled."""

        async def cancel_once_running(env, handle):  # noqa: ANN001
            await _until(lambda: h.ATTEMPTS["n_slow"] >= 1)
            await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="test"))
            await _until(lambda: "n_slow" in h.CANCELLED)

        await h.run_graph(
            _sleeping_graph(60), during=cancel_once_running, worker_options=_FAST_HEARTBEATS
        )

        assert "n_slow" in h.CANCELLED

    @pytest.mark.asyncio
    async def test_cancel_interrupts_a_parked_review_child(self, stream):
        review = {
            "nodeId": "n_review",
            "type": "core.humanReview",
            "activity": "interpreter.core_human_review",
            "config": {"timeoutSeconds": 3600},
            "timeoutSeconds": 3600,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
            "inputs": [h.edge("n_agent", "out", "in")],
            "onError": "degrade",
            "emitsTrajectory": True,
        }
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [h.agent("n_agent", inputs=[h.edge("n_trigger", "out", "in")])],
                },
                {"stageIndex": 2, "nodes": [review]},
            ]
        )

        async def cancel_once_parked(env, handle):  # noqa: ANN001
            def review_started(event) -> bool:  # noqa: ANN001
                return event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED

            await await_history_event(handle, review_started, description="review parked")
            await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="test"))

        result, nodes, history = await h.run_graph(graph, during=cancel_once_parked)

        assert result.status == "CANCELLED"
        assert nodes["n_review"].reason == "cancelled"
        assert any(
            e.event_type
            == EventType.EVENT_TYPE_REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED
            or e.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_CANCELED
            for e in history.events
        )


class TestRunDeadline:
    @pytest.mark.asyncio
    async def test_a_run_over_its_budget_settles_timed_out(self, stream):
        result, nodes, _ = await h.run_graph(
            _sleeping_graph(60, max_total=5), worker_options=_FAST_HEARTBEATS
        )

        assert result.status == "TIMED_OUT"
        assert nodes["n_slow"].status == "FAILED"
        assert nodes["n_slow"].reason == "run_timed_out"
        assert "n_after" not in nodes
        assert _completed_status(stream) == "TIMED_OUT"

    @pytest.mark.asyncio
    async def test_the_timed_out_state_is_what_the_state_query_reports(self, stream):
        captured: dict = {}

        async def query_after(env, handle):  # noqa: ANN001
            await handle.result()
            captured["state"] = await handle.query(WorkflowInterpreter.state)

        await h.run_graph(
            _sleeping_graph(60, max_total=5), during=query_after, worker_options=_FAST_HEARTBEATS
        )

        assert captured["state"].status == "TIMED_OUT"

    @pytest.mark.asyncio
    async def test_a_run_inside_its_budget_is_untouched(self, stream):
        result, nodes, _ = await h.run_graph(_sleeping_graph(0.2, max_total=600))

        assert result.status == "SUCCEEDED"
        assert nodes["n_after"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_a_human_review_is_not_charged_to_the_budget(self, stream):
        """A review that times out after 10 minutes, in a run with a 60 s compute budget: the
        review is a durable wait on a clinician, so the run settles on the REVIEW's outcome
        (`review_timed_out`, DEGRADED), never TIMED_OUT."""
        review = {
            "nodeId": "n_review",
            "type": "core.humanReview",
            "activity": "interpreter.core_human_review",
            "config": {"timeoutSeconds": 600},
            "timeoutSeconds": 3600,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
            "inputs": [h.edge("n_agent", "out", "in")],
            "onError": "degrade",
            "emitsTrajectory": True,
        }
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [h.agent("n_agent", inputs=[h.edge("n_trigger", "out", "in")])],
                },
                {"stageIndex": 2, "nodes": [review]},
                {
                    "stageIndex": 3,
                    "nodes": [h.agent("n_after", inputs=[h.edge("n_agent", "out", "in")])],
                },
            ]
        )
        graph["caps"]["maxTotalSeconds"] = 60
        result, nodes, _ = await h.run_graph(graph)

        assert nodes["n_review"].reason == "review_timed_out"
        assert nodes["n_after"].status == "SUCCEEDED"
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_the_live_handoff_wait_is_not_charged_to_the_budget(self, stream):
        script = [LiveOutputsResult(ended=False)] * 4 + [
            LiveOutputsResult(ended=True, outputs={"n_summary": {"text": "note"}})
        ]

        from temporalio import activity

        @activity.defn(name="interpreter.load_live_outputs")
        async def load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
            return script.pop(0) if len(script) > 1 else script[0]

        realtime = h.agent(
            "n_summary",
            execution={"lane": "realtime", "cadence": "perTurn"},
            inputs=[h.edge("n_trigger", "out", "context")],
        )
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {"stageIndex": 1, "nodes": [realtime]},
                {
                    "stageIndex": 2,
                    "nodes": [h.agent("n_finalize", inputs=[h.edge("n_summary", "out", "in")])],
                },
            ]
        )
        # Four 15 s polls = 60 s parked, against a 20 s compute budget.
        graph["caps"]["maxTotalSeconds"] = 20
        from harness.temporal.interpreter.models import RunSubject

        activities = [
            a
            for a in h.ACTIVITIES
            if getattr(a, "__temporal_activity_definition").name != "interpreter.load_live_outputs"
        ] + [load_live_outputs]
        result, nodes, _ = await h.run_graph(
            graph,
            payload={"consultationId": "c-1"},
            subject=RunSubject(consultationId="c-1"),
            activities=activities,
        )

        assert nodes["n_finalize"].status == "SUCCEEDED"
        assert result.status != "TIMED_OUT"
