"""Admin workflow-ops endpoint tests (RED-first, TASK-330 Phase 6 — Phase B).

The apps/api ``HarnessOpsClient`` calls these EXACT paths/shapes under
``/api/v1/internal/harness``. A fake Temporal client (no server, no network)
drives the orchestration: list (+ tenant filter + search-attribute-unavailable
memo fallback), describe (+ phase + not-found), and the cancel / terminate /
signal action acknowledgements. The service-token guard is reused from the
internal endpoints.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from temporalio.client import WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from harness.core.config import Settings
from harness.main import create_app

_BASE = "/api/v1/internal/harness"


class _FakeTypedSA:
    """Stand-in ``TypedSearchAttributes``: returns the tenant for the keyword key."""

    def __init__(self, tenant: str | None) -> None:
        self._tenant = tenant

    def get(self, key: Any, default: Any = None) -> Any:
        if getattr(key, "name", None) == "HarnessTenantId" and self._tenant is not None:
            return self._tenant
        return default


class _FakeExecution:
    def __init__(
        self,
        *,
        wid: str,
        run_id: str = "run-1",
        status: WorkflowExecutionStatus = WorkflowExecutionStatus.RUNNING,
        sa_tenant: str | None = None,
        memo_tenant: str | None = None,
        history_length: int = 7,
        close: datetime | None = None,
    ) -> None:
        self.id = wid
        self.run_id = run_id
        self.status = status
        self.typed_search_attributes = _FakeTypedSA(sa_tenant)
        self._memo_tenant = memo_tenant
        self.history_length = history_length
        self.start_time = datetime(2026, 6, 7, 12, 0, tzinfo=UTC)
        self.close_time = close
        self.raw_description = SimpleNamespace(pending_activities=[])

    async def memo(self) -> dict[str, Any]:
        return {"tenantId": self._memo_tenant} if self._memo_tenant is not None else {}


class _FakeIterator:
    def __init__(self, page: list[_FakeExecution], token: bytes | None) -> None:
        self.current_page = page
        self.next_page_token = token

    async def fetch_next_page(self) -> None:
        return None


class _RaisingIterator:
    async def fetch_next_page(self) -> None:
        raise RPCError(
            "search attribute HarnessTenantId is not registered",
            RPCStatusCode.INVALID_ARGUMENT,
            b"",
        )


class _FakeHandle:
    def __init__(self, client: _FakeClient, wid: str) -> None:
        self._client = client
        self.id = wid

    async def describe(self) -> _FakeExecution:
        if self.id not in self._client.descriptions:
            raise RPCError("workflow not found", RPCStatusCode.NOT_FOUND, b"")
        return self._client.descriptions[self.id]

    async def cancel(self, **kw: Any) -> None:
        self._client.actions.append(("cancel", self.id, kw))

    async def terminate(self, *args: Any, reason: str | None = None, **kw: Any) -> None:
        self._client.actions.append(("terminate", self.id, reason))

    async def signal(self, signal: Any, arg: Any = None, **kw: Any) -> None:
        self._client.actions.append(("signal", self.id, signal, arg))

    async def query(self, query: Any, *a: Any, **kw: Any) -> Any:
        return self._client.phases.get(self.id)


class _FakeClient:
    def __init__(self) -> None:
        self.executions: list[_FakeExecution] = []
        self.next_token: bytes | None = None
        self.descriptions: dict[str, _FakeExecution] = {}
        self.phases: dict[str, str] = {}
        self.actions: list[tuple] = []
        self.list_queries: list[dict[str, Any]] = []
        self.raise_on_sa = False

    def list_workflows(
        self, query: str = "", *, page_size: int = 1000, next_page_token: bytes | None = None, **kw: Any
    ):
        self.list_queries.append(
            {"query": query, "page_size": page_size, "next_page_token": next_page_token}
        )
        if self.raise_on_sa and "HarnessTenantId" in query:
            return _RaisingIterator()
        return _FakeIterator(list(self.executions), self.next_token)

    def get_workflow_handle(self, workflow_id: str, **kw: Any) -> _FakeHandle:
        return _FakeHandle(self, workflow_id)


def _settings(token: str = "") -> Settings:
    return Settings(service_token=SecretStr(token), log_level="debug")


@pytest_asyncio.fixture
async def admin_app() -> AsyncGenerator[tuple[AsyncClient, _FakeClient], None]:
    app = create_app(settings_override=_settings())
    client = _FakeClient()
    app.state.temporal_client = client
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, client


class TestListWorkflows:
    @pytest.mark.asyncio
    async def test_returns_mapped_items_and_next_page_token(self, admin_app):
        http, client = admin_app
        client.executions = [
            _FakeExecution(wid="harness-doc-c-1", run_id="r-1", sa_tenant="t-1"),
            _FakeExecution(
                wid="harness-doc-c-2",
                run_id="r-2",
                status=WorkflowExecutionStatus.COMPLETED,
                sa_tenant="t-2",
                close=datetime(2026, 6, 7, 13, 0, tzinfo=UTC),
            ),
        ]
        client.next_token = b"page-2-token"

        resp = await http.get(f"{_BASE}/workflows", params={"limit": 25})
        assert resp.status_code == 200
        data = resp.json()
        assert client.list_queries[0]["page_size"] == 25
        assert [i["workflowId"] for i in data["items"]] == ["harness-doc-c-1", "harness-doc-c-2"]
        first = data["items"][0]
        assert first["runId"] == "r-1"
        assert first["consultationId"] == "c-1"
        assert first["tenantId"] == "t-1"
        assert first["status"] == "RUNNING"
        assert first["startedAt"] == "2026-06-07T12:00:00+00:00"
        assert first["closeTime"] is None
        assert data["items"][1]["status"] == "COMPLETED"
        assert data["items"][1]["closeTime"] == "2026-06-07T13:00:00+00:00"
        # Cursor token round-trips as a base64 string.
        assert data["nextPageToken"] == base64.b64encode(b"page-2-token").decode()

    @pytest.mark.asyncio
    async def test_empty_next_page_token_is_null(self, admin_app):
        http, client = admin_app
        client.executions = [_FakeExecution(wid="harness-doc-c-1", sa_tenant="t-1")]
        client.next_token = b""
        resp = await http.get(f"{_BASE}/workflows")
        assert resp.json()["nextPageToken"] is None

    @pytest.mark.asyncio
    async def test_status_and_consultation_filters_build_visibility_query(self, admin_app):
        http, client = admin_app
        await http.get(f"{_BASE}/workflows", params={"status": "RUNNING", "consultationId": "c-9"})
        query = client.list_queries[0]["query"]
        assert 'ExecutionStatus = "Running"' in query
        assert 'WorkflowId = "harness-doc-c-9"' in query

    @pytest.mark.asyncio
    async def test_tenant_filter_uses_search_attribute(self, admin_app):
        http, client = admin_app
        client.executions = [_FakeExecution(wid="harness-doc-c-1", sa_tenant="t-1")]
        await http.get(f"{_BASE}/workflows", params={"tenantId": "t-1"})
        assert 'HarnessTenantId = "t-1"' in client.list_queries[0]["query"]

    @pytest.mark.asyncio
    async def test_search_attribute_unavailable_falls_back_to_memo_filter(self, admin_app):
        http, client = admin_app
        client.raise_on_sa = True
        # SA not registered: tenant is only on the memo. Only t-1's workflow is kept.
        client.executions = [
            _FakeExecution(wid="harness-doc-c-1", run_id="r-1", memo_tenant="t-1"),
            _FakeExecution(wid="harness-doc-c-2", run_id="r-2", memo_tenant="t-2"),
        ]
        resp = await http.get(f"{_BASE}/workflows", params={"tenantId": "t-1"})
        assert resp.status_code == 200
        data = resp.json()
        assert [i["workflowId"] for i in data["items"]] == ["harness-doc-c-1"]
        assert data["items"][0]["tenantId"] == "t-1"
        # It retried without the unregistered search attribute (>= 2 list calls).
        assert len(client.list_queries) >= 2
        assert "HarnessTenantId" not in client.list_queries[-1]["query"]


class TestDescribeWorkflow:
    @pytest.mark.asyncio
    async def test_describe_returns_detail_with_phase(self, admin_app):
        http, client = admin_app
        client.descriptions["harness-doc-c-1"] = _FakeExecution(
            wid="harness-doc-c-1", run_id="r-1", sa_tenant="t-1", history_length=42
        )
        client.phases["harness-doc-c-1"] = "GATE"

        resp = await http.get(f"{_BASE}/workflows/harness-doc-c-1", params={"phase": "true"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["workflowId"] == "harness-doc-c-1"
        assert data["runId"] == "r-1"
        assert data["consultationId"] == "c-1"
        assert data["tenantId"] == "t-1"
        assert data["status"] == "RUNNING"
        assert data["historyLength"] == 42
        assert data["pendingActivities"] == []
        assert data["phase"] == "GATE"

    @pytest.mark.asyncio
    async def test_describe_without_phase_flag_does_not_query(self, admin_app):
        http, client = admin_app
        client.descriptions["harness-doc-c-1"] = _FakeExecution(wid="harness-doc-c-1", sa_tenant="t-1")
        client.phases["harness-doc-c-1"] = "GATE"
        resp = await http.get(f"{_BASE}/workflows/harness-doc-c-1")
        assert resp.status_code == 200
        assert resp.json()["phase"] is None

    @pytest.mark.asyncio
    async def test_describe_missing_workflow_returns_404(self, admin_app):
        http, _client = admin_app
        resp = await http.get(f"{_BASE}/workflows/harness-doc-missing")
        assert resp.status_code == 404


class TestWorkflowActions:
    @pytest.mark.asyncio
    async def test_cancel_requests_and_acknowledges(self, admin_app):
        http, client = admin_app
        client.descriptions["harness-doc-c-1"] = _FakeExecution(
            wid="harness-doc-c-1", run_id="r-1", status=WorkflowExecutionStatus.CANCELED
        )
        resp = await http.post(
            f"{_BASE}/workflows/harness-doc-c-1/cancel", json={"tenantId": "t-1", "reason": "mistake"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data == {
            "workflowId": "harness-doc-c-1",
            "runId": "r-1",
            "status": "CANCELED",
            "action": "cancel",
            "requested": True,
        }
        assert client.actions[0][0] == "cancel"

    @pytest.mark.asyncio
    async def test_terminate_passes_reason(self, admin_app):
        http, client = admin_app
        client.descriptions["harness-doc-c-1"] = _FakeExecution(
            wid="harness-doc-c-1", run_id="r-1", status=WorkflowExecutionStatus.TERMINATED
        )
        resp = await http.post(
            f"{_BASE}/workflows/harness-doc-c-1/terminate", json={"reason": "abort"}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["action"] == "terminate"
        assert data["status"] == "TERMINATED"
        assert data["requested"] is True
        assert client.actions[0] == ("terminate", "harness-doc-c-1", "abort")

    @pytest.mark.asyncio
    async def test_signal_forwards_name_and_payload(self, admin_app):
        http, client = admin_app
        client.descriptions["harness-doc-c-1"] = _FakeExecution(wid="harness-doc-c-1", run_id="r-1")
        resp = await http.post(
            f"{_BASE}/workflows/harness-doc-c-1/signal",
            json={"tenantId": "t-1", "signalName": "approve", "payload": {"decision": "SIGNED"}},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["action"] == "signal"
        assert data["requested"] is True
        assert client.actions[0] == ("signal", "harness-doc-c-1", "approve", {"decision": "SIGNED"})

    @pytest.mark.asyncio
    async def test_action_tolerates_describe_failure(self, admin_app):
        http, client = admin_app
        # No description registered -> the post-action describe fails; the endpoint
        # still acknowledges the request (runId null) rather than 500-ing.
        resp = await http.post(f"{_BASE}/workflows/harness-doc-c-1/cancel", json={})
        assert resp.status_code == 200
        data = resp.json()
        assert data["requested"] is True
        assert data["runId"] is None


class TestAuth:
    @pytest.mark.asyncio
    async def test_rejects_missing_or_bad_token(self, monkeypatch):
        app = create_app(settings_override=_settings(token="secret"))
        app.state.temporal_client = _FakeClient()
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            missing = await http.get(f"{_BASE}/workflows")
            bad = await http.get(f"{_BASE}/workflows", headers={"X-Service-Token": "nope"})
            ok = await http.get(f"{_BASE}/workflows", headers={"X-Service-Token": "secret"})
        assert missing.status_code == 401
        assert bad.status_code == 401
        assert ok.status_code == 200
