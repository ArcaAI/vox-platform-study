"""The TARGET NODE CATALOGUE (TASK-809 DD-6/DD-9) — TASK-806 lane A.

Nine ``agent.*`` node types, and every one of them is a THIN DELEGATION to an engine that already
exists in this interpreter. That is DD-9's instruction taken literally — *"One generation engine,
three palette entries … Do not fork the engine"* — generalised to the whole catalogue, and it is
the same shape ``interpreter_consultation_synthesize`` already uses (``return await
interpreter_text_generate(payload)``, ``consultation_compose.py``).

Delegation is what makes two names for one capability safe. The wrappers hold no logic of their
own, so there is no second behaviour to keep in step with the first; and because
``record_and_flush`` reads the node id and node type off ``payload``, a run trace still reads
``agent.summarization`` rather than the engine's name.

## Why the catalogue exists ALONGSIDE the pipeline keys rather than replacing them

A node type is a contract with every saved tenant graph (``node-registry.ts`` §``schemaVersion``).
Both committed seed graphs and every golden fixture name ``consultation.*`` keys, so renaming them
would invalidate saved definitions. The catalogue is therefore additive; the pipeline keys are what
today's graphs use, and these are what a graph authored against the target contract uses.

## Output keys are the port contract, not a convention

Each wrapper's output dict is whatever its engine returns, and the ``outputKey`` its port declares
in ``node-ports.ts`` names a key of THAT dict. Two entries needed no adjustment because their
engine already publishes the right key; ``agent.transcription`` is the one exception and it is
deliberate — see its docstring.
"""

from __future__ import annotations

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes.consultation import interpreter_consultation_phi_hop
from harness.temporal.interpreter.nodes.consultation_capture import (
    interpreter_consultation_capture_binding,
)
from harness.temporal.interpreter.nodes.consultation_compose import (
    interpreter_consultation_retrieve_evidence,
    interpreter_consultation_synthesize,
)
from harness.temporal.interpreter.nodes.consultation_endpoint import interpreter_feedback_capture
from harness.temporal.interpreter.nodes.consultation_nlp import (
    interpreter_consultation_bind_terminology,
    interpreter_consultation_extract_entities,
)


@activity.defn(name="interpreter.agent_transcription")
async def interpreter_agent_transcription(payload: NodeActivityInput) -> NodeActivityResult:
    """The catalogue's capture entry — ``lane: 'realtime'``.

    The runtime that actually turns a live session into a transcript is TASK-811's realtime
    executor, which is why this node is declared ``realtime`` and the durable interpreter SKIPS it
    (``workflow.py``, reason ``realtime_lane``). This durable wrapper exists so the node is
    dispatchable at all: ``compile()`` refuses any graph containing an unimplemented node type, and
    ``NodeSpec`` requires a real registered activity. It delegates to the same session-binding
    engine ``consultation.captureBinding`` uses, so a graph that somehow reaches it here behaves
    exactly as that node does rather than differently.
    """
    return await interpreter_consultation_capture_binding(payload)


@activity.defn(name="interpreter.agent_normalization")
async def interpreter_agent_normalization(payload: NodeActivityInput) -> NodeActivityResult:
    """ONTOLOGY normalization — mapping surface forms onto coded concepts.

    "Normalization" is not a second, unbuilt engine: it is what the terminology hop already does
    (``apps/nlp/src/nlp/services/ontology_linker.py`` normalizes a span and looks it up in the
    ontology vocabulary; ``interpreter_consultation_bind_terminology`` validates the resulting
    SNOMED/ICD/RxNorm/LOINC/UMLS codes against a registered terminology server). Entities in,
    coded entities out, under the same ``entities`` output key.
    """
    return await interpreter_consultation_bind_terminology(payload)


