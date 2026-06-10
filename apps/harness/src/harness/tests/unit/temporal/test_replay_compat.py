"""Replay-compatibility tests for HarnessDocWorkflow (TASK-348 / CRIT-1).

A workflow definition change is only deploy-safe when the CURRENT definition
can replay histories recorded by PREVIOUS definitions: Temporal replays the
recorded event history through the live code, and any divergence in the
commands the code generates (e.g. a new ``execute_activity`` call with no
``workflow.patched()`` gate) fails the workflow task with a non-determinism
error — wedging every in-flight execution, including runs parked at the
clinician GATE ``wait_condition``.

The fresh-execution tests in ``test_doc_workflow.py`` can never catch this
class of defect; only replaying a frozen old-era history does. Fixtures are
captured with ``_capture_replay_fixture.py`` (see its docstring for
provenance and the capture procedure).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from temporalio.client import WorkflowHistory
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Replayer

from harness.temporal.workflows import HarnessDocWorkflow

_FIXTURES = Path(__file__).parent / "fixtures"


def _history(name: str) -> WorkflowHistory:
    return WorkflowHistory.from_json(name, (_FIXTURES / f"{name}.json").read_text())


class TestReplayCompatibility:
    @pytest.mark.asyncio
    async def test_pre_task345_history_replays_on_current_definition(self):
        """In-flight executions started BEFORE the progress feed must survive deploy.

        The fixture history was recorded by the pre-TASK-345 definition (no
        ``report_progress`` activities). Replaying it through the current
        definition raises on non-determinism unless every TASK-345 emission
        point is gated behind ``workflow.patched()``.
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        # Raises (non-determinism) if the new progress emissions are not patch-gated.
        await replayer.replay_workflow(_history("doc_workflow_pre_task345_history"))

    @pytest.mark.asyncio
    async def test_task345_history_replays_on_current_definition(self):
        """Forward guard: current-era executions must survive FUTURE deploys.

        The fixture history was recorded by the TASK-345 definition (patch
        marker + six ``report_progress`` events). Any later workflow change
        that alters the command sequence without its own ``workflow.patched()``
        gate fails this replay. Capture a new-era fixture alongside every new
        patch gate (see ``_capture_replay_fixture.py``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_task345_history"))
