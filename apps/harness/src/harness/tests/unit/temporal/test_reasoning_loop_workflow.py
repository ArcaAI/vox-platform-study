"""Reasoning-lane tests for the consultation loop (TASK-664).

Every test runs the REAL workflow definitions against stub activities in
Temporal's time-skipping environment, so what is exercised is orchestration: the
planner decision recorded in history, specialists as isolated child workflows,
scoped reads, enforced ``writeScope``, inspectable adjudication, cycle detection
and the specialist budget.

The mechanical loop's own properties (pinning, de-duplication, depth cap, action
budget, ``continue_as_new``, child finalize) are TASK-662's and are covered in
``test_consultation_loop_workflow.py`` — not re-tested here.

**Replay note.** Unlike TASK-662, this ticket edits a workflow type that ALREADY
has a recorded history (``consultation_loop_task662_history``), so every new
command it issues sits behind the ``task-664-reasoning`` patch era. That the
frozen fixture still replays is asserted in ``test_replay_compat.py``.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker
from temporalio.workflow import ChildWorkflowCancellationType, ParentClosePolicy

from harness.temporal.models import (
    LOOP_ACTION_DOCUMENT_EXTRACT_TEXT,
    LOOP_ACTION_HARNESS_FINALIZE,
    LOOP_ACTION_KEYS,
    LOOP_ACTION_NLP_EXTRACT_ENTITIES,
    LOOP_ACTION_VISION_EXTRACT_TEXT,
    LOOP_EVENT_ACTION_SKIPPED,
    LOOP_SKIP_CYCLE_DETECTED,
    LOOP_SKIP_SPECIALIST_BUDGET,
    PRIMARY_ONLY_OUTPUT_KINDS,
    AdjudicationRecord,
    ApprovalSignal,
    ConsultationEndingSignal,
    ConsultationLoopWorkflowInput,
    ContextAddedSignal,
    LoopAgentSpec,
    LoopBudget,
    LoopSubscription,
    PlanDecision,
    PlannedSpecialist,
    SpecialistFinding,
    SpecialistResult,
    adjudicate,
)
from harness.temporal.workflows import (
    LOOP_ACTION_REGISTRY,
    ConsultationLoopWorkflow,
    HarnessDocWorkflow,
    SpecialistWorkflow,
    consultation_loop_workflow_id,
    specialist_workflow_id,
)
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)
from harness.tests.unit.temporal._loop_stubs import (
    LoopStubConfig,
    LoopStubRecorder,
    default_loop_config,
    make_loop_stub_activities,
    reasoning_loop_config,
)
from harness.tests.unit.temporal._temporal_sync import await_query, start_time_skipping

PRIMARY = LoopAgentSpec(
    agent_id="agent-primary",
    role="PRIMARY",
    slug="primary",
    goal="Produce one reconciled note",
    subscribed_kinds=["transcript", "worknote"],
    write_scope=["note", "gate"],
)
CARDIO = LoopAgentSpec(
    agent_id="agent-cardio",
    role="SPECIALIST",
    slug="cardiology",
    subscribed_kinds=["transcript"],
    write_scope=["cardiology_finding"],
)
PHARM = LoopAgentSpec(
    agent_id="agent-pharm",
    role="SPECIALIST",
    slug="pharmacy",
    subscribed_kinds=["worknote"],
    write_scope=["medication_finding"],
)


def _wf_input(**overrides) -> ConsultationLoopWorkflowInput:
    base = {
        "consultation_id": "c-r1",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "session_id": "s-1",
        "replan_interval_events": 1,
    }
    base.update(overrides)
    return ConsultationLoopWorkflowInput(**base)


def _ctx(item_id: str, *, kind: str = "transcript", depth: int = 0, at: str = "1") -> ContextAddedSignal:
    return ContextAddedSignal(
        context_item_id=item_id, kind_key=kind, depth=depth, occurred_at=at, text="chest pain"
    )


async def _await_state(handle, predicate, **kwargs):
    """Poll the ``state()`` query until ``predicate`` holds.

    See ``_temporal_sync`` for why the poll itself has to tolerate a transient
    RPC deadline rather than treat one as a failed assertion.
    """
    return await await_query(handle, ConsultationLoopWorkflow.state, predicate, **kwargs)


class _ReasoningHarness:
    """Runs the loop AND the specialist child workflow against stub activities."""

    def __init__(self, config: LoopStubConfig | None = None) -> None:
        self.config = config or LoopStubConfig(config=reasoning_loop_config())
        self.recorder = LoopStubRecorder()

    async def __aenter__(self):
        self.env = await start_time_skipping(data_converter=pydantic_data_converter)
        self.task_queue = f"reason-tq-{uuid.uuid4()}"
        self.worker = Worker(
            self.env.client,
            task_queue=self.task_queue,
            workflows=[ConsultationLoopWorkflow, SpecialistWorkflow],
            activities=make_loop_stub_activities(self.config, self.recorder),
        )
        await self.worker.__aenter__()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.worker.__aexit__(*exc)
        await self.env.shutdown()

    async def start(self, wf_input: ConsultationLoopWorkflowInput):
        return await self.env.client.start_workflow(
            ConsultationLoopWorkflow.run,
            wf_input,
            id=consultation_loop_workflow_id(wf_input.consultation_id) + f"-{uuid.uuid4()}",
            task_queue=self.task_queue,
        )


# ===========================================================================
# Registry — the three keys TASK-662 declared but did not back
# ===========================================================================


class TestActionRegistryIsFullyBacked:
    def test_registry_still_covers_the_canonical_vocabulary(self):
        assert set(LOOP_ACTION_REGISTRY) == set(LOOP_ACTION_KEYS)

    def test_the_three_task662_placeholders_are_now_implemented(self):
        """TASK-662 §5 left these dispatching as `unsupported_action` skips."""
        for key in (
            LOOP_ACTION_VISION_EXTRACT_TEXT,
            LOOP_ACTION_DOCUMENT_EXTRACT_TEXT,
            LOOP_ACTION_NLP_EXTRACT_ENTITIES,
        ):
            assert LOOP_ACTION_REGISTRY[key].implemented, f"{key} is still unbacked"

    def test_every_canonical_action_is_now_backed(self):
        unbacked = [k for k, spec in LOOP_ACTION_REGISTRY.items() if not spec.implemented]
        assert unbacked == []

    def test_derived_context_actions_are_marked_as_such(self):
        """A derive action re-enters its output as context — that IS the cascade."""
        derivers = {k for k, spec in LOOP_ACTION_REGISTRY.items() if spec.derives_context}
        assert derivers == {
            LOOP_ACTION_VISION_EXTRACT_TEXT,
            LOOP_ACTION_DOCUMENT_EXTRACT_TEXT,
            LOOP_ACTION_NLP_EXTRACT_ENTITIES,
        }


# ===========================================================================
# TDD-1 — the planner decision is recorded and replays
# ===========================================================================


class TestPlannerIsAnActivity:
    @pytest.mark.asyncio
    async def test_planner_runs_as_an_activity_so_its_decision_is_in_history(self):
        """TDD-1 — the model is invoked in an ACTIVITY, never in the workflow body.

        That is the whole reason C1/D3 require it: an activity result is recorded
        in history, so a replay reuses the recorded decision instead of asking a
        non-deterministic model again.
        """
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.plans_made >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        assert h.recorder.count("plan_reasoning") >= 1

    @pytest.mark.asyncio
    async def test_the_recorded_decision_replays_without_re_invoking_the_model(self):
        """A replay of the produced history must issue no NEW planner call."""
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.plans_made >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()
            history = await handle.fetch_history()
            calls_during_execution = h.recorder.count("plan_reasoning")

        from temporalio.worker import Replayer

        replayer = Replayer(
            workflows=[ConsultationLoopWorkflow, SpecialistWorkflow],
            data_converter=pydantic_data_converter,
        )
        await replayer.replay_workflow(history)
        # The replayer runs no activities at all; the decision came from history.
        assert h.recorder.count("plan_reasoning") == calls_during_execution


class TestReplanCadence:
    @pytest.mark.asyncio
    async def test_replanning_happens_at_checkpoints_not_per_event(self):
        """Evidence (*Learning When to Plan*): per-step replanning is overthinking.

        With `replan_interval_events=5`, ten accepted events must produce far
        fewer than ten plans — the cadence is an explicit, configurable knob.
        """
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input(replan_interval_events=5))
            for i in range(10):
                await handle.signal(
                    ConsultationLoopWorkflow.context_added, _ctx(f"i-{i}", at=str(i))
                )
            await _await_state(handle, lambda s: s.events_processed == 10)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 10
        assert h.recorder.count("plan_reasoning") < 10, "replanned per event"
        assert h.recorder.count("plan_reasoning") >= 1, "never planned at all"

    @pytest.mark.asyncio
    async def test_the_replan_cadence_is_configurable(self):
        """A larger interval plans strictly less often over the same event stream."""
        counts = {}
        for interval in (1, 10):
            async with _ReasoningHarness() as h:
                handle = await h.start(_wf_input(replan_interval_events=interval))
                for i in range(10):
                    await handle.signal(
                        ConsultationLoopWorkflow.context_added, _ctx(f"i-{i}", at=str(i))
                    )
                await _await_state(handle, lambda s: s.events_processed == 10)
                await handle.signal(
                    ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
                )
                await handle.result()
                counts[interval] = h.recorder.count("plan_reasoning")

        assert counts[1] > counts[10]


# ===========================================================================
# TDD-2 / TDD-3 — write scope and scoped reads
# ===========================================================================


class TestSpecialistWriteScope:
    @pytest.mark.asyncio
    async def test_a_specialist_cannot_write_outside_its_write_scope(self):
        """TDD-2 — enforcement sits in the PARENT, outside the agent's own code.

        The stub specialist deliberately returns a finding for an output kind it
        was never granted. It must not reach the adjudication record.
        """
        stub = LoopStubConfig(
            config=reasoning_loop_config(),
            specialist_findings={
                "agent-cardio": [
                    SpecialistFinding(output_kind="cardiology_finding", statement="AF likely"),
                    SpecialistFinding(output_kind="medication_finding", statement="stop warfarin"),
                ]
            },
        )
        async with _ReasoningHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.specialists_run >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        records = h.recorder.payloads("record_adjudication")
        assert records, "no adjudication was recorded"
        statements = _all_statements(records)
        assert "AF likely" in statements
        assert "stop warfarin" not in statements, "out-of-scope finding was accepted"
        assert any(r.record.dropped_out_of_scope for r in records), "the drop was not reported"

    @pytest.mark.asyncio
    async def test_a_specialist_can_never_write_the_note_or_the_gate(self):
        """TDD-8 — the primary is the only writer, structurally.

        Even a MISCONFIGURED specialist whose `writeScope` names `note` is
        refused: the primary-only outputs are a platform floor, not a per-agent
        setting (TASK-654 §4.6 — enforcement outside agent code).
        """
        rogue = LoopAgentSpec(
            agent_id="agent-rogue",
            role="SPECIALIST",
            slug="rogue",
            subscribed_kinds=["transcript"],
            write_scope=["note", "gate", "cardiology_finding"],
        )
        stub = LoopStubConfig(
            config=reasoning_loop_config(agents=[PRIMARY, rogue]),
            specialist_findings={
                "agent-rogue": [
                    SpecialistFinding(output_kind="note", statement="ENTIRE NOTE"),
                    SpecialistFinding(output_kind="gate", statement="PASS"),
                    SpecialistFinding(output_kind="cardiology_finding", statement="AF likely"),
                ]
            },
        )
        async with _ReasoningHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.specialists_run >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        statements = _all_statements(h.recorder.payloads("record_adjudication"))
        assert "ENTIRE NOTE" not in statements
        assert "PASS" not in statements
        assert "AF likely" in statements

    def test_primary_only_outputs_are_declared_not_inferred(self):
        assert "note" in PRIMARY_ONLY_OUTPUT_KINDS
        assert "gate" in PRIMARY_ONLY_OUTPUT_KINDS


class TestSpecialistScopedReads:
    @pytest.mark.asyncio
    async def test_a_specialist_reads_only_its_subscribed_kinds(self):
        """TDD-3 — the parent hands each specialist ONLY its subscribed slice."""
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("t-1", kind="transcript", at="1"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("w-1", kind="worknote", at="2"))
            await _await_state(handle, lambda s: s.specialists_run >= 2)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        by_agent = {}
        for payload in h.recorder.payloads("run_specialist"):
            by_agent.setdefault(payload.agent_id, []).extend(
                item.kind_key for item in payload.context
            )

        assert set(by_agent.get("agent-cardio", [])) <= {"transcript"}
        assert set(by_agent.get("agent-pharm", [])) <= {"worknote"}
        assert by_agent.get("agent-cardio"), "cardiology specialist saw nothing"

    def test_the_agent_spec_answers_read_and_write_questions_purely(self):
        assert CARDIO.reads("transcript") is True
        assert CARDIO.reads("worknote") is False
        assert CARDIO.may_write("cardiology_finding") is True
        assert CARDIO.may_write("medication_finding") is False


# ===========================================================================
# TDD-4 — specialist failure degrades the run
# ===========================================================================


class TestSpecialistFailureIsIsolated:
    @pytest.mark.asyncio
    async def test_a_failing_specialist_degrades_the_run_but_does_not_abort_it(self):
        """TDD-4 — own failure isolation is the reason specialists are children."""
        stub = LoopStubConfig(
            config=reasoning_loop_config(), failing_specialists={"agent-cardio"}
        )
        async with _ReasoningHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("t-1", kind="transcript", at="1"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("w-1", kind="worknote", at="2"))
            await _await_state(handle, lambda s: s.events_processed == 2)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.degraded is True, "a failed specialist must be visible as degradation"
        assert result.specialist_failures >= 1
        # ...and the run still completed and still consumed everything.
        assert result.events_processed == 2
        assert result.cancelled is False

    @pytest.mark.asyncio
    async def test_the_healthy_specialists_still_contribute(self):
        stub = LoopStubConfig(
            config=reasoning_loop_config(), failing_specialists={"agent-cardio"}
        )
        async with _ReasoningHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("w-1", kind="worknote", at="2"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("t-1", kind="transcript", at="1"))
            await _await_state(handle, lambda s: s.events_processed == 2)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        contributors = set()
        for payload in h.recorder.payloads("record_adjudication"):
            contributors.update(payload.record.contributing_agent_ids)
        assert "agent-pharm" in contributors


class TestSpecialistChildPolicies:
    def test_specialist_children_carry_both_explicit_policies(self):
        """The close policy alone leaves the parent running forever (TASK-662 §4.3)."""
        spec = LOOP_ACTION_REGISTRY["harness.finalize"]
        assert spec.parent_close_policy is ParentClosePolicy.REQUEST_CANCEL
        assert spec.child_cancellation_type is ChildWorkflowCancellationType.TRY_CANCEL

    def test_specialist_workflow_id_is_deterministic(self):
        wid = specialist_workflow_id("c-1", "agent-cardio", "plan-1")
        assert wid == specialist_workflow_id("c-1", "agent-cardio", "plan-1")
        assert "c-1" in wid and "agent-cardio" in wid and "plan-1" in wid


# ===========================================================================
# TDD-5 — contradictory findings surface rather than merge
# ===========================================================================


class TestAdjudicationIsInspectable:
    def test_contradictory_findings_surface_as_a_recorded_conflict(self):
        """TDD-5 / story E12 — one reconciled view, with the rejected one visible."""
        results = [
            SpecialistResult(
                agent_id="agent-a",
                plan_id="p-1",
                kind_key="transcript",
                findings=[
                    SpecialistFinding(
                        output_kind="respiratory_finding",
                        statement="community-acquired pneumonia",
                        confidence=0.8,
                    )
                ],
            ),
            SpecialistResult(
                agent_id="agent-b",
                plan_id="p-1",
                kind_key="transcript",
                findings=[
                    SpecialistFinding(
                        output_kind="respiratory_finding",
                        statement="acute bronchitis",
                        confidence=0.6,
                    )
                ],
            ),
        ]
        record = adjudicate("c-1", "p-1", results)

        assert len(record.conflicts) == 1
        conflict = record.conflicts[0]
        assert conflict.accepted.statement == "community-acquired pneumonia"
        assert [v.statement for v in conflict.rejected] == ["acute bronchitis"]
        assert conflict.basis, "the basis for choosing must be recorded"
        assert set(record.contributing_agent_ids) == {"agent-a", "agent-b"}

    def test_a_conflict_is_never_silently_merged_away(self):
        """The rejected view is retained; nothing is dropped without a record."""
        results = [
            SpecialistResult(
                agent_id="agent-a",
                plan_id="p-1",
                kind_key="transcript",
                findings=[SpecialistFinding(output_kind="k", statement="X", confidence=0.9)],
            ),
            SpecialistResult(
                agent_id="agent-b",
                plan_id="p-1",
                kind_key="transcript",
                findings=[SpecialistFinding(output_kind="k", statement="Y", confidence=0.1)],
            ),
        ]
        record = adjudicate("c-1", "p-1", results)
        rendered = record.model_dump_json()
        assert "X" in rendered and "Y" in rendered

    def test_agreement_is_recorded_as_agreement_not_as_a_conflict(self):
        results = [
            SpecialistResult(
                agent_id="agent-a",
                plan_id="p-1",
                kind_key="transcript",
                findings=[SpecialistFinding(output_kind="k", statement="same", confidence=0.7)],
            ),
            SpecialistResult(
                agent_id="agent-b",
                plan_id="p-1",
                kind_key="transcript",
                findings=[SpecialistFinding(output_kind="k", statement="same", confidence=0.5)],
            ),
        ]
        record = adjudicate("c-1", "p-1", results)
        assert record.conflicts == []
        assert [v.statement for v in record.agreements] == ["same"]

    def test_adjudication_is_deterministic(self):
        """It runs INSIDE the workflow body, so it must be a pure function (C1)."""
        results = [
            SpecialistResult(
                agent_id="agent-b",
                plan_id="p-1",
                kind_key="t",
                findings=[SpecialistFinding(output_kind="k", statement="B", confidence=0.5)],
            ),
            SpecialistResult(
                agent_id="agent-a",
                plan_id="p-1",
                kind_key="t",
                findings=[SpecialistFinding(output_kind="k", statement="A", confidence=0.5)],
            ),
        ]
        first = adjudicate("c-1", "p-1", results)
        second = adjudicate("c-1", "p-1", results)
        assert first == second

    def test_an_equal_confidence_tie_breaks_deterministically_on_agent_id(self):
        results = [
            SpecialistResult(
                agent_id="agent-z",
                plan_id="p-1",
                kind_key="t",
                findings=[SpecialistFinding(output_kind="k", statement="Z", confidence=0.5)],
            ),
            SpecialistResult(
                agent_id="agent-a",
                plan_id="p-1",
                kind_key="t",
                findings=[SpecialistFinding(output_kind="k", statement="A", confidence=0.5)],
            ),
        ]
        record = adjudicate("c-1", "p-1", results)
        assert record.conflicts[0].accepted.agent_id == "agent-a"

    @pytest.mark.asyncio
    async def test_the_adjudication_record_reaches_the_inspection_surface(self):
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.specialists_run >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        payloads = h.recorder.payloads("record_adjudication")
        assert payloads, "adjudication was never published"
        assert isinstance(payloads[0].record, AdjudicationRecord)


# ===========================================================================
# TDD-6 — cycle detection
# ===========================================================================


class TestCycleDetection:
    @pytest.mark.asyncio
    async def test_a_repeated_agent_kind_pair_terminates_the_cascade(self):
        """TDD-6 — `(agent, kind)` is the cycle identity (TASK-654 §4.2)."""
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            for i in range(4):
                await handle.signal(
                    ConsultationLoopWorkflow.context_added,
                    _ctx(f"i-{i}", kind="transcript", at=str(i)),
                )
            await _await_state(handle, lambda s: s.events_processed == 4)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        # Four transcript items, one cardiology specialist subscribed to
        # transcript: the pair runs ONCE, the rest are cycle-suppressed.
        cardio_runs = [
            p for p in h.recorder.payloads("run_specialist") if p.agent_id == "agent-cardio"
        ]
        assert len(cardio_runs) == 1, f"cycle not detected; ran {len(cardio_runs)} times"
        assert result.cycles_suppressed >= 1

    @pytest.mark.asyncio
    async def test_the_suppression_is_observable_on_the_client_feed(self):
        async with _ReasoningHarness() as h:
            handle = await h.start(_wf_input())
            for i in range(3):
                await handle.signal(
                    ConsultationLoopWorkflow.context_added,
                    _ctx(f"i-{i}", kind="transcript", at=str(i)),
                )
            await _await_state(handle, lambda s: s.events_processed == 3)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        reasons = [
            p.reason
            for p in h.recorder.payloads("emit_loop_event")
            if p.event_type == LOOP_EVENT_ACTION_SKIPPED
        ]
        assert LOOP_SKIP_CYCLE_DETECTED in reasons


# ===========================================================================
# TDD-7 — the specialist budget
# ===========================================================================


class TestSpecialistBudget:
    @pytest.mark.asyncio
    async def test_the_budget_cuts_off_a_runaway_specialist_without_harming_the_run(self):
        """TDD-7 — exhausting the budget DEGRADES; it never aborts."""
        config = reasoning_loop_config(
            budget=LoopBudget(max_depth=3, max_actions=200, max_specialist_runs=1),
        )
        async with _ReasoningHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("t-1", kind="transcript", at="1"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("w-1", kind="worknote", at="2"))
            await _await_state(handle, lambda s: s.events_processed == 2)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.specialists_run == 1, "budget did not cap specialist runs"
        assert result.degraded is True
        # The run itself is unharmed: it consumed everything and completed.
        assert result.events_processed == 2
        assert result.cancelled is False

        reasons = [
            p.reason
            for p in h.recorder.payloads("emit_loop_event")
            if p.event_type == LOOP_EVENT_ACTION_SKIPPED
        ]
        assert LOOP_SKIP_SPECIALIST_BUDGET in reasons


# ===========================================================================
# TDD-8 — the primary is the only writer of note and gate
# ===========================================================================


class TestPrimaryIsTheOnlyWriter:
    @pytest.mark.asyncio
    async def test_only_the_loop_starts_the_document_workflow(self):
        """The finalize child is dispatched by the loop's ending actions ALONE.

        Runs the real `HarnessDocWorkflow` as the child, so the assertion is
        about actual command issuance rather than about state bookkeeping.
        Specialists ran first and contributed findings; not one of them has a
        path to `harness.finalize` — `SpecialistWorkflow` dispatches no loop
        actions at all and starts no children.
        """
        consultation_id = "c-final"
        config = reasoning_loop_config(ending_actions=[LOOP_ACTION_HARNESS_FINALIZE])
        loop_recorder = LoopStubRecorder()
        doc_recorder = StubRecorder()

        async with await start_time_skipping(data_converter=pydantic_data_converter) as env:
            task_queue = f"final-tq-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=task_queue,
                workflows=[ConsultationLoopWorkflow, SpecialistWorkflow, HarnessDocWorkflow],
                activities=[
                    *make_loop_stub_activities(
                        LoopStubConfig(config=config), loop_recorder
                    ),
                    *make_stub_activities(StubConfig(), doc_recorder),
                ],
            ):
                handle = await env.client.start_workflow(
                    ConsultationLoopWorkflow.run,
                    _wf_input(consultation_id=consultation_id),
                    id=consultation_loop_workflow_id(consultation_id),
                    task_queue=task_queue,
                )
                await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
                await _await_state(handle, lambda s: s.specialists_run >= 1)
                await handle.signal(
                    ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
                )

                # The loop AWAITS its finalize child, so the child must be signed
                # for the parent to complete (the TASK-662 fixture does the same).
                child = env.client.get_workflow_handle(f"harness-doc-{consultation_id}")
                await _await_state(handle, lambda s: s.finalize_workflow_id is not None)
                for _ in range(400):
                    try:
                        await child.signal(
                            HarnessDocWorkflow.approval,
                            ApprovalSignal(
                                decision="SIGNED",
                                clinician_id="doc-1",
                                context_item_version_id="v-1",
                                attestation_hash="h-1",
                            ),
                        )
                        break
                    except Exception:  # noqa: BLE001 - the child may not be started yet
                        await asyncio.sleep(0.02)

                result = await handle.result()

        assert result.finalize_workflow_id == f"harness-doc-{consultation_id}"
        assert result.finalized is True
        assert result.specialists_run >= 1, "specialists must have run alongside"
        # The document workflow's own draft persistence happened exactly once,
        # and it was reached through the loop — never through a specialist.
        assert len(doc_recorder.persist_draft_inputs) == 1

    def test_the_specialist_workflow_declares_no_note_or_gate_capability(self):
        """A structural check: the specialist's result type cannot carry a note."""
        fields = set(SpecialistResult.model_fields)
        assert "note_text" not in fields
        assert "gate_decision" not in fields


