"""N-11 ``consultation.persistDraft`` and N-12 ``consultation.finalizeAssurance`` — the two
``external_write`` persistence nodes.

Compile targets per ``contracts/palette-contract.md`` §1: ``persist_draft`` and
``finalize_assurance``. Both belong to no reference role — they are the substrate's own
durability checkpoints, and both are `mandatory` safety class for the reason
``contracts/node-types.md`` gives.

Neither activity checks ``payload.sandbox``: ``workflow.py:188`` already SKIPS any
``external_write`` node in a sandboxed run before the activity is scheduled, so a Workbench run
of a consultation graph never writes a ContextItem. Re-checking here would be a second copy of
one rule in the place least able to enforce it.

``config.occ`` (CR-07/WF-CONS-014, the TASK-709 authorship protection made structural) is
enforced by the VALIDATOR, not re-derived here — same reasoning as ``consultation.synthesize``'s
``producesCode``. The optimistic-concurrency behaviour itself lives in apps/api, which owns the
write.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.services.api_client import ApiServiceError
from harness.temporal.activities import finalize_assurance, persist_draft
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import (
    bound_text,
    bound_value,
    run_identity,
)
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import FinalizeAssuranceInput, PersistDraftInput


def _dict_or_none(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


@activity.defn(name="interpreter.consultation_persist_draft")
async def interpreter_consultation_persist_draft(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-11 — persist the verified draft note as a ContextItem.

    Sensor scores and citations are read from the bound verifier output when present, so a graph
    that routes ``sensors → persistDraft`` records the verdicts alongside the note. A graph that
    persists without a verifier still works — it just records no scores, which is honest rather
    than fabricated.
    """
    started = now()
    content = bound_text(payload.bound_inputs)
    if not content:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_content"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no draft content bound from an upstream node to persist"
        )

    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to persist against"
        )

    try:
        result = await persist_draft(
            PersistDraftInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                content=content,
                user_id=identity.user_id,
                job_id=identity.job_id,
                sensor_scores=_dict_or_none(bound_value(payload.bound_inputs, "scores")),
                citations_map=_dict_or_none(bound_value(payload.bound_inputs, "citationsMap")),
                guardrail_decisions=_dict_or_none(
                    bound_value(payload.bound_inputs, "guardrailDecisions")
                ),
                reduced_assurance=_optional_bool(
                    bound_value(payload.bound_inputs, "reducedAssurance")
                ),
                rag_triad_score=_optional_float(bound_value(payload.bound_inputs, "ragTriadScore")),
                is_auto_generated=True,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="persist_draft_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"draft persistence failed: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"contextItemId": result.context_item_id, "text": content},
    )


def _optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


@activity.defn(name="interpreter.consultation_finalize_assurance")
async def interpreter_consultation_finalize_assurance(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-12 — backfill the assurance verdict onto the already-delivered draft.

    Targets the ``contextItemId`` an upstream ``persistDraft`` published. Without one there is
    nothing to bind a verdict to, and inventing a target would stamp a verdict on the wrong note
    — so it degrades instead.
    """
    started = now()
    context_item_id = bound_value(payload.bound_inputs, "contextItemId")
    if not isinstance(context_item_id, str) or not context_item_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_context_item_id"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="no contextItemId bound from an upstream persistDraft node to assure",
        )

    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to finalize against"
        )

    try:
        result = await finalize_assurance(
            FinalizeAssuranceInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                user_id=identity.user_id,
                job_id=identity.job_id,
                context_item_id=context_item_id,
                sensor_scores=_dict_or_none(bound_value(payload.bound_inputs, "scores")),
                citations_map=_dict_or_none(bound_value(payload.bound_inputs, "citationsMap")),
                guardrail_decisions=_dict_or_none(
                    bound_value(payload.bound_inputs, "guardrailDecisions")
                ),
                reduced_assurance=_optional_bool(
                    bound_value(payload.bound_inputs, "reducedAssurance")
                ),
                rag_triad_score=_optional_float(bound_value(payload.bound_inputs, "ragTriadScore")),
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="finalize_assurance_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"assurance finalization failed: {exc}")

    if not result.recorded:
        await record_and_flush(
            payload,
            status=STATUS_DEGRADED,
            started=started,
            error_code="finalize_assurance_refused",
        )
        return NodeActivityResult(
            status="DEGRADED", reason="assurance verdict was not recorded by apps/api"
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"contextItemId": result.context_item_id or context_item_id, "recorded": True},
    )
