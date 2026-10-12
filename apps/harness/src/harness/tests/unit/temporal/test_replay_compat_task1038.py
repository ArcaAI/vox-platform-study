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

The ``interpreter_task1038_*`` fixtures are the FORWARD guards of the TASK-1038 era itself
(``_capture_task1038_replay_fixtures.py --task1038``, recorded on the post-change definition):
payload references, a kept degraded output, the node retry policy, the run deadline (fired and
not), and a cancel landing on an in-flight node.
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
    "interpreter_task1038_v1_history",
    "interpreter_task1038_timed_out_history",
    "interpreter_task1038_cancelled_history",
    "interpreter_task1038_loop_ref_history",
    # TASK-1036 / TASK-1038 wave B (lane B1) — forward guards of `task-1038-run-protocol-v2`,
    # `task-1036-bindings` and `task-1036-consultation-reads`
    # (`_capture_task1038_replay_fixtures.py --task1036`, recorded on the post-change definition).
    "interpreter_task1036_contract_history",
    "interpreter_task1036_loop_history",
    "loop_workflow_task1036_bindings_history",
    # TASK-1042 (lane L2) — forward guard of `task-1042-live-audio-wait`
    # (`_capture_task1042_replay_fixture.py`, recorded on the post-change definition).
    "interpreter_task1042_live_audio_history",
    # TASK-1038 lane E3 — forward guard of `task-1038-loop-run-start-reads`
    # (`_capture_task1038_replay_fixtures.py --task1038-e3`, recorded on the post-change definition).
    "interpreter_task1038_e3_loop_reads_history",
    "loop_workflow_task1038_e3_reads_history",
    # TASK-1066 — backward and forward guards of `upstream-failed-output`
    # (`_capture_upstream_failed_output_fixture.py`).
    "interpreter_upstream_failed_pre_marker_history",
    "interpreter_upstream_failed_marker_history",
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


class TestTask1038EraFixtures:
    @pytest.mark.asyncio
    async def test_a_payload_refs_degraded_output_review_run_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1038_v1_history"))

    @pytest.mark.asyncio
    async def test_a_timed_out_run_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1038_timed_out_history"))

    @pytest.mark.asyncio
    async def test_a_cancelled_in_flight_run_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1038_cancelled_history"))

    @pytest.mark.asyncio
    async def test_a_loop_over_a_reference_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1038_loop_ref_history"))


class TestWaveBDataContractFixtures:
    """Run protocol v2 + bindings + declared consultation reads (run start AND node start), a
    review fed by a binding, an End-wired node; and a loop body bound to the current item."""

    @pytest.mark.asyncio
    async def test_a_v2_bindings_and_reads_run_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1036_contract_history"))

    @pytest.mark.asyncio
    async def test_a_loop_body_bound_to_its_item_replays(self):
        await _replayer().replay_workflow(_history("interpreter_task1036_loop_history"))
        await _replayer().replay_workflow(_history("loop_workflow_task1036_bindings_history"))


class TestEveryInterpreterFamilyFixture:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", INTERPRETER_FAMILY_FIXTURES)
    async def test_replays_on_the_current_definitions(self, name: str):
        await _replayer().replay_workflow(_history(name))
