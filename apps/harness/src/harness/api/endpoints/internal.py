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
    """Reject the request unless ``X-Service-Token`` matches the shared secret.

    Constant-time comparison. An empty configured token means auth is disabled
    (local dev) and every caller is allowed through.
    """
    expected = _settings(request).harness_service_token.get_secret_value()
    if not expected:
        return
    if not x_service_token or not secrets.compare_digest(x_service_token, expected):
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


class StartDocumentRequest(BaseModel):
    """Body for ``document:start`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str = Field(alias="tenantId")
    user_id: str | None = Field(default=None, alias="userId")
    job_id: str | None = Field(default=None, alias="jobId")
    correlation_id: str | None = Field(default=None, alias="correlationId")
    context_item_id: str | None = Field(default=None, alias="contextItemId")
    transcript_text: str = Field(default="", alias="transcriptText")
    conversation_language: str = Field(default="en", alias="conversationLanguage")
    dna_style_id: str | None = Field(default=None, alias="dnaStyleId")
    template: str | None = Field(default=None)
    smr_provider: str | None = Field(default=None, alias="smrProvider")
    smr_model: str | None = Field(default=None, alias="smrModel")


class ApprovalRequest(BaseModel):
    """Body for ``signal/approve`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str | None = Field(default=None, alias="tenantId")
    context_item_version_id: str | None = Field(default=None, alias="contextItemVersionId")
    attestation_hash: str | None = Field(default=None, alias="attestationHash")
    clinician_id: str | None = Field(default=None, alias="clinicianId")
    decision: str | None = Field(default=None)


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
        conversation_language=body.conversation_language,
        dna_style_id=body.dna_style_id,
        template=body.template,
        smr_provider=body.smr_provider,
        smr_model=body.smr_model,
        gate=HarnessGateConfig(
            max_regen=settings.max_regen,
            gate_sla_seconds=settings.gate_sla_seconds,
            gate_escalation_seconds=settings.gate_escalation_seconds,
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
