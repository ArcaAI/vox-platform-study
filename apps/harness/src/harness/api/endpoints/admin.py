"""Admin workflow-ops endpoints (apps/api → apps/harness).

The OUTBOUND apps/api ``HarnessOpsClient`` is HTTP-only (the Temporal SDK stays
isolated here); these endpoints wrap the Temporal client so platform/tenant
admins can observe and operate the document workflows:

* ``GET  /workflows`` — list (visibility query; cursor-paged).
* ``GET  /workflows/{id}`` — describe (``?phase=true`` also queries the loop phase).
* ``POST /workflows/{id}/cancel`` — request cancellation.
* ``POST /workflows/{id}/terminate`` — terminate (with a reason).
* ``POST /workflows/{id}/signal`` — forward an arbitrary signal.

With the ``/api/v1/internal`` mount the effective prefix is
``/api/v1/internal/harness`` — the exact paths the ``HarnessOpsClient`` calls.
All routes are guarded by the shared ``HARNESS_SERVICE_TOKEN`` (reusing
``require_service_token``). Tenant ownership is enforced by apps/api; the harness
surfaces ``tenantId`` (from the ``HarnessTenantId`` search attribute, else the
memo) and filters list results to a requested tenant.

Fail-safe: a missing/closed workflow yields 404; a custom-search-attribute
outage degrades to a memo + client-side tenant filter (it never 500s the list).
"""

from __future__ import annotations

import base64
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from google.protobuf.json_format import MessageToDict
from pydantic import BaseModel, ConfigDict, Field
from temporalio.service import RPCError, RPCStatusCode

from harness.api.endpoints.internal import (
    HARNESS_TENANT_ID_ATTR,
    HARNESS_TENANT_ID_KEY,
    _temporal_client,
    require_service_token,
)
from harness.core.logging import get_logger
from harness.temporal.workflow_ids import DOC_WORKFLOW_ID_PREFIX

logger = get_logger(__name__)

router = APIRouter(tags=["admin"])

# The deterministic workflow-id scheme (``harness-doc-{consultationId}``) — used to
# recover the consultation id from a workflow id and to target a single workflow.
# Read from the leaf module that now owns the three prefixes (TASK-957).
_WORKFLOW_ID_PREFIX = DOC_WORKFLOW_ID_PREFIX

# Memo key (fallback when the ``HarnessTenantId`` search attribute is unavailable).
# The search-attribute name/key are shared with ``internal.start_document``.
_TENANT_MEMO_KEY = "tenantId"

_DEFAULT_PAGE_SIZE = 50

# Contract status (uppercase, enum-name) -> Temporal visibility status keyword.
_VISIBILITY_STATUS = {
    "RUNNING": "Running",
    "COMPLETED": "Completed",
    "FAILED": "Failed",
    "CANCELED": "Canceled",
    "TERMINATED": "Terminated",
    "TIMED_OUT": "TimedOut",
    "CONTINUED_AS_NEW": "ContinuedAsNew",
}


