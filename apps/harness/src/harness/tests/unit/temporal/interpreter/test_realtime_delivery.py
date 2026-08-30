"""TASK-796 — the three realtime capabilities must actually REACH the clinician.

TASK-791 built the three R3 nodes and they work: they generate. But nothing they generate is
ever displayed. ``consultation.realtimeSummary`` announces ``{ordinal, total, chars}`` on the
loop plane and the console renders a progress bar; the summary TEXT lives and dies as node
output. ``consultation.suggestions`` and ``consultation.proposeCorrections`` have no delivery at
all.

These tests specify the delivery, and the two properties that bound it:

1. **The loop event is NOT widened.** ``EmitLoopEventInput`` is ``extra="forbid"`` and its
   docstring calls the channel "a live UI feed, not a PHI transport". Summary text must never
   appear on it. The announcement stays exactly what it was.
2. **A correction proposal is not a summary.** It carries a stable id, its own span, both halves
   of its provenance, and ``status: 'PROPOSED'`` / ``applied: False`` — and the SOURCE TEXT comes
   back byte-identical. A system that silently rewrites a drug name or a dose is a patient-safety
   defect.

Delivery itself is best-effort in exactly the sense ``report_loop_event`` already is: a publish
that fails costs the DELIVERY, never the work.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.sensors.base import NEREntity
from harness.services.api_client import ApiServiceError, ResolvedPromptTemplateResponse
from harness.services.text_client import TextGenerationResult
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_realtime as rt

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1", "jobId": "j1"}

_SOAP_REPLY = (
    "Subjective: Cough for three days.\n"
    "Objective: Temp 37.8C, chest clear.\n"
    "Assessment: Likely viral URTI.\n"
    "Plan: Fluids, review in 48h."
)


def _payload(node_type: str, **overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "n1",
        "node_type": node_type,
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": dict(_RUN),
    }
    base.update(overrides)
    return NodeActivityInput(**base)


#: TASK-826 — the correction node's bound instruction template.
_CORRECTION_TEMPLATE = "11111111-1111-1111-1111-111111111111"


class _RecordingApi:
    """Resolves a selection and records every publish the nodes make."""

    def __init__(self, *, provider: str | None = "lm-studio", model: str | None = "a-model"):
        self.provider = provider
        self.model = model
        self.events: list[dict[str, Any]] = []
        self.summaries: list[dict[str, Any]] = []
        self.assists: list[dict[str, Any]] = []

    async def get_resolved_prompt_template(self, template_id, tenant_id=None):
        """TASK-826 — `consultation.proposeCorrections` resolves its system prompt from the
        node's `promptTemplateId`. Delivery is what these tests are about, so the instruction
        resolves cleanly here; the degrade paths are specified in
        `test_realtime_capability_nodes.py::TestCorrectionInstructionIsGoverned`."""
        return ResolvedPromptTemplateResponse(
            found=True, approved=True, content="a tenant correction instruction", version_number=1
        )

    async def get_policy(self, tenant_id, consultation_id=None, task_key=None, model_slug=None):
        return {
            "textProvider": self.provider,
            "textModel": self.model,
            "phiEnabled": False,
            "phiFailClosed": True,
        }

    async def report_loop_event(self, consultation_id, **kwargs):
        self.events.append({"consultationId": consultation_id, **kwargs})
        return True

    async def publish_live_summary(self, consultation_id, **kwargs):
        self.summaries.append({"consultationId": consultation_id, **kwargs})
        return True

    async def publish_live_assist(self, consultation_id, **kwargs):
        self.assists.append({"consultationId": consultation_id, **kwargs})
        return True


class _FakeText:
    def __init__(self, *contents: str):
        self._contents = list(contents)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs):
        self.calls.append(kwargs)
        content = self._contents[min(len(self.calls) - 1, len(self._contents) - 1)]
        return TextGenerationResult(content=content, provider="lm-studio", model="a-model")


# ---------------------------------------------------------------------------
# W1 — the interim summary reaches the clinician on the EXISTING live plane
# ---------------------------------------------------------------------------


class TestRealtimeSummaryDelivery:
    @pytest.mark.asyncio
    async def test_publishes_each_window_to_the_live_summary_plane(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(_SOAP_REPLY, _SOAP_REPLY))

        result = await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live", "windowChars": 20},
                bound_inputs={"in": {"text": "A" * 20 + "B" * 20}},
            )
        )

        assert result.status == "SUCCEEDED"
        # One publish per window, so the panel grows DURING the consultation.
        assert len(api.summaries) == 2
        assert result.output["published"] == 2

        first = api.summaries[0]
        assert first["consultationId"] == "c1"
        assert first["tenant_id"] == _TENANT
        assert first["ordinal"] == 1
        assert first["total"] == 2
        assert first["source"] == "interpreter"
        assert first["node_type"] == "consultation.realtimeSummary"
        assert first["provider"] == "lm-studio"
        assert first["model"] == "a-model"
        # The clinician-visible text is CARRIED, not counted.
        assert "Cough for three days" in first["running_summary"]

    @pytest.mark.asyncio
    async def test_the_published_payload_is_soap_shaped_not_a_flat_blob(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(_SOAP_REPLY))

        await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "transcript"}},
            )
        )

        sections = api.summaries[0]["sections"]
        assert [s["title"] for s in sections] == [
            "Subjective",
            "Objective",
            "Assessment",
            "Plan",
        ]
        assert sections[0]["content"] == "Cough for three days."
        assert sections[3]["content"] == "Fluids, review in 48h."

    @pytest.mark.asyncio
    async def test_unstructured_prose_degrades_to_one_running_summary_section(self, monkeypatch):
        """Same fallback the default engine's ``parseSoapSections`` uses — never a crash,
        never an invented section."""
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText("just some prose"))

        await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "transcript"}},
            )
        )

        sections = api.summaries[0]["sections"]
        assert sections == [{"title": "Running Summary", "content": "just some prose"}]

    @pytest.mark.asyncio
    async def test_the_loop_announcement_is_not_widened(self, monkeypatch):
        """The PHI boundary. The announcement keeps carrying ids and counts ONLY."""
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(_SOAP_REPLY))

        await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "AAAA transcript"}},
            )
        )

        assert len(api.events) == 1
        event = api.events[0]
        assert set(event["detail"]) == {"ordinal", "total", "chars"}
        blob = repr(event)
        for leak in ("Cough", "Subjective", "AAAA", "viral"):
            assert leak not in blob

    @pytest.mark.asyncio
    async def test_a_failed_publish_never_loses_the_summary(self, monkeypatch):
        class _DeafApi(_RecordingApi):
            async def publish_live_summary(self, consultation_id, **kwargs):
                raise ApiServiceError("live plane down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _DeafApi())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(_SOAP_REPLY))

        result = await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "transcript"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["published"] == 0
        assert result.output["summaries"] == [_SOAP_REPLY]


# ---------------------------------------------------------------------------
# W3a — suggestions reach the clinician with a stable id
# ---------------------------------------------------------------------------


class TestSuggestionDelivery:
    @pytest.mark.asyncio
    async def test_publishes_suggestions_with_stable_ids_and_provenance(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: _FakeText(
                '{"suggestions": [{"text": "Ask about penicillin allergy",'
                ' "category": "history"}]}'
            ),
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "rash after antibiotics"}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert len(api.assists) == 1
        assist = api.assists[0]
        assert assist["kind"] == "suggestions"
        assert assist["node_type"] == "consultation.suggestions"
        [suggestion] = assist["suggestions"]
        assert suggestion["text"] == "Ask about penicillin allergy"
        assert suggestion["category"] == "history"
        assert suggestion["status"] == "PROPOSED"
        assert suggestion["proposedBy"] == "lm-studio:a-model"
        assert suggestion["suggestionId"]
        # The node's own output carries the same ids the console will act on.
        assert result.output["suggestions"][0]["suggestionId"] == suggestion["suggestionId"]

    @pytest.mark.asyncio
    async def test_suggestion_ids_are_deterministic_across_retries(self, monkeypatch):
        """A Temporal activity retries. A re-run must re-publish the SAME ids, or a clinician
        who already dismissed a suggestion sees it return as a new one."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _RecordingApi())
        monkeypatch.setattr(
            rt, "_text_client", lambda s: _FakeText('{"suggestions": [{"text": "Check BP"}]}')
        )

        payload = _payload(
            "consultation.suggestions",
            config={"taskKey": "text.live"},
            bound_inputs={"in": {"text": "something"}},
        )
        first = await rt.interpreter_consultation_suggestions(payload)
        second = await rt.interpreter_consultation_suggestions(payload)

        assert (
            first.output["suggestions"][0]["suggestionId"]
            == second.output["suggestions"][0]["suggestionId"]
        )

    @pytest.mark.asyncio
    async def test_a_failed_publish_never_loses_the_suggestions(self, monkeypatch):
        class _DeafApi(_RecordingApi):
            async def publish_live_assist(self, consultation_id, **kwargs):
                raise ApiServiceError("assist plane down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _DeafApi())
        monkeypatch.setattr(
            rt, "_text_client", lambda s: _FakeText('{"suggestions": [{"text": "Check BP"}]}')
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "something"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["count"] == 1
        assert result.output["published"] is False


# ---------------------------------------------------------------------------
# W3b — correction PROPOSALS reach the clinician, still proposal-first
# ---------------------------------------------------------------------------


class TestCorrectionDelivery:
    _SOURCE = "Patient started on amoxicilin 500mg TID for otits media."

    def _fake_extract(self):
        entities = [
            NEREntity(text="amoxicilin", type="DRUG", start=19, end=29),
            NEREntity(text="otits media", type="CONDITION", start=44, end=55),
        ]

        async def _extract(payload):
            return type("R", (), {"entities": entities})()

        return _extract

    def _reply(self) -> str:
        return (
            '{"proposals": ['
            '{"start": 19, "end": 29, "original": "amoxicilin",'
            ' "proposed": "amoxicillin", "category": "drugName",'
            ' "confidence": 0.96, "rationale": "misspelling"}]}'
        )

    @pytest.mark.asyncio
    async def test_publishes_proposals_that_a_clinician_can_accept_or_reject(self, monkeypatch):
        api = _RecordingApi()
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "extract_entities", self._fake_extract())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(self._reply()))

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _CORRECTION_TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert len(api.assists) == 1
        assist = api.assists[0]
        assert assist["kind"] == "corrections"
        corrections = assist["corrections"]

        # Proposal-first, on the wire as well as in the output.
        assert corrections["applied"] is False
        assert corrections["appliedCount"] == 0
        assert corrections["rejectedProposals"] == 0
        # Binds the proposals to the exact text they were computed against, so a console
        # cannot splice them into text that has since drifted.
        assert corrections["textSha256"] == rt.text_digest(self._SOURCE)

        [proposal] = corrections["proposals"]
        assert proposal["proposalId"]
        assert proposal["status"] == "PROPOSED"
        assert proposal["original"] == "amoxicilin"
        assert proposal["proposed"] == "amoxicillin"
        assert proposal["detectedBy"] == "nlp.ner"
        assert proposal["proposedBy"] == "lm-studio:a-model"
        assert self._SOURCE[proposal["start"] : proposal["end"]] == proposal["original"]

        # And the SOURCE TEXT is still byte-identical.
        assert result.output["text"] == self._SOURCE
        assert result.output["applied"] is False

    @pytest.mark.asyncio
    async def test_proposal_ids_are_deterministic_across_retries(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _RecordingApi())
        monkeypatch.setattr(rt, "extract_entities", self._fake_extract())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(self._reply()))

        payload = _payload(
            "consultation.proposeCorrections",
            config={"taskKey": "text.live", "promptTemplateId": _CORRECTION_TEMPLATE},
            bound_inputs={"in": {"text": self._SOURCE}},
        )
        first = await rt.interpreter_consultation_propose_corrections(payload)
        second = await rt.interpreter_consultation_propose_corrections(payload)

        assert (
            first.output["proposals"][0]["proposalId"]
            == second.output["proposals"][0]["proposalId"]
        )

    @pytest.mark.asyncio
    async def test_nothing_is_published_when_there_is_nothing_to_propose(self, monkeypatch):
        api = _RecordingApi()

        async def _extract(payload):
            return type("R", (), {"entities": []})()

        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "extract_entities", _extract)
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("nothing to correct — must not generate")
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _CORRECTION_TEMPLATE},
                bound_inputs={"in": {"text": "nothing clinical here"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert api.assists == []

    @pytest.mark.asyncio
    async def test_a_failed_publish_never_loses_the_proposals(self, monkeypatch):
        class _DeafApi(_RecordingApi):
            async def publish_live_assist(self, consultation_id, **kwargs):
                raise ApiServiceError("assist plane down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _DeafApi())
        monkeypatch.setattr(rt, "extract_entities", self._fake_extract())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText(self._reply()))

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _CORRECTION_TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert len(result.output["proposals"]) == 1
        assert result.output["published"] is False


# ---------------------------------------------------------------------------
# The boundary this ticket must not widen
# ---------------------------------------------------------------------------


class TestLoopEventBoundaryUnwidened:
    def test_emit_loop_event_input_still_forbids_extra_fields(self):
        from harness.temporal.models import EmitLoopEventInput

        assert EmitLoopEventInput.model_config["extra"] == "forbid"

    def test_emit_loop_event_input_gained_no_text_carrying_field(self):
        from harness.temporal.models import EmitLoopEventInput

        assert set(EmitLoopEventInput.model_fields) == {
            "consultation_id",
            "tenant_id",
            "event_type",
            "context_item_id",
            "kind_key",
            "action",
            "reason",
            "detail",
        }
