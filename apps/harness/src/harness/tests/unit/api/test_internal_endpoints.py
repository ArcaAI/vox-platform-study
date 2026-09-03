"""Tests for the token-guarded internal start/signal endpoints.

The Temporal client is mocked and
injected on ``app.state`` so these tests assert pure wiring — the start endpoint
starts ``HarnessDocWorkflow`` with the deterministic ``harness-doc-{id}`` id on
the configured task queue, the signal endpoint targets that same id with the
mapped ``ApprovalSignal``, and the shared ``HARNESS_SERVICE_TOKEN`` guards both.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from harness.core.config import Settings
from harness.main import create_app

_TOKEN = "shared-secret"
_HEADERS = {"X-Service-Token": _TOKEN}


def _build(service_token: str = _TOKEN, *, optimistic_delivery_enabled: bool = False):
    settings = Settings(
        service_token=SecretStr(service_token),
        # The guard accepts EITHER the shared INTERNAL_ACCESS_TOKEN or the legacy
        # per-service one, so the shared token has to be pinned here too — the
        # developer's own .env.dev sets it, and it would otherwise leak in and
        # arm a guard these cases build deliberately unarmed.
        internal_access_token=SecretStr(service_token),
        log_level="debug",
        optimistic_delivery_enabled=optimistic_delivery_enabled,
    )
    app = create_app(settings_override=settings)

    handle = MagicMock()
    handle.id = "harness-doc-c-1"
    handle.signal = AsyncMock()

    client = MagicMock()
    client.start_workflow = AsyncMock(return_value=handle)
    client.get_workflow_handle = MagicMock(return_value=handle)
    app.state.temporal_client = client
    return app, client, handle, settings


@pytest_asyncio.fixture
async def harness() -> AsyncGenerator[tuple, None]:
    app, client, handle, settings = _build()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, client, handle, settings


class TestStartDocument:
    @pytest.mark.asyncio
    async def test_start_starts_workflow_with_deterministic_id_and_task_queue(self, harness):
        http, client, _handle, settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "userId": "u-1",
                "jobId": "job-1",
                "contextItemId": "ctx-t1",
                "transcriptText": "Patient has hypertension.",
                "conversationLanguage": "en",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["workflowId"] == "harness-doc-c-1"

        client.start_workflow.assert_awaited_once()
        args, kwargs = client.start_workflow.call_args
        wf_input = args[1]
        assert kwargs["id"] == "harness-doc-c-1"
        assert kwargs["task_queue"] == settings.temporal.task_queue
        assert wf_input.consultation_id == "c-1"
        assert wf_input.tenant_id == "t-1"
        assert wf_input.transcript_text == "Patient has hypertension."
        # Deterministic loop knobs are snapshotted from settings into the input.
        assert wf_input.gate.max_regen == settings.max_regen

    @pytest.mark.asyncio
    async def test_start_threads_external_patient_id_into_workflow_input(self, harness):
        """(consent-abac Phase 4) — externalPatientId reaches
        HarnessDocWorkflowInput so call_mcp_tool/retrieve_context can key a
        consent-gate lookup."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "transcriptText": "x",
                "externalPatientId": "PAT-20250101-001",
            },
        )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        wf_input = args[1]
        assert wf_input.external_patient_id == "PAT-20250101-001"

    @pytest.mark.asyncio
    async def test_start_defaults_external_patient_id_to_none(self, harness):
        """An un-upgraded caller omits it — the workflow degrades (consent
        UNAVAILABLE, not a crash), never a validation error."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "transcriptText": "x"},
        )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        assert args[1].external_patient_id is None

    @pytest.mark.asyncio
    async def test_start_threads_redaction_rules_into_workflow_input(self, harness):
        """CamelCase redactionRules parse into RedactionRule payloads on
        HarnessDocWorkflowInput; an omitted field defaults to an empty (no-op) list."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "transcriptText": "x",
                "redactionRules": [
                    {"id": "r1", "type": "remove", "match": "literal", "pattern": "employer"}
                ],
            },
        )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        wf_input = args[1]
        assert len(wf_input.redaction_rules) == 1
        assert wf_input.redaction_rules[0].id == "r1"
        assert wf_input.redaction_rules[0].pattern == "employer"

    @pytest.mark.asyncio
    async def test_start_defaults_redaction_rules_to_empty(self, harness):
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "transcriptText": "x"},
        )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        assert args[1].redaction_rules == []

    @pytest.mark.asyncio
    async def test_start_rejects_missing_or_bad_token(self, harness):
        http, client, _handle, _settings = harness
        body = {"tenantId": "t-1"}

        missing = await http.post("/api/v1/internal/consultations/c-1/document:start", json=body)
        bad = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers={"X-Service-Token": "wrong"},
            json=body,
        )
        assert missing.status_code == 401
        assert bad.status_code == 401
        client.start_workflow.assert_not_awaited()


class TestStartSnapshotsOptimisticFlag:
    """The start path snapshots ``HARNESS_OPTIMISTIC_DELIVERY_ENABLED``
    (via ``Settings``) into the workflow input's ``HarnessGateConfig`` at workflow start.

    This is the determinism-safe injection point: the env is read in NON-workflow
    code (the FastAPI start endpoint) and captured in the input, so the workflow
    never reads env and the value is stable across replay.
    """

    @pytest.mark.asyncio
    async def test_default_off_snapshots_false_into_gate(self, harness):
        # (a) Default settings (flag unset) ⇒ the snapshotted gate is OFF.
        http, client, _handle, settings = harness
        assert settings.optimistic_delivery_enabled is False
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1"},
        )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        wf_input = args[1]
        assert wf_input.gate.optimistic_delivery_enabled is False

    @pytest.mark.asyncio
    async def test_flag_on_snapshots_true_into_gate(self):
        # (b) HARNESS_OPTIMISTIC_DELIVERY_ENABLED on ⇒ the snapshotted gate is ON.
        app, client, _handle, settings = _build(optimistic_delivery_enabled=True)
        assert settings.optimistic_delivery_enabled is True
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(
                "/api/v1/internal/consultations/c-1/document:start",
                headers=_HEADERS,
                json={"tenantId": "t-1"},
            )
        assert resp.status_code == 200
        args, _ = client.start_workflow.call_args
        wf_input = args[1]
        assert wf_input.gate.optimistic_delivery_enabled is True


