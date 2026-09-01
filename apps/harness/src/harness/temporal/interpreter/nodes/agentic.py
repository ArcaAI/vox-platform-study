"""The GENERIC (``agentic``) node catalogue — the Python half of TASK-847.

Eight node types whose behaviour is CONFIGURATION rather than key, mirroring
``packages/workflow-contract/src/node-registry.ts``. The cross-language parity guard
(``node-registry.snapshot.json``) requires every ``implemented: true`` node type on the
TypeScript side to have a real, registrable ``@activity.defn`` callable here, so all eight are
registered — but they are not all the same KIND of thing, and the difference is deliberate and
observable rather than papered over:

===============================  ==========================================================
``agentic.input``                REAL. Binds a key of the run payload and publishes it.
``agentic.data``                 REAL. Deterministic reshape — the tier-2 escape hatch.
``agentic.output``               REAL. Publishes the run's result payload.
``agentic.agent``                DELEGATION to ``interpreter_text_generate`` — the same
                                 generation engine ``generate.text`` uses. One engine, two
                                 palette entries, exactly as ``agent_catalogue.py`` does it.
``agentic.guardrail``            DELEGATION to ``interpreter_guardrail_check``.
``agentic.stt``                  REAL, and this is the PROMOTION the ticket asks for: it
                                 dispatches ``dispatch_batch_transcription``, the existing
                                 TASK-724 Task 5 batch path, instead of returning ``DEGRADED``
                                 like every ``stt.*`` placeholder does.
``agentic.loop``                 OBSERVABLE non-execution. TASK-848 owns the loop body.
``agentic.tts``                  OBSERVABLE non-execution. TASK-849 owns audio transport.
===============================  ==========================================================

## Why the last two are ``implemented: true`` and still do not run

``compile()`` REFUSES any graph containing an ``implemented: false`` node type
(``nodeInfo()`` returns undefined), and this ticket's own verification criterion is *"a graph
using every new node type compiles to a valid IR"*. So the choice is not between "runs" and
"refused at compile" — it is between an honest ``DEGRADED`` naming the ticket that owns the work,
and a silent ``SUCCEEDED`` for work that never happened. This module takes the first, which is
the standing rule ``stt_placeholder.py`` states for its own siblings: *"fail loudly… never pass
through while claiming the hop ran."* A run that reaches one is visibly degraded on its
trajectory.

## What is NOT here, and must not be added

**No resolution of any reference.** ``providerConfigRef``, ``tools[].mcpServerId`` and
``pipelineRef`` are REFERENCES on the compiled graph (TASK-837 §3.4 rule 16); resolving them
means reading the tenant's row through the tenant → SYSTEM cascade, which is the gateway's job
and reaches this worker through the engines these activities delegate to. An adapter here that
built its own client from a graph value would be the exact cascade bypass the whole contract
exists to prevent — and because BYOK funding is DERIVED from ``row.tenantId``, it would mis-bill
silently rather than fail.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    MISSING,
    STATUS_OK,
    now,
    record_and_flush,
    resolve_dotted_path,
)
from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check
from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate

# Named rather than inlined so the message a trajectory records is the same string in every
# branch, and so a reader grepping for the owning ticket finds one place.
_LOOP_NOT_YET_EXECUTABLE = (
    "agentic.loop declares its BOUNDS (maxIterations / maxDurationSeconds / maxTotalTokens) as a "
    "contract; the loop BODY — continue_as_new per iteration, sub-agents as child workflows, and "
    "the bounds enforced against a workflow TIMER rather than wall-clock — is TASK-848. This "
    "activity degrades observably rather than claiming an iteration that did not run."
)

_TTS_NOT_YET_EXECUTABLE = (
    "agentic.tts declares its provider binding and voice reference as a contract; binary audio "
    "TRANSPORT — synthesis dispatch and the artifact write — is TASK-849 (OD-4). This activity "
    "degrades observably rather than claiming an audio artifact that was never produced."
)


def _config(payload: NodeActivityInput) -> dict[str, Any]:
    config = getattr(payload, "config", None)
    return config if isinstance(config, dict) else {}


def _bound_inputs(payload: NodeActivityInput) -> dict[str, Any]:
    bound = getattr(payload, "bound_inputs", None)
    return bound if isinstance(bound, dict) else {}


@activity.defn(name="interpreter.agentic_input")
async def interpreter_agentic_input(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's typed entry point.

    ``sourceKey`` names which key of the run payload this node binds; absent means the whole
    payload. The declared ``ioSchema`` is TIER 3 — validated at the node boundary — and is
    deliberately NOT enforced here yet: the schema is tenant-authored and this activity has no
    evaluator, so claiming to validate it would be a false safety claim. It is carried through
    on the compiled config for the boundary check TASK-848 wires.
    """
    started = now()
    config = _config(payload)
    run_payload = getattr(payload, "run_payload", None)
    run_payload = run_payload if isinstance(run_payload, dict) else {}

    source_key = config.get("sourceKey")
    bound = run_payload.get(source_key) if isinstance(source_key, str) else run_payload

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={"payload": bound})


