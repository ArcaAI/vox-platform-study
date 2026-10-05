"""The NotePlan pointer reaches the harness at every run start (P-E E6, H-111 / H-116).

* ``document:start`` accepts camelCase ``notePlanRef`` and maps it onto
  ``HarnessDocWorkflowInput.note_plan_ref``; a start without one stays ``None``.
* The loop's finalize payload (``LoopFinalizeRequest``, ``extra="forbid"``) carries the
  pointer, and ``signal/consultation-ending`` maps ``notePlanRef`` onto it.
* ``AssembleInput`` carries the plan id so ``assemble`` reuses the plan instead of composing a
  second one.
* Every payload recorded before these fields existed still validates (replay: new optional
  fields default to ``None``).

Hermetic: the Temporal client is a mock on ``app.state``.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr, ValidationError

from harness.core.config import Settings
from harness.main import create_app
from harness.services.note_plan.models import NotePlanRef
from harness.temporal.models import (
    AssembleInput,
    ConsultationEndingSignal,
    HarnessDocWorkflowInput,
    LoopFinalizeRequest,
)

_TOKEN = "shared-secret"
_HEADERS = {"X-Service-Token": _TOKEN}
_CID = "0199a000-0000-7000-8000-0000000000c1"
_PLAN_ID = "0199a000-0000-7000-8000-000000000001"
_WIRE_REF = {"consultationId": _CID, "mode": "final", "planId": _PLAN_ID}


@pytest_asyncio.fixture
async def harness() -> AsyncGenerator[tuple, None]:
    settings = Settings(
        service_token=SecretStr(_TOKEN),
        internal_access_token=SecretStr(_TOKEN),
        log_level="debug",
    )
    app = create_app(settings_override=settings)
    handle = MagicMock()
    handle.id = f"harness-doc-{_CID}"
    handle.signal = AsyncMock()
    client = MagicMock()
    client.start_workflow = AsyncMock(return_value=handle)
    client.get_workflow_handle = MagicMock(return_value=handle)
    app.state.temporal_client = client
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, client, handle


class TestDocumentStartNotePlanRef:
    @pytest.mark.asyncio
    async def test_maps_camel_case_note_plan_ref_onto_the_workflow_input(self, harness):
        http, client, _ = harness
        resp = await http.post(
            f"/api/v1/internal/consultations/{_CID}/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "jobId": "job-1", "notePlanRef": _WIRE_REF},
        )
        assert resp.status_code == 200
        wf_input = client.start_workflow.call_args.args[1]
        assert isinstance(wf_input, HarnessDocWorkflowInput)
        assert wf_input.note_plan_ref == NotePlanRef(
            consultation_id=_CID, plan_id=_PLAN_ID, mode="final"
        )

    @pytest.mark.asyncio
    async def test_a_start_without_a_plan_keeps_note_plan_ref_none(self, harness):
        http, client, _ = harness
        resp = await http.post(
            f"/api/v1/internal/consultations/{_CID}/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "transcriptText": "hello"},
        )
        assert resp.status_code == 200
        assert client.start_workflow.call_args.args[1].note_plan_ref is None

    @pytest.mark.asyncio
    async def test_a_malformed_ref_is_refused_at_the_boundary(self, harness):
        http, client, _ = harness
        resp = await http.post(
            f"/api/v1/internal/consultations/{_CID}/document:start",
            headers=_HEADERS,
            json={"tenantId": "t-1", "notePlanRef": {"consultationId": _CID}},
        )
        assert resp.status_code == 422
        client.start_workflow.assert_not_called()


class TestLoopFinalizeRequest:
    def test_accepts_the_note_plan_ref(self):
        request = LoopFinalizeRequest.model_validate({"note_plan_ref": _WIRE_REF})
        assert request.note_plan_ref is not None
        assert request.note_plan_ref.plan_id == _PLAN_ID

    def test_an_old_payload_without_it_still_validates(self):
        recorded = {
            "transcript_text": "",
            "context_item_id": None,
            "job_id": None,
            "conversation_language": "en",
            "dna_style_id": None,
            "template": None,
            "smr_provider": "lm-studio",
            "smr_model": None,
        }
        request = LoopFinalizeRequest.model_validate(recorded)
        assert request.note_plan_ref is None
        assert request.text_provider == "lm-studio"
        signal = ConsultationEndingSignal.model_validate({"reason": "x", "finalize": recorded})
        assert signal.finalize is not None and signal.finalize.note_plan_ref is None

    def test_still_forbids_unknown_keys(self):
        with pytest.raises(ValidationError):
            LoopFinalizeRequest.model_validate({"notePlan": _WIRE_REF})

    @pytest.mark.asyncio
    async def test_consultation_ending_maps_note_plan_ref_onto_the_finalize_payload(self, harness):
        http, _, handle = harness
        resp = await http.post(
            f"/api/v1/internal/workflows/{_CID}/signal/consultation-ending",
            headers=_HEADERS,
            json={"reason": "recording_stopped", "notePlanRef": _WIRE_REF},
        )
        assert resp.status_code == 200
        signal = handle.signal.call_args.args[1]
        assert isinstance(signal, ConsultationEndingSignal)
        assert signal.finalize is not None
        assert signal.finalize.note_plan_ref == NotePlanRef(
            consultation_id=_CID, plan_id=_PLAN_ID, mode="final"
        )

    @pytest.mark.asyncio
    async def test_consultation_ending_without_a_ref_keeps_none(self, harness):
        http, _, handle = harness
        resp = await http.post(
            f"/api/v1/internal/workflows/{_CID}/signal/consultation-ending",
            headers=_HEADERS,
            json={"reason": "recording_stopped"},
        )
        assert resp.status_code == 200
        assert handle.signal.call_args.args[1].finalize.note_plan_ref is None


class TestAssembleInputNotePlanId:
    def test_carries_the_plan_id(self):
        payload = AssembleInput(consultation_id=_CID, tenant_id="t-1", note_plan_id=_PLAN_ID)
        assert payload.note_plan_id == _PLAN_ID

    def test_an_old_payload_without_it_still_validates(self):
        payload = AssembleInput.model_validate(
            {"consultation_id": _CID, "tenant_id": "t-1", "template": None}
        )
        assert payload.note_plan_id is None
