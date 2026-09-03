"""Internal, service-to-service endpoints (apps/api → apps/harness).

apps/api is the gateway / system-of-record; it drives the durable document loop
through these two endpoints (it never talks to Temporal directly):

* ``POST /api/v1/internal/consultations/{id}/document:start`` — start (idempotently)
  the :class:`~harness.temporal.workflows.HarnessDocWorkflow` for a consultation.
* ``POST /api/v1/internal/workflows/{id}/signal/approve`` — forward a clinician
  sign-off to the running workflow's ``approval`` signal.

Both are guarded by the shared ``HARNESS_SERVICE_TOKEN`` (``X-Service-Token``
header). An empty configured token disables the guard (local dev only). The
Temporal client is resolved from ``app.state`` (populated by the lifespan) or
connected lazily, so it can be mocked in tests.
"""

from __future__ import annotations

import secrets
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from temporalio.client import Client
from temporalio.common import SearchAttributeKey, SearchAttributePair, TypedSearchAttributes
from temporalio.exceptions import WorkflowAlreadyStartedError

from harness.core.config import Settings
from harness.core.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(tags=["internal"])

# Custom Temporal search attribute carrying the owning tenant. Keyword-typed so the
# admin console's visibility query can filter by it. One-time per-cluster setup:
#   temporal operator search-attribute create --name HarnessTenantId --type Keyword
# When it is not registered, ``start_document`` degrades to a memo-only start and the
# admin endpoints fall back to memo + client-side filtering (see ``admin.py``).
HARNESS_TENANT_ID_ATTR = "HarnessTenantId"
HARNESS_TENANT_ID_KEY = SearchAttributeKey.for_keyword(HARNESS_TENANT_ID_ATTR)


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def require_service_token(
    request: Request,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Reject the request unless ``X-Service-Token`` matches an accepted secret.

    Accepts the canonical shared ``INTERNAL_ACCESS_TOKEN`` OR the legacy
    ``HARNESS_SERVICE_TOKEN``, via :attr:`Settings.accepted_service_tokens` —
    the same both-tokens posture ``knowledge.py`` already implements. Reading
    ``harness_service_token`` alone made this surface the one inbound guard that
    rejected a caller presenting the shared token. Constant-time comparison; no
    configured token at all means auth is disabled (local dev / hermetic CI).
    """
    accepted = _settings(request).accepted_service_tokens
    if not accepted:
        return
    if not x_service_token or not any(
        secrets.compare_digest(x_service_token, tok) for tok in accepted
    ):
        raise HTTPException(status_code=401, detail="invalid or missing service token")


async def _temporal_client(request: Request) -> Client:
    """Return the shared Temporal client, connecting lazily if needed."""
    client = getattr(request.app.state, "temporal_client", None)
    if client is None:
        from harness.temporal.client import get_temporal_client

        client = await get_temporal_client(_settings(request))
        request.app.state.temporal_client = client
    return client


def _workflow_id(consultation_id: str) -> str:
    """Deterministic, idempotent workflow id for a consultation's document loop."""
    return f"harness-doc-{consultation_id}"


def _loop_workflow_id(consultation_id: str) -> str:
    """Deterministic, idempotent workflow id for a consultation's LOOP.

    Mirrors ``consultation_loop_workflow_id`` in ``temporal.workflows``; kept as
    a local one-liner for the same reason ``_workflow_id`` is — this module must
    stay importable without loading the workflow sandbox.
    """
    return f"consultation-loop-{consultation_id}"


class StartDocumentRequest(BaseModel):
    """Body for ``document:start`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str = Field(alias="tenantId")
    user_id: str | None = Field(default=None, alias="userId")
    job_id: str | None = Field(default=None, alias="jobId")
    correlation_id: str | None = Field(default=None, alias="correlationId")
    context_item_id: str | None = Field(default=None, alias="contextItemId")
    # (consent-abac Phase 4) — Consultation.patientId, so
    # call_mcp_tool/retrieve_context can key a consent-gate lookup. Optional
    # (extra="ignore" + default None): an un-upgraded gateway caller omits it
    # and those activities degrade to UNAVAILABLE rather than crash.
    external_patient_id: str | None = Field(default=None, alias="externalPatientId")
    transcript_text: str = Field(default="", alias="transcriptText")
    conversation_language: str = Field(default="en", alias="conversationLanguage")
    dna_style_id: str | None = Field(default=None, alias="dnaStyleId")
    template: str | None = Field(default=None)
    text_provider: str | None = Field(default=None, alias="textProvider")
    text_model: str | None = Field(default=None, alias="textModel")
    # DNA redaction/rewrite rules resolved + decrypted gateway-side
    # (tenant + doctor double-gate). Default [] ⇒ the workflow's apply_redaction
    # insertion is a no-op (byte-identical to the prior start). Each entry is
    # the RedactionRule shape ({ id, type, match, pattern, replacement?, note? }).
    redaction_rules: list[dict[str, Any]] = Field(default_factory=list, alias="redactionRules")


class ApprovalRequest(BaseModel):
    """Body for ``signal/approve`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str | None = Field(default=None, alias="tenantId")
    context_item_version_id: str | None = Field(default=None, alias="contextItemVersionId")
    attestation_hash: str | None = Field(default=None, alias="attestationHash")
    clinician_id: str | None = Field(default=None, alias="clinicianId")
    decision: str | None = Field(default=None)


class EditRequest(BaseModel):
    """Body for ``signal/edit`` (camelCase at the apps/api boundary).

    apps/api forwards a clinician edit of an
    optimistically-delivered draft (still ``DRAFT_PENDING_SENSORS``) so the
    workflow re-binds + re-runs assurance on the edited content (Q3) and disables
    the silent regen-if-untouched path (Q1). ``content`` is required — it is the
    edited note the assurance pass must screen.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    content: str
    context_item_version_id: str | None = Field(default=None, alias="contextItemVersionId")
    edited_by: str | None = Field(default=None, alias="editedBy")


class LoopContextAddedRequest(BaseModel):
    """Body for ``signal/context-added`` (the receiver for the caller).

    Now, ``HarnessGatewayService.signalContextAdded`` sends every
    field below: ``kindKey``/``occurredAt``/``depth``/``content`` are no longer
    hypothetical future additions, they are what a payload-complete signal
    actually carries. They stay ADDITIVE-OPTIONAL regardless — ``extra="ignore"``
    on both sides means an un-upgraded gateway (or a future field neither side
    knows yet) never breaks the wire.

    ``kindKey`` falls back to ``subType`` and then to ``contextType`` so a
    gateway that has not yet been taught the kind key still routes against
    SOMETHING the tenant's subscriptions can match, rather than silently
    matching nothing. ``resolved_text`` similarly prefers the fuller
    ``content`` over the older, shorter ``contentPreview``.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str | None = Field(default=None, alias="tenantId")
    context_item_id: str = Field(alias="contextItemId")
    context_type: str | None = Field(default=None, alias="contextType")
    sub_type: str | None = Field(default=None, alias="subType")
    kind_key: str | None = Field(default=None, alias="kindKey")
    occurred_at: str | None = Field(default=None, alias="occurredAt")
    depth: int = 0
    source: str | None = Field(default=None)
    content_preview: str = Field(default="", alias="contentPreview")
    # The fuller context body (up to LOOP_SIGNAL_CONTENT_MAX_LENGTH
    # chars gateway-side; see context.service.ts for the size-threshold
    # reasoning). Additive-optional, same posture as kindKey/occurredAt/depth:
    # an un-upgraded gateway sends none of it and `resolved_text()` falls back
    # to `content_preview`.
    content: str | None = Field(default=None)
    user_id: str | None = Field(default=None, alias="userId")
    session_id: str | None = Field(default=None, alias="sessionId")
    correlation_id: str | None = Field(default=None, alias="correlationId")

    def resolved_kind_key(self) -> str | None:
        return self.kind_key or self.sub_type or self.context_type

    def resolved_text(self) -> str:
        """The fuller `content` when the gateway sent it, else `content_preview`."""
        return self.content or self.content_preview


class LoopEndingRequest(BaseModel):
    """Body for ``signal/consultation-ending``."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    reason: str | None = Field(default=None)
    persist_snapshot: bool = Field(default=True, alias="persistSnapshot")
    # The HarnessDocWorkflow start payload the loop forwards to its finalize
    # child. Omitted ⇒ the child starts with an empty transcript, which is the
    # correct degradation: the gateway owns the transcript, not the loop.
    transcript_text: str = Field(default="", alias="transcriptText")
    context_item_id: str | None = Field(default=None, alias="contextItemId")
    job_id: str | None = Field(default=None, alias="jobId")
    conversation_language: str = Field(default="en", alias="conversationLanguage")
    dna_style_id: str | None = Field(default=None, alias="dnaStyleId")
    template: str | None = Field(default=None)
    text_provider: str | None = Field(default=None, alias="textProvider")
    text_model: str | None = Field(default=None, alias="textModel")
    # — advisory transcript corrections the clinician accepted
    #: (`StopRecordingRequest.acceptedProposals`), forwarded verbatim onto the
    # `ConsultationEndingSignal` so `feedback.capture` has something to
    #: promote over the raw transcript.
    accepted_proposals: list[dict[str, Any]] = Field(default_factory=list, alias="acceptedProposals")


class LoopCancelRequest(BaseModel):
    """Body for ``signal/loop-cancel`` — an orderly application-level stop."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    reason: str | None = Field(default=None)


@router.post(
    "/consultations/{consultation_id}/document:start",
    dependencies=[Depends(require_service_token)],
)
async def start_document(
    consultation_id: str,
    body: StartDocumentRequest,
    request: Request,
) -> dict[str, Any]:
    """Start the document workflow (idempotent on the deterministic workflow id)."""
    # Imported lazily so the module has no import-time dependency on the workflow
    # sandbox (keeps the HTTP surface importable without a Temporal runtime).
    from harness.redaction.engine import RedactionRule
    from harness.temporal.models import HarnessDocWorkflowInput, HarnessGateConfig
    from harness.temporal.workflows import HarnessDocWorkflow

    settings = _settings(request)
    client = await _temporal_client(request)
    workflow_id = _workflow_id(consultation_id)

    wf_input = HarnessDocWorkflowInput(
        consultation_id=consultation_id,
        tenant_id=body.tenant_id,
        user_id=body.user_id,
        job_id=body.job_id,
        correlation_id=body.correlation_id,
        context_item_id=body.context_item_id,
        transcript_text=body.transcript_text,
        external_patient_id=body.external_patient_id,
        conversation_language=body.conversation_language,
        dna_style_id=body.dna_style_id,
        template=body.template,
        text_provider=body.text_provider,
        text_model=body.text_model,
        # Parse each rule dict into a RedactionRule (validates the JSON shape at the
        # boundary; a malformed rule 422s here rather than failing closed mid-workflow).
        redaction_rules=[RedactionRule.model_validate(r) for r in body.redaction_rules],
        gate=HarnessGateConfig(
            max_regen=settings.max_regen,
            gate_sla_seconds=settings.gate_sla_seconds,
            gate_escalation_seconds=settings.gate_escalation_seconds,
            # Snapshot HARNESS_OPTIMISTIC_DELIVERY_ENABLED here,
            # in the (non-workflow) start path, so the optimistic kill-switch is captured
            # in the workflow input and stays deterministic across replay.
            optimistic_delivery_enabled=settings.optimistic_delivery_enabled,
        ),
    )

    # Tenant ownership rides on a search attribute (for the admin visibility query)
    # AND a memo (the fallback when the SA is not registered on the cluster).
    memo = {"tenantId": body.tenant_id, "consultationId": consultation_id}
    search_attributes = TypedSearchAttributes(
        [SearchAttributePair(HARNESS_TENANT_ID_KEY, body.tenant_id)]
    )
    start_kwargs: dict[str, Any] = {
        "id": workflow_id,
        "task_queue": settings.temporal.task_queue,
        "memo": memo,
    }

    try:
        await client.start_workflow(
            HarnessDocWorkflow.run,
            wf_input,
            search_attributes=search_attributes,
            **start_kwargs,
        )
        status = "started"
    except WorkflowAlreadyStartedError:
        # Idempotent: a loop is already running for this consultation.
        status = "already_running"
    except Exception as exc:  # noqa: BLE001 — fail-safe: the SA may be unregistered
        # Degrade to a memo-only start so a missing search attribute never blocks a
        # consultation. The admin console then filters by the memo client-side.
        logger.warning(
            "harness.document.start.search_attribute_unavailable",
            consultation_id=consultation_id,
            workflow_id=workflow_id,
            error=str(exc),
        )
        try:
            await client.start_workflow(HarnessDocWorkflow.run, wf_input, **start_kwargs)
            status = "started"
        except WorkflowAlreadyStartedError:
            status = "already_running"

    logger.info(
        "harness.document.start",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        status=status,
    )
    return {"workflowId": workflow_id, "status": status}


@router.post(
    "/workflows/{consultation_id}/signal/approve",
    dependencies=[Depends(require_service_token)],
)
async def signal_approve(
    consultation_id: str,
    body: ApprovalRequest,
    request: Request,
) -> dict[str, Any]:
    """Forward a clinician sign-off to the running workflow's ``approval`` signal."""
    from harness.temporal.models import ApprovalSignal
    from harness.temporal.workflows import HarnessDocWorkflow

    client = await _temporal_client(request)
    workflow_id = _workflow_id(consultation_id)

    handle = client.get_workflow_handle(workflow_id)
    await handle.signal(
        HarnessDocWorkflow.approval,
        ApprovalSignal(
            tenant_id=body.tenant_id,
            context_item_version_id=body.context_item_version_id,
            attestation_hash=body.attestation_hash,
            clinician_id=body.clinician_id,
            decision=body.decision,
        ),
    )

    logger.info(
        "harness.document.signal_approve",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        decision=body.decision,
    )
    return {"workflowId": workflow_id, "signaled": True}


@router.post(
    "/workflows/{consultation_id}/signal/edit",
    dependencies=[Depends(require_service_token)],
)
async def signal_edit(
    consultation_id: str,
    body: EditRequest,
    request: Request,
) -> dict[str, Any]:
    """Forward a clinician edit to the running workflow's ``edit`` signal.

    Targets the same deterministic ``harness-doc-{id}``
    handle as ``signal/approve``; the workflow re-binds assurance to the edited
    content + version and re-runs it (Q3), and permanently disables the silent
    regen-if-untouched path (Q1).
    """
    from harness.temporal.models import EditSignal
    from harness.temporal.workflows import HarnessDocWorkflow

    client = await _temporal_client(request)
    workflow_id = _workflow_id(consultation_id)

    handle = client.get_workflow_handle(workflow_id)
    await handle.signal(
        HarnessDocWorkflow.edit,
        EditSignal(
            content=body.content,
            context_item_version_id=body.context_item_version_id,
            edited_by=body.edited_by,
        ),
    )

    logger.info(
        "harness.document.signal_edit",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        context_item_version_id=body.context_item_version_id,
    )
    return {"workflowId": workflow_id, "signaled": True}


# ---------------------------------------------------------------------------
# Consultation loop
#
# The gateway shipped the CALLER for `signal/context-added`;
# these three routes are the matching receiver.
# ---------------------------------------------------------------------------


@router.post(
    "/workflows/{consultation_id}/signal/context-added",
    dependencies=[Depends(require_service_token)],
)
async def signal_context_added(
    consultation_id: str,
    body: LoopContextAddedRequest,
    request: Request,
) -> dict[str, Any]:
    """Deliver a context item to the consultation loop, starting it if needed.

    This is a signal-WITH-start, not a signal: the loop's lifetime is the
    consultation's, and the first context item is what brings it into
    existence. Signal-with-start is idempotent on the deterministic workflow id
    — a second call signals the running loop instead of racing a duplicate into
    existence — which is why it is used here rather than a start-then-signal
    pair that could interleave.

    ``tenantId`` is required: the workflow cannot be STARTED without it, and a
    loop with the wrong tenant would resolve another tenant's configuration.
    """
    from harness.temporal.models import ConsultationLoopWorkflowInput, ContextAddedSignal
    from harness.temporal.workflows import ConsultationLoopWorkflow

    if not body.tenant_id:
        raise HTTPException(status_code=400, detail="tenantId is required")

    settings = _settings(request)
    client = await _temporal_client(request)
    workflow_id = _loop_workflow_id(consultation_id)

    wf_input = ConsultationLoopWorkflowInput(
        consultation_id=consultation_id,
        tenant_id=body.tenant_id,
        user_id=body.user_id,
        correlation_id=body.correlation_id,
        session_id=body.session_id,
    )
    signal = ContextAddedSignal(
        context_item_id=body.context_item_id,
        kind_key=body.resolved_kind_key(),
        context_type=body.context_type,
        source=body.source,
        occurred_at=body.occurred_at,
        depth=body.depth,
        text=body.resolved_text(),
    )

    memo = {"tenantId": body.tenant_id, "consultationId": consultation_id}
    start_kwargs: dict[str, Any] = {
        "id": workflow_id,
        "task_queue": settings.temporal.task_queue,
        "memo": memo,
        "start_signal": "contextAdded",
        "start_signal_args": [signal],
    }

    try:
        await client.start_workflow(
            ConsultationLoopWorkflow.run,
            wf_input,
            search_attributes=TypedSearchAttributes(
                [SearchAttributePair(HARNESS_TENANT_ID_KEY, body.tenant_id)]
            ),
            **start_kwargs,
        )
    except Exception as exc:  # noqa: BLE001 — fail-safe: the SA may be unregistered
        # Same degradation as ``start_document``: a search attribute that is not
        # registered on the cluster must never stop a consultation.
        logger.warning(
            "harness.loop.signal_context_added.search_attribute_unavailable",
            consultation_id=consultation_id,
            workflow_id=workflow_id,
            error=str(exc),
        )
        await client.start_workflow(ConsultationLoopWorkflow.run, wf_input, **start_kwargs)

    logger.info(
        "harness.loop.signal_context_added",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        context_item_id=body.context_item_id,
        kind_key=signal.kind_key,
        depth=body.depth,
    )
    return {"workflowId": workflow_id, "signaled": True}


@router.post(
    "/workflows/{consultation_id}/signal/consultation-ending",
    dependencies=[Depends(require_service_token)],
)
async def signal_consultation_ending(
    consultation_id: str,
    body: LoopEndingRequest,
    request: Request,
) -> dict[str, Any]:
    """Tell the loop the consultation is over: drain, run ending actions, finish.

    A plain signal, NOT signal-with-start: there is nothing to end when no loop
    is running, and starting one just to immediately end it would emit a
    spurious finalize.
    """
    from harness.temporal.models import ConsultationEndingSignal, LoopFinalizeRequest
    from harness.temporal.workflows import ConsultationLoopWorkflow

    client = await _temporal_client(request)
    workflow_id = _loop_workflow_id(consultation_id)

    handle = client.get_workflow_handle(workflow_id)
    await handle.signal(
        ConsultationLoopWorkflow.consultation_ending,
        ConsultationEndingSignal(
            reason=body.reason,
            persist_snapshot=body.persist_snapshot,
            accepted_proposals=body.accepted_proposals,
            finalize=LoopFinalizeRequest(
                transcript_text=body.transcript_text,
                context_item_id=body.context_item_id,
                job_id=body.job_id,
                conversation_language=body.conversation_language,
                dna_style_id=body.dna_style_id,
                template=body.template,
                text_provider=body.text_provider,
                text_model=body.text_model,
            ),
        ),
    )

    logger.info(
        "harness.loop.signal_consultation_ending",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        reason=body.reason,
    )
    return {"workflowId": workflow_id, "signaled": True}


@router.post(
    "/workflows/{consultation_id}/signal/loop-cancel",
    dependencies=[Depends(require_service_token)],
)
async def signal_loop_cancel(
    consultation_id: str,
    body: LoopCancelRequest,
    request: Request,
) -> dict[str, Any]:
    """Stop the loop WITHOUT running its ending actions (the consultation was abandoned).

    Named ``loop-cancel`` rather than ``cancel`` so it is never mistaken for
    Temporal cancellation: this is an orderly application-level stop and the
    workflow COMPLETES, it does not fail.
    """
    from harness.temporal.models import CancelLoopSignal
    from harness.temporal.workflows import ConsultationLoopWorkflow

    client = await _temporal_client(request)
    workflow_id = _loop_workflow_id(consultation_id)

    handle = client.get_workflow_handle(workflow_id)
    await handle.signal(ConsultationLoopWorkflow.cancel, CancelLoopSignal(reason=body.reason))

    logger.info(
        "harness.loop.signal_loop_cancel",
        consultation_id=consultation_id,
        workflow_id=workflow_id,
        reason=body.reason,
    )
    return {"workflowId": workflow_id, "signaled": True}
