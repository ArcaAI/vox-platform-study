"""TASK-932 R-16a — the LIVE HANDOFF: what the durable interpreter does with the live lane's work.

The defect this suite pins, measured on the live dev stack 2026-09-09 (workflow
`workflow-interpreter-01a082e8-df34-7553-8f7b-47136b0c754c`): `interpreter.core_agent` for the
seeded `n_finalize` node was scheduled with `bound_inputs: {}` and completed
`{"status":"DEGRADED","reason":"core.agent: nothing bound on \\`in\\`/\\`context\\` to generate
from"}`. Every consultation ended with no finalized note.

Two independent causes, one per half of this file:

1. **The outputs were invisible.** `_has_live_owner` skips every `realtime` node of a
   consultation-bound run so exactly one runtime executes it — but the skip stored no output, and
   `_resolve_bound_inputs` reads `self._node_outputs`. The durable consumer therefore bound
   nothing. Skipping a node says WHO runs it; it never said its output does not exist.
2. **The walk arrived too early.** The run is dispatched at consultation OPEN
   (`ConsultationWorkflowDispatchService`, trigger `consultation open`) and the stage walk has no
   wait in it, so the `onEnd` finalizer ran within a second of the consultation opening — before
   a word had been spoken. Even a perfect handoff would have found nothing.

Same hermetic pattern as `test_core_interpreter.py`: a real ephemeral Temporal server, the real
interpreter, and only the network-bound activities replaced by stubs registered under their
production names.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.models import (
    InterpreterInput,
    LiveOutputsRequest,
    LiveOutputsResult,
    NodeActivityInput,
    NodeActivityResult,
    RunSubject,
)
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES
from harness.tests.unit.temporal.interpreter.test_core_interpreter import (
    _TENANT,
    _body,
    _node,
    _store,
    _trigger,
)

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"

#: What each dispatched `core.agent` was actually handed. A module-level capture because
#: `InterpreterResult` carries per-node STATUS only — the whole point of the fix is what arrived
#: on `bound_inputs`, which no result surface reports.
_SEEN: dict[str, NodeActivityInput] = {}

#: Scripted answers for `interpreter.load_live_outputs`, popped in order; the last one repeats.
_HANDOFF_SCRIPT: list[LiveOutputsResult] = []
#: Every request the workflow made, so "did it wait?" and "did it ask at all?" are both testable.
_HANDOFF_CALLS: list[LiveOutputsRequest] = []


@activity.defn(name="interpreter.core_agent")
async def stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    _SEEN[payload.node_id] = payload
    bound = payload.bound_inputs
    text = bound.get("in") or bound.get("context")
    if not text:
        # The REAL degrade this ticket exists to remove — same status and reason as
        # `_run_text_generation`'s `no_bound_text` arm, so a test that stops reproducing it is
        # measuring the fix and not the stub.
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: nothing bound on `in`/`context` to generate from",
        )
    return NodeActivityResult(status="SUCCEEDED", output={"text": f"finalized({text})"})


@activity.defn(name="interpreter.load_live_outputs")
async def stub_load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
    _HANDOFF_CALLS.append(request)
    if not _HANDOFF_SCRIPT:
        return LiveOutputsResult(ended=True)
    return _HANDOFF_SCRIPT.pop(0) if len(_HANDOFF_SCRIPT) > 1 else _HANDOFF_SCRIPT[0]


_STUBBED = {"interpreter.core_agent", "interpreter.load_live_outputs"}
_ACTIVITIES = [
    *[
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name not in _STUBBED
    ],
    *LOOP_ACTIVITIES,
    *SCAFFOLD_ACTIVITIES,
    stub_core_agent,
    stub_load_live_outputs,
]
_WORKFLOWS = [WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow]


def _realtime_agent(node_id: str, slug: str) -> dict:
    return _node(
        node_id,
        "core.agent",
        "interpreter.core_agent",
        config={
            "agentRef": {"slug": slug},
            "execution": {"lane": "realtime", "cadence": "perTurn"},
        },
        # The seeded graph's own wiring: `n_trigger.out -> n_summary.context`.
        inputs=[{"fromNodeId": "n_trigger", "fromPort": "out", "toPort": "context"}],
    )


def _durable_finalizer(node_id: str, from_node: str) -> dict:
    return _node(
        node_id,
        "core.agent",
        "interpreter.core_agent",
        config={
            "agentRef": {"slug": "casenote-finalization"},
            "execution": {"lane": "durable", "cadence": "onEnd"},
        },
        inputs=[{"fromNodeId": from_node, "fromPort": "out", "toPort": "in"}],
    )


def _consultation_graph() -> dict:
    """The seeded shape, reduced to the edge that broke: realtime summary -> durable finalize."""
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [_realtime_agent("n_summary", "general-medicine-summarization")],
            },
            {"stageIndex": 2, "nodes": [_durable_finalizer("n_finalize", "n_summary")]},
        ]
    )


async def _run(
    body: dict, *, subject: RunSubject | None = None, sandbox: bool = False
) -> dict[str, Any]:
    ref = await _store(body)
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"task932-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            result = await env.client.execute_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=_TENANT,
                    run_id=run_id,
                    sandbox=sandbox,
                    # What `sanitize_run_payload` re-stamps before a real run starts: identity
                    # reaches the nodes through `run_payload`, and `core.trigger` publishes it
                    # as the run's `trigger` context.
                    payload={
                        "visit_type": "new-visit",
                        **(
                            {"consultationId": subject.consultation_id}
                            if subject is not None
                            else {}
                        ),
                    },
                    subject=subject,
                ),
                id=f"wf-task932-{run_id}",
                task_queue=tq,
            )
    return {n.node_id: n for s in result.stages for n in s.nodes}


@pytest.fixture(autouse=True)
def _reset() -> None:
    _SEEN.clear()
    _HANDOFF_CALLS.clear()
    _HANDOFF_SCRIPT.clear()


class TestLiveHandoff:
    @pytest.mark.asyncio
    async def test_a_live_owned_node_s_persisted_output_binds_into_its_durable_consumer(self):
        """THE FIX. `n_summary` is skipped (`realtime_lane`) and `n_finalize` still gets its note."""
        _HANDOFF_SCRIPT.append(
            LiveOutputsResult(ended=True, outputs={"n_summary": {"text": "S: cough for 3 days"}})
        )
        by_id = await _run(_consultation_graph(), subject=RunSubject(consultationId=_CONSULTATION))

        assert by_id["n_summary"].status == "SKIPPED"
        assert by_id["n_summary"].reason == "realtime_lane"
        assert by_id["n_finalize"].status == "SUCCEEDED"
        # The whole ticket, in one assertion: `bound_inputs` is no longer `{}`.
        assert _SEEN["n_finalize"].bound_inputs == {"in": "S: cough for 3 days"}

    @pytest.mark.asyncio
    async def test_the_handoff_names_the_nodes_the_walk_actually_skipped(self):
        _HANDOFF_SCRIPT.append(LiveOutputsResult(ended=True, outputs={"n_summary": {"text": "x"}}))
        await _run(_consultation_graph(), subject=RunSubject(consultationId=_CONSULTATION))

        assert [c.node_ids for c in _HANDOFF_CALLS] == [["n_summary"]]
        assert _HANDOFF_CALLS[0].consultation_id == _CONSULTATION
        assert _HANDOFF_CALLS[0].tenant_id == _TENANT

    @pytest.mark.asyncio
    async def test_it_WAITS_for_the_live_session_to_end_rather_than_finalizing_at_open(self):
        """Cause 2. The run starts at consultation OPEN; the finalizer must not run there.

        Three `ended: false` answers stand in for a consultation still being recorded. The
        time-skipping environment fast-forwards the poll interval, so this measures the LOOP,
        not wall-clock.
        """
        _HANDOFF_SCRIPT.extend(
            [
                LiveOutputsResult(ended=False),
                LiveOutputsResult(ended=False),
                LiveOutputsResult(ended=False),
                LiveOutputsResult(ended=True, outputs={"n_summary": {"text": "the running note"}}),
            ]
        )
        by_id = await _run(_consultation_graph(), subject=RunSubject(consultationId=_CONSULTATION))

        assert len(_HANDOFF_CALLS) == 4
        assert by_id["n_finalize"].status == "SUCCEEDED"
        assert _SEEN["n_finalize"].bound_inputs == {"in": "the running note"}

    @pytest.mark.asyncio
    async def test_a_handoff_that_produced_nothing_degrades_EXACTLY_as_before(self):
        """A consultation that never recorded. No note is invented; the named degrade stands."""
        _HANDOFF_SCRIPT.append(LiveOutputsResult(ended=True, outputs={}))
        by_id = await _run(_consultation_graph(), subject=RunSubject(consultationId=_CONSULTATION))

        assert by_id["n_finalize"].status == "DEGRADED"
        assert by_id["n_finalize"].reason == (
            "core.agent: nothing bound on `in`/`context` to generate from"
        )
        assert _SEEN["n_finalize"].bound_inputs == {}

    @pytest.mark.asyncio
    async def test_an_exposure_plane_run_never_asks_for_a_handoff(self):
        """No subject ⇒ no live owner ⇒ nothing was skipped ⇒ nothing to wait for.

        The realtime node RUNS here (TASK-930 D-1), so its own output binds and the API plane
        keeps the behaviour that ticket gave it — at zero added latency.
        """
        by_id = await _run(_consultation_graph())

        assert _HANDOFF_CALLS == []
        assert by_id["n_summary"].status == "SUCCEEDED"
        assert by_id["n_finalize"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_a_sandbox_run_never_waits_on_a_live_session(self):
        """A Workbench execution is a dry run of the graph, not a consultation.

        Its `external_write` nodes are already suppressed, so a handoff would buy it nothing —
        and parking it for the length of a clinical session would turn "preview this workflow"
        into a two-hour wait.
        """
        _HANDOFF_SCRIPT.append(LiveOutputsResult(ended=False))
        by_id = await _run(
            _consultation_graph(),
            subject=RunSubject(consultationId=_CONSULTATION),
            sandbox=True,
        )

        assert _HANDOFF_CALLS == []
        assert by_id["n_summary"].reason == "realtime_lane"

    @pytest.mark.asyncio
    async def test_the_handoff_context_reaches_the_agent_s_prompt_scope_as_context_dot_star(self):
        """R-16a's DNA half: `{{context.dna_style_text}}` in the seeded finalize instruction.

        `_prompt_scope` aliases `trigger` as `context`, and `_run_context` overlays the handoff's
        own context onto it — so the clinician's effective writing style reaches the prompt
        without ever travelling in the caller-composed run payload.
        """
        _HANDOFF_SCRIPT.append(
            LiveOutputsResult(
                ended=True,
                outputs={"n_summary": {"text": "note"}},
                context={"dna_style_text": "Terse. Abbreviates freely.", "dna_style_id": "rep-1"},
            )
        )
        await _run(_consultation_graph(), subject=RunSubject(consultationId=_CONSULTATION))

        trigger = _SEEN["n_finalize"].run_context["trigger"]
        assert trigger["dna_style_text"] == "Terse. Abbreviates freely."
        assert trigger["dna_style_id"] == "rep-1"
        # Identity is untouched — the overlay ADDS, it does not replace the run's own subject.
        assert trigger["consultationId"] == _CONSULTATION
        # TASK-946 OD-3 — and the SAME context is reachable under the namespace both lanes
        # share, across the real activity-input serialization rather than in-process.
        assert trigger["context"]["dna_style_text"] == "Terse. Abbreviates freely."
        assert trigger["context"]["consultationId"] == _CONSULTATION
