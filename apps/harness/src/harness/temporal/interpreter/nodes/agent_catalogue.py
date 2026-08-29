"""The TARGET NODE CATALOGUE (TASK-809 DD-6/DD-9) — TASK-806 lane A.

Ten ``agent.*`` node types. NINE of them are a THIN DELEGATION to an engine that already
exists in this interpreter; ``agent.important_findings`` (Lane N) is the one exception, and it is
an exception because the capability it names did not exist in ANY form — TASK-815 §14a: *"important
information highlighted — DOES NOT EXIST ... there is no red-flag / critical-value / allergy-alert
/ severity layer anywhere"*. There was nothing to delegate to, so it is a real implementation; see
its own docstring for why it still hosts no model and ships no importance taxonomy. That is DD-9's instruction taken literally — *"One generation engine,
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

from typing import Any

from temporalio import activity

from harness.guards.phi.redactor import PhiEgressBlocked
from harness.services.text_client import TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import bound_text, bound_value
from harness.temporal.interpreter.nodes._llm_policy import (
    InstructionUnavailable,
    generate_json,
    resolve_instruction,
    resolve_text_selection,
)
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    read_model_slug,
    record_and_flush,
)
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
from harness.temporal.interpreter.nodes.consultation_realtime import (
    interpreter_consultation_propose_corrections,
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


@activity.defn(name="interpreter.agent_grammar")
async def interpreter_agent_grammar(payload: NodeActivityInput) -> NodeActivityResult:
    """Lane R (R1) — the GRAMMAR/SPELLING pass, ``lane: 'realtime'``.

    Delegates to the SAME correction engine ``consultation.proposeCorrections`` runs, for the
    reason every wrapper in this module exists: two names for one capability are safe only when
    there is one implementation behind them.

    Like ``interpreter_agent_transcription``, this durable wrapper exists so the node is
    DISPATCHABLE at all — ``compile()`` refuses a graph containing an unimplemented node type and
    ``NodeSpec`` requires a real registered activity — but it is not the runtime that normally
    executes it. ``_dispatch_node`` SKIPS a ``realtime`` node with ``reason="realtime_lane"``;
    TASK-811's live executor owns this one, because corrections over a PARTIAL transcript are only
    useful while the clinician is still watching it grow.

    The engine PROPOSES and applies nothing: it returns the source text byte-identical, marks
    every proposal ``applied: False``, and drops any proposal whose ``[start, end)`` does not
    equal its own ``original``. That is a patient-safety property, not a preference, and it is
    unchanged by which lane runs it.
    """
    return await interpreter_consultation_propose_corrections(payload)


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


#: Upper bound on findings kept from one reply when the node authors none. A BOUNDED-OUTPUT
#: guard, not a ranking policy — it caps how many findings cross the wire, and says nothing about
#: WHICH ones matter. That question belongs to the tenant's instruction and to nothing in this
#: file.
_DEFAULT_MAX_FINDINGS = 25


def _findings_from(raw: Any, limit: int) -> list[dict[str, Any]]:
    """Keep the findings a client can actually anchor a highlight to.

    A finding needs a surface span (``text``) and a label (``type``) — the label is whatever the
    TENANT's instruction told the model to assign, which is why nothing here validates it against
    a list. A row missing either is DROPPED rather than defaulted: inventing a label would be this
    file answering the question the owner assigned to the tenant admin, and a finding with no
    surface form cannot be highlighted in the note at all.
    """
    if not isinstance(raw, list):
        return []
    findings: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        label = item.get("type")
        if not isinstance(text, str) or not text.strip():
            continue
        if not isinstance(label, str) or not label.strip():
            continue
        finding: dict[str, Any] = {"text": text, "type": label}
        confidence = item.get("confidence")
        if isinstance(confidence, int | float) and 0 <= float(confidence) <= 1:
            finding["confidence"] = float(confidence)
        rationale = item.get("rationale")
        if isinstance(rationale, str) and rationale.strip():
            finding["rationale"] = rationale
        findings.append(finding)
        if len(findings) >= limit:
            break
    return findings


@activity.defn(name="interpreter.agent_important_findings")
async def interpreter_agent_important_findings(payload: NodeActivityInput) -> NodeActivityResult:
    """Lane N — IMPORTANT FINDINGS, mined from the consultation context by tenant instruction.

    The owner's specification is a configuration statement, and this activity is written to be
    nothing more than its executable form:

    > "'Important' information or findings will be mined/generated/extracted by agent following a
    > set of instructions defined/declared/overwriten by tenant admin for using LLM to detect,
    > extract, picking-up knowledge from consultation context (transcription, consultation context
    > items, etc...)"

    So there is **no severity table, no red-flag term list and no importance threshold in this
    module**. The system prompt is the tenant's own ``PromptTemplate``, resolved APPROVED through
    the gateway, and an unbound or unapproved one DEGRADES with a named code rather than falling
    back to a default — a governed prompt that silently becomes an in-code constant is the exact
    hardcoded-configuration failure ``00-project-context.md`` forbids, and here it would mean the
    platform deciding what is clinically important on the tenant's behalf.

    ## Which runtime actually runs this

    The node is ``lane: 'realtime'`` — the owner wants findings surfaced while the clinician is
    still in the room — so ``_dispatch_node`` SKIPS it with ``reason="realtime_lane"`` and
    TASK-811's live executor owns it, exactly as it owns ``agent.grammar``. This durable
    implementation exists because ``compile()`` refuses a graph containing an unimplemented node
    type and ``NodeSpec`` requires a real registered activity; unlike the delegating wrappers
    around it, it had no engine to point at, so it does the work itself. Both runtimes call the
    same peer service with the same tenant-bound instruction, so the two cannot disagree about
    what a finding is.

    ## Its source is the TRANSCRIPT

    Bound inputs only, never the generated note: the node's ``in`` port is typed ``transcript``
    and ``document`` does not satisfy it, so an "important finding" the model invented in a note
    and then highlighted as clinically important is not a wiring mistake anyone can make.
    """
    started = now()
    config = payload.config
    task_key = config.get("taskKey") or "text.live"

    source_text = bound_text(payload.bound_inputs)
    if not source_text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_transcript"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no transcript bound from an upstream node to mine"
        )

    try:
        instruction = await resolve_instruction(
            config.get("promptTemplateId"),
            payload.tenant_id,
            missing_code="no_findings_instruction_bound",
        )
    except InstructionUnavailable as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code=exc.error_code
        )
        return NodeActivityResult(status="DEGRADED", reason=exc.reason)

    judgement, error_code = await resolve_text_selection(
        payload.tenant_id, task_key, read_model_slug(config)
    )
    if judgement is None:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code=error_code
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"no text provider/model resolved for this tenant ({error_code})",
        )

    # "consultation context items, etc..." — the optional `context` socket, passed through as the
    # tenant's instruction sees fit. Never summarized or filtered here: deciding which context
    # matters is the instruction's job.
    context_items = bound_value(payload.bound_inputs, "context")
    entities = bound_value(payload.bound_inputs, "entities")
    user_payload: dict[str, Any] = {"transcript": source_text}
    if context_items is not None:
        user_payload["context"] = context_items
    if isinstance(entities, list) and entities:
        user_payload["entities"] = entities

    try:
        parsed = await generate_json(
            tenant_id=payload.tenant_id,
            judgement=judgement,
            system_prompt=instruction,
            user_payload=user_payload,
            max_tokens=config.get("maxTokens"),
        )
    except PhiEgressBlocked as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="phi_egress_blocked"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"phi egress blocked: {exc}")
    except TextServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="text_generate_failed"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"important-findings extraction failed: {exc}"
        )

    if parsed is None:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="unparseable_findings"
        )
        # Never fabricate. An empty highlight set is a visible nothing; a guessed one is a
        # clinical claim the tenant's instruction never made.
        return NodeActivityResult(
            status="DEGRADED", reason="the model did not return a parseable findings object"
        )

    raw_max = config.get("maxFindings")
    limit = raw_max if isinstance(raw_max, int) and raw_max > 0 else _DEFAULT_MAX_FINDINGS
    findings = _findings_from(parsed.get("findings"), limit)

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        # `findings`, not `entities` — the port's declared outputKey. The PRIMITIVE is `entities`
        # so a finding rides the same highlight path an NER entity does; the distinct KEY is what
        # keeps "the tenant said this matters" and "the detector saw a drug name" apart.
        output={
            "findings": findings,
            "provider": judgement.provider,
            "model": judgement.model,
        },
    )


AGENT_CATALOGUE_ACTIVITIES = [
    interpreter_agent_transcription,
    interpreter_agent_normalization,
    interpreter_agent_ner,
    interpreter_agent_grammar,
    interpreter_agent_important_findings,
    interpreter_agent_presummarization,
    interpreter_agent_summarization,
    interpreter_agent_discharge_summary,
    interpreter_agent_retrieval,
    interpreter_agent_feedback,
    interpreter_agent_dna_redaction,
]