class WorkflowActionRequest(BaseModel):
    """Body for ``cancel`` / ``terminate`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str | None = Field(default=None, alias="tenantId")
    reason: str | None = None


class WorkflowSignalRequest(BaseModel):
    """Body for ``signal`` (camelCase at the apps/api boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str | None = Field(default=None, alias="tenantId")
    signal_name: str = Field(alias="signalName")
    payload: Any | None = None


# ---------------------------------------------------------------------------
# Mapping helpers (Temporal execution -> the camelCase admin contract)
# ---------------------------------------------------------------------------


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _consultation_id(workflow_id: str) -> str | None:
    if workflow_id.startswith(_WORKFLOW_ID_PREFIX):
        return workflow_id[len(_WORKFLOW_ID_PREFIX) :]
    return None


def _status_name(execution: Any) -> str:
    status = getattr(execution, "status", None)
    return status.name if status is not None else "UNKNOWN"


def _tenant_from_sa(execution: Any) -> str | None:
    try:
        return cast("str | None", execution.typed_search_attributes.get(HARNESS_TENANT_ID_KEY))
    except Exception:  # noqa: BLE001 — search attribute may be unavailable; degrade
        return None


async def _resolve_tenant(execution: Any) -> str | None:
    """Owning tenant: the ``HarnessTenantId`` search attribute, else the memo."""
    sa_tenant = _tenant_from_sa(execution)
    if sa_tenant:
        return sa_tenant
    try:
        memo = await execution.memo()
    except Exception:  # noqa: BLE001 — memo decode is best-effort
        return None
    if isinstance(memo, dict):
        value = memo.get(_TENANT_MEMO_KEY)
        return str(value) if value is not None else None
    return None


def _summary(execution: Any, tenant_id: str | None, *, phase: str | None = None) -> dict[str, Any]:
    """Project a Temporal execution onto the ``HarnessWorkflowSummary`` shape."""
    return {
        "workflowId": execution.id,
        "runId": getattr(execution, "run_id", None) or None,
        "consultationId": _consultation_id(execution.id),
        "tenantId": tenant_id,
        "status": _status_name(execution),
        "phase": phase,
        "startedAt": _iso(getattr(execution, "start_time", None)),
        "closeTime": _iso(getattr(execution, "close_time", None)),
        # Not available from visibility — populated by the UI from the detail/result.
        "regenCount": None,
        "escalations": None,
        "slaSeconds": None,
    }


def _pending_activities(description: Any) -> list[dict[str, Any]] | None:
    raw = getattr(getattr(description, "raw_description", None), "pending_activities", None)
    if raw is None:
        return None
    out: list[dict[str, Any]] = []
    for pa in raw:
        try:
            out.append(MessageToDict(pa))
        except Exception:  # noqa: BLE001 — best-effort proto -> dict
            continue
    return out


async def _safe_memo(description: Any) -> dict[str, Any] | None:
    try:
        memo = await description.memo()
    except Exception:  # noqa: BLE001
        return None
    return memo if isinstance(memo, dict) else None


def _search_attributes(tenant_id: str | None) -> dict[str, Any] | None:
    return {HARNESS_TENANT_ID_ATTR: tenant_id} if tenant_id else None


async def _safe_phase(handle: Any) -> str | None:
    """Best-effort ``HarnessDocWorkflow.phase`` query (tolerate closed/not-found)."""
    try:
        return cast("str | None", await handle.query("phase"))
    except Exception:  # noqa: BLE001 — closed/missing workflow has no live query
        return None


async def _result_value(handle: Any, description: Any) -> Any | None:
    """The terminal workflow result for a COMPLETED workflow (best-effort, else None)."""
    if _status_name(description) != "COMPLETED":
        return None
    try:
        result = await handle.result()
    except Exception:  # noqa: BLE001 — closed-but-failed / not-fetchable
        return None
    if hasattr(result, "model_dump"):
        return result.model_dump(mode="json")
    return result


def _decode_token(page_token: str | None) -> bytes | None:
    if not page_token:
        return None
    try:
        return base64.b64decode(page_token)
    except Exception:  # noqa: BLE001 — a malformed cursor restarts from the first page
        logger.warning("harness.admin.list.bad_page_token")
        return None


def _encode_token(token: bytes | None) -> str | None:
    # Temporal returns empty bytes when there are no more pages.
    return base64.b64encode(token).decode() if token else None


def _build_query(status: str | None, consultation_id: str | None, tenant_id: str | None) -> str:
    clauses: list[str] = []
    if status:
        visibility = _VISIBILITY_STATUS.get(status.upper())
        if visibility:
            clauses.append(f'ExecutionStatus = "{visibility}"')
    if consultation_id:
        clauses.append(f'WorkflowId = "{_WORKFLOW_ID_PREFIX}{consultation_id}"')
    if tenant_id:
        clauses.append(f'{HARNESS_TENANT_ID_ATTR} = "{tenant_id}"')
    return " AND ".join(clauses)


async def _list_page(
    client: Any, query: str, page_size: int, token: bytes | None
) -> tuple[list[Any], bytes | None]:
    iterator = client.list_workflows(query, page_size=page_size, next_page_token=token)
    await iterator.fetch_next_page()
    return list(iterator.current_page or []), iterator.next_page_token


def _upstream_error(exc: RPCError, action: str) -> HTTPException:
    logger.warning("harness.admin.temporal_error", action=action, error=str(exc))
    return HTTPException(status_code=502, detail=f"temporal error ({action}): {exc}")


async def _action_ack(client: Any, workflow_id: str, action: str) -> dict[str, Any]:
    """Acknowledge a requested action, best-effort enriching it with runId + status."""
    run_id: str | None = None
    status = "UNKNOWN"
    try:
        description = await client.get_workflow_handle(workflow_id).describe()
        run_id = getattr(description, "run_id", None) or None
        status = _status_name(description)
    except Exception:  # noqa: BLE001 — the action is already requested; status is best-effort
        logger.info("harness.admin.action.describe_unavailable", workflow_id=workflow_id)
    return {
        "workflowId": workflow_id,
        "runId": run_id,
        "status": status,
        "action": action,
        "requested": True,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/workflows", dependencies=[Depends(require_service_token)])
async def list_workflows(
    request: Request,
    tenant_id: str | None = Query(default=None, alias="tenantId"),
    status: str | None = Query(default=None),
    consultation_id: str | None = Query(default=None, alias="consultationId"),
    limit: int = Query(default=_DEFAULT_PAGE_SIZE, ge=1, le=1000),
    page_token: str | None = Query(default=None, alias="pageToken"),
) -> dict[str, Any]:
    """List document workflows (visibility query; cursor-paged via ``nextPageToken``)."""
    client = await _temporal_client(request)
    token = _decode_token(page_token)

    query = _build_query(status, consultation_id, tenant_id)
    client_filter_tenant: str | None = None
    try:
        executions, next_token = await _list_page(client, query, limit, token)
    except RPCError as exc:
        # The custom search attribute is likely not registered. Degrade: re-run the
        # query without it and filter by tenant client-side via the memo.
        if tenant_id is None:
            raise _upstream_error(exc, "list") from exc
        logger.warning("harness.admin.list.search_attribute_unavailable", error=str(exc))
        query = _build_query(status, consultation_id, None)
        executions, next_token = await _list_page(client, query, limit, token)
        client_filter_tenant = tenant_id

    items: list[dict[str, Any]] = []
    for execution in executions:
        tenant = await _resolve_tenant(execution)
        if client_filter_tenant is not None and tenant != client_filter_tenant:
            continue
        items.append(_summary(execution, tenant))

    return {"items": items, "nextPageToken": _encode_token(next_token)}


@router.get("/workflows/{workflow_id}", dependencies=[Depends(require_service_token)])
async def describe_workflow(
    workflow_id: str,
    request: Request,
    phase: bool = Query(default=False),
) -> dict[str, Any]:
    """Describe a single workflow (``?phase=true`` also queries the loop phase)."""
    client = await _temporal_client(request)
    handle = client.get_workflow_handle(workflow_id)
    try:
        description = await handle.describe()
    except RPCError as exc:
        if exc.status == RPCStatusCode.NOT_FOUND:
            raise HTTPException(status_code=404, detail="workflow not found") from exc
        raise _upstream_error(exc, "describe") from exc

    tenant = await _resolve_tenant(description)
    detail = _summary(description, tenant)
    detail.update(
        {
            "historyLength": getattr(description, "history_length", None),
            "pendingActivities": _pending_activities(description),
            "memo": await _safe_memo(description),
            "searchAttributes": _search_attributes(tenant),
            "result": await _result_value(handle, description),
        }
    )
    if phase:
        detail["phase"] = await _safe_phase(handle)
    return detail


@router.post("/workflows/{workflow_id}/cancel", dependencies=[Depends(require_service_token)])
async def cancel_workflow(
    workflow_id: str, body: WorkflowActionRequest, request: Request
) -> dict[str, Any]:
    """Request cancellation of a running workflow (cooperative)."""
    client = await _temporal_client(request)
    await client.get_workflow_handle(workflow_id).cancel()
    logger.info(
        "harness.admin.cancel",
        workflow_id=workflow_id,
        tenant_id=body.tenant_id,
        reason=body.reason,
    )
    return await _action_ack(client, workflow_id, "cancel")


@router.post("/workflows/{workflow_id}/terminate", dependencies=[Depends(require_service_token)])
async def terminate_workflow(
    workflow_id: str, body: WorkflowActionRequest, request: Request
) -> dict[str, Any]:
    """Terminate a workflow immediately (non-cooperative), recording the reason."""
    client = await _temporal_client(request)
    await client.get_workflow_handle(workflow_id).terminate(reason=body.reason)
    logger.info(
        "harness.admin.terminate",
        workflow_id=workflow_id,
        tenant_id=body.tenant_id,
        reason=body.reason,
    )
    return await _action_ack(client, workflow_id, "terminate")


@router.post("/workflows/{workflow_id}/signal", dependencies=[Depends(require_service_token)])
async def signal_workflow(
    workflow_id: str, body: WorkflowSignalRequest, request: Request
) -> dict[str, Any]:
    """Forward an arbitrary signal to a running workflow."""
    client = await _temporal_client(request)
    handle = client.get_workflow_handle(workflow_id)
    if body.payload is not None:
        await handle.signal(body.signal_name, body.payload)
    else:
        await handle.signal(body.signal_name)
    logger.info(
        "harness.admin.signal",
        workflow_id=workflow_id,
        tenant_id=body.tenant_id,
        signal_name=body.signal_name,
    )
    return await _action_ack(client, workflow_id, "signal")
