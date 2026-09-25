"""TASK-1006 (A-2) — an UNBOUND consultation run carrying a text transcript on ``work_note``.

ALaaS's queue lane summarises a finished recording by running the department's ArcaAI
consultation workflow on the unbound plane (``hope.workflows.run``) with the transcript on the
declared TEXT trigger kind ``work_note`` (``{ text }``) and no audio. For the note path to match a
recording's, the transcript has to reach the same sockets ``n_asr.transcript`` feeds on the live
path: ``n_ner.in``, and — through NER's pass-through ``out`` — every ``n_summary_*.in``.

What the SEEDED graphs do with that payload today (the graphs are read from the generated blob
modules, so this suite follows the seed):

* ``n_asr`` degrades ``no_audio`` (its ``audio`` socket has no edge), so ``n_ner.in`` receives
  nothing and NER degrades.
* ``n_summary_*`` still run, because ``n_trigger.out -> n_summary_*.context`` hands them the whole
  trigger payload — the transcript arrives ONLY as a field inside that JSON envelope, never on
  ``in``.

The ``xfail(strict=True)`` cases pin the gap: no socket of the current ``core`` vocabulary can
lift a TEXT kind out of the trigger's ``context<schemaRef>`` object onto a ``text`` input
(``core.trigger`` publishes one ``context<schemaRef>`` socket; ``core.data``/``core.variable``
publish ``object``; the lattice widens ``context<schemaRef>`` only to ``object``). Closing it needs
a registry change — the lane report lists the options. When that lands these cases XPASS, and
``strict`` turns that into a failure so the marker is removed with the fix.

Hermetic: an ephemeral time-skipping Temporal server, the real interpreter, and only
``interpreter.core_agent`` stubbed (under its production name) — dispatching on the node's own
``agentRef.slug``, and recording what each node was bound.
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
    NodeActivityInput,
    NodeActivityResult,
    ReviewDecisionSignal,
)
from harness.temporal.interpreter.nodes.core import _texts
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow, review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event

_BUCKET = "harness-claim-check"
_ARCAAI_TENANT = "50000000-0000-0000-0000-000000000001"
_GLOBAL_TENANT = "50000000-0000-0000-0000-000000000000"
_TRANSCRIPT = (
    "Doctor: What brings you in today? Patient: A dry cough for three days and a mild fever."
)
_CASE_NOTE = "S: Dry cough x3d, mild fever.\nP: Fluids, review in 5 days."

#: The `context` kind every ArcaAI / library consultation trigger declares — its REQUIRED fields,
#: in the shape ALaaS's `buildConsultationWorkflowInput` sends them.
_CONTEXT = {
    "visit_type": "new-visit",
    "current_department": "General Medicine",
    "language": "en",
    "conversation_language": "en",
    "safe_age": "54",
    "safe_dob": "Unknown",
    "safe_gender": "male",
    "formatted_previous_visits": "",
    "formatted_vitals": "Not available",
}

# ---------------------------------------------------------------------------------------------
# The SEEDED compiled configs
# ---------------------------------------------------------------------------------------------

_SEED_DIR = Path(__file__).resolve().parents[8] / "packages/database/src/prisma/db_main/seed"
_GENERATED_MODULES = {
    "28-workflow-library.generated.ts": (
        "export const WORKFLOW_LIBRARY_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = "
    ),
    "29-arcaai-agents-and-workflows.generated.ts": (
        "export const ARCAAI_GENERATED: Readonly<Record<string, GeneratedWorkflowBlob>> = "
    ),
}


def _seeded_blobs() -> dict[str, Any]:
    """Every generated blob — parsed out of the machine-written modules the seed reads."""
    blobs: dict[str, Any] = {}
    for file_name, anchor in _GENERATED_MODULES.items():
        source = (_SEED_DIR / file_name).read_text(encoding="utf-8")
        start = source.index(anchor) + len(anchor)
        end = source.rindex("};") + 1
        blobs.update(json.loads(source[start:end]))
    return blobs


#: Every seeded CONSULTATION graph (the ArcaAI eleven + the library's two copies).
_CONSULTATION_KEYS = sorted(key for key in _seeded_blobs() if key.endswith("-consultation"))

#: The two executed here — one ArcaAI visit-type split, one library single summarizer.
_EXECUTED = {
    "ARCAAI:arcaai-gen-consultation": (_ARCAAI_TENANT, ["n_summary_new"]),
    "GLOBAL:general-medicine-consultation": (_GLOBAL_TENANT, ["n_summary"]),
}


def _config(key: str) -> dict[str, Any]:
    return _seeded_blobs()[key]["compiledConfig"]


def _compiled_node(config: dict[str, Any], node_id: str) -> dict[str, Any]:
    for stage in config["stages"]:
        for node in stage["nodes"]:
            if node["nodeId"] == node_id:
                return node
    raise AssertionError(f"the seeded graph has no node {node_id!r}")


# ---------------------------------------------------------------------------------------------
# The one stubbed activity — records what each node was BOUND
# ---------------------------------------------------------------------------------------------

_BOUND: dict[str, dict[str, Any]] = {}


@activity.defn(name="interpreter.core_agent")
async def stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """Each seeded agent as it would behave with the NLP/LLM planes reachable.

    The degrade conditions are the real activities' own: ASR needs an `audio` artifact
    (`_run_transcription`), NER needs text on `in` read through the SAME `_texts` the real
    `_run_ner` uses, and a TEXT_GENERATION agent needs `in` or `context` (`_run_text_generation`).
    """
    _BOUND[payload.node_id] = dict(payload.bound_inputs)
    slug = (payload.config.get("agentRef") or {}).get("slug") or ""
    bound = payload.bound_inputs

    if slug == "realtime-transcription":
        if not bound.get("audio"):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: no audio artifact reference arrived on the `audio` port",
            )
        return NodeActivityResult(status="SUCCEEDED", output={"transcript": _TRANSCRIPT})

    if slug == "medical-ner":
        text = " ".join(_texts(bound.get("in")))
        if not text:
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: no text arrived on the `in` port — nothing to extract from",
            )
        return NodeActivityResult(
            status="SUCCEEDED",
            output={"data": {"entities": [{"text": "cough", "label": "SYMPTOM"}]}, "out": text},
        )

    if slug == "casenote-finalization":
        if not (bound.get("in") or bound.get("context")):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: nothing bound on `in`/`context` to generate from",
            )
        return NodeActivityResult(
            status="SUCCEEDED",
            output={
                "text": json.dumps({"case_note": _CASE_NOTE, "redactions": []}),
                "data": {"case_note": _CASE_NOTE, "redactions": []},
            },
        )

    # The pre-summary and every running-note summarizer are TEXT_GENERATION agents.
    if not (bound.get("in") or bound.get("context")):
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: nothing bound on `in`/`context` to generate from",
        )
    return NodeActivityResult(status="SUCCEEDED", output={"text": f"note by {slug}"})


_ACTIVITIES = [
    *[
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name != "interpreter.core_agent"
    ],
    *LOOP_ACTIVITIES,
    stub_core_agent,
]
_WORKFLOWS = [WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow]


async def _run_unbound(key: str, payload: dict[str, Any]):
    """One unbound (`hope.workflows.run`) run, its review gate approved as ALaaS releases it."""
    tenant_id, _ = _EXECUTED[key]
    config = _config(key)
    _BOUND.clear()
    ref = await store_blob(json.dumps(config), store=_MEMORY_STORE, bucket=_BUCKET)
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"work-note-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id=config["definitionId"],
                    config_ref=ref,
                    tenant_id=tenant_id,
                    run_id=run_id,
                    payload=payload,
                    subject=None,
                ),
                id=f"wf-work-note-{run_id}",
                task_queue=tq,
            )

            def _review_started(event: Any) -> bool:
                return (
                    event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                    and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                    == review_gate_workflow_id(run_id, "n_review")
                )

            await await_history_event(handle, _review_started, description="review child started")
            await env.client.get_workflow_handle(
                review_gate_workflow_id(run_id, "n_review")
            ).signal(
                ReviewGateWorkflow.review,
                ReviewDecisionSignal(decision="approved", reviewer_id="alaas-queue"),
            )
            result = await handle.result()
            return result, {n.node_id: n for s in result.stages for n in s.nodes}, dict(_BOUND)


_WORK_NOTE_PAYLOAD = {"context": _CONTEXT, "work_note": {"text": _TRANSCRIPT}}

_GAP = (
    "TASK-1006 A-2: no `core` socket lifts the trigger's TEXT kind `work_note` onto a `text` "
    "input — closing it needs a registry change (see the lane report)"
)


# ---------------------------------------------------------------------------------------------


class TestTheAudioPathIsWhatTheSeedDeclares:
    """The live transcript producer is `n_asr.transcript -> n_ner.in` on every consultation graph,
    and NER's pass-through `out` is what every summarizer reads on `in`."""

    @pytest.mark.parametrize("key", _CONSULTATION_KEYS)
    def test_ner_reads_the_asr_transcript(self, key: str) -> None:
        ner = _compiled_node(_config(key), "n_ner")
        assert {(b["fromNodeId"], b["fromPort"], b["toPort"]) for b in ner["inputs"]} >= {
            ("n_asr", "transcript", "in")
        }

    @pytest.mark.parametrize("key", _CONSULTATION_KEYS)
    def test_every_summarizer_reads_ner_out_on_in(self, key: str) -> None:
        config = _config(key)
        summaries = [
            node
            for stage in config["stages"]
            for node in stage["nodes"]
            if node["nodeId"].startswith("n_summary")
        ]
        assert summaries
        for node in summaries:
            assert ("n_ner", "out", "in") in {
                (b["fromNodeId"], b["fromPort"], b["toPort"]) for b in node["inputs"]
            }


