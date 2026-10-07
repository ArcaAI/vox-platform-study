"""TASK-1050 W2f — the FORWARD replay guard for ``task-1050-guardrail-hold``.

Two fixtures, captured with ``_capture_task1050_guardrail_hold_fixtures.py`` on the post-change
definition (a trigger plus one ``core.agent`` whose generation guardrail refused):

* ``interpreter_task1050_guardrail_hold_resumed_history`` — paused, signalled ``acknowledged``,
  the node re-executed once and the run SUCCEEDED;
* ``interpreter_task1050_guardrail_hold_timed_out_history`` — nobody resolved it; the hold timer
  fired and the run FAILED (``GUARDRAIL_BLOCKED``).

A later change to the hold's command sequence that is not behind its own ``workflow.patched``
fails here rather than wedging a run parked on a clinician. The backward guard (every older
history replays without consulting the marker, because no recorded result carries a
``guardrail_hold``) is the interpreter-family set in ``test_replay_compat*.py``; add these two
fixture names to that set at the gate pass.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowHistory
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Replayer

from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_RESUMED = "interpreter_task1050_guardrail_hold_resumed_history"
_TIMED_OUT = "interpreter_task1050_guardrail_hold_timed_out_history"
_FIXTURES = Path(__file__).parent / "fixtures"


def _history(name: str) -> WorkflowHistory:
    return WorkflowHistory.from_json(name, (_FIXTURES / f"{name}.json").read_text())


def _patches(history: WorkflowHistory) -> set[str]:
    return {
        json.loads(payload.data)["id"]
        for event in history.events
        if event.event_type == EventType.EVENT_TYPE_MARKER_RECORDED
        for payload in event.marker_recorded_event_attributes.details["patch-data"].payloads
    }


def _scheduled(history: WorkflowHistory, activity_type: str) -> int:
    return sum(
        1
        for event in history.events
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
        and event.activity_task_scheduled_event_attributes.activity_type.name == activity_type
    )


def _count(history: WorkflowHistory, event_type: int) -> int:
    return sum(1 for event in history.events if event.event_type == event_type)


def test_the_resumed_fixture_paused_was_signalled_and_re_ran_the_node() -> None:
    history = _history(_RESUMED)
    assert "task-1050-guardrail-hold" in _patches(history)
    assert _scheduled(history, "interpreter.core_agent") == 2
    signals = [
        event.workflow_execution_signaled_event_attributes.signal_name
        for event in history.events
        if event.event_type == EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED
    ]
    assert signals == ["guardrail_resolution"]
    assert _count(history, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED) == 1


def test_the_timed_out_fixture_fired_the_hold_timer_and_ran_the_node_once() -> None:
    history = _history(_TIMED_OUT)
    assert "task-1050-guardrail-hold" in _patches(history)
    assert _scheduled(history, "interpreter.core_agent") == 1
    assert _count(history, EventType.EVENT_TYPE_TIMER_FIRED) >= 1
    assert _count(history, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("name", [_RESUMED, _TIMED_OUT])
async def test_the_hold_replays_on_the_current_definition(name: str) -> None:
    replayer = Replayer(
        workflows=[WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow],
        data_converter=pydantic_data_converter,
    )
    await replayer.replay_workflow(_history(name))
