"""The interpreter's dispatcher API — the single HTTP entry point the
exposure plane and the Workbench call to start a WorkflowInterpreter run,
plus the status/result read surface and cancel.

Guarded by the shared ``X-Service-Token`` (``require_service_token``, reused from
``internal.py``) — never called directly by browsers, only through the gateway. A NEW route
family keyed by ``runId`` (not ``consultationId``) — deliberately NOT an extension of the
existing consultation-document family in ``internal.py``, so this substrate stays separable from
the consultation palette (Wave 4's job, per the ticket's own scoping).
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from temporalio.client import Client
from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from harness.api.endpoints.internal import require_service_token
from harness.core.config import Settings
from harness.core.logging import get_logger
from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.interpreter.models import RunSubject, sanitize_run_payload

logger = get_logger(__name__)

router = APIRouter(tags=["workflow-interpreter"])


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


async def _temporal_client_or_503(request: Request) -> Client:
    """Lazily connect (cached on ``app.state``, same pattern as ``internal.py``), but convert a
    connect failure into an explicit 503 rather than letting it propagate as a generic 500 or —
    worse — being swallowed into a false-success response. Per the ticket's infrastructure
    caveat : "every interpreter run must fail *visibly* when Temporal is unreachable
    — never a success log with no run."
    """
    client = getattr(request.app.state, "temporal_client", None)
    if client is not None:
        return cast(Client, client)
    from harness.temporal.client import get_temporal_client

    try:
        client = await get_temporal_client(_settings(request))
    except Exception as exc:  # noqa: BLE001 — must surface as a visible 503, never 500/202
        logger.warning("harness.interpreter.temporal_unreachable", error=str(exc))
        raise HTTPException(status_code=503, detail="temporal unreachable") from exc
    request.app.state.temporal_client = client
    return client


def _rpc_error_response(exc: RPCError, *, action: str) -> HTTPException:
    if exc.status == RPCStatusCode.NOT_FOUND:
        return HTTPException(status_code=404, detail="workflow run not found")
    logger.warning("harness.interpreter.temporal_rpc_error", action=action, error=str(exc))
    return HTTPException(status_code=502, detail=f"temporal error ({action}): {exc}")


class StartWorkflowRunRequest(BaseModel):
    """Body for ``POST /workflow-runs:start``.

    ``config_ref`` is a pre-minted :class:`ClaimCheckRef` to the version's ``compiledConfig`` —
    this endpoint never accepts a raw compiled config or a graph; producing/storing the ref is
    the caller's ( gateway controller, or Workbench sandbox controller) job.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    run_id: str = Field(alias="runId")
    session_id: str = Field(alias="sessionId")
    workflow_version_id: str = Field(alias="workflowVersionId")
    tenant_id: str = Field(alias="tenantId")
    config_ref: ClaimCheckRef = Field(alias="configRef")
    sandbox: bool = Field(default=False)
    # Additive-optional ( Workbench, closing the gap `InterpreterInput.payload`'s own
    # docstring named): the raw invocation/test payload. NO LONGER forwarded verbatim — as of
    # lane A it is passed through `sanitize_run_payload`, which removes every
    # `RESERVED_RUN_IDENTITY_KEYS` entry before the workflow starts. Never required — a real
    # (non-sandbox) exposure-plane invoke may still omit it and get `{}`.
    payload: dict[str, Any] = Field(default_factory=dict)
    # lane A. The run's SERVER-RESOLVED clinical subject, on its own channel so a
    # caller-composed `payload` cannot impersonate one. See `RunSubject` for why this is a
    # separate field rather than a convention about `payload`'s contents.
    subject: RunSubject | None = Field(default=None)


