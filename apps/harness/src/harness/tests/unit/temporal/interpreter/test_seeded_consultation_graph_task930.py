"""TASK-930 D-1 — the seeded consultation graph must be able to serve the API plane it declares.

`general-medicine-consultation` is seeded with ``kinds: ['consultation', 'api']`` and a
``core.output`` contract, and the §6.9 local run showed it could satisfy neither on the API
plane::

    n_trigger  SUCCEEDED
    n_asr      SKIPPED    realtime_lane
    n_ner      SKIPPED    realtime_lane
    n_summary  SKIPPED    realtime_lane
    n_finalize DEGRADED   core.agent: nothing bound on `in`/`context` to generate from
    n_review   SUCCEEDED
    n_output   FAILED     'case_note' is a required property

Two independent defects, fixed together because either alone still yields no case note.

**S1 — lane ownership needs an OWNER.** The durable interpreter skipped every ``realtime`` node
because "the live executor owns it". That is true of a CONSULTATION-bound run and false of an
exposure-plane one, where no live executor exists and the skip means nobody ever runs the node.
The rule the skip protects — exactly one runtime executes any given node, because
``external_write`` nodes would otherwise double-write one consultation's document — is a rule
about a consultation, and it is preserved verbatim where a consultation exists. So the skip is now
conditional on the run being consultation-bound.

**S2 — the graph laundered its own result.** ``n_output.in`` was fed from ``n_review.out``, which
is the review DECISION object (``{outcome, reviewer_id, comment, edited_payload, escalations}``) —
so the declared ``{case_note, ...}`` output was unreachable on EITHER plane, no matter what ran.
The finalized note now flows ``n_finalize.data -> n_output.in`` and the review contributes the
ORDERING edge it should always have been (``n_review.next -> n_output.after``).

``entities`` left the required list with the same honesty: NER consumes a ``transcript``, and the
port lattice deliberately refuses to feed it anything else (``port-model.ts``: "``document -> ner``
is a type error … the anti-hallucination-laundering rule made structural"). Only live audio
produces a transcript, so an API-plane run has no entities and must not claim to.

Hermetic: an ephemeral time-skipping Temporal server, the real interpreter, and only
``interpreter.core_agent`` stubbed (under its production name) — dispatching on the node's own
``agentRef.slug`` so each seeded agent behaves as it would with LLM/NLP reachable.

The compiled config under test is the SEEDED one, read from the generated blob module, so this
test fails if the seed graph regresses.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
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
    ReviewDecisionSignal,
    RunSubject,
)
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow, review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event

_BUCKET = "harness-claim-check"
_GLOBAL_TENANT = "50000000-0000-0000-0000-000000000000"
_CASE_NOTE = "S: Epigastric pain ...\nP: Stop the NSAID, start a PPI."

#: What an API-plane caller supplies: the payload shape the seeded `consultation_note_context`
#: derives — one property per declared kind, the clinical fields under `context`, and every field
#: that schema marks REQUIRED (the trigger's own gate, which this test must satisfy honestly
#: rather than route around).
_API_CONTEXT = {
    "visit_type": "new-visit",
    "current_department": "General Medicine",
    "language": "en",
    "safe_age": "54",
    "safe_dob": "Unknown",
    "safe_gender": "male",
    "formatted_previous_visits": "",
    "formatted_vitals": "Not available",
    "chief_complaint": "Epigastric pain for two weeks",
}

# ---------------------------------------------------------------------------------------------
# The SEEDED compiled config
# ---------------------------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[8]
_GENERATED = (
    _REPO_ROOT / "packages/database/src/prisma/db_main/seed/28-workflow-library.generated.ts"
)
_ANCHOR = (
    "export const WORKFLOW_LIBRARY_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = "
)


def _seeded_blobs() -> dict[str, Any]:
    """The generated blobs, parsed out of the module `regen-workflow-seeds.ts` writes.

    That module is machine-written — the export is a literal `JSON.stringify(blobs, null, 2)`
    (`renderModule`), and its own header forbids hand edits — so parsing it is reading the same
    artifact the seed reads rather than keeping a second copy that could drift from it.
    """
    source = _GENERATED.read_text(encoding="utf-8")
    start = source.index(_ANCHOR) + len(_ANCHOR)
    end = source.rindex("};") + 1
    return json.loads(source[start:end])


def _seeded_consultation_config() -> dict[str, Any]:
    blob = _seeded_blobs()["GLOBAL:general-medicine-consultation"]
    return blob["compiledConfig"]


def _node_config(config: dict[str, Any], node_id: str) -> dict[str, Any]:
    for stage in config["stages"]:
        for node in stage["nodes"]:
            if node["nodeId"] == node_id:
                return node
    raise AssertionError(f"the seeded graph has no node {node_id!r}")


# ---------------------------------------------------------------------------------------------
# The one stubbed activity
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_agent")
async def stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """Behaves as each seeded agent would with the NLP/LLM planes reachable.

    The two realtime agents degrade EXACTLY as the real activities do when the API plane hands
    them nothing (`_run_transcription` -> `no_audio`, `_run_ner` -> no text on `in`), so this test
    asserts the graph survives their absence rather than pretending they produced something.
    """
    slug = (payload.config.get("agentRef") or {}).get("slug")
    bound = payload.bound_inputs

    if slug == "realtime-transcription":
        if not bound.get("audio"):
            return NodeActivityResult(status="DEGRADED", reason="core.agent: no audio bound")
        return NodeActivityResult(status="SUCCEEDED", output={"transcript": "spoken words"})

    if slug == "medical-ner":
        if not bound.get("in"):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: no text arrived on the `in` port — nothing to extract from",
            )
        return NodeActivityResult(
            status="SUCCEEDED",
            output={"data": {"entities": [{"text": "metformin", "label": "MEDICATION"}]}},
        )

    if slug == "general-medicine-summarization":
        if not (bound.get("in") or bound.get("context")):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: nothing bound on `in`/`context` to generate from",
            )
        return NodeActivityResult(status="SUCCEEDED", output={"text": "running note"})

    if slug == "casenote-finalization":
        if not (bound.get("in") or bound.get("context")):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: nothing bound on `in`/`context` to generate from",
            )
        # `outputSchema` is applied as a `json_schema` response format (§5), so the real
        # activity parses the completion into `data` — this is that shape.
        return NodeActivityResult(
            status="SUCCEEDED",
            output={
                "text": json.dumps({"case_note": _CASE_NOTE, "redactions": []}),
                "data": {"case_note": _CASE_NOTE, "redactions": []},
            },
        )

    raise AssertionError(f"the seeded graph bound an unexpected agent: {slug!r}")


#: TASK-932 R-16a — the LIVE HANDOFF, scripted. A consultation-bound run now WAITS for the live
#: session to hand its outputs over before dispatching the durable `onEnd` finalizer, so this
#: suite has to say what the live lane produced. `_LIVE_OUTPUTS` empty ⇒ "the live lane produced
#: nothing", which is the state that reproduces the original `no_bound_text` degrade.
_LIVE_OUTPUTS: dict[str, dict[str, Any]] = {}


@activity.defn(name="interpreter.load_live_outputs")
async def stub_load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
    return LiveOutputsResult(
        ended=True,
        outputs={k: v for k, v in _LIVE_OUTPUTS.items() if k in set(request.node_ids)},
        context={},
    )


_STUBBED = {"interpreter.core_agent", "interpreter.load_live_outputs"}
_ACTIVITIES = [
    *[
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name not in _STUBBED
    ],
    *LOOP_ACTIVITIES,
    stub_core_agent,
    stub_load_live_outputs,
]
_WORKFLOWS = [WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow]


async def _run(
    config: dict[str, Any], *, payload: dict, subject: RunSubject | None, review: str | None
):
    # Stored VERBATIM: the seeded compiled config already carries the `checksum` the compiler
    # stamped, and `parse_and_verify` re-derives it. Recomputing one here would test this test.
    ref = await store_blob(json.dumps(config), store=_MEMORY_STORE, bucket=_BUCKET)
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"seeded-core-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id=config["definitionId"],
                    config_ref=ref,
                    tenant_id=_GLOBAL_TENANT,
                    run_id=run_id,
                    payload=payload,
                    subject=subject,
                ),
                id=f"wf-seeded-{run_id}",
                task_queue=tq,
            )
            if review is not None:

                def _review_started(event: Any) -> bool:
                    return (
                        event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                        and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                        == review_gate_workflow_id(run_id, "n_review")
                    )

                await await_history_event(
                    handle, _review_started, description="review child started"
                )
                await env.client.get_workflow_handle(
                    review_gate_workflow_id(run_id, "n_review")
                ).signal(
                    ReviewGateWorkflow.review,
                    ReviewDecisionSignal(decision=review, reviewer_id="dr-1"),
                )
            result = await handle.result()
            return result, {n.node_id: n for s in result.stages for n in s.nodes}


# ---------------------------------------------------------------------------------------------


class TestTheSeededGraphIsWhatItClaims:
    def test_it_declares_both_kinds(self) -> None:
        trigger = _node_config(_seeded_consultation_config(), "n_trigger")
        assert trigger["config"]["kinds"] == ["consultation", "api"]

    def test_the_output_is_fed_by_the_finalizer_not_by_the_review_decision(self) -> None:
        output = _node_config(_seeded_consultation_config(), "n_output")
        data_sources = {
            (binding["fromNodeId"], binding["fromPort"])
            for binding in output["inputs"]
            if binding["toPort"] != "after"
        }
        assert data_sources == {("n_finalize", "data")}
        # The review still gates the publish — as ORDERING, which is what a review handle carries.
        assert any(
            binding["toPort"] == "after" and binding["fromNodeId"] == "n_review"
            for binding in output["inputs"]
        )

    def test_entities_are_not_claimed_as_a_required_output(self) -> None:
        schema = _node_config(_seeded_consultation_config(), "n_output")["config"]["outputSchema"]
        assert schema["required"] == ["case_note"]


class TestTheApiPlane:
    @pytest.mark.asyncio
    async def test_an_unbound_run_reaches_the_output_with_a_case_note(self) -> None:
        config = _seeded_consultation_config()
        result, nodes = await _run(
            config,
            payload={"context": _API_CONTEXT},
            subject=None,
            review="approved",
        )

        assert nodes["n_trigger"].status == "SUCCEEDED"
        # No live executor owns this run, so the durable interpreter runs the realtime nodes
        # itself rather than skipping into an unsatisfiable output.
        assert nodes["n_asr"].reason != "realtime_lane"
        assert nodes["n_summary"].status == "SUCCEEDED"
        assert nodes["n_finalize"].status == "SUCCEEDED"
        # `core.output` runs the REAL activity and `onSchemaViolation: 'fail'` raises on a
        # mismatch, so SUCCEEDED is exactly "a payload satisfying `required: ['case_note']`,
        # `case_note: string` was published". `InterpreterResult` carries no payload to read.
        assert nodes["n_output"].status == "SUCCEEDED"
        assert result.status != "FAILED"

    @pytest.mark.asyncio
    async def test_the_asr_and_ner_steps_degrade_honestly_without_audio(self) -> None:
        _, nodes = await _run(
            _seeded_consultation_config(),
            payload={"context": {**_API_CONTEXT, "visit_type": "revisit"}},
            subject=None,
            review="approved",
        )
        assert nodes["n_asr"].status == "DEGRADED"
        assert nodes["n_ner"].status == "DEGRADED"


class TestTheConsultationPlaneIsUnCHANGED:
    @pytest.mark.asyncio
    async def test_a_consultation_bound_run_still_leaves_the_realtime_nodes_to_the_live_lane(
        self,
    ) -> None:
        _LIVE_OUTPUTS.clear()
        _LIVE_OUTPUTS["n_summary"] = {"text": "running note from the live lane"}
        try:
            _, nodes = await _run(
                _seeded_consultation_config(),
                payload={},
                subject=RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"),
                review="approved",
            )
        finally:
            _LIVE_OUTPUTS.clear()
        for node_id in ("n_asr", "n_ner", "n_summary"):
            assert nodes[node_id].status == "SKIPPED"
            assert nodes[node_id].reason == "realtime_lane"


class TestTheConsultationPlaneFinalizes:
    """TASK-932 R-16a — the OTHER half of the §6.9 table, on the plane that ships.

    TASK-930 fixed the API plane. On the consultation plane the same two nodes stayed broken for
    a different reason: the realtime skip is CORRECT there (the live executor owns those nodes),
    but it left their outputs invisible, so `n_finalize` degraded `no_bound_text` on every real
    consultation and `n_output` published nothing.
    """

    @pytest.mark.asyncio
    async def test_the_finalizer_gets_the_live_lane_s_note_and_the_output_publishes(self) -> None:
        _LIVE_OUTPUTS.clear()
        _LIVE_OUTPUTS["n_summary"] = {"text": "S: cough x3d\nO: afebrile\nA: URTI\nP: fluids"}
        try:
            result, nodes = await _run(
                _seeded_consultation_config(),
                payload={},
                subject=RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"),
                review="approved",
            )
        finally:
            _LIVE_OUTPUTS.clear()

        assert nodes["n_summary"].status == "SKIPPED"
        assert nodes["n_finalize"].status == "SUCCEEDED"
        # `core.output` runs for real with `onSchemaViolation: 'fail'`, so SUCCEEDED IS
        # "a payload satisfying `required: ['case_note']` was published".
        assert nodes["n_output"].status == "SUCCEEDED"
        assert result.status != "FAILED"

    @pytest.mark.asyncio
    async def test_a_consultation_that_never_recorded_still_degrades_with_the_named_reason(
        self,
    ) -> None:
        """Nothing is invented for a session with no live output — the §6.9 line stands.

        TASK-946 D3 / OD-4 — and the run now REACHES its terminal state. `review=None`: this run
        is never signalled, because no clinician gate is opened. `n_review` binds `in` from
        `n_finalize.out`, the degraded finalizer stores no output, so the gate would be opened on
        `{}` — which is exactly what the three trials of 2026-09-10 did, parking a clinician on
        an empty note for the full 3,600 s deadline before `n_output` failed its schema and the
        run closed FAILED an hour after the consultation had stopped. The gate is skipped
        instead, and this test COMPLETING without ever signalling one is the proof.
        """
        _LIVE_OUTPUTS.clear()
        result, nodes = await _run(
            _seeded_consultation_config(),
            payload={},
            subject=RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"),
            review=None,
        )
        assert nodes["n_finalize"].status == "DEGRADED"
        assert nodes["n_finalize"].reason == (
            "core.agent: nothing bound on `in`/`context` to generate from"
        )
        assert nodes["n_review"].status == "DEGRADED"
        assert nodes["n_review"].reason == "review_skipped_empty_payload"
        # The run still fails, and on the honest cause: `core.output` carries
        # `onSchemaViolation: 'fail'` and there is no `case_note` to publish.
        assert nodes["n_output"].status == "FAILED"
        assert result.status == "FAILED"