class TestAnUnboundWorkNoteRun:
    @pytest.mark.parametrize("key", sorted(_EXECUTED))
    async def test_it_still_publishes_a_case_note(self, key: str) -> None:
        result, nodes, bound = await _run_unbound(key, _WORK_NOTE_PAYLOAD)
        assert nodes["n_trigger"].status == "SUCCEEDED"
        assert nodes["n_asr"].status == "DEGRADED"
        # The transcript DOES reach each summarizer — inside the trigger envelope on `context`.
        for node_id in _EXECUTED[key][1]:
            assert bound[node_id]["context"]["work_note"] == {"text": _TRANSCRIPT}, node_id
        assert nodes["n_finalize"].status == "SUCCEEDED"
        assert nodes["n_output"].status == "SUCCEEDED"
        assert result.status != "FAILED"

    @pytest.mark.parametrize("key", sorted(_EXECUTED))
    @pytest.mark.xfail(strict=True, reason=_GAP)
    async def test_ner_receives_the_transcript_on_in(self, key: str) -> None:
        _, nodes, bound = await _run_unbound(key, _WORK_NOTE_PAYLOAD)
        assert _texts(bound.get("n_ner", {}).get("in")) == [_TRANSCRIPT]
        assert nodes["n_ner"].status == "SUCCEEDED"

    @pytest.mark.parametrize("key", sorted(_EXECUTED))
    @pytest.mark.xfail(strict=True, reason=_GAP)
    async def test_every_summarizer_receives_the_transcript_on_in(self, key: str) -> None:
        _, _, bound = await _run_unbound(key, _WORK_NOTE_PAYLOAD)
        for node_id in _EXECUTED[key][1]:
            assert _texts(bound[node_id].get("in")) == [_TRANSCRIPT], node_id
