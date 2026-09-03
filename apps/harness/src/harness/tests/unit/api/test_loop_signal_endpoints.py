"""Tests for the consultation-loop signal endpoints.

shipped the CALLER for ``POST /signal/context-added`` and recorded that
the receiver did not exist yet. These tests pin the receiver's contract: the
deterministic loop id, signal-WITH-start on the context path, plain signals on
the ending/cancel paths, the shared service-token guard, and — the part most
likely to rot — tolerance of the payload the gateway actually sends today.

The Temporal client is mocked and injected on ``app.state``, so what is asserted
is pure wiring, exactly as in ``test_internal_endpoints.py``.
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


def _build(service_token: str = _TOKEN):
    settings = Settings(service_token=SecretStr(service_token), log_level="debug")
    app = create_app(settings_override=settings)

    handle = MagicMock()
    handle.id = "consultation-loop-c-1"
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


class TestContextAddedSignal:
    @pytest.mark.asyncio
    async def test_signal_with_start_uses_the_deterministic_loop_id(self, harness):
        http, client, _handle, settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "contextItemId": "ci-1",
                "contextType": "TRANSCRIPT",
                "kindKey": "transcript",
                "occurredAt": "2026-08-12T00:00:00.000Z",
                "depth": 1,
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"workflowId": "consultation-loop-c-1", "signaled": True}

        client.start_workflow.assert_awaited_once()
        args, kwargs = client.start_workflow.call_args
        wf_input = args[1]
        assert kwargs["id"] == "consultation-loop-c-1"
        assert kwargs["task_queue"] == settings.temporal.task_queue
        # Signal-WITH-start: idempotent on the id, so a second call signals the
        # running loop rather than racing a duplicate into existence.
        assert kwargs["start_signal"] == "contextAdded"
        signal = kwargs["start_signal_args"][0]
        assert wf_input.consultation_id == "c-1"
        assert wf_input.tenant_id == "t-1"
        assert signal.context_item_id == "ci-1"
        assert signal.kind_key == "transcript"
        assert signal.occurred_at == "2026-08-12T00:00:00.000Z"
        assert signal.depth == 1

    @pytest.mark.asyncio
    async def test_accepts_the_payload_the_gateway_sends_today(self, harness):
        """`HarnessGatewayService.signalContextAdded` sends exactly these five keys.

        It carries no `kindKey`, no `occurredAt` and no `depth`, so the receiver
        must not require them — and must still route against something, which is
        why `kindKey` falls back to `subType` and then `contextType`.
        """
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "contextItemId": "ci-1",
                "contextType": "WORKNOTE",
                "subType": "LAB_RESULT",
                "contentPreview": "sodium 139",
            },
        )
        assert resp.status_code == 200
        signal = client.start_workflow.call_args.kwargs["start_signal_args"][0]
        assert signal.kind_key == "LAB_RESULT"
        assert signal.context_type == "WORKNOTE"
        assert signal.depth == 0
        assert signal.text == "sodium 139"

    @pytest.mark.asyncio
    async def test_content_wins_over_content_preview_when_both_are_sent(self, harness):
        """A payload-complete signal carries the full body in
        `content`; the receiver must prefer it over the older, shorter
        `contentPreview` rather than silently keeping the truncated one."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "contextItemId": "ci-1",
                "contextType": "TRANSCRIPT",
                "contentPreview": "doctor: hel",
                "content": "doctor: hello, patient: hi doctor, how are you feeling today",
            },
        )
        assert resp.status_code == 200
        signal = client.start_workflow.call_args.kwargs["start_signal_args"][0]
        assert signal.text == "doctor: hello, patient: hi doctor, how are you feeling today"

    @pytest.mark.asyncio
    async def test_falls_back_to_content_preview_when_content_is_absent(self, harness):
        """An un-upgraded gateway (or a caller that only sends the short
        preview) must still route SOMETHING to the specialist."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={
                "tenantId": "t-1",
                "contextItemId": "ci-1",
                "contextType": "WORKNOTE",
                "contentPreview": "BP elevated",
            },
        )
        assert resp.status_code == 200
        signal = client.start_workflow.call_args.kwargs["start_signal_args"][0]
        assert signal.text == "BP elevated"

    @pytest.mark.asyncio
    async def test_kind_key_falls_back_to_context_type_when_no_sub_type(self, harness):
        http, client, _handle, _settings = harness
        await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={"tenantId": "t-1", "contextItemId": "ci-1", "contextType": "CASE_NOTE"},
        )
        signal = client.start_workflow.call_args.kwargs["start_signal_args"][0]
        assert signal.kind_key == "CASE_NOTE"

    @pytest.mark.asyncio
    async def test_missing_tenant_id_is_rejected(self, harness):
        """A loop started without a tenant would resolve the wrong configuration."""
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={"contextItemId": "ci-1", "contextType": "WORKNOTE"},
        )
        assert resp.status_code == 400
        client.start_workflow.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_service_token_guard_applies(self, harness):
        http, client, _handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers={"X-Service-Token": "wrong"},
            json={"tenantId": "t-1", "contextItemId": "ci-1"},
        )
        assert resp.status_code == 401
        client.start_workflow.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unregistered_search_attribute_degrades_to_a_memo_only_start(self, harness):
        """A cluster without `HarnessTenantId` registered must still run loops."""
        http, client, _handle, _settings = harness
        client.start_workflow = AsyncMock(side_effect=[RuntimeError("SA not registered"), None])
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/context-added",
            headers=_HEADERS,
            json={"tenantId": "t-1", "contextItemId": "ci-1", "contextType": "WORKNOTE"},
        )
        assert resp.status_code == 200
        assert client.start_workflow.await_count == 2
        # The retry carries no search_attributes, only the memo.
        assert "search_attributes" not in client.start_workflow.call_args.kwargs


class TestEndingAndCancelSignals:
    @pytest.mark.asyncio
    async def test_ending_signal_targets_the_loop_and_carries_the_finalize_payload(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/consultation-ending",
            headers=_HEADERS,
            json={
                "reason": "recording stopped",
                "persistSnapshot": False,
                "transcriptText": "Patient reports headache.",
                "contextItemId": "ci-transcript",
                "jobId": "job-1",
                "conversationLanguage": "ml",
                "template": "SOAP",
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"workflowId": "consultation-loop-c-1", "signaled": True}
        client.get_workflow_handle.assert_called_once_with("consultation-loop-c-1")

        _method, payload = handle.signal.call_args.args
        assert payload.reason == "recording stopped"
        assert payload.persist_snapshot is False
        assert payload.finalize is not None
        assert payload.finalize.transcript_text == "Patient reports headache."
        assert payload.finalize.context_item_id == "ci-transcript"
        assert payload.finalize.conversation_language == "ml"
        assert payload.finalize.template == "SOAP"

    @pytest.mark.asyncio
    async def test_ending_signal_forwards_accepted_proposals_task814(self, harness):
        """corrections the clinician accepted must reach the signal payload
        unchanged, so the endpoint stage's `feedback.capture` node has something to promote."""
        http, client, handle, _settings = harness
        proposal = {
            "proposalId": "p-1",
            "start": 10,
            "end": 16,
            "original": "Toprovol",
            "proposed": "Toprol",
            "category": "drugName",
            "confidence": 0.92,
            "status": "ACCEPTED",
        }
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/consultation-ending",
            headers=_HEADERS,
            json={"reason": "recording_stopped", "acceptedProposals": [proposal]},
        )
        assert resp.status_code == 200
        client.get_workflow_handle.assert_called_once_with("consultation-loop-c-1")

        _method, payload = handle.signal.call_args.args
        assert payload.accepted_proposals == [proposal]

    @pytest.mark.asyncio
    async def test_ending_signal_omits_accepted_proposals_when_absent_task814(self, harness):
        http, client, handle, _settings = harness
        await http.post(
            "/api/v1/internal/workflows/c-1/signal/consultation-ending",
            headers=_HEADERS,
            json={"reason": "recording_stopped"},
        )
        _method, payload = handle.signal.call_args.args
        assert payload.accepted_proposals == []

    @pytest.mark.asyncio
    async def test_ending_is_a_plain_signal_not_a_signal_with_start(self, harness):
        """Nothing to end when no loop runs — starting one just to end it would
        emit a spurious finalize."""
        http, client, _handle, _settings = harness
        await http.post(
            "/api/v1/internal/workflows/c-1/signal/consultation-ending",
            headers=_HEADERS,
            json={},
        )
        client.start_workflow.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_cancel_signal_targets_the_loop(self, harness):
        http, client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/loop-cancel",
            headers=_HEADERS,
            json={"reason": "abandoned"},
        )
        assert resp.status_code == 200
        client.get_workflow_handle.assert_called_once_with("consultation-loop-c-1")
        _method, payload = handle.signal.call_args.args
        assert payload.reason == "abandoned"
        client.start_workflow.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_cancel_is_token_guarded(self, harness):
        http, _client, handle, _settings = harness
        resp = await http.post(
            "/api/v1/internal/workflows/c-1/signal/loop-cancel",
            headers={"X-Service-Token": "wrong"},
            json={},
        )
        assert resp.status_code == 401
        handle.signal.assert_not_awaited()