@activity.defn(name="interpreter.agentic_data")
async def interpreter_agentic_data(payload: NodeActivityInput) -> NodeActivityResult:
    """Deterministic reshape — the tier-2 escape hatch.

    The mapping language is intentionally tiny: dotted reads out of this node's bound inputs,
    renamed writes onto its output, plus literal constants. Anything richer is a transformation
    language, which is a second place for tenant logic to live and a second thing to audit.

    An unresolved mapping marked ``required`` DEGRADES the node observably; an optional one is
    simply absent from the output. Neither ever invents a value — a fabricated field is worse
    than a missing one, because a downstream schema check would pass on it.
    """
    started = now()
    config = _config(payload)
    bound = _bound_inputs(payload)

    output: dict[str, Any] = {}
    constants = config.get("constants")
    if isinstance(constants, dict):
        output.update(constants)

    missing_required: list[str] = []
    mappings = config.get("mappings")
    for mapping in mappings if isinstance(mappings, list) else []:
        if not isinstance(mapping, dict):
            continue
        source = mapping.get("from")
        target = mapping.get("to")
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        value = resolve_dotted_path(bound, source)
        if value is MISSING:
            if mapping.get("required") is True:
                missing_required.append(source)
            continue
        output[target] = value

    if missing_required:
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"agentic.data: required mapping(s) did not resolve: {', '.join(sorted(missing_required))}",
            output={"data": output},
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={"data": output})