@router.post(
    "/workflow-runs:start",
    dependencies=[Depends(require_service_token)],
)
async def start_workflow_run(body: StartWorkflowRunRequest, request: Request) -> dict[str, Any]:
    """Start (idempotently, by workflow-id collision) a WorkflowInterpreter run."""
    from harness.temporal.interpreter.models import InterpreterInput
    from harness.temporal.interpreter.workflow import WorkflowInterpreter, interpreter_workflow_id

    settings = _settings(request)
    client = await _temporal_client_or_503(request)
    workflow_id = interpreter_workflow_id(body.run_id)

    wf_input = InterpreterInput(
        session_id=body.session_id,
        workflow_version_id=body.workflow_version_id,
        config_ref=body.config_ref,
        tenant_id=body.tenant_id,
        run_id=body.run_id,
        sandbox=body.sandbox,
        # lane A (C-8 link 1). The caller's payload is stripped of every
        # `RESERVED_RUN_IDENTITY_KEYS` entry and the SERVER-resolved subject is stamped in its
        # place. Unconditional: no branch on sandbox, palette or caller — a strip with a branch
        # is a strip somebody eventually reasons their way around.
        payload=sanitize_run_payload(body.payload, body.subject),
        subject=body.subject,
    )

    started_flag: bool | None = None
    try:
        handle = await client.start_workflow(
            WorkflowInterpreter.run,
            wf_input,
            id=workflow_id,
            task_queue=settings.temporal.task_queue,
            # lane A step 6 — the two policies that make a RETRY join rather than
            # double-bill, and they cover DIFFERENT cases:
            #   * `USE_EXISTING` — the prior execution is still RUNNING. Temporal returns a
            #     handle to it instead of raising, so a retried webhook attaches to the run
            #     already in flight.
            #   * `REJECT_DUPLICATE` — the prior execution has CLOSED. This is the case the
            #     previous `WorkflowAlreadyStartedError` catch could not cover: Temporal's
            #     DEFAULT reuse policy is `ALLOW_DUPLICATE`, so a webhook retried after the run
            #     finished started a SECOND, separately-billed execution under the same id and
            #     reported it as a fresh start. It now raises, and is reported as a join.
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
        )
        # `USE_EXISTING` does NOT raise when it joins — the distinction rides on the start
        # response's `started` flag. Read defensively: a client stub (or a server too old to set
        # the field) leaves it unknown, and "assume started" is the honest default there, since
        # `REJECT_DUPLICATE` already turns every closed-run duplicate into the exception path.
        start_response = getattr(handle, "_start_workflow_response", None)
        started_flag = getattr(start_response, "started", None)
        status = "started" if started_flag is not False else "already_running"
    except WorkflowAlreadyStartedError:
        # A CLOSED prior execution under this workflow id (`REJECT_DUPLICATE`), or a server that
        # does not honour the conflict policy. Either way: return the existing run, HTTP 200,
        # never a second execution.
        status = "already_running"

    handle = client.get_workflow_handle(workflow_id)
    try:
        description = await handle.describe()
        temporal_run_id = description.run_id
    except RPCError as exc:  # pragma: no cover - defensive: describe right after start
        raise _rpc_error_response(exc, action="describe-after-start") from exc

    logger.info(
        "harness.interpreter.run.start",
        run_id=body.run_id,
        workflow_id=workflow_id,
        status=status,
    )
    return {
        "runId": body.run_id,
        "workflowId": workflow_id,
        "temporalRunId": temporal_run_id,
        "status": status,
    }


@router.get(
    "/workflow-runs/{run_id}",
    dependencies=[Depends(require_service_token)],
)
async def get_workflow_run(run_id: str, request: Request) -> dict[str, Any]:
    """Status/result read surface: Temporal ``describe()`` + the ``state`` query."""
    from harness.temporal.interpreter.workflow import WorkflowInterpreter, interpreter_workflow_id

    client = await _temporal_client_or_503(request)
    workflow_id = interpreter_workflow_id(run_id)
    handle = client.get_workflow_handle(workflow_id)

    try:
        description = await handle.describe()
    except RPCError as exc:
        raise _rpc_error_response(exc, action="describe") from exc

    stages_payload: list[dict[str, Any]] = []
    status = description.status.name if description.status else "UNKNOWN"
    try:
        state = await handle.query(WorkflowInterpreter.state)
        stages_payload = [s.model_dump(mode="json") for s in state.stages]
        status = state.status
    except Exception as exc:  # noqa: BLE001 — the query is best-effort once the run has closed
        logger.info(
            "harness.interpreter.run.state_query_unavailable", run_id=run_id, error=str(exc)
        )

    return {
        "runId": run_id,
        "status": status,
        "stages": stages_payload,
        "startedAt": description.start_time.isoformat() if description.start_time else None,
        "endedAt": description.close_time.isoformat() if description.close_time else None,
    }


