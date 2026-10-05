"""TASK-1042 OD-4a — the FORWARD replay guard for ``task-1042-live-audio-wait``.

``interpreter_task1042_live_audio_history.json`` was captured with
``_capture_task1042_replay_fixture.py`` on the post-change definition: a run bound to a live STT
session that polled ``interpreter.load_live_audio_state`` (``live``, ``live``, ``ended``) before its
first stage. A later change to that wait's command sequence that is not behind its own
``workflow.patched`` fails here rather than wedging a run parked on a dictation.

Only this one fixture is replayed here; the backward guard (every older history replays without
consulting the marker, because its ``live_audio`` is ``None``) is the interpreter-family set in
``test_replay_compat*.py``.
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

_NAME = "interpreter_task1042_live_audio_history"
_FIXTURE = Path(__file__).parent / "fixtures" / f"{_NAME}.json"


def _history() -> WorkflowHistory:
    return WorkflowHistory.from_json(_NAME, _FIXTURE.read_text())


def test_the_fixture_is_a_live_audio_run() -> None:
    """It recorded the marker and polled the state activity more than once."""
    history = _history()
    patches = {
        json.loads(payload.data)["id"]
        for event in history.events
        if event.event_type == EventType.EVENT_TYPE_MARKER_RECORDED
        for payload in event.marker_recorded_event_attributes.details["patch-data"].payloads
    }
    polls = [
        event
        for event in history.events
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
        and event.activity_task_scheduled_event_attributes.activity_type.name
        == "interpreter.load_live_audio_state"
    ]
    assert "task-1042-live-audio-wait" in patches
    assert len(polls) == 3


@pytest.mark.asyncio
async def test_the_live_audio_wait_replays_on_the_current_definition() -> None:
    replayer = Replayer(
        workflows=[WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow],
        data_converter=pydantic_data_converter,
    )
    await replayer.replay_workflow(_history())
