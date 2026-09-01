"""Replay-compatibility tests for HarnessDocWorkflow.

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

from harness.temporal.interpreter.loop_workflow import (
    AgenticLoopWorkflow,
    AgenticSubAgentWorkflow,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.workflows import ConsultationLoopWorkflow, HarnessDocWorkflow

_FIXTURES = Path(__file__).parent / "fixtures"


def _history(name: str) -> WorkflowHistory:
    return WorkflowHistory.from_json(name, (_FIXTURES / f"{name}.json").read_text())


class TestReplayCompatibility:
    @pytest.mark.asyncio
    async def test_pre_progress_feed_history_replays_on_current_definition(self):
        """In-flight executions started BEFORE the progress feed must survive deploy.

        The fixture history was recorded by the definition that predates the progress
        feed (no ``report_progress`` activities). Replaying it through the current
        definition raises on non-determinism unless every progress-emission
        point is gated behind ``workflow.patched()``.
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        # Raises (non-determinism) if the new progress emissions are not patch-gated.
        await replayer.replay_workflow(_history("doc_workflow_pre_task345_history"))

    @pytest.mark.asyncio
    async def test_progress_feed_history_replays_on_current_definition(self):
        """Forward guard: current-era executions must survive FUTURE deploys.

        The fixture history was recorded by the definition with the progress feed
        (patch marker + six ``report_progress`` events). Any later workflow change
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
    async def test_post_failure_terminal_history_replays_on_current_definition(self):
        """Forward guard for the CURRENT (failure-terminal) era — incl. the
        heartbeat_timeout addition.

        The fixture is a FAILURE-terminal history: ``persist_draft``
        fails AFTER the inferential pass, so the recorded history carries BOTH patch
        markers — ``task-345-harness-progress`` (the progress feed) and
        ``task-348-failure-terminal`` (the failed-terminal emission) — as well as the
        ``run_inferential_sensors`` command whose options later changed.

        Replaying it through the current definition proves the heartbeat_timeout edit is
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
    async def test_post_optimistic_delivery_history_replays_on_current_definition(self):
        """Forward guard for the OPTIMISTIC-delivery era.

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
    async def test_post_assurance_signals_regen_history_replays_on_current_definition(self):
        """Forward guard for the Slice-4b (assurance-signals) era.

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
    async def test_post_gate_terminal_abandon_history_replays_on_current_definition(self):
        """Forward guard for the gate TERMINAL-ABANDON era.

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
    async def test_post_edit_rerun_cap_history_replays_on_current_definition(self):
        """Forward guard for the edit-rerun-CAP era.

        The fixture is an optimistic run with clinician edits on TWO assurance passes and
        ``max_edit_reruns=1``, so the loop CAPS the re-runs (one edit re-run, not two). It
        carries the ``task-458-edit-rerun-cap`` marker (alongside the optimistic +
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
    async def test_post_optimistic_retraction_history_replays_on_current_definition(self):
        """Forward guard for the optimistic-delivery RETRACTION era.

        The fixture is an optimistic run whose post-delivery assurance FLAGs (UNSAFE), so the
        delivered draft is RETRACTED: it carries the ``task-481-optimistic-retraction`` marker
        (alongside the progress-feed and optimistic-delivery markers) plus the retraction
        command sequence — early
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
    async def test_post_claim_check_history_replays_on_current_definition(self):
        """Forward + backward guard for the claim-check (out-of-band payload) era.

        The fixture is a happy-path history recorded with the ``generate`` + ``assemble_prompt``
        stubs returning OFFLOADED results — the note + prompts emptied inline and replaced by a
        small ``ClaimCheckRef`` that the workflow threads to every downstream activity
        (``extract_entities`` / ``run_sensors`` / ``run_inferential_sensors`` / ``persist_draft``).

        The claim-check is additive-optional and dereferenced INSIDE the activities, so the
        recorded command sequence is byte-identical to the inline happy path: NO new
        ``execute_activity`` command and NO ``workflow.patched()`` marker are introduced (the
        exact ``phi_enabled`` / ``prior_verdicts`` posture). Replaying this ref-threaded history
        GREEN proves ref-threading is command-neutral — the partner to the pre-claim-check
        (inline-blob) fixtures above, which also replay GREEN under the same definition.
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task483_claim_check_history"))

    @pytest.mark.asyncio
    async def test_post_mcp_history_replays_on_current_definition(self):
        """Forward guard for the (Phase 5) MCP external-tools era.

        The fixture is a happy-path history recorded with the MCP tool path ARMED — the
        policy enables ``mcpToolsEnabled`` and registers an enabled terminology server, so
        the workflow took the patch-gated branch: it carries the ``task-516-mcp-tools``
        patch marker AND the new ``call_mcp_tool`` command (after the transcript NER, before
        retrieval) that validates the extracted entity codes against the FHIR terminology
        server.

        Replaying it through the current definition proves an in-flight MCP-armed execution
        survives a redeploy, and forward-guards the command-sequence change: any FUTURE
        ungated change to the MCP path fails this replay with a non-determinism error unless
        gated behind its own ``workflow.patched()``. The default-OFF fixtures above (which
        NEVER call ``workflow.patched("task-516-mcp-tools")`` — the ``and`` short-circuit)
        also stay green, proving the feature is command-neutral when the flag is off.
        Recapture alongside every new patch gate (see ``_capture_replay_fixture.py --mcp``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_mcp_history"))

    @pytest.mark.asyncio
    async def test_post_redaction_history_replays_on_current_definition(self):
        """Forward guard for the DNA redaction/rewrite era.

        The fixture is a happy-path history recorded with the redaction path ARMED — the
        start payload carries a ``redaction_rules`` entry and the ``apply_redaction`` stub
        returns a CHANGED note, so the workflow took the patch-gated branch: it carries the
        ``-redaction`` patch marker AND the new command sequence (``apply_redaction``
        -> ``extract_entities`` -> ``run_sensors`` re-run) inserted after the computational
        loop settles and before persist.

        Replaying it through the current definition proves an in-flight redaction-armed
        execution survives a redeploy, and forward-guards the command-sequence change: any
        FUTURE ungated change to the redaction path fails this replay with a non-determinism
        error unless gated behind its own ``workflow.patched``. The empty-rules fixtures
        above (which NEVER call ``workflow.patched("-redaction")`` — the ``and``
        short-circuit) also stay green, proving the feature is command-neutral when unarmed.
        Recapture alongside every new patch gate (see ``_capture_replay_fixture.py --redaction``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task551_redaction_history"))

    @pytest.mark.asyncio
    async def test_post_redaction_audit_history_replays_on_current_definition(self):
        """Forward guard for the DNA redaction AUDIT era.

        The fixture is a redaction-armed history recorded against the CURRENT definition,
        so it carries BOTH the ``-redaction`` marker AND the new
        ``-redaction-audit`` marker (the manifest marker + compact manifest are
        threaded into ``persist_draft`` behind that second gate). Replaying it proves an
        in-flight audit-armed execution survives a redeploy.

        Crucially, the FROZEN ``doc_workflow_post_task551_redaction_history`` fixture above
        — recorded BEFORE the audit era existed, so it lacks the audit marker — must ALSO
        stay green: on replay ``workflow.patched("-redaction-audit")`` returns
        False, so the marker is never computed and the persist body stays byte-identical.
        Together they forward-guard the audit-trail change as gated + replay-safe.
        Recapture alongside every new patch gate (``_capture_replay_fixture.py --redaction-audit``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(
            _history("doc_workflow_post_task551_redaction_audit_history")
        )

    @pytest.mark.asyncio
    async def test_post_assemble_reuse_history_replays_on_current_definition(self):
        """Forward guard for the (F-13) assemble-REUSE era.

        The fixture is a COMPUTATIONAL regen (``REGEN`` then ``PASS``) so the
        pre-delivery loop runs twice and the second iteration takes the patch-gated
        skip: the recorded history carries the ``task-553-assemble-reuse`` marker and
        only ONE ``assemble_prompt`` command for TWO ``generate`` commands.

        Replaying it through the current definition proves an in-flight reuse-era
        execution survives a redeploy, and forward-guards the REMOVED command: any
        FUTURE ungated change to the loop's command sequence fails this replay with a
        non-determinism error unless gated behind its own ``workflow.patched()``.
        Crucially, every fixture above — all recorded BEFORE this era, and all
        single-iteration in the pre-delivery loop — must ALSO stay green: the
        ``assembled is None`` operand short-circuits BEFORE ``workflow.patched`` on
        the first iteration, so a one-pass run records no marker at all and its
        command sequence is byte-identical to the legacy one. Recapture alongside
        every new patch gate (``_capture_replay_fixture.py --assemble-reuse``).
        """
        replayer = Replayer(
            workflows=[HarnessDocWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("doc_workflow_post_task553_assemble_reuse_history"))


class TestConsultationLoopReplayCompatibility:
    """Replay guard for the loop — a SEPARATE workflow type.

    Being a new type is exactly why the loop needed no ``workflow.patched`` era:
    there are no histories recorded by an older definition of it, so there is
    nothing to stay compatible WITH. What this class does is start the clock —
    from here on, an ungated change to the loop's command sequence fails a
    replay instead of wedging in-flight consultations after a deploy.
    """

    @pytest.mark.asyncio
    async def test_loop_history_replays_on_current_definition(self):
        """Forward guard for the loop's initial era.

        The fixture records every command shape the loop can issue:
        ``fetch_loop_config`` (the once-only pin), ``livedoc_start`` (start
        action), ``emit_loop_event`` for a subscribed context item AND for one
        skipped over the depth cap, ``livedoc_stop`` (ending action), and the
        ``start_child_workflow`` that hands off to the unmodified
        ``HarnessDocWorkflow``.

        Only the PARENT definition is registered below: a replayer replays the
        recorded commands, it does not execute the child, so the child-start
        command is verified without the document workflow taking part. Any
        future change that adds, removes or reorders a loop command — including
        moving the config fetch, or dispatching an action in a different order —
        fails here unless it is gated behind its own ``workflow.patched``.
        Recapture alongside such a change (``_capture_replay_fixture.py --loop``).
        """
        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("consultation_loop_task662_history"))

    @pytest.mark.asyncio
    async def test_pre_reasoning_loop_history_replays_after_task664(self):
        """The single most important assertion this ticket makes.

         added commands to a workflow type that ALREADY had a recorded
        history — the fixture replayed above. Those commands (the planner
        activity, the specialist children, the adjudication publish, the
        derived-context activities) would break that replay if issued
        unconditionally, which is why they sit behind the ``-reasoning``
        patch era and why the era gate is written with the
        ``config.reasoning_enabled`` operand FIRST: on this history the flag is
        False, so ``workflow.patched`` is never even called.

        The assertion is deliberately the SAME fixture as the test above rather
        than a new one. A consultation that was mid-flight when
        deployed is exactly this history meeting exactly this definition, and
        that is the case that must not wedge.
        """
        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("consultation_loop_task662_history"))

    @pytest.mark.asyncio
    async def test_reasoning_history_replays_on_current_definition(self):
        """Forward guard for the loop's (reasoning) era.

        The fixture records the commands the deliberative lane adds:
        ``plan_reasoning`` (the planner ACTIVITY — this fixture is what proves
        its decision replays from history without re-invoking the model),
        a ``SpecialistWorkflow`` child start, ``document_extract_text`` (a derive
        action whose output re-enters as context one depth deeper), and
        ``record_adjudication``.

        Only the parent definition is registered: a replayer replays recorded
        commands rather than executing children, so the child-start command is
        verified without the specialist taking part. Recapture alongside any
        intentional change (``_capture_replay_fixture.py --reasoning``).
        """
        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("consultation_loop_task664_reasoning_history"))

    @pytest.mark.asyncio
    async def test_pre_idle_bound_loop_histories_replay_after_task685(self):
        """The central replay assertion.

        Bounding the main ``wait_condition`` schedules a TIMER — a command an
        unbounded wait never recorded — so it would break BOTH frozen loop
        fixtures if issued unconditionally. It sits behind the
        ``-idle-timeout`` era, gated with the ``idle_timeout_seconds``
        operand FIRST, and the recorded configs of both fixtures predate that
        field entirely: they deserialise with the bound absent, so
        ``workflow.patched`` is never even called and neither history sees a
        timer.

        Both fixtures are asserted here rather than only the older one, because
        an in-flight consultation at deploy time is either era and neither may
        wedge.
        """
        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("consultation_loop_task662_history"))
        await replayer.replay_workflow(_history("consultation_loop_task664_reasoning_history"))

    @pytest.mark.asyncio
    async def test_idle_timeout_history_replays_on_current_definition(self):
        """Forward guard for the loop's (idle-bound) era.

        The fixture is a run that received one context item and then nothing —
        no ``consultation-ending``, no ``cancel`` — so it reached its pinned idle
        bound. It carries the ``-idle-timeout`` marker, the
        ``wait_condition`` TIMER (started AND fired), the ``loop.timed_out``
        emission, and a terminal completion with NO ending action: a timeout
        abandons rather than fabricating a finalize.

        Any FUTURE ungated change to the bounded wait — moving the timer,
        changing what the timeout emits, or running ending actions on it — fails
        this replay with a non-determinism error unless it is gated behind its
        own ``workflow.patched``. Recapture alongside such a change
        (``_capture_replay_fixture.py --idle-timeout``).
        """
        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("consultation_loop_task685_idle_timeout_history"))


class TestWorkflowInterpreterReplayCompatibility:
    """Replay guard for WorkflowInterpreter (TASK-718) — the interpreter's OWN new workflow
    type, following the exact same "new type needs no era until its first fixture is frozen"
    precedent `ConsultationLoopWorkflow` set (`workflows.py:1611-1614`).

    ``interpreter_v1_history.json`` is the fixture captured with the very first release
    (`_capture_interpreter_replay_fixture.py`), per the ticket's "replay-compat discipline from
    run #1" requirement — this interpreter must never repeat `HarnessDocWorkflow`'s position of
    reaching eleven live `workflow.patched()` eras before anyone wrote a fixture. It covers, in
    one run, the three command shapes a future change is most likely to break: a multi-stage
    linear walk, a 3-node fan-out stage, and one DEGRADED node settling alongside SUCCEEDED
    siblings in the same stage (the all-settled join).

    Any future ungated change to the interpreter's dispatch loop (a new/removed/reordered
    ``execute_activity`` call in the shared per-stage/per-node path) fails this replay with a
    non-determinism error. Recapture alongside every new patch gate
    (``_capture_interpreter_replay_fixture.py``), per
    ``docs/implementation/TASK-718-Workflow-Interpreter/contracts/versioning.md``.
    """

    @pytest.mark.asyncio
    async def test_v1_history_replays_on_current_definition(self):
        from harness.temporal.interpreter.workflow import WorkflowInterpreter

        replayer = Replayer(
            workflows=[WorkflowInterpreter],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("interpreter_v1_history"))


class TestAgenticLoopReplayCompatibility:
    """TASK-848b step 9 — the loop's own replay guards, in both directions.

    The loop introduced ONE new command: the interpreter starting `AgenticLoopWorkflow` as a
    child, gated behind `workflow.patched(_LOOP_PATCH)`. That gate is load-bearing rather than
    ceremonial — TASK-847 shipped `agentic.loop` as a dispatchable ACTIVITY, so histories recorded
    before this change genuinely carry an `ActivityTaskScheduled` for `interpreter.agentic_loop`
    and must keep replaying that way.
    """

    @pytest.mark.asyncio
    async def test_a_current_era_loop_history_replays_on_the_current_definition(self):
        """FORWARD guard: today's in-flight loops must survive tomorrow's deploy.

        The fixture is a real recorded history carrying the child-workflow start and the patch
        marker. Moving or ungating the loop dispatch changes the command sequence, and this test
        is what makes that fail here rather than against live clinical runs.
        """
        replayer = Replayer(
            workflows=[WorkflowInterpreter, AgenticLoopWorkflow, AgenticSubAgentWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("interpreter_loop_v1_history"))

    @pytest.mark.asyncio
    async def test_a_pre_loop_history_still_replays(self):
        """BACKWARD guard: a history recorded before the loop existed must be unaffected.

        `interpreter_v1_history` predates `agentic.loop` entirely, so the cheap operand
        (`node.type == _LOOP_NODE_TYPE`) short-circuits and `workflow.patched` is never reached.
        This asserts the guard costs nothing to a graph that contains no loop — the property that
        lets it be added without touching every existing execution.
        """
        replayer = Replayer(
            workflows=[WorkflowInterpreter, AgenticLoopWorkflow, AgenticSubAgentWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(_history("interpreter_v1_history"))
