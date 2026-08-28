"""TASK-812 — the ENDPOINT STAGE: ``session.timeout``, ``summary.finalize``, ``feedback.capture``.

The endpoint stage is the ordered sequence that runs before a consultation session closes. Before
this ticket it existed only as a hardcoded literal in the gateway
(``loop-config.service.ts``'s ``endingActionsBase``), which an admin could SUBTRACT from and
nothing else (D-10); two of its three jobs had no node, no activity and no code anywhere.

## The three defects, and which activity closes each

* **D-10** — the sequence was a literal. It is now the persisted, admin-ordered
  ``consultation.endpoint.actions`` list, resolved by ``LoopConfigService`` and dispatched by
  ``ConsultationLoopWorkflow._run_lifecycle_actions``. These three activities are what make
  ordering it MEAN something: before them there was nothing to order but ``livedoc.stop`` and
  ``harness.finalize``.
* **D-11** — no feedback-capture node or activity existed. ``interpreter_feedback_capture`` is it.
* **D-12** — the idle timeout deliberately skipped the ending actions, so a timed-out consultation
  never finalized. ``interpreter_session_timeout`` is the node that records that outcome, and the
  loop now RUNS the sequence on expiry (``workflows.py``, patch era ``task-812-endpoint-on-timeout``).

## Why all three are safe to retry (the durable-lane contract)

Every registry entry here is ``trigger: 'on-end'``, ``lane: 'durable'`` and therefore
``idempotent: true`` — ``nodeDescriptorContractProblems`` refuses a durable non-idempotent node.
Temporal WILL retry these, so each one converges rather than accumulating:

* the session disposition is an UPSERT of one block on the consultation — the same reason written
  twice leaves the same state, and the gateway reports ``changed: False``;
* finalize is a state TRANSITION: a section already ``LOCKED`` is skipped, never re-locked with a
  fresh timestamp, so a second pass reports ``lockedSections: 0`` and ``alreadyLocked: N``;
* a promotion carries a DETERMINISTIC key derived from the accepted proposal ids, so a retry finds
  its own prior write and promotes nothing further.

## Failure posture — degrade VISIBLY, never silently

Uniform with the rest of the palette (CR-14): none of these three is ``critical``, so a gateway
error DEGRADES the node with a named ``error_code`` instead of failing the run. What is NOT
uniform is the underlying activity: ``livedoc_stop`` swallows every exception because a stale UI
panel is cheap, and these three deliberately do not. A swallowed finalize is a note that never
locked, reported as success.

## DD-8 lives here, in ``_accepted_proposals``

``consultation.proposeCorrections`` returns its source text byte-identical with ``applied: False``
and is ``external_write=False`` — it can propose and nothing else, because a system that silently
rewrites a drug name or a dose in clinical text is a patient-safety defect. This module is where a
clinician's ACCEPTANCE turns one of those proposals into a real correction over the raw channel,
and ``_accepted_proposals`` is the filter that makes it the ONLY such path: a proposal is
promotable only when it is explicitly listed as accepted, and a proposal still carrying
``status: "PROPOSED"`` is dropped no matter which port it arrived on.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.services.api_client import ApiServiceError
from harness.temporal.activities import (
    capture_feedback,
    finalize_documents,
    record_session_endpoint,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import bound_value, run_identity
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import (
    ENDPOINT_REASON_ENDED,
    ENDPOINT_REASON_TIMED_OUT,
    CaptureFeedbackInput,
    FinalizeDocumentsInput,
    RecordSessionEndpointInput,
)

#: The dispositions a run payload may declare. Anything else is normalised to ``ENDED`` rather
#: than passed through: an unrecognised disposition stamped onto a clinical record is worse than
#: a conservative one, and the loop is the authority on expiry, not a graph author.
_KNOWN_REASONS = {ENDPOINT_REASON_ENDED, ENDPOINT_REASON_TIMED_OUT, "CANCELLED"}

#: Only a proposal a clinician actually accepted may be promoted (DD-8).
_ACCEPTED_STATUS = "ACCEPTED"


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _endpoint_config(payload: NodeActivityInput) -> dict[str, Any]:
    config = payload.config
    return config if isinstance(config, dict) else {}


@activity.defn(name="interpreter.session_timeout")
async def interpreter_session_timeout(payload: NodeActivityInput) -> NodeActivityResult:
    """Stamp HOW this consultation session reached its endpoint.

    The disposition comes from the RUN, never from ``payload.config`` — whether a session ended
    on a signal or on its idle bound is an observed fact about the execution, not something a
    tenant authors on a node. ``config.idleTimeoutSeconds`` is recorded alongside it so a reader
    of a finished consultation sees the bound that applied to it rather than today's setting.
    """
    started = now()
    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to stamp"
        )

    config = _endpoint_config(payload)
    raw_reason = _optional_str(payload.run_payload.get("endpointReason")) or ENDPOINT_REASON_ENDED
    reason = raw_reason if raw_reason in _KNOWN_REASONS else ENDPOINT_REASON_ENDED
    sequence = payload.run_payload.get("endpointSequence")

    try:
        result = await record_session_endpoint(
            RecordSessionEndpointInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                reason=reason,
                idle_timeout_seconds=_optional_int(config.get("idleTimeoutSeconds")),
                sequence=(
                    [s for s in sequence if isinstance(s, str)]
                    if isinstance(sequence, list)
                    else []
                ),
                user_id=identity.user_id,
                job_id=identity.job_id,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="session_endpoint_failed"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"endpoint disposition was not recorded: {exc}"
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"reason": result.reason, "recorded": result.recorded, "changed": result.changed},
    )


@activity.defn(name="interpreter.summary_finalize")
async def interpreter_summary_finalize(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-3 — finalize the consultation by LOCKING EVERY DOCUMENT.

    Not the SOAP note. Every document. There is no ``documentKey`` in the config schema and no
    ``document_key`` on the payload, so this node cannot be narrowed into the defect DD-3 names:
    a finalize that locks only the SOAP note leaves a discharge summary editable after signature.

    The bound ``in: document`` port expresses ORDERING — "finalize after the thing that writes" —
    and is deliberately optional and multiple. What it never does is scope the lock.
    """
    started = now()
    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to finalize"
        )

    config = _endpoint_config(payload)
    try:
        result = await finalize_documents(
            FinalizeDocumentsInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                lock_confirmed_only=bool(config.get("lockConfirmedOnly", False)),
                user_id=identity.user_id,
                job_id=identity.job_id,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="finalize_documents_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"document finalization failed: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "documentKeys": result.document_keys,
            "lockedSections": result.locked_sections,
            "alreadyLocked": result.already_locked,
            "skippedSections": result.skipped_sections,
        },
    )


