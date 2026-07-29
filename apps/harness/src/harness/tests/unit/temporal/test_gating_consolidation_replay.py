"""Replay-safety anchor for the gating-consolidation workstreams (T8).

WS-1's RECOMMENDED design threads the per-claim verdict cache as ADDITIVE, optional,
data-only fields on the existing ``run_inferential_sensors`` activity I/O — the
Slice-5d precedent (``live_assurance`` / ``consultation_id`` / ... were
added with safe defaults and NO ``workflow.patched()`` marker, because adding an
activity-input field does not alter the recorded COMMAND SEQUENCE). That keeps all
five frozen replay histories byte-identical on the current definition.

This is the anchor for the gating-consolidation workstreams:

* ``test_existing_replay_fixtures_stay_byte_identical`` — every frozen history still
  replays on the current ``HarnessDocWorkflow`` (GREEN today; mirrors
  ``test_replay_compat.py`` deliberately, as the place a 6th fixture is wired if a
  workstream ever changes the workflow command sequence).
* ``test_inferential_input_uses_additive_optional_fields`` — pins the additive,
  data-only precedent WS-1 follows: only ``note_text`` is required on
  ``RunInferentialSensorsInput``; every other field has a default, so adding a
  ``verdict_cache`` field is additive and schedules the activity identically (no
  patch marker required).

If WS-1 (or any gating-consolidation workstream) ends up CHANGING the workflow
command sequence, it MUST ship a new ``workflow.patched(...)`` gate AND a
newly-captured 6th fixture, then add it to ``_FIXTURES`` below (see
``_capture_replay_fixture.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from temporalio.client import WorkflowHistory
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Replayer

from harness.temporal.models import RunInferentialSensorsInput
from harness.temporal.workflows import HarnessDocWorkflow

# The temporal replay fixtures live next to test_replay_compat.py.
_FIXTURE_DIR = Path(__file__).parent / "fixtures"

# The five frozen histories that the gating-consolidation work must keep green.
_FIXTURES = (
    "doc_workflow_pre_task345_history",
    "doc_workflow_task345_history",
    "doc_workflow_post_task348_history",
    "doc_workflow_post_task355_history",
    "doc_workflow_post_task355_regen_history",
)


@pytest.mark.parametrize("name", _FIXTURES)
@pytest.mark.asyncio
async def test_existing_replay_fixtures_stay_byte_identical(name: str):
    """T8: each frozen history replays on the current definition.

    Replaying raises a non-determinism error if a workflow change altered the recorded
    command sequence without a ``workflow.patched()`` gate. WS-1's data-only caching
    must keep every one of these green.
    """
    replayer = Replayer(workflows=[HarnessDocWorkflow], data_converter=pydantic_data_converter)
    history = WorkflowHistory.from_json(name, (_FIXTURE_DIR / f"{name}.json").read_text())
    await replayer.replay_workflow(history)


def test_inferential_input_uses_additive_optional_fields():
    """T8: the data-only precedent WS-1 follows.

    Only ``note_text`` is required on ``RunInferentialSensorsInput``; every other field
    is optional with a default (the Slice-5d pattern). Adding a ``verdict_cache`` field
    the same way is additive and replay-safe — it does not introduce a new workflow
    command, so it needs no patch marker.
    """
    required = [
        name
        for name, field in RunInferentialSensorsInput.model_fields.items()
        if field.is_required()
    ]
    assert required == [
        "note_text"
    ], f"only note_text should be required, also required: {required}"
