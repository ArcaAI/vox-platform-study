"""TASK-1038 R-8 — replay guards for the interpreter eras and children that had none.

Before TASK-1038 only two of the interpreter's patch eras were fixtured (``task-849``,
``task-864``) and none of its child workflow types was replayed on its own. The fixtures replayed
here were captured with ``_capture_task1038_replay_fixtures.py`` against the PRE-TASK-1038
definition (base ``45ce54bc6``) before any TASK-1038 workflow edit, so each one is exactly what an
in-flight run of that era looks like when a later definition is deployed under it:

* ``task-731-hitl-gate`` — a run parked at its blocking gate, approved;
* ``task-932-live-handoff`` — a consultation-bound run that polled the live handoff twice;
* ``task-946-review-skip-empty-payload`` — a review never opened on an empty payload;
* ``ConsultationGateWorkflow``, ``ReviewGateWorkflow`` and both ends of a ``LoopWorkflow``
  ``continue_as_new`` chain, each replayed through its OWN current definition.

Any change to the command sequence of one of these paths that is not behind its own
``workflow.patched`` fails here rather than wedging a live run.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from temporalio.client import WorkflowHistory
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Replayer

from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_FIXTURES = Path(__file__).parent / "fixtures"

_ALL_WORKFLOWS = [WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow]

#: Every interpreter-family fixture, old and new. The TASK-1038 patches must keep ALL of these
#: replaying — the old ones as the backward guard, the new ones as the per-era guard.
INTERPRETER_FAMILY_FIXTURES = (
    "interpreter_v1_history",
    "interpreter_stream_v1_history",
    "interpreter_core_v1_history",
    "interpreter_gate_task731_history",
    "interpreter_live_handoff_task932_history",
    "interpreter_review_skip_task946_history",
    "consultation_gate_task731_history",
    "review_gate_task864_history",
    "loop_workflow_task864_first_run_history",
    "loop_workflow_task864_last_run_history",
)


def _history(name: str) -> WorkflowHistory:
    return WorkflowHistory.from_json(name, (_FIXTURES / f"{name}.json").read_text())


def _replayer() -> Replayer:
    return Replayer(workflows=_ALL_WORKFLOWS, data_converter=pydantic_data_converter)


class TestMissingEraFixtures:
    @pytest.mark.asyncio
    async def test_a_gate_era_history_replays(self):
        await _replayer().replay_workflow(_history("interpreter_gate_task731_history"))

    @pytest.mark.asyncio
    async def test_a_live_handoff_era_history_replays(self):
        await _replayer().replay_workflow(_history("interpreter_live_handoff_task932_history"))

    @pytest.mark.asyncio
    async def test_a_review_skip_era_history_replays(self):
        await _replayer().replay_workflow(_history("interpreter_review_skip_task946_history"))


class TestChildWorkflowFixtures:
    @pytest.mark.asyncio
    async def test_the_consultation_gate_child_replays(self):
        await _replayer().replay_workflow(_history("consultation_gate_task731_history"))

    @pytest.mark.asyncio
    async def test_the_review_gate_child_replays(self):
        await _replayer().replay_workflow(_history("review_gate_task864_history"))

    @pytest.mark.asyncio
    async def test_the_first_generation_of_a_loop_chain_replays(self):
        await _replayer().replay_workflow(_history("loop_workflow_task864_first_run_history"))

    @pytest.mark.asyncio
    async def test_the_last_generation_of_a_loop_chain_replays(self):
        await _replayer().replay_workflow(_history("loop_workflow_task864_last_run_history"))


class TestEveryInterpreterFamilyFixture:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", INTERPRETER_FAMILY_FIXTURES)
    async def test_replays_on_the_current_definitions(self, name: str):
        await _replayer().replay_workflow(_history(name))
