"""Tests for the token-guarded internal start/signal endpoints.

RED-first: written before the router exists. The Temporal client is mocked and
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

from harness.core.config import Settings
from harness.main import create_app

_TOKEN = "shared-secret"
_HEADERS = {"X-Service-Token": _TOKEN}


def _build(service_token: str = _TOKEN):
    settings = Settings(service_token=service_token, log_level="debug")
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