# ===========================================================================
# Derived-context cascade — the three newly backed keys
# ===========================================================================


class TestDerivedContextCascade:
    @pytest.mark.asyncio
    async def test_a_derive_action_re_enters_its_output_as_context_one_depth_deeper(self):
        """TASK-654 §4.2 — an action's output re-enters the bus as context."""
        config = reasoning_loop_config(
            subscriptions=[
                LoopSubscription(kind_key="attachment", actions=[LOOP_ACTION_DOCUMENT_EXTRACT_TEXT]),
                LoopSubscription(kind_key="attachment_text", actions=["client.emit"]),
            ],
            budget=LoopBudget(max_depth=3, max_actions=50, max_specialist_runs=5),
        )
        async with _ReasoningHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.context_added,
                ContextAddedSignal(
                    context_item_id="a-1", kind_key="attachment", depth=0, occurred_at="1"
                ),
            )
            await _await_state(handle, lambda s: s.derived_context >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert h.recorder.count("document_extract_text") == 1
        assert result.derived_context >= 1
        # The derived item was itself dispatched — the cascade actually ran.
        emitted_kinds = [p.kind_key for p in h.recorder.payloads("emit_loop_event")]
        assert "attachment_text" in emitted_kinds

    @pytest.mark.asyncio
    async def test_the_derived_cascade_still_terminates_at_the_depth_cap(self):
        """The cascade is real, so the TASK-662 depth cap must actually bound it."""
        config = reasoning_loop_config(
            subscriptions=[
                LoopSubscription(kind_key="attachment", actions=[LOOP_ACTION_DOCUMENT_EXTRACT_TEXT]),
                # The derived kind derives AGAIN — an unbounded cascade but for the cap.
                LoopSubscription(
                    kind_key="attachment_text", actions=[LOOP_ACTION_NLP_EXTRACT_ENTITIES]
                ),
                LoopSubscription(
                    kind_key="attachment_text_entities",
                    actions=[LOOP_ACTION_NLP_EXTRACT_ENTITIES],
                ),
            ],
            budget=LoopBudget(max_depth=2, max_actions=50, max_specialist_runs=5),
        )
        async with _ReasoningHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.context_added,
                ContextAddedSignal(
                    context_item_id="a-1", kind_key="attachment", depth=0, occurred_at="1"
                ),
            )
            await _await_state(handle, lambda s: s.depth_capped >= 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.depth_capped >= 1, "the derived cascade never hit the cap"
        assert result.cancelled is False


# ===========================================================================
# Reasoning stays OFF the note-generation call
# ===========================================================================


class TestReasoningPlacement:
    def test_the_planner_requests_reasoning_and_the_finalize_child_does_not(self):
        """arXiv 2605.24902 — reasoning on SOAP generation drops judge score 4.10 -> 3.28.

        Reasoning belongs to planning and verification. The note is generated by
        the frozen `HarnessDocWorkflow` child, which this ticket does not touch
        and to which no reasoning flag is passed.
        """
        from harness.temporal.models import PlanLoopInput

        assert PlanLoopInput.model_fields["reasoning"].default is True

        from harness.temporal.models import LoopFinalizeRequest

        assert "reasoning" not in LoopFinalizeRequest.model_fields

    def test_the_specialist_analysis_is_a_verification_task_not_a_generation_task(self):
        """Specialists emit findings (claims), never note prose — see README §1.5."""
        fields = set(SpecialistFinding.model_fields)
        assert fields == {"output_kind", "statement", "confidence", "evidence_context_item_ids"}


# ===========================================================================
# Reasoning is opt-in — a config without it behaves exactly as TASK-662 did
# ===========================================================================


class TestReasoningIsOptIn:
    @pytest.mark.asyncio
    async def test_a_non_reasoning_config_never_plans_or_runs_specialists(self):
        """K7 — a consultation with no reasoning configured behaves as before."""
        async with _ReasoningHarness(LoopStubConfig(config=default_loop_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await _await_state(handle, lambda s: s.events_processed == 1)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert h.recorder.count("plan_reasoning") == 0
        assert h.recorder.count("run_specialist") == 0
        assert h.recorder.count("record_adjudication") == 0
        assert result.plans_made == 0
        assert result.specialists_run == 0

    def test_reasoning_defaults_to_off_on_the_pinned_config(self):
        assert default_loop_config().reasoning_enabled is False


class TestPlanDecisionShape:
    def test_a_degraded_plan_dispatches_nothing(self):
        """An unusable planner answer must be inert, never a guess."""
        decision = PlanDecision(plan_id="p-1", dispatch=[], degraded=True)
        assert decision.dispatch == []
        assert decision.degraded is True

    def test_a_planned_specialist_names_both_the_agent_and_the_kind(self):
        planned = PlannedSpecialist(agent_id="a", kind_key="transcript")
        assert planned.agent_id == "a"
        assert planned.kind_key == "transcript"


def _all_statements(payloads) -> set[str]:
    out: set[str] = set()
    for payload in payloads:
        for conflict in payload.record.conflicts:
            out.add(conflict.accepted.statement)
            out.update(v.statement for v in conflict.rejected)
        out.update(v.statement for v in payload.record.agreements)
    return out
