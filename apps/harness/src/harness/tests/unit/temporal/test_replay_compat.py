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

    @pytest.mark.asyncio
    async def test_post_task348_history_replays_on_current_definition(self):
        """Forward guard for the CURRENT (post-TASK-348) era — incl. the Step-1 change.

        The fixture is a post-TASK-348 FAILURE-terminal history: ``persist_draft``
        fails AFTER the inferential pass, so the recorded history carries BOTH patch
        markers — ``task-345-harness-progress`` (the progress feed) and
        ``task-348-failure-terminal`` (the failed-terminal emission) — as well as the
        ``run_inferential_sensors`` command whose options TASK-354 Step 1 changed.

        Replaying it through the current definition proves the Step-1 edits are
        replay-safe: adding ``heartbeat_timeout`` is an activity OPTION (it does not
        alter the recorded command sequence), so no ``workflow.patched()`` gate is
        required. It also forward-guards the failure path: any FUTURE ungated change
        to the command sequence (a new/removed/reordered activity or patch gate)
        fails this replay with a non-determinism error. Recapture alongside every new
        patch gate (see ``_capture_replay_fixture.py --failure``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task348_history"))

    @pytest.mark.asyncio
    async def test_post_task355_optimistic_history_replays_on_current_definition(self):
        """Forward guard for the TASK-355 Phase D OPTIMISTIC era (Slice 4a).

        The fixture is a happy-path history recorded with the optimistic flag ON, so
        it carries the ``task-355-optimistic-delivery`` patch marker AND the reordered
        command sequence: early ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` ->
        ``run_inferential_sensors`` -> ``finalize_assurance`` -> gate ->
        ``record_gate_decision`` (the inferential pass moved AFTER delivery).

        Replaying it through the current definition proves an in-flight optimistic
        execution survives a redeploy, and forward-guards the new path: any FUTURE
        ungated change to the optimistic command sequence (e.g. the Slice-4b
        regen-if-untouched / edit signals) fails this replay with a non-determinism
        error unless it is gated behind its own ``workflow.patched()``. Recapture
        alongside every new patch gate (see ``_capture_replay_fixture.py --optimistic``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task355_history"))

    @pytest.mark.asyncio
    async def test_post_task355_regen_history_replays_on_current_definition(self):
        """Forward guard for the TASK-355 Phase D Slice-4b (assurance-signals) era.

        The fixture is a regen-if-untouched history recorded with the optimistic flag
        ON and an inferential REGEN-then-SAFE sequence, so it carries BOTH the
        ``task-355-optimistic-delivery`` AND ``task-355-assurance-signals`` patch
        markers plus the Slice-4b regen command sequence: early
        ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> ``run_inferential_sensors``
        (REGEN) -> regenerate (``assemble_prompt`` -> ``generate`` ->
        ``extract_entities`` -> ``run_sensors``) -> re-deliver ``persist_draft`` ->
        ``run_inferential_sensors`` (SAFE) -> ``finalize_assurance`` -> gate ->
        ``record_gate_decision`` (the inferential pass can now loop + regenerate AFTER
        delivery).

        Replaying it through the current definition proves an in-flight Slice-4b
        execution survives a redeploy, and forward-guards the regen/edit dynamics: any
        FUTURE ungated change to the assurance-signals command sequence fails this
        replay with a non-determinism error unless gated behind its own
        ``workflow.patched()``. Recapture alongside every new patch gate (see
        ``_capture_replay_fixture.py --regen``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task355_regen_history"))

    @pytest.mark.asyncio
    async def test_post_task458_gate_abandon_history_replays_on_current_definition(self):
        """Forward guard for the TASK-458 C1-02 gate TERMINAL-ABANDON era.

        The fixture is a never-signed gate that escalates to its terminal bound and
        ABANDONS (approved=False), so it carries the ``task-458-gate-terminal-abandon``
        patch marker plus the new gate command sequence: two ``escalate_gate`` calls (the
        second flagged terminal) then a terminal completion WITHOUT
        ``record_gate_decision``.

        Replaying it through the current definition proves an in-flight abandoning gate
        survives a redeploy, and forward-guards the terminal path: any FUTURE ungated
        change to the gate command sequence fails this replay with a non-determinism error
        unless gated behind its own ``workflow.patched()``. Recapture alongside every new
        patch gate (see ``_capture_replay_fixture.py --gate-abandon``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task458_gate_abandon_history"))

    @pytest.mark.asyncio
    async def test_post_task458_edit_cap_history_replays_on_current_definition(self):
        """Forward guard for the TASK-458 C1-02 edit-rerun-CAP era.

        The fixture is an optimistic run with clinician edits on TWO assurance passes and
        ``max_edit_reruns=1``, so the loop CAPS the re-runs (one edit re-run, not two). It
        carries the ``task-458-edit-rerun-cap`` marker (alongside the TASK-355 optimistic +
        assurance-signals markers and the gate-terminal marker) plus the capped command
        sequence: only ONE edit-driven ``run_inferential_sensors`` re-run before finalize.

        Replaying it through the current definition proves an in-flight capped-edit
        execution survives a redeploy, and forward-guards the cap dynamics: any FUTURE
        ungated change to the edit-cap command sequence fails this replay unless gated
        behind its own ``workflow.patched()`` (see ``_capture_replay_fixture.py --edit-cap``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task458_edit_cap_history"))

    @pytest.mark.asyncio
    async def test_post_task481_retraction_history_replays_on_current_definition(self):
        """Forward guard for the TASK-481 (E2) optimistic-delivery RETRACTION era.

        The fixture is an optimistic run whose post-delivery assurance FLAGs (UNSAFE), so the
        delivered draft is RETRACTED: it carries the ``task-481-optimistic-retraction`` marker
        (alongside the TASK-345/355 markers) plus the retraction command sequence — early
        ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> ``run_inferential_sensors`` (FLAG) ->
        ``retract_draft`` -> terminal completion (retracted, NO ``finalize_assurance``, NO
        gate / ``record_gate_decision``).

        Replaying it through the current definition proves an in-flight retracting execution
        survives a redeploy, and forward-guards the retraction branch: any FUTURE ungated
        change to the retraction command sequence fails this replay with a non-determinism
        error unless gated behind its own ``workflow.patched()``. Recapture alongside every
        new patch gate (see ``_capture_replay_fixture.py --retract``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task481_retraction_history"))

    @pytest.mark.asyncio
    async def test_post_task483_claim_check_history_replays_on_current_definition(self):
        """Forward + backward guard for the TASK-483 claim-check (out-of-band payload) era.

        The fixture is a happy-path history recorded with the ``generate`` + ``assemble_prompt``
        stubs returning OFFLOADED results — the note + prompts emptied inline and replaced by a
        small ``ClaimCheckRef`` that the workflow threads to every downstream activity
        (``extract_entities`` / ``run_sensors`` / ``run_inferential_sensors`` / ``persist_draft``).

        The claim-check is additive-optional and dereferenced INSIDE the activities, so the
        recorded command sequence is byte-identical to the inline happy path: NO new
        ``execute_activity`` command and NO ``workflow.patched()`` marker are introduced (the
        exact ``phi_enabled`` / ``prior_verdicts`` posture). Replaying this ref-threaded history
        GREEN proves ref-threading is command-neutral (AC-4) — the partner to the 8 pre-483
        (inline-blob) fixtures above, which also replay GREEN under the same definition.
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task483_claim_check_history"))