def _accepted_proposals(payload: NodeActivityInput) -> tuple[list[dict[str, Any]], int]:
    """The accepted advisory corrections bound to this node, and how many were refused.

    THE DD-8 FILTER. A proposal is promotable only when a clinician accepted it, and acceptance
    is expressed one of exactly two ways: the proposal object itself carries
    ``status: "ACCEPTED"``, or the RUN payload names its ``proposalId`` in
    ``feedback.acceptedProposalIds``. A proposal still marked ``PROPOSED`` is dropped whichever
    port it arrived on — including the ``edits`` socket a ``consultation.proposeCorrections`` node
    feeds directly, which is the wiring most likely to be mistaken for an approval.

    Minimum confidence is applied here too, so a low-confidence proposal is never OFFERED for
    promotion even when the payload names it.
    """
    raw = bound_value(payload.bound_inputs, "proposals")
    if not isinstance(raw, list):
        raw = payload.run_payload.get("proposals")
    if not isinstance(raw, list):
        return [], 0

    feedback = payload.run_payload.get("feedback")
    accepted_ids = set()
    if isinstance(feedback, dict):
        ids = feedback.get("acceptedProposalIds")
        if isinstance(ids, list):
            accepted_ids = {i for i in ids if isinstance(i, str)}

    config = _endpoint_config(payload)
    min_confidence = config.get("minConfidence")
    floor = float(min_confidence) if isinstance(min_confidence, (int, float)) else None

    accepted: list[dict[str, Any]] = []
    refused = 0
    for item in raw:
        if not isinstance(item, dict):
            refused += 1
            continue
        proposal_id = item.get("proposalId")
        is_accepted = item.get("status") == _ACCEPTED_STATUS or (
            isinstance(proposal_id, str) and proposal_id in accepted_ids
        )
        if not is_accepted:
            refused += 1
            continue
        confidence = item.get("confidence")
        if floor is not None and not (isinstance(confidence, (int, float)) and confidence >= floor):
            refused += 1
            continue
        accepted.append({**item, "status": _ACCEPTED_STATUS})
    return accepted, refused


@activity.defn(name="interpreter.feedback_capture")
async def interpreter_feedback_capture(payload: NodeActivityInput) -> NodeActivityResult:
    """DD-11/DD-8 — capture endpoint feedback, and promote any ACCEPTED correction.

    This node exists because nothing captured endpoint feedback anywhere in the platform (D-11),
    and it is the only path that promotes an advisory transcript correction over the raw channel
    (DD-8). Both halves matter: without the capture there was no clinician signal at the endpoint
    at all, and without the single path there would be no way to say where a correction to
    clinical text is allowed to come from.

    ``promoteCorrections: false`` removes the promotion; it does not relocate it. There is
    nowhere else for an accepted proposal to go.
    """
    started = now()
    identity = run_identity(payload.run_payload)
    if not identity.consultation_id:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_consultation_id"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="run payload carries no consultationId to capture against"
        )

    config = _endpoint_config(payload)
    accepted, refused = _accepted_proposals(payload)
    if config.get("promoteCorrections") is False:
        refused += len(accepted)
        accepted = []

    feedback = payload.run_payload.get("feedback")
    feedback = feedback if isinstance(feedback, dict) else {}

    try:
        result = await capture_feedback(
            CaptureFeedbackInput(
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
                context_item_id=_optional_str(bound_value(payload.bound_inputs, "contextItemId"))
                or _optional_str(feedback.get("contextItemId")),
                text_sha256=_optional_str(bound_value(payload.bound_inputs, "textSha256"))
                or _optional_str(feedback.get("textSha256")),
                accepted_proposals=accepted,
                rating=_optional_int(feedback.get("rating")),
                comment=_optional_str(feedback.get("comment")),
                user_id=identity.user_id,
                job_id=identity.job_id,
            )
        )
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="capture_feedback_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"feedback capture failed: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "captured": result.captured,
            "promotedCount": result.promoted_count,
            # Proposals this node REFUSED to offer for promotion, plus any the gateway itself
            # refused (a drifted digest, a span that no longer matches). Both are counted so a
            # clinician's "I accepted three" and a record showing one are reconcilable.
            "rejectedCount": result.rejected_count + refused,
            "promotionKey": result.promotion_key,
            "alreadyPromoted": result.already_promoted,
        },
    )
