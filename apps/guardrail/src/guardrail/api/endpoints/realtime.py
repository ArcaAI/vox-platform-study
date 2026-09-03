"""The realtime consultation plane's HTTP surface.

Three routes on two clocks, and one of them is the only one that authorises
anything:

``POST /guardrail/realtime/segments``
    Streaming tier. One finalized STT segment in, one three-axis verdict out,
    stored under a handle so consumers read it instead of re-asking. Never
    returns a complete consumption window — a delta cannot authorise a read.

``GET /guardrail/realtime/segments/{segment_id}``
    What a consumer calls INSTEAD of guardrail. Three consumers reading one
    verdict is three cache reads and one classification.

``POST /guardrail/realtime/consumption``
    The gate that actually matters. The caller declares the CUMULATIVE window it
    is about to feed a model, the assembly it will compose it into, and the
    capabilities it holds; guardrail validates that artifact as one whole thing
    and answers whether the derivation may run.

``POST /guardrail/realtime/output``
    C-4. Output-side checks, which no amount of input validation covers.

**Every route fails CLOSED for derivations and OPEN for the record.** A timeout
or an unresolved selection stops the AI work and returns
``transcriptDisposition: retain_verbatim`` — because fail-closed governs
downstream USE, and a guardrail that blanks a live transcript is itself a
patient-safety event. There is no response shape on this router that can ask a
caller to remove, redact or withhold transcript text.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from guardrail.core.dependencies import (
    ModelUnavailableError,
    admitted,
    build_realtime_validator,
    require_tenant_id,
)
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.realtime.consumption import ConsumptionGate, ConsumptionRequest
from guardrail.realtime.output_checks import check_clinical_preservation, check_span_provenance
from guardrail.realtime.verdict import RETAIN_VERBATIM, content_hash

logger = get_logger(__name__)

router = APIRouter()


class SegmentRequest(BaseModel):
    session_id: str = Field(..., description="The consultation stream this segment belongs to")
    segment_id: str = Field(..., description="The finalized segment's id")
    text: str = Field(..., description="The FINALIZED segment text — never an interim hypothesis")


class ConsumptionGateRequest(BaseModel):
    """What the consumer is about to do. Declared, never inferred.

    ``text`` is the CUMULATIVE artifact the model will actually read — not the
    delta since the last checkpoint. Sending a delta here is the Prompt Overflow
    vulnerability, and the ``window`` assertion in the response is what makes
    that visible rather than silent.
    """

    session_id: str
    text: str = Field(..., description="The cumulative artifact, not the delta (C-2)")
    assembly_template_id: str = Field(..., description="e.g. summarize.partial@3")
    capability_set_id: str = Field(..., description="e.g. readonly-text")
    declared_capabilities: list[str] = Field(default_factory=list)
    source_artifact_count: int = Field(
        default=1,
        description="How many independently-validated artifacts are joined into ONE "
        "context. More than one is a composite, and a composite is unvalidated.",
    )


class OutputCheckRequest(BaseModel):
    """C-4. Deliberately carries NO verdict reference.

    An output check that could be skipped because the input passed would not be
    independent of the input verdict, and independence is the condition. There is
    no field here with which to express the skip.
    """

    task: str = Field(..., description="ner | grammar")
    source_text: str = Field(..., description="The transcript the output derives FROM")
    corrected_text: str | None = Field(default=None, description="grammar: the edited text")
    entities: list[dict[str, Any]] = Field(default_factory=list, description="ner: the entities")


def _unavailable(what: str, exc: Exception) -> HTTPException:
    """503 for derivations. The transcript is untouched, and the body says so."""
    logger.error(f"guardrail.realtime.{what}.unavailable error={type(exc).__name__}")
    return HTTPException(
        status_code=503,
        detail={
            "error": f"realtime {what} could not be validated — refusing to report 'safe'",
            "notice": "ai_derivations_paused",
            # Restated on the failure path precisely because this is where a
            # caller is most likely to improvise a policy of its own.
            "transcriptDisposition": RETAIN_VERBATIM,
        },
    )


@router.post("/guardrail/realtime/segments")
async def validate_segment(request: SegmentRequest, http_request: Request) -> dict[str, Any]:
    """Streaming tier — validate one finalized segment."""
    tenant_id = require_tenant_id(http_request)
    try:
        async with admitted(http_request):
            validator = await build_realtime_validator(http_request.app.state, tenant_id)
            verdict = await validator.validate_segment(
                session_id=request.session_id,
                segment_id=request.segment_id,
                text=request.text,
            )
    except HTTPException:
        raise
    except (ModelUnavailableError, GuardrailUndeterminedError) as exc:
        raise _unavailable("segment", exc) from exc
    except Exception as exc:  # noqa: BLE001 — fail-closed backstop, PHI-safe
        raise _unavailable("segment", exc) from exc
    payload: dict[str, Any] = verdict.to_dict()
    return payload


@router.get("/guardrail/realtime/segments/{segment_id}")
async def read_segment_verdict(segment_id: str, http_request: Request) -> dict[str, Any]:
    """The fan-out read. Tenant-scoped by key, so a cross-tenant hit cannot occur."""
    tenant_id = require_tenant_id(http_request)
    try:
        validator = await build_realtime_validator(http_request.app.state, tenant_id)
        stored = await validator.read_segment_verdict(segment_id)
    except HTTPException:
        raise
    except (ModelUnavailableError, GuardrailUndeterminedError) as exc:
        raise _unavailable("segment_read", exc) from exc
    if stored is None:
        raise HTTPException(status_code=404, detail="no verdict for that segment")
    payload: dict[str, Any] = stored
    return payload


@router.post("/guardrail/realtime/consumption")
async def gate_consumption(
    request: ConsumptionGateRequest, http_request: Request
) -> dict[str, Any]:
    """Consumption tier — validate the CUMULATIVE artifact and gate the read."""
    tenant_id = require_tenant_id(http_request)
    try:
        async with admitted(http_request):
            validator = await build_realtime_validator(http_request.app.state, tenant_id)
            verdict = await validator.validate_cumulative(
                session_id=request.session_id,
                text=request.text,
                assembly_template_id=request.assembly_template_id,
                capability_set_id=request.capability_set_id,
            )
            gate = ConsumptionGate(capabilities=validator._policy.capabilities)  # noqa: SLF001
            decision = gate.evaluate(
                ConsumptionRequest(
                    tenant_id=tenant_id,
                    cumulative_content_hash=content_hash(request.text),
                    consumer_window_chars=verdict.window.consumer_window_chars,
                    assembly_template_id=request.assembly_template_id,
                    capability_set_id=request.capability_set_id,
                    declared_capabilities=tuple(request.declared_capabilities),
                    source_artifact_count=request.source_artifact_count,
                ),
                held_verdict=verdict,
                segment_verdicts=[],
            )
    except HTTPException:
        raise
    except (ModelUnavailableError, GuardrailUndeterminedError) as exc:
        raise _unavailable("consumption", exc) from exc
    except Exception as exc:  # noqa: BLE001 — fail-closed backstop, PHI-safe
        raise _unavailable("consumption", exc) from exc
    return {"decision": decision.to_dict(), "verdict": verdict.to_dict()}


@router.post("/guardrail/realtime/output")
async def check_output(request: OutputCheckRequest, http_request: Request) -> dict[str, Any]:
    """C-4 — output-side checks. Deterministic; no model, no verdict, no skip.

    Generative summaries are NOT handled here: sentence-level groundedness is
    `/guardrail/groundedness`, over the NLI selection in `apps/nlp`. A second
    copy would be a second inference stack.
    """
    tenant_id = require_tenant_id(http_request)
    try:
        validator = await build_realtime_validator(http_request.app.state, tenant_id)
        lexicons = validator._policy.lexicons  # noqa: SLF001
    except HTTPException:
        raise
    except (ModelUnavailableError, GuardrailUndeterminedError) as exc:
        raise _unavailable("output", exc) from exc

    if request.task == "ner":
        outcome, kept = check_span_provenance(request.entities, request.source_text)
        return {
            "task": "ner",
            "tenantId": tenant_id,
            "checks": [outcome.to_dict()],
            "keptEntities": kept,
            "droppedCount": len(request.entities) - len(kept),
            "transcriptDisposition": RETAIN_VERBATIM,
        }
    if request.task == "grammar":
        if request.corrected_text is None:
            raise HTTPException(
                status_code=422, detail="grammar output checks require `corrected_text`"
            )
        checks = check_clinical_preservation(
            request.source_text, request.corrected_text, lexicons=lexicons
        )
        return {
            "task": "grammar",
            "tenantId": tenant_id,
            "checks": [c.to_dict() for c in checks],
            # A correction that alters a drug, dose, negation or laterality is a
            # SAFETY EVENT, not a style change — named as such on the wire.
            "safetyEvent": any(c.outcome == "flag" for c in checks),
            "transcriptDisposition": RETAIN_VERBATIM,
        }
    raise HTTPException(
        status_code=422,
        detail=(
            "unknown output task; `ner` and `grammar` are checked here, and generative "
            "groundedness is /guardrail/groundedness"
        ),
    )