@activity.defn(name="interpreter.agent_ner")
async def interpreter_agent_ner(payload: NodeActivityInput) -> NodeActivityResult:
    """Medical NER over the bound TRANSCRIPT. Delegates to the extraction engine.

    Its declared input is ``transcript`` and nothing else, which is the anti-laundering rule made
    structural: ``document`` and ``transcript`` are lattice siblings, so no generation node in the
    catalogue can be wired into this one.
    """
    return await interpreter_consultation_extract_entities(payload)


@activity.defn(name="interpreter.agent_presummarization")
async def interpreter_agent_presummarization(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-6 — pre-summarization, running ``on-start`` over ADMIN-SELECTED CONTEXT.

    Fed from ``context<schemaRef>``, never from the transcript: today's pre-summary job already
    takes ``caseNoteIds``, so it summarizes provided context rather than what was said, and typing
    the input that way is what keeps a transcript from being wired in by accident.

    It must stay NON-SIGNABLE (``isFinalSummary`` excludes ``PRE_SUMMARY``, locked by
    ``kept-generators-signability.task732.test.ts``). Nothing here can make it signable — that
    property lives on the generator — but this is the node a future persistence change would have
    to be checked against.
    """
    return await interpreter_consultation_synthesize(payload)


@activity.defn(name="interpreter.agent_summarization")
async def interpreter_agent_summarization(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-9 — the clinical-note generation entry. Same engine, ``on-end`` trigger."""
    return await interpreter_consultation_synthesize(payload)


@activity.defn(name="interpreter.agent_discharge_summary")
async def interpreter_agent_discharge_summary(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-9 — the discharge-summary entry. Same engine; the DOCUMENT SHAPE it is bound to
    (``documentTemplateId``, DD-2) is what makes it a discharge summary, not a forked model call.
    """
    return await interpreter_consultation_synthesize(payload)


@activity.defn(name="interpreter.agent_retrieval")
async def interpreter_agent_retrieval(payload: NodeActivityInput) -> NodeActivityResult:
    """Evidence retrieval. Delegates to the JIT hybrid retriever, publishing under ``context``."""
    return await interpreter_consultation_retrieve_evidence(payload)


@activity.defn(name="interpreter.agent_feedback")
async def interpreter_agent_feedback(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-8 — promotion of an ACCEPTED advisory correction. Delegates to the endpoint engine.

    It carries ``external_write`` for the same reason ``feedback.capture`` does, and that is not
    incidental: these two are the only nodes in the registry that both CONSUME ``edits`` and write,
    which is what makes "an advisory correction becomes real here or nowhere" a property of the
    port table rather than a convention.
    """
    return await interpreter_feedback_capture(payload)


@activity.defn(name="interpreter.agent_dna_redaction")
async def interpreter_agent_dna_redaction(payload: NodeActivityInput) -> NodeActivityResult:
    """TASK-815 §11 — the DNA writing-style redaction pass, as a NODE.

    It used to be a resolver flag TRIPLE: a tenant ``dnaRedactionEnabled`` cascade, the doctor's
    own DNA opt-in, and the department default ``DepartmentAgent.dnaStylePolicy`` VETO. The veto
    retired with ``DepartmentAgent`` and stays retired (owner ruling: a consultation both surviving
    gates enable IS redacted). The tenant gate becomes the PRESENCE of this node in the tenant's
    published graph; the doctor opt-in stays the clinician's own setting and is honoured unless the
    node's ``requireDoctorOptIn`` says otherwise.

    Delegates to the same redactor hop ``consultation.phiHop`` uses, so there is one redaction
    implementation rather than a DNA-specific copy of one.
    """
    return await interpreter_consultation_phi_hop(payload)


AGENT_CATALOGUE_ACTIVITIES = [
    interpreter_agent_transcription,
    interpreter_agent_normalization,
    interpreter_agent_ner,
    interpreter_agent_presummarization,
    interpreter_agent_summarization,
    interpreter_agent_discharge_summary,
    interpreter_agent_retrieval,
    interpreter_agent_feedback,
    interpreter_agent_dna_redaction,
]