class TestSignalApprove:
    @pytest.mark.asyncio
    async def test_signal_targets_the_right_workflow_id_with_mapped_payload(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/approve",
            headers=_HEADERS,
            json={
                "decision": "SIGNED",
                "clinicianId": "doc-1",
                "contextItemVersionId": "v-1",
                "attestationHash": "h-1",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["workflowId"] == "harness-doc-c-1"

        client.get_workflow_handle.assert_called_once_with("harness-doc-c-1")
        handle.signal.assert_awaited_once()
        sargs, _ = handle.signal.call_args
        payload = sargs[1]
        assert payload.decision == "SIGNED"
        assert payload.clinician_id == "doc-1"
        assert payload.context_item_version_id == "v-1"
        assert payload.attestation_hash == "h-1"

    @pytest.mark.asyncio
    async def test_signal_rejects_bad_token(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/approve",
            headers={"X-Service-Token": "wrong"},
            json={"decision": "SIGNED"},
        )
        assert resp.status_code == 401
        handle.signal.assert_not_awaited()
        client.get_workflow_handle.assert_not_called()


class TestSignalEdit:
    """The edit-signal SENDER side.

    apps/api forwards a clinician edit of an optimistically-delivered draft (while
    it is still DRAFT_PENDING_SENSORS) to the running workflow's ``edit`` signal so
    the assurance pass re-binds + re-runs on the edited content (Q3) and the silent
    regen-if-untouched path is disabled (Q1).
    """

    @pytest.mark.asyncio
    async def test_signal_targets_the_right_workflow_id_with_mapped_payload(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/edit",
            headers=_HEADERS,
            json={
                "content": "S: edited subjective ... P: edited plan",
                "contextItemVersionId": "v-2",
                "editedBy": "doc-1",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["workflowId"] == "harness-doc-c-1"
        assert resp.json()["signaled"] is True

        client.get_workflow_handle.assert_called_once_with("harness-doc-c-1")
        handle.signal.assert_awaited_once()
        sargs, _ = handle.signal.call_args
        payload = sargs[1]
        assert payload.content == "S: edited subjective ... P: edited plan"
        assert payload.context_item_version_id == "v-2"
        assert payload.edited_by == "doc-1"

    @pytest.mark.asyncio
    async def test_signal_rejects_bad_token(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/edit",
            headers={"X-Service-Token": "wrong"},
            json={"content": "edited"},
        )
        assert resp.status_code == 401
        handle.signal.assert_not_awaited()
        client.get_workflow_handle.assert_not_called()

    @pytest.mark.asyncio
    async def test_signal_requires_content(self, harness):
        # ``content`` is the edited note the assurance pass must screen — without it
        # the request is a 422 (pydantic validation) and no signal is sent.
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/edit",
            headers=_HEADERS,
            json={"editedBy": "doc-1"},
        )
        assert resp.status_code == 422
        handle.signal.assert_not_awaited()


class TestTokenDisabledForLocalDev:
    @pytest.mark.asyncio
    async def test_empty_configured_token_disables_the_guard(self):
        # Local dev: empty HARNESS_SERVICE_TOKEN => the guard is a no-op.
        app, client, _handle, _settings = _build(service_token="")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(
                "/api/v1/internal/consultations/c-1/document:start",
                json={"tenantId": "t-1"},
            )
        assert resp.status_code == 200
        client.start_workflow.assert_awaited_once()


class TestStartSetsTenantMetadata:
    @pytest.mark.asyncio
    async def test_start_sets_tenant_search_attribute_and_memo(self, harness):
        # The owning tenant rides on the HarnessTenantId search attribute (so the
        # admin console can filter by it) AND on the memo (the SA-outage fallback).
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/consultations/c-1/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "transcriptText": "x"},
        )
        assert resp.status_code == 200

        _args, kwargs = client.start_workflow.call_args
        memo = kwargs["memo"]
        assert memo["tenantId"] == "t-1"
        assert memo["consultationId"] == "c-1"

        from temporalio.common import SearchAttributeKey

        sa = kwargs["search_attributes"]
        assert sa.get(SearchAttributeKey.for_keyword("HarnessTenantId")) == "t-1"

    @pytest.mark.asyncio
    async def test_start_degrades_to_memo_when_search_attribute_unregistered(self):
        # If HarnessTenantId is not registered on the cluster, the first start
        # rejects; we retry memo-only rather than failing the consultation.
        app, client, handle, _settings = _build()
        client.start_workflow = AsyncMock(
            side_effect=[RuntimeError("search attribute HarnessTenantId is not registered"), handle]
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(
                "/api/v1/internal/consultations/c-1/document:start",
                headers=_HEADERS,
                json={"tenantId": "t-1"},
            )
        assert resp.status_code == 200
        assert resp.json()["status"] == "started"
        assert client.start_workflow.await_count == 2
        # The retry dropped the search attribute but kept the memo fallback.
        _a, retry_kwargs = client.start_workflow.call_args_list[1]
        assert retry_kwargs.get("search_attributes") is None
        assert retry_kwargs["memo"]["tenantId"] == "t-1"
