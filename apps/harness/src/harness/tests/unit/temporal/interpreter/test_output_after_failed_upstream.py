"""A ``core.output`` is never run on the empty result of a required node that failed.

Measured at three concurrent sessions: ``n_finalize`` (``onError: 'fail'``) was cancelled by its
``start_to_close`` timeout, settled DEGRADED with nothing stored, and the walk went on to run
``n_output`` over that nothing. It failed its own schema, so the run's recorded cause was an
output-contract violation — and the consultation was told the workflow "ended without a clinical
result" — when the real cause was the finalizer timing out.

Now the output node is not dispatched at all: it settles FAILED with a reason that names the
upstream node and carries that node's own reason, so the run's error code is the real one.

Hermetic: the shared TASK-1038 harness (a time-skipping Temporal server, the real interpreter, a
stubbed ``interpreter.core_agent``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowHistory
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Replayer

from harness.temporal.interpreter.activities import run_error_code_of
from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter import _task1038_harness as h

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture(autouse=True)
def _reset():
    h.reset()
    yield
    h.reset()


def _scheduled(history, activity_type: str) -> bool:
    return any(
        event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
        and event.activity_task_scheduled_event_attributes.activity_type.name == activity_type
        for event in history.events
    )


def _graph(*, finalize_on_error: str, stub: str = "client_error") -> dict:
    finalize = h.agent("n_finalize", _stub=stub, inputs=[h.edge("n_trigger", "out", "in")])
    finalize["onError"] = finalize_on_error
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {"stageIndex": 1, "nodes": [finalize]},
            {"stageIndex": 2, "nodes": [h.output([h.edge("n_finalize", "data", "in")])]},
        ]
    )


@pytest.mark.asyncio
async def test_the_output_is_not_run_when_its_required_producer_failed() -> None:
    result, nodes, history = await h.run_graph(_graph(finalize_on_error="fail"))

    assert nodes["n_finalize"].status == "DEGRADED"
    assert not _scheduled(history, "interpreter.core_output")
    output = nodes["n_output"]
    assert output.status == "FAILED"
    reason = output.reason or ""
    assert reason.startswith("upstream_failed: n_finalize: ")
    # The producer's own cause rides along, so the run's error code is not OUTPUT_INVALID.
    assert "ApiClientError" in reason
    assert run_error_code_of(reason) != "OUTPUT_INVALID"
    assert result.status == "FAILED"


@pytest.mark.asyncio
async def test_a_producer_the_author_allowed_to_degrade_still_reaches_the_output() -> None:
    _, nodes, history = await h.run_graph(_graph(finalize_on_error="degrade"))

    assert nodes["n_finalize"].status == "DEGRADED"
    assert _scheduled(history, "interpreter.core_output")
    assert not (nodes["n_output"].reason or "").startswith("upstream_failed")


@pytest.mark.asyncio
async def test_a_degraded_producer_that_kept_its_output_still_feeds_the_output() -> None:
    _, nodes, history = await h.run_graph(
        _graph(finalize_on_error="fail", stub="degraded_with_output")
    )

    assert nodes["n_finalize"].status == "DEGRADED"
    assert _scheduled(history, "interpreter.core_output")
    assert not (nodes["n_output"].reason or "").startswith("upstream_failed")


# ---------------------------------------------------------------------------------------------
# Replay — the short-circuit REMOVES a command, so it rides behind `upstream-failed-output`.
# Fixtures: `_capture_upstream_failed_output_fixture.py`, recorded on the definition before the
# marker (the output activity scheduled) and after it.
# ---------------------------------------------------------------------------------------------

_FIXTURES = Path(__file__).parent.parent / "fixtures"


def _replayer() -> Replayer:
    return Replayer(
        workflows=[WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow],
        data_converter=pydantic_data_converter,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fixture",
    [
        # BACKWARD: a run recorded before the marker scheduled the output; it must replay as such.
        "interpreter_upstream_failed_pre_marker_history",
        # FORWARD: a later ungated change to the short-circuit fails here, not on a live run.
        "interpreter_upstream_failed_marker_history",
    ],
)
async def test_both_eras_replay(fixture: str) -> None:
    history = WorkflowHistory.from_json(fixture, (_FIXTURES / f"{fixture}.json").read_text())
    await _replayer().replay_workflow(history)
