"""TASK-850 lane A — the run-identity channel is SEPARATE from the run payload.

Closes link 1 of finding C-8: ``RunIdentity`` (``nodes/_consultation_shared.py``) and
``nodes/consultation.py`` both read ``consultationId`` / ``externalPatientId`` / ``userId``
straight out of ``InterpreterInput.payload``, which the exposure plane forwards VERBATIM from a
caller. Anyone who could compose a payload could therefore name any live consultation.

The fix is structural rather than a check: identity travels on its OWN field (``subject``), and
the dispatcher STRIPS the reserved keys out of ``payload`` before the workflow ever sees them. A
caller-composed payload is then incapable of carrying identity — for every caller of this
dispatcher, not only the gateway.
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


def _handle() -> MagicMock:
    handle = MagicMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(
            run_id="temporal-run-1",
            status=SimpleNamespace(name="RUNNING"),
            start_time=datetime(2026, 8, 16, 0, 0, tzinfo=UTC),
            close_time=None,
        )
    )
    return handle


def _build():
    settings = Settings(service_token=SecretStr(_TOKEN), log_level="debug")
    app = create_app(settings_override=settings)

    client = MagicMock()
    client.start_workflow = AsyncMock()
    client.get_workflow_handle = MagicMock(return_value=_handle())
    app.state.temporal_client = client
    return app, client


@pytest_asyncio.fixture
async def harness() -> AsyncGenerator[tuple, None]:
    app, client = _build()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, client


def _wf_input(client):
    return client.start_workflow.await_args.args[1]


class TestPayloadCannotCarryIdentity:
    @pytest.mark.asyncio
    async def test_caller_supplied_identity_keys_are_stripped_from_payload(self, harness):
        """The C-8 shape itself: a payload naming somebody else's consultation."""
        http, client = harness
        resp = await http.post(
            f"{_BASE}/workflow-runs:start",
            headers=_HEADERS,
            json=_start_body(
                payload={
                    "consultationId": "VICTIM-CONSULTATION",
                    "externalPatientId": "VICTIM-PATIENT",
                    "userId": "VICTIM-DOCTOR",
                    "jobId": "j",
                    "sessionId": "s",
                    "text": "legitimate business input",
                }
            ),
        )
        assert resp.status_code == 200

        wf_input = _wf_input(client)
        for key in ("consultationId", "externalPatientId", "userId", "jobId", "sessionId"):
            assert key not in wf_input.payload, f"{key} survived into the run payload"
        # Everything that is NOT identity is forwarded untouched.
        assert wf_input.payload["text"] == "legitimate business input"

    @pytest.mark.asyncio
    async def test_subject_is_the_only_source_of_identity(self, harness):
        """A server-resolved subject re-stamps the identity keys the strip removed, so the
        thirteen ``run_identity(...)`` call sites keep working with no edit."""
        http, client = harness
        resp = await http.post(
            f"{_BASE}/workflow-runs:start",
            headers=_HEADERS,
            json=_start_body(
                payload={"consultationId": "ATTACKER-CHOSEN", "text": "hi"},
                subject={
                    "consultationId": "SERVER-RESOLVED",
                    "externalPatientId": "SERVER-PATIENT",
                    "userId": "SERVER-USER",
                },
            ),
        )
        assert resp.status_code == 200

        wf_input = _wf_input(client)
        assert wf_input.payload["consultationId"] == "SERVER-RESOLVED"
        assert wf_input.payload["externalPatientId"] == "SERVER-PATIENT"
        assert wf_input.payload["userId"] == "SERVER-USER"
        assert wf_input.payload["text"] == "hi"
        assert wf_input.subject is not None
        assert wf_input.subject.consultation_id == "SERVER-RESOLVED"

    @pytest.mark.asyncio
    async def test_no_subject_means_no_identity_at_all(self, harness):
        """Absent a subject the run is identity-less — it does not fall back to the payload."""
        http, client = harness
        resp = await http.post(
            f"{_BASE}/workflow-runs:start",
            headers=_HEADERS,
            json=_start_body(payload={"consultationId": "ATTACKER-CHOSEN"}),
        )
        assert resp.status_code == 200
        wf_input = _wf_input(client)
        assert wf_input.payload == {}
        assert wf_input.subject is None


class TestIdempotencyPolicies:
    @pytest.mark.asyncio
    async def test_start_declares_use_existing_and_reject_duplicate(self, harness):
        """TASK-850 step 6. ``USE_EXISTING`` joins a RUNNING execution; ``REJECT_DUPLICATE`` is
        what stops a retry after the run CLOSED from starting a second, separately-billed
        execution — Temporal's default reuse policy (``ALLOW_DUPLICATE``) would do exactly that.
        """
        from temporalio.common import WorkflowIDConflictPolicy, WorkflowIDReusePolicy

        http, client = harness
        resp = await http.post(f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body())
        assert resp.status_code == 200

        kwargs = client.start_workflow.await_args.kwargs
        assert kwargs["id_conflict_policy"] is WorkflowIDConflictPolicy.USE_EXISTING
        assert kwargs["id_reuse_policy"] is WorkflowIDReusePolicy.REJECT_DUPLICATE

    @pytest.mark.asyncio
    async def test_joining_a_running_execution_reports_already_running(self, harness):
        """With ``USE_EXISTING`` Temporal does not raise — it answers ``started=False``.
        Reporting that as ``started`` would tell a retrying webhook it had begun a second run."""
        http, client = harness
        handle = _handle()
        handle._start_workflow_response = SimpleNamespace(started=False)
        client.start_workflow = AsyncMock(return_value=handle)

        resp = await http.post(f"{_BASE}/workflow-runs:start", headers=_HEADERS, json=_start_body())
        assert resp.status_code == 200
        assert resp.json()["status"] == "already_running"
