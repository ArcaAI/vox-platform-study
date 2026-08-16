"""The interpreter's dispatcher API (TASK-718 Task 10) — the single HTTP entry point the
exposure plane (TASK-722) and the Workbench (TASK-721) call to start a WorkflowInterpreter run,
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
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from harness.api.endpoints.internal import require_service_token
from harness.core.config import Settings
from harness.core.logging import get_logger
from harness.temporal.claim_check import ClaimCheckRef

logger = get_logger(__name__)

router = APIRouter(tags=["workflow-interpreter"])


def _settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


async def _temporal_client_or_503(request: Request) -> Client:
    """Lazily connect (cached on ``app.state``, same pattern as ``internal.py``), but convert a
    connect failure into an explicit 503 rather than letting it propagate as a generic 500 or —
    worse — being swallowed into a false-success response. Per the ticket's infrastructure
    caveat (README §2): "every interpreter run must fail *visibly* when Temporal is unreachable
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
    the caller's (eventually TASK-722's gateway controller's) job.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    run_id: str = Field(alias="runId")
    session_id: str = Field(alias="sessionId")
    workflow_version_id: str = Field(alias="workflowVersionId")
    tenant_id: str = Field(alias="tenantId")
    config_ref: ClaimCheckRef = Field(alias="configRef")
    sandbox: bool = Field(default=False)


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
    )

    try:
        await client.start_workflow(
            WorkflowInterpreter.run,
            wf_input,
            id=workflow_id,
            task_queue=settings.temporal.task_queue,
        )
        status = "started"
    except WorkflowAlreadyStartedError:
        # Idempotent: a run already exists for this run id — return it, HTTP 200, never a
        # second execution (ticket §4 Task 10).
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
