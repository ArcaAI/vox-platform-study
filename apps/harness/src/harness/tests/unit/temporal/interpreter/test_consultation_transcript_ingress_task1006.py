"""TASK-1006 (A-2) — an UNBOUND consultation run carrying a finished transcript and no audio.

ALaaS's queue lane summarises a finished recording by running the department's ArcaAI
consultation workflow on the unbound plane (``hope.workflows.run``). It sends the transcript on
the trigger's declared TEXT kind ``transcript`` (``{ text }``) — its own kind, NOT ``work_note``,
which is the clinician's own writing. For the note path to match a recording's, that text has to
reach the socket ``n_asr.transcript`` feeds on the live path, ``n_ner.in``, and through NER's
pass-through ``out`` every ``n_summary_*.in``.

The trigger's one data socket is ``out: context<schemaRef>``, which widens to ``object`` and never
to ``text``; ``n_transcript`` (a ``core.data`` node, mapping ``in.transcript.text -> text``) lifts
the kind onto ``core.data``'s ``text`` socket, bound into ``n_ner.in`` beside ``n_asr``. It is a
DURABLE node, so the live lane drops the binding and a recorded consultation is unchanged — the
consultation-bound case below proves the durable half of that.

Hermetic: an ephemeral time-skipping Temporal server, the real interpreter (and the REAL
``core.data`` / ``core.condition`` / ``core.output`` activities), with only
``interpreter.core_agent`` and ``interpreter.load_live_outputs`` stubbed under their production
names. The compiled configs are the SEEDED ones, read from the generated blob modules.
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
    ResolvedAgent,
    ReviewDecisionSignal,
    RunSubject,
)
from harness.temporal.interpreter.nodes import core
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

_TENANT_OF = {"ARCAAI": _ARCAAI_TENANT, "GLOBAL": _GLOBAL_TENANT}

#: `(graph, visit_type, the summarizer that visit type routes to)` — both ArcaAI branches and the
#: library's single summarizer.
_EXECUTED = [
    ("ARCAAI:arcaai-gen-consultation", "new-visit", "n_summary_new"),
    ("ARCAAI:arcaai-gen-consultation", "revisit", "n_summary_revisit"),
    ("GLOBAL:general-medicine-consultation", "new-visit", "n_summary"),
]


def _config(key: str) -> dict[str, Any]:
    return _seeded_blobs()[key]["compiledConfig"]


def _compiled_node(config: dict[str, Any], node_id: str) -> dict[str, Any]:
    for stage in config["stages"]:
        for node in stage["nodes"]:
            if node["nodeId"] == node_id:
                return node
    raise AssertionError(f"the seeded graph has no node {node_id!r}")


def _edges_into(node: dict[str, Any]) -> set[tuple[str, str, str]]:
    return {(b["fromNodeId"], b["fromPort"], b["toPort"]) for b in node["inputs"]}


# ---------------------------------------------------------------------------------------------
# The stubbed activities — `core_agent` records what each node was BOUND
# ---------------------------------------------------------------------------------------------

_BOUND: dict[str, dict[str, Any]] = {}
_LIVE_OUTPUTS: dict[str, dict[str, Any]] = {}

#: The seeded `medical-ner` agent as the gateway resolves it — NER runs through the REAL
#: `_run_ner` (only the NLP service is faked), so what it hands downstream is the production shape.
_NER_AGENT = ResolvedAgent.model_validate(
    {
        "agentId": "agent-ner",
        "agentVersionId": "agent-ner-v1",
        "slug": "medical-ner",
        "versionNumber": 1,
        "task": "NAMED_ENTITY_RECOGNITION",
        "tenantId": _ARCAAI_TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "NAMED_ENTITY_RECOGNITION",
            "model": {"id": "m-ner", "slug": "medical-ner", "provider": "built-in"},
            "instruction": {},
            "parameters": {},
        },
        "models": [
            {
                "role": "primary",
                "slug": "medical-ner",
                "sourceUri": "blaze999/Medical-NER",
                "localPath": "/mnt/models-bucket/medical-ner",
                "provider": "built-in",
                "tenantId": "00000000-0000-0000-0000-000000000000",
            }
        ],
    }
)


class _FakeNlp:
    async def classify_tokens_raw(self, text: str, **_kwargs: Any) -> dict[str, Any]:
        start = text.find("cough")
        return {
            "entities": [
                {
                    "text": "cough",
                    "entity_type": "SYMPTOM",
                    "confidence": 0.9,
                    "position": {"start": start, "end": start + len("cough")},
                }
            ]
        }


@pytest.fixture(autouse=True)
def _real_ner_against_a_fake_nlp(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "_nlp_client", lambda _settings: _FakeNlp())
    monkeypatch.setattr(core, "record_and_flush", _noop)


@activity.defn(name="interpreter.core_agent")
async def stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """Each seeded agent as it would behave with the NLP/LLM planes reachable.

    NER is the REAL `_run_ner` (the NLP service faked): what it passes through is exactly what a
    summarizer is bound. The other degrade conditions are the real activities' own: ASR needs an
    `audio` artifact (`_run_transcription`), a TEXT_GENERATION agent needs `in` or `context`
    (`_run_text_generation`).
    """
    # TASK-1036 §9.2 — the seeded graphs now carry compiled `bindings`, which hand an agent its
    # primary text by NodeIO name (`message` / `text`); the real activities read it through
    # `core._bound`, which aliases it onto the legacy `in`. The stub reads it the same way.
    bound = core._bound(payload)
    _BOUND[payload.node_id] = dict(bound)
    slug = (payload.config.get("agentRef") or {}).get("slug") or ""

    if slug == "realtime-transcription":
        if not bound.get("audio"):
            return NodeActivityResult(
                status="DEGRADED",
                reason="core.agent: no audio artifact reference arrived on the `audio` port",
            )
        return NodeActivityResult(status="SUCCEEDED", output={"transcript": _TRANSCRIPT})

    if slug == "medical-ner":
        return await core._run_ner(payload, _NER_AGENT, core.now())

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


async def _run(key: str, payload: dict[str, Any], subject: RunSubject | None = None):
    """One run of a seeded graph, its review gate approved (as ALaaS releases it under OD-14)."""
    config = _config(key)
    _BOUND.clear()
    ref = await store_blob(json.dumps(config), store=_MEMORY_STORE, bucket=_BUCKET)
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"transcript-ingress-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id=config["definitionId"],
                    config_ref=ref,
                    tenant_id=_TENANT_OF[key.split(":", 1)[0]],
                    run_id=run_id,
                    payload=payload,
                    subject=subject,
                ),
                id=f"wf-transcript-ingress-{run_id}",
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


def _transcript_payload(visit_type: str) -> dict[str, Any]:
    return {"context": {**_CONTEXT, "visit_type": visit_type}, "transcript": {"text": _TRANSCRIPT}}


# ---------------------------------------------------------------------------------------------


class TestTheSeededWiring:
    @pytest.mark.parametrize("key", _CONSULTATION_KEYS)
    def test_ner_reads_the_asr_transcript_and_the_caller_transcript_and_nothing_else(
        self, key: str
    ) -> None:
        ner = _compiled_node(_config(key), "n_ner")
        assert _edges_into(ner) == {("n_asr", "transcript", "in"), ("n_transcript", "text", "in")}

    @pytest.mark.parametrize("key", _CONSULTATION_KEYS)
    def test_n_transcript_is_a_durable_reshape_of_the_trigger_transcript_kind(
        self, key: str
    ) -> None:
        node = _compiled_node(_config(key), "n_transcript")
        assert node["type"] == "core.data"
        assert _edges_into(node) == {("n_trigger", "out", "in")}
        assert node["config"]["mappings"] == [{"from": "in.transcript.text", "to": "text"}]
        assert "execution" not in node["config"]  # durable by type — never on the live lane

    @pytest.mark.parametrize("key", _CONSULTATION_KEYS)
    def test_the_trigger_declares_the_transcript_kind(self, key: str) -> None:
        trigger = _compiled_node(_config(key), "n_trigger")
        resolved = trigger["config"]["contextSchema"]["resolved"]
        # TASK-1038 F1 — a TEXT kind (cardinality ONE) also accepts a plain string.
        assert resolved["properties"]["transcript"] == {
            "anyOf": [{"type": "string"}, {"type": "object"}]
        }
        assert "transcript" not in resolved.get("required", [])

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
            assert ("n_ner", "out", "in") in _edges_into(node)


class TestAnUnboundTranscriptRun:
    @pytest.mark.parametrize(("key", "visit_type", "summary"), _EXECUTED)
    async def test_ner_and_the_summarizer_receive_the_transcript_on_in(
        self, key: str, visit_type: str, summary: str
    ) -> None:
        result, nodes, bound = await _run(key, _transcript_payload(visit_type))

        assert nodes["n_trigger"].status == "SUCCEEDED"
        assert nodes["n_asr"].status == "DEGRADED"  # no audio — the other source
        assert nodes["n_transcript"].status == "SUCCEEDED"
        assert _texts(bound["n_ner"].get("in")) == [_TRANSCRIPT]
        assert nodes["n_ner"].status == "SUCCEEDED"
        assert _texts(bound[summary].get("in")) == [_TRANSCRIPT]
        assert nodes[summary].status == "SUCCEEDED"
        assert nodes["n_finalize"].status == "SUCCEEDED"
        # `core.output` is the REAL activity with `onSchemaViolation: 'fail'`, so SUCCEEDED IS
        # "a payload satisfying `required: ['case_note']` was published".
        assert nodes["n_output"].status == "SUCCEEDED"
        assert result.status != "FAILED"

    async def test_a_work_note_is_not_read_as_a_transcript(self) -> None:
        # The clinician's own notes stay what they are: they reach the summarizer inside the
        # trigger context, never NER's transcript socket.
        payload = {"context": _CONTEXT, "work_note": {"text": "Own note: likely viral."}}
        _, nodes, bound = await _run("ARCAAI:arcaai-gen-consultation", payload)
        assert nodes["n_transcript"].status == "SUCCEEDED"
        assert "in" not in bound["n_ner"]
        assert nodes["n_ner"].status == "DEGRADED"


class TestTheConsultationBoundRunIsUnchanged:
    async def test_the_live_lane_still_owns_asr_ner_and_the_summaries(self) -> None:
        _LIVE_OUTPUTS.clear()
        _LIVE_OUTPUTS["n_summary_new"] = {"text": "S: cough x3d\nA: URTI\nP: fluids"}
        try:
            result, nodes, bound = await _run(
                "ARCAAI:arcaai-gen-consultation",
                {"context": _CONTEXT},
                subject=RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"),
            )
        finally:
            _LIVE_OUTPUTS.clear()

        for node_id in ("n_asr", "n_ner", "n_summary_new", "n_summary_revisit"):
            assert nodes[node_id].status == "SKIPPED", node_id
            assert nodes[node_id].reason == "realtime_lane", node_id
        # The durable reshape runs, finds no transcript, and binds nothing anywhere.
        assert nodes["n_transcript"].status == "SUCCEEDED"
        assert "n_ner" not in bound
        assert nodes["n_finalize"].status == "SUCCEEDED"
        assert nodes["n_output"].status == "SUCCEEDED"
        assert result.status != "FAILED"