@activity.defn(name="interpreter.agentic_output")
async def interpreter_agentic_output(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's typed exit point.

    ``onSchemaViolation`` is declared on the config and honoured by TIER 3 once the boundary
    evaluator lands; until then this node publishes what it was handed and never silently
    reshapes it. It is ``external_write`` in the registry because publishing the run's result is
    a write a sandboxed run must suppress.
    """
    started = now()
    bound = _bound_inputs(payload)
    # One bound input is the normal shape (`in` is a single required port); more than one means
    # the author fanned several edges into it, so the whole map is the result.
    result: Any = next(iter(bound.values())) if len(bound) == 1 else bound
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={"payload": result})


@activity.defn(name="interpreter.agentic_agent")
async def interpreter_agentic_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """The GENERIC agent — a thin delegation to the generation engine ``generate.text`` uses.

    DD-9's instruction taken literally: *"One generation engine, three palette entries… Do not
    fork the engine."* The wrapper holds no logic of its own, so there is no second behaviour to
    keep in step; ``record_and_flush`` reads the node type off ``payload``, so a run trace still
    reads ``agentic.agent`` rather than the engine's name.

    Its config differs from ``generate.text``'s (a ``providerConfigRef`` instead of a ``taskKey``,
    plus tools and guard references), and RESOLVING that binding is the engine's job, through the
    tenant → SYSTEM cascade — never this wrapper's, which would be the cascade bypass §3.4 rule 16
    forbids.
    """
    return await interpreter_text_generate(payload)


@activity.defn(name="interpreter.agentic_guardrail")
async def interpreter_agentic_guardrail(payload: NodeActivityInput) -> NodeActivityResult:
    """The generic guardrail — delegation to the content-safety engine, same as
    ``guard.moderation``. ``guardrailType`` is a POLICY key ``apps/guardrail`` resolves per
    tenant; the model, its threshold and its label taxonomy all ride on the ``AiModel`` row that
    cascade selected (TASK-735 phases 3 & 6), never on this node."""
    return await interpreter_guardrail_check(payload)


@activity.defn(name="interpreter.agentic_stt")
async def interpreter_agentic_stt(payload: NodeActivityInput) -> NodeActivityResult:
    """BATCH transcription of a STORED audio artifact — the ticket's *"promote STT from
    placeholder to real"*, done the only way that is compatible with workflow determinism.

    The eight ``stt.*`` palette nodes stay placeholders, and that is correct rather than
    unfinished: TASK-724 §1's central design decision is that a published ``stt``
    ``WorkflowDefinition`` COMPILES INTO an ``AsrPipeline`` row and is never walked node-by-node
    by this interpreter. Per-frame audio inside a Temporal workflow would violate rule 06's
    determinism constraint and be a latency disaster besides.

    This node is the other half of that design: ONE activity, dispatching the existing
    ``dispatch_batch_transcription`` path (TASK-724 Task 5 — which itself calls apps/api's
    ``POST /internal/harness/stt/batch-jobs``, the same ``TranscriptionJobService`` write path the
    batch controller uses). No second job-processing path, no per-frame audio, and the pipeline is
    named by REFERENCE so engine, model and thresholds all resolve off the ``AsrPipeline`` row.

    ``pipelineSlug`` is not resolvable from here — by-slug resolution is a tenant → SYSTEM cascade
    read the gateway owns — so a node bound by slug degrades observably rather than guessing.
    """
    # Imported inside the function, not at module scope: `activities.py` imports this module for
    # `NODE_ACTIVITIES`, so a module-level import of it would be circular.
    from harness.temporal.activities import (  # noqa: PLC0415
        dispatch_batch_transcription,
    )
    from harness.temporal.models import DispatchBatchTranscriptionInput  # noqa: PLC0415

    started = now()
    config = _config(payload)
    pipeline_ref = config.get("pipelineRef")
    pipeline_ref = pipeline_ref if isinstance(pipeline_ref, dict) else {}
    pipeline_id = pipeline_ref.get("pipelineId")
    tenant_id = getattr(payload, "tenant_id", None)

    if not isinstance(pipeline_id, str) or not pipeline_id:
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(
            status="DEGRADED",
            reason=(
                "agentic.stt: `pipelineRef.pipelineId` did not resolve. A node bound by "
                "`pipelineSlug` needs the gateway's tenant -> SYSTEM cascade to resolve the slug "
                "to a row; this activity resolves nothing itself, by design."
            ),
        )
    if not isinstance(tenant_id, str) or not tenant_id:
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(
            status="DEGRADED",
            reason="agentic.stt: no tenant id on the activity payload — transcription is tenant-scoped work and must be attributable.",
        )

    bound = _bound_inputs(payload)
    audio_uri = next(
        (value for value in bound.values() if isinstance(value, str) and value),
        None,
    )
    if audio_uri is None:
        await record_and_flush(payload, status=STATUS_OK, started=started)
        return NodeActivityResult(
            status="DEGRADED",
            reason="agentic.stt: no audio artifact reference arrived on the `in` port.",
        )

    result = await dispatch_batch_transcription(
        DispatchBatchTranscriptionInput(
            tenant_id=tenant_id,
            pipeline_id=pipeline_id,
            audio_uri=audio_uri,
            language=config.get("language") if isinstance(config.get("language"), str) else None,
            poll_timeout_seconds=config.get("pollTimeoutSeconds") or 900,
        )
    )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    if result.timed_out or result.status != "COMPLETED":
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"agentic.stt: batch job {result.job_id} is {result.status}"
            + (" (poll timed out; the job is still running)" if result.timed_out else ""),
            output={"transcript": None, "jobId": result.job_id},
        )
    return NodeActivityResult(status="SUCCEEDED", output={"transcript": None, "jobId": result.job_id})


@activity.defn(name="interpreter.agentic_loop")
async def interpreter_agentic_loop(payload: NodeActivityInput) -> NodeActivityResult:
    """OBSERVABLE non-execution — TASK-848 owns the loop body. See the module docstring for why
    this is ``implemented: true`` and still does not run."""
    started = now()
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="DEGRADED", reason=_LOOP_NOT_YET_EXECUTABLE)


@activity.defn(name="interpreter.agentic_tts")
async def interpreter_agentic_tts(payload: NodeActivityInput) -> NodeActivityResult:
    """OBSERVABLE non-execution — TASK-849 owns binary audio transport (OD-4). See the module
    docstring."""
    started = now()
    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="DEGRADED", reason=_TTS_NOT_YET_EXECUTABLE)


# Spread into `activities.NODE_ACTIVITIES` rather than re-typed there, for the reason that list
# records at length: `registry.py`'s NODE_REGISTRY and NODE_ACTIVITIES are two SEPARATE
# hand-maintained lists — the first decides what the interpreter DISPATCHES, the second what the
# worker SERVES — and a node in the first but not the second passes every static check, including
# the cross-language parity guard, then fails at runtime with an unregistered-activity error.
AGENTIC_ACTIVITIES = [
    interpreter_agentic_input,
    interpreter_agentic_output,
    interpreter_agentic_agent,
    interpreter_agentic_guardrail,
    interpreter_agentic_data,
    interpreter_agentic_loop,
    interpreter_agentic_stt,
    interpreter_agentic_tts,
]