@router.get(
    "/workflow-runs/{run_id}/gate",
    dependencies=[Depends(require_service_token)],
)
async def get_workflow_run_gate(run_id: str, request: Request) -> dict[str, Any]:
    """Live state of the run's HITL gate, read from the CHILD workflow.

    Answers the one question a caller needs before offering a clinician an Approve action: is
    this run actually parked on a human right now? `WorkflowRunStatus` cannot answer it — a run
    waiting at the gate and a run busy generating text are both `RUNNING` — and a projection
    would be a second source of truth for a decision boundary. So this reads the child's own
    `state` query, which is the truth by construction.

    `waiting: false` with `exists: false` is the normal answer for every run that has no gate
    (every summarization/stt run, and any consultation run that has not reached its gate yet):
    a plain 200, not an error, because "no gate here" is not a failure.
    """
    from temporalio.service import RPCStatusCode

    from harness.temporal.interpreter.gate_workflow import (
        ConsultationGateWorkflow,
        gate_workflow_id,
    )

    client = await _temporal_client_or_503(request)
    workflow_id = gate_workflow_id(run_id)

    try:
        state = await client.get_workflow_handle(workflow_id).query(ConsultationGateWorkflow.state)
    except RPCError as exc:
        if exc.status in (RPCStatusCode.NOT_FOUND, RPCStatusCode.FAILED_PRECONDITION):
            return {"runId": run_id, "workflowId": workflow_id, "exists": False, "waiting": False}
        raise _rpc_error_response(exc, action="gate-state") from exc

    phase = state.get("phase")
    return {
        "runId": run_id,
        "workflowId": workflow_id,
        "exists": True,
        # Only the GATE phase is a live human wait. RECORD/DONE/ABANDONED are all terminal-ish
        # and must never render an Approve action — approving a decided gate is a no-op at best
        # and a misleading affordance at worst.
        "waiting": phase == "GATE" and not state.get("approved", False),
        "phase": phase,
        "escalations": state.get("escalations", 0),
        "approved": state.get("approved", False),
    }


class GateApprovalRequest(BaseModel):
    """Body for ``:approve`` (camelCase at the apps/api boundary), mirroring the existing
    ``/workflows/{id}/signal/approve`` body for the legacy document workflow."""

    model_config = ConfigDict(populate_by_name=True)

    decision: str | None = None
    clinician_id: str | None = Field(default=None, alias="clinicianId")
    context_item_version_id: str | None = Field(default=None, alias="contextItemVersionId")
    attestation_hash: str | None = Field(default=None, alias="attestationHash")
    tenant_id: str | None = Field(default=None, alias="tenantId")


@router.post(
    "/workflow-runs/{run_id}:approve",
    dependencies=[Depends(require_service_token)],
)
async def approve_workflow_run_gate(
    run_id: str, body: GateApprovalRequest, request: Request
) -> dict[str, Any]:
    """Release the run's HITL gate with a clinician decision.

    Signals the GATE CHILD workflow, not the interpreter: the interpreter's own signal surface
    is deliberately cancel-only, and the durable wait lives in
    ``ConsultationGateWorkflow`` — see its module docstring. The child id is derived from the run
    id alone (`gate_workflow_id`), which is what lets this route address it without reading run
    state. Like ``:cancel``, the signal is a code allow-list, never a caller-supplied
    ``signalName`` (F-09).

    A run with no gate, or one whose gate already completed, surfaces the Temporal RPC error
    through ``_rpc_error_response`` rather than reporting a sign-off that did not happen.
    """
    from harness.temporal.interpreter.gate_workflow import (
        ConsultationGateWorkflow,
        gate_workflow_id,
    )
    from harness.temporal.interpreter.models import GateApprovalSignal

    client = await _temporal_client_or_503(request)
    workflow_id = gate_workflow_id(run_id)
    handle = client.get_workflow_handle(workflow_id)

    try:
        await handle.signal(
            ConsultationGateWorkflow.approval,
            GateApprovalSignal(
                decision=body.decision,
                clinician_id=body.clinician_id,
                context_item_version_id=body.context_item_version_id,
                attestation_hash=body.attestation_hash,
                tenant_id=body.tenant_id,
            ),
        )
    except RPCError as exc:
        raise _rpc_error_response(exc, action="approve") from exc

    logger.info(
        "harness.interpreter.run.gate_approved",
        run_id=run_id,
        workflow_id=workflow_id,
        decision=body.decision,
    )
    return {"runId": run_id, "workflowId": workflow_id, "signaled": True}


@router.post(
    "/workflow-runs/{run_id}:cancel",
    dependencies=[Depends(require_service_token)],
)
async def cancel_workflow_run(run_id: str, request: Request) -> dict[str, Any]:
    """Send the ``cancel`` signal — a code allow-list, never a caller-supplied ``signalName``
    (F-09, orchestration.md, is the anti-pattern this must not repeat)."""
    from harness.temporal.interpreter.models import CancelSignal
    from harness.temporal.interpreter.workflow import WorkflowInterpreter, interpreter_workflow_id

    client = await _temporal_client_or_503(request)
    workflow_id = interpreter_workflow_id(run_id)
    handle = client.get_workflow_handle(workflow_id)

    try:
        await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="api-cancel"))
    except RPCError as exc:
        raise _rpc_error_response(exc, action="cancel") from exc

    logger.info("harness.interpreter.run.cancel_requested", run_id=run_id)
    return {"runId": run_id, "status": "cancel_requested"}
