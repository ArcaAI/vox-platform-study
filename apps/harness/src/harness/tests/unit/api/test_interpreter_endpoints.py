"""Dispatcher API tests (Task 10) — the start/status/cancel HTTP surface for WorkflowInterpreter.

Same mocking pattern as test_internal_endpoints.py: the Temporal client is a MagicMock injected
on app.state, so these tests assert pure wiring — no live Temporal server.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from harness.core.config import Settings
from harness.main import create_app

_TOKEN = "shared-secret"
_HEADERS = {"X-Service-Token": _TOKEN}
_BASE = "/api/v1/internal"

_CONFIG_REF = {
    "store": "memory",
    "bucket": "harness-claim-check",
    "key": "abc123",
    "size": 10,
    "sha256": "0" * 64,
    "content_type": "text/plain; charset=utf-8",
}


def _start_body(**overrides) -> dict:
    body = {
        "runId": "run-1",
        "sessionId": "s-1",
        "workflowVersionId": "v-1",
        "tenantId": "t-1",
        "configRef": _CONFIG_REF,
        "sandbox": False,
    }
    body.update(overrides)
    return body


def _build():
    settings = Settings(service_token=SecretStr(_TOKEN), log_level="debug")
    app = create_app(settings_override=settings)

    handle = MagicMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(
            run_id="temporal-run-1",
            status=SimpleNamespace(name="RUNNING"),
            start_time=datetime(2026, 8, 16, 0, 0, tzinfo=UTC),
            close_time=None,
        )
    )
    handle.signal = AsyncMock()
    handle.query = AsyncMock(
        return_value=SimpleNamespace(run_id="run-1", status="RUNNING", stages=[])
    )

    client = MagicMock()
    client.start_workflow = AsyncMock()
    client.get_workflow_handle = MagicMock(return_value=handle)
    app.state.temporal_client = client
    return app, client, handle, settings


@pytest_asyncio.fixture
async def harness() -> AsyncGenerator[tuple, None]:
    app, client, handle, settings = _build()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, client, handle, settings


class TestStartWorkflowRun:
    @pytest.mark.asyncio
    async def test_starts_with_deterministic_workflow_id_and_task_queue(self, harness):
        http, client, _handle, settings = harness
        resp = await http.post(
            f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body()
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["runId"] == "run-1"
        assert body["workflowId"] == "workflow-interpreter-run-1"
        assert body["temporalRunId"] == "temporal-run-1"
        assert body["status"] == "started"

        client.start_workflow.assert_awaited_once()
        args, kwargs = client.start_workflow.call_args
        wf_input = args[1]
        assert kwargs["id"] == "workflow-interpreter-run-1"
        assert kwargs["task_queue"] == settings.temporal.task_queue
        assert wf_input.session_id == "s-1"
        assert wf_input.tenant_id == "t-1"
        assert wf_input.sandbox is False

    @pytest.mark.asyncio
    async def test_duplicate_start_returns_existing_run_not_a_second_execution(self, harness):
        http, client, _handle, _settings = harness
        client.start_workflow = AsyncMock(side_effect=WorkflowAlreadyStartedError("x", "y"))

        resp = await http.post(
            f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body()
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "already_running"
        assert body["temporalRunId"] == "temporal-run-1"

    @pytest.mark.asyncio
    async def test_temporal_unreachable_returns_503_never_a_false_success(self):
        import unittest.mock as mock

        settings = Settings(service_token=SecretStr(_TOKEN), log_level="debug")
        app = create_app(settings_override=settings)
        app.state.temporal_client = None  # forces the lazy-connect path

        transport = ASGITransport(app=app)
        with mock.patch(
            "harness.temporal.client.get_temporal_client",
            new=AsyncMock(side_effect=RuntimeError("connection refused")),
        ):
            async with AsyncClient(transport=transport, base_url="http://test") as http:
                resp = await http.post(
                    f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body()
                )
        assert resp.status_code == 503


class TestGetWorkflowRun:
    @pytest.mark.asyncio
    async def test_returns_status_and_state_query_shape(self, harness):
        http, _client, handle, _settings = harness
        handle.query = AsyncMock(
            return_value=SimpleNamespace(
                run_id="run-1",
                status="SUCCEEDED",
                stages=[SimpleNamespace(model_dump=lambda mode: {"stageIndex": 0, "nodes": []})],
            )
        )
        resp = await http.get(f"{_BASE}/workflow-runs/run-1", headers=_HEADERS)
        assert resp.status_code == 200
        body = resp.json()
        assert body["runId"] == "run-1"
        assert body["status"] == "SUCCEEDED"
        assert body["stages"] == [{"stageIndex": 0, "nodes": []}]

    @pytest.mark.asyncio
    async def test_not_found_returns_404(self, harness):
        http, _client, handle, _settings = harness
        handle.describe = AsyncMock(
            side_effect=RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
        )
        resp = await http.get(f"{_BASE}/workflow-runs/does-not-exist", headers=_HEADERS)
        assert resp.status_code == 404


class TestCancelWorkflowRun:
    @pytest.mark.asyncio
    async def test_cancel_sends_the_allow_listed_signal_only(self, harness):
        http, _client, handle, _settings = harness
        resp = await http.post(f"{_BASE}/workflow-runs/run-1:cancel", headers=_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancel_requested"

        handle.signal.assert_awaited_once()
        args, _kwargs = handle.signal.call_args
        # The FIRST positional arg is the bound signal method reference (WorkflowInterpreter
        # .cancel) — never a caller-supplied string name (F-09 anti-pattern).
        assert args[0].__name__ == "cancel"


class TestAuth:
    @pytest.mark.asyncio
    async def test_missing_token_rejected(self, harness):
        http, _client, _handle, _settings = harness
        resp = await http.post(f"{_BASE}/workflow-runs:start", json=_start_body())
        assert resp.status_code == 401
