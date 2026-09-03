"""The three R3 capabilities verified do not exist anywhere (-W3).

R3 asks ONE workflow to coordinate: record -> transcribe -> realtime entity extraction ->
**realtime short summaries** -> autofill SOAP -> **intelligent suggestions** ->
**spelling / medical-term / drug-name correction**. The last three had no node, no activity and
no sensor. These tests specify them before they exist.

What is asserted here is the same adapter contract every other consultation node carries
(`test_consultation_pipeline_nodes.py`'s docstring): identity read from ``run_payload`` never
``config``, data read generically from ``bound_inputs`` never off a fixed port name, CR-14's
degrade-never-raise posture, and — the part unique to this ticket — that **selection fails
CLOSED** and that **W3 never rewrites clinical text**.

The patient-safety assertion in ``TestProposeCorrections`` is the load-bearing one: a system
that silently corrects a drug name or a dose is a patient-safety defect, not a feature. The node
must PROPOSE with provenance and leave the accept/reject decision to the clinician.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio import activity as temporal_activity

from harness.sensors.base import NEREntity
from harness.services.api_client import ApiServiceError, ResolvedPromptTemplateResponse
from harness.services.nlp_client import NlpServiceError
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import consultation_realtime as rt

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = {"consultationId": "c1", "externalPatientId": "p1", "userId": "u1"}
# A bound prompt template id. / — `consultation.proposeCorrections` and
#: `consultation.suggestions` BOTH resolve their system prompt from this binding, so a test of
#: either that omits it exercises the unconfigured-node degrade rather than the behaviour it
#: means to assert.
_TEMPLATE = "11111111-1111-1111-1111-111111111111"


def _payload(node_type: str, **overrides) -> NodeActivityInput:
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


class _FakeApi:
    """Resolves a provider/model, and records every loop event the node publishes.

    Also records the delivery publishes, so the assertions below keep testing the
    ANNOUNCEMENT boundary (ids/counts only) rather than accidentally testing that no delivery
    happens at all — the delivery is specified in ``test_realtime_delivery.py``.
    """

    def __init__(
        self,
        *,
        provider="lm-studio",
        model="a-model",
        found=True,
        approved=True,
        prompt_content="TENANT INSTRUCTION",
    ):
        self.provider = provider
        self.model = model
        self.found = found
        self.approved = approved
        self.prompt_content = prompt_content
        self.events: list[dict[str, Any]] = []
        self.policy_task_keys: list[Any] = []
        self.summaries: list[dict[str, Any]] = []
        self.assists: list[dict[str, Any]] = []
        self.resolved_ids: list[str] = []

    async def get_resolved_prompt_template(self, template_id, tenant_id=None):
        self.resolved_ids.append(template_id)
        return ResolvedPromptTemplateResponse(
            found=self.found,
            approved=self.approved,
            content=self.prompt_content,
            version_number=1,
        )

    async def get_policy(self, tenant_id, consultation_id=None, task_key=None, model_slug=None):
        self.policy_task_keys.append(task_key)
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
# W1 — consultation.realtimeSummary
# ---------------------------------------------------------------------------


class TestRealtimeSummary:
    @pytest.mark.asyncio
    async def test_summarises_each_window_and_announces_it_without_leaking_text(self, monkeypatch):
        """The incremental path: one generate + one loop event per window.

        The loop-event plane is a live UI feed, NOT a PHI transport
        (``EmitLoopEventInput``'s docstring), so the announcement may carry ordinals and
        lengths but never the summary text itself.
        """
        api = _FakeApi()
        text = _FakeText("first recap", "second recap")
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: text)

        payload = _payload(
            "consultation.realtimeSummary",
            config={"taskKey": "text.live", "windowChars": 20},
            bound_inputs={"in": {"text": "A" * 20 + "B" * 20}},
        )
        result = await rt.interpreter_consultation_realtime_summary(payload)

        assert result.status == "SUCCEEDED"
        assert result.output["summaries"] == ["first recap", "second recap"]
        assert result.output["windowCount"] == 2
        # Two generations — the batching is activity-side, never a per-token workflow signal.
        assert len(text.calls) == 2
        # One announcement per window, in order, carrying NO transcript or summary text.
        assert len(api.events) == 2
        for ordinal, event in enumerate(api.events, start=1):
            assert event["detail"]["ordinal"] == ordinal
            assert event["detail"]["total"] == 2
            blob = repr(event)
            assert "first recap" not in blob
            assert "second recap" not in blob
            assert "AAAA" not in blob

    @pytest.mark.asyncio
    async def test_unresolved_model_fails_closed(self, monkeypatch):
        """Selection is `failMode: closed` — never an env fallback, never a guessed model."""
        api = _FakeApi(provider=None, model=None)
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate without a selection")
        )

        result = await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "some transcript"}},
            )
        )
        assert result.status == "DEGRADED"
        assert "provider/model" in (result.reason or "").lower()

    @pytest.mark.asyncio
    async def test_a_failed_announcement_never_loses_the_summary(self, monkeypatch):
        """The live feed must never fail the loop (``report_loop_event``'s own posture)."""

        class _DeafApi(_FakeApi):
            async def report_loop_event(self, consultation_id, **kwargs):
                raise ApiServiceError("feed down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _DeafApi())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText("a recap"))

        result = await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "some transcript"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["summaries"] == ["a recap"]
        assert result.output["announced"] == 0

    @pytest.mark.asyncio
    async def test_no_bound_text_degrades(self):
        result = await rt.interpreter_consultation_realtime_summary(
            _payload("consultation.realtimeSummary", config={"taskKey": "text.live"})
        )
        assert result.status == "DEGRADED"
        assert "no text" in (result.reason or "").lower()

    @pytest.mark.asyncio
    async def test_text_failure_degrades_rather_than_raising(self, monkeypatch):
        class _FailingText:
            async def generate(self, **kwargs):
                raise TextServiceError("text down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FailingText())

        result = await rt.interpreter_consultation_realtime_summary(
            _payload(
                "consultation.realtimeSummary",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": "some transcript"}},
            )
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# W2 — consultation.suggestions
# ---------------------------------------------------------------------------


class TestSuggestions:
    @pytest.mark.asyncio
    async def test_returns_parsed_suggestions_from_the_text_service(self, monkeypatch):
        api = _FakeApi()
        text = _FakeText(
            '{"suggestions": [{"text": "Ask about penicillin allergy", "category": "history"}]}'
        )
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: text)

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "patient reports a rash after antibiotics"}},
            )
        )

        assert result.status == "SUCCEEDED"
        [suggestion] = result.output["suggestions"]
        assert suggestion["text"] == "Ask about penicillin allergy"
        assert suggestion["category"] == "history"
        # the item is delivered to a clinician, so it carries an id and a status
        # only the clinician advances. The delivery itself is specified separately.
        assert suggestion["status"] == "PROPOSED"
        assert suggestion["suggestionId"]
        assert result.output["count"] == 1
        # Delegated to apps/text — harness grows no second inference stack (rule 06).
        assert len(text.calls) == 1
        assert api.policy_task_keys == ["text.live"]

    @pytest.mark.asyncio
    async def test_unparseable_output_degrades_rather_than_fabricating(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "_text_client", lambda s: _FakeText("not json at all"))

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "something"}},
            )
        )
        assert result.status == "DEGRADED"
        assert result.output.get("suggestions") == []

    @pytest.mark.asyncio
    async def test_respects_max_suggestions(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: _FakeText('{"suggestions": [{"text": "a"}, {"text": "b"}, {"text": "c"}]}'),
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={
                    "taskKey": "text.live",
                    "maxSuggestions": 2,
                    "promptTemplateId": _TEMPLATE,
                },
                bound_inputs={"in": {"text": "something"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["count"] == 2

    @pytest.mark.asyncio
    async def test_unresolved_model_fails_closed(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(provider=None, model=None))
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate without a selection")
        )
        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "something"}},
            )
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# W3 — consultation.proposeCorrections (patient safety)
# ---------------------------------------------------------------------------


class TestProposeCorrections:
    @pytest.mark.asyncio
    async def test_proposes_with_provenance_and_never_rewrites_the_text(self, monkeypatch):
        """THE patient-safety contract for this node.

        A correction is a PROPOSAL the clinician accepts. The node must return the source text
        byte-identical, mark nothing as applied, and attribute every proposal to the detector
        that found the span and the model that proposed the replacement.
        """
        source = "Patient started on amoxicilin 500mg TID for otits media."
        entities = [
            NEREntity(text="amoxicilin", type="DRUG", start=19, end=29),
            NEREntity(text="otits media", type="CONDITION", start=44, end=55),
        ]

        async def _fake_extract(payload):
            return type("R", (), {"entities": entities})()

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "extract_entities", _fake_extract)
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: _FakeText(
                '{"proposals": ['
                '{"start": 19, "end": 29, "original": "amoxicilin",'
                ' "proposed": "amoxicillin", "category": "drugName",'
                ' "confidence": 0.96, "rationale": "misspelling of an RxNorm drug name"},'
                '{"start": 44, "end": 55, "original": "otits media",'
                ' "proposed": "otitis media", "category": "medicalTerm",'
                ' "confidence": 0.93, "rationale": "misspelling"}]}'
            ),
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": source}},
            )
        )

        assert result.status == "SUCCEEDED"
        # 1. The text is returned UNCHANGED. Nothing was rewritten.
        assert result.output["text"] == source
        # 2. Nothing is applied. The clinician is the one who accepts.
        assert result.output["applied"] is False
        assert result.output["appliedCount"] == 0
        # 3. Every proposal carries provenance for BOTH halves of how it was produced.
        proposals = result.output["proposals"]
        assert len(proposals) == 2
        for proposal in proposals:
            assert proposal["detectedBy"] == "nlp.ner"
            assert proposal["proposedBy"] == "lm-studio:a-model"
            assert proposal["rationale"]
            assert 0.0 <= proposal["confidence"] <= 1.0
            assert proposal["status"] == "PROPOSED"
            # The span it refers to must actually be the text it claims to replace.
            assert source[proposal["start"] : proposal["end"]] == proposal["original"]
        assert proposals[0]["proposed"] == "amoxicillin"

    @pytest.mark.asyncio
    async def test_drops_a_proposal_whose_span_does_not_match_the_source(self, monkeypatch):
        """A proposal that misreports its own span cannot be shown for one-click acceptance.

        Accepting it would splice a replacement over the WRONG characters — so an unverifiable
        proposal is dropped, and the drop is counted rather than hidden.
        """
        source = "Patient started on amoxicilin 500mg."

        async def _fake_extract(payload):
            return type("R", (), {"entities": [NEREntity(text="amoxicilin", start=19, end=29)]})()

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "extract_entities", _fake_extract)
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: _FakeText(
                '{"proposals": ['
                '{"start": 0, "end": 7, "original": "amoxicilin",'
                ' "proposed": "amoxicillin", "category": "drugName",'
                ' "confidence": 0.9, "rationale": "misspelling"}]}'
            ),
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": source}},
            )
        )
        assert result.output["proposals"] == []
        assert result.output["rejectedProposals"] == 1
        assert result.output["text"] == source

    @pytest.mark.asyncio
    async def test_no_entities_yields_no_proposals_without_calling_the_model(self, monkeypatch):
        async def _fake_extract(payload):
            return type("R", (), {"entities": []})()

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "extract_entities", _fake_extract)
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("nothing to correct — must not generate")
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "nothing clinical here"}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output["proposals"] == []

    @pytest.mark.asyncio
    async def test_ner_failure_degrades_rather_than_raising(self, monkeypatch):
        async def _failing_extract(payload):
            raise NlpServiceError("nlp down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(rt, "extract_entities", _failing_extract)

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "some clinical text"}},
            )
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_unresolved_model_fails_closed(self, monkeypatch):
        async def _fake_extract(payload):
            return type("R", (), {"entities": [NEREntity(text="x", start=0, end=1)]})()

        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(provider=None, model=None))
        monkeypatch.setattr(rt, "extract_entities", _fake_extract)
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate without a selection")
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": "x"}},
            )
        )
        assert result.status == "DEGRADED"


# ---------------------------------------------------------------------------
# the correction instruction is GOVERNED CONFIGURATION, never a literal
# ---------------------------------------------------------------------------


class TestCorrectionInstructionIsGoverned:
    """The durable corrector's system prompt comes from its OWN ``promptTemplateId`` binding.

    It used to be ``_CORRECTION_SYSTEM_PROMPT``, a module-level Python constant, while the very
    same engine's realtime caller (``LiveDocumentationService.resolveGovernedNodePrompt``) already
    resolved an APPROVED template and threw when it could not. Two configuration postures for one
    capability, and the durable half was the one that violated
    00-project-context.md Principles — *"a ... prompt ... is NOT a literal in
    code"*.

    The load-bearing assertion is the second one. A default here would mean the platform deciding
    how every tenant's clinical text is corrected, and — because a proposal is offered to a
    clinician for one-click acceptance — it would do so on a patient-safety surface. So an unbound
    template must stop the node VISIBLY and must never reach a model.
    """

    _SOURCE = "Patient started on amoxicilin 500mg."

    def _entities(self):
        async def _extract(payload):
            return type("R", (), {"entities": [NEREntity(text="amoxicilin", start=19, end=29)]})()

        return _extract

    @pytest.mark.asyncio
    async def test_the_system_prompt_is_the_bound_templates_content_verbatim(self, monkeypatch):
        api = _FakeApi(prompt_content="Correct THIS tenant's notes, this way.")
        text = _FakeText(
            '{"proposals": [{"start": 19, "end": 29, "original": "amoxicilin",'
            ' "proposed": "amoxicillin", "category": "drugName", "confidence": 0.9,'
            ' "rationale": "misspelling"}]}'
        )
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "extract_entities", self._entities())
        monkeypatch.setattr(rt, "_text_client", lambda s: text)

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert api.resolved_ids == [_TEMPLATE]
        assert text.calls[0]["system_prompt"] == "Correct THIS tenant's notes, this way."

    @pytest.mark.asyncio
    async def test_an_unbound_instruction_DEGRADES_and_never_falls_back_to_a_default(
        self, monkeypatch
    ):
        """THE mutation target. Re-introducing any in-code default turns this red."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(
            rt, "extract_entities", lambda *a, **k: pytest.fail("must not detect before it is configured")
        )
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: pytest.fail("must not generate without a tenant instruction"),
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "no instruction template is bound" in result.reason

    @pytest.mark.asyncio
    async def test_an_unapproved_instruction_DEGRADES(self, monkeypatch):
        """Same bar every other governed prompt is held to — DRAFT content never reaches a model."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(approved=False))
        monkeypatch.setattr(rt, "extract_entities", self._entities())
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate on an unapproved prompt")
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "no approved version" in result.reason

    @pytest.mark.asyncio
    async def test_a_missing_template_DEGRADES(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(found=False))
        monkeypatch.setattr(rt, "extract_entities", self._entities())
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate on a missing prompt")
        )

        result = await rt.interpreter_consultation_propose_corrections(
            _payload(
                "consultation.proposeCorrections",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "not found" in result.reason

    def test_the_module_holds_no_correction_prompt_literal(self):
        """Belt-and-braces on the mutation above, at the SOURCE rather than the behaviour.

        The behavioural test catches a fallback that is REACHED. This catches one that is merely
        re-introduced — a constant added back "for the tests" is the shape this defect took the
        first time.
        """
        import inspect

        source = inspect.getsource(rt)
        assert "_CORRECTION_SYSTEM_PROMPT" not in source
        # The deleted constant's own giveaway phrases. scoped this deliberately to
        # CORRECTION-specific prose because `_SUGGESTION_SYSTEM_PROMPT` was still a literal in
        # this same file, and widening it then would have made an unrelated node's fix a
        # prerequisite for this one. removed that literal, so the narrowing is retired
        # and the sibling is guarded by its own assertion below.
        for phrase in ("You review clinical text", "medical-term and drug-name errors"):
            assert phrase not in source


# ---------------------------------------------------------------------------
# the suggestion instruction is GOVERNED CONFIGURATION, never a literal
# ---------------------------------------------------------------------------


class TestSuggestionInstructionIsGoverned:
    """W2's system prompt comes from its OWN ``promptTemplateId`` binding.

    The identical defect fixed one node over, in the same file:
    ``_SUGGESTION_SYSTEM_PROMPT`` was a module-level Python constant, so a tenant could not read,
    change or version-pin how suggestions were put to its clinicians —
    00-project-context.md Principles, *"a ... prompt ... is NOT a literal in
    code"*.

    The load-bearing assertion is the unbound one. This node proposes clinical questions and
    checks to a clinician mid-consultation, so a silent in-code default would mean the platform
    deciding what every tenant's clinicians are prompted to ask. An unbound template must stop
    the node VISIBLY and must never reach a model.
    """

    _SOURCE = "patient reports a rash after antibiotics"

    @pytest.mark.asyncio
    async def test_the_system_prompt_is_the_bound_templates_content_verbatim(self, monkeypatch):
        api = _FakeApi(prompt_content="Suggest for THIS tenant, this way.")
        text = _FakeText('{"suggestions": [{"text": "Ask about penicillin allergy"}]}')
        monkeypatch.setattr(rt, "_api_client", lambda s: api)
        monkeypatch.setattr(rt, "_text_client", lambda s: text)

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )

        assert result.status == "SUCCEEDED"
        assert api.resolved_ids == [_TEMPLATE]
        assert text.calls[0]["system_prompt"] == "Suggest for THIS tenant, this way."

    @pytest.mark.asyncio
    async def test_an_unbound_instruction_DEGRADES_and_never_falls_back_to_a_default(
        self, monkeypatch
    ):
        """THE mutation target. Re-introducing any in-code default turns this red."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi())
        monkeypatch.setattr(
            rt,
            "_text_client",
            lambda s: pytest.fail("must not generate without a tenant instruction"),
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "no instruction template is bound" in result.reason

    @pytest.mark.asyncio
    async def test_an_unapproved_instruction_DEGRADES(self, monkeypatch):
        """DRAFT content never reaches a model — the same bar every governed prompt is held to."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(approved=False))
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate on an unapproved prompt")
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "no approved version" in result.reason

    @pytest.mark.asyncio
    async def test_a_missing_template_DEGRADES(self, monkeypatch):
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(found=False))
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate on a missing prompt")
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "not found" in result.reason

    @pytest.mark.asyncio
    async def test_an_empty_instruction_DEGRADES(self, monkeypatch):
        """An APPROVED but empty body is still no instruction, and must not reach a model."""
        monkeypatch.setattr(rt, "_api_client", lambda s: _FakeApi(prompt_content="   "))
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate on an empty prompt")
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live", "promptTemplateId": _TEMPLATE},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_resolution_precedes_the_policy_call_so_a_misconfigured_node_is_always_visible(
        self, monkeypatch
    ):
        """Configuration validity is not conditional on a peer service being reachable.

        Resolving after `_resolve_selection` would make an unbound node report
        `policy_fetch_unreachable` whenever the policy call failed too — the configuration gap
        masked by a transient one, and invisible on exactly the runs an operator investigates.
        """

        class _NoPolicyApi(_FakeApi):
            async def get_policy(self, *a, **k):
                raise ApiServiceError("policy plane down")

        monkeypatch.setattr(rt, "_api_client", lambda s: _NoPolicyApi())
        monkeypatch.setattr(
            rt, "_text_client", lambda s: pytest.fail("must not generate without an instruction")
        )

        result = await rt.interpreter_consultation_suggestions(
            _payload(
                "consultation.suggestions",
                config={"taskKey": "text.live"},
                bound_inputs={"in": {"text": self._SOURCE}},
            )
        )
        assert result.status == "DEGRADED"
        assert "no instruction template is bound" in result.reason

    def test_the_module_holds_no_suggestion_prompt_literal(self):
        """The source-level half of the mutation guard, as established for W3.

        The behavioural tests catch a fallback that is REACHED; this catches one merely
        re-introduced. Neither is sufficient alone — recorded a mutation where a
        paraphrased default kept a grep-only guard green.
        """
        import inspect

        source = inspect.getsource(rt)
        assert "_SUGGESTION_SYSTEM_PROMPT" not in source
        for phrase in (
            "You assist a clinician during a live consultation",
            "propose the most useful next questions",
            "Never state a diagnosis as fact",
        ):
            assert phrase not in source


# ---------------------------------------------------------------------------
# Registry membership — the three keys must be dispatchable
# ---------------------------------------------------------------------------


class TestRegistryMembership:
    def test_the_three_new_node_types_are_registered_and_implemented(self):
        from harness.temporal.interpreter.registry import NODE_REGISTRY

        for key, activity_name in (
            ("consultation.realtimeSummary", "interpreter.consultation_realtime_summary"),
            ("consultation.suggestions", "interpreter.consultation_suggestions"),
            (
                "consultation.proposeCorrections",
                "interpreter.consultation_propose_corrections",
            ),
        ):
            assert key in NODE_REGISTRY, f"{key} missing from NODE_REGISTRY"
            spec = NODE_REGISTRY[key]
            assert spec.implemented is True
            assert spec.activity_name == activity_name

    def test_correction_and_suggestion_nodes_write_nothing_externally(self):
        """Both are PROPOSAL surfaces — they must not be classed as external writers."""
        from harness.temporal.interpreter.registry import NODE_REGISTRY

        assert NODE_REGISTRY["consultation.suggestions"].external_write is False
        assert NODE_REGISTRY["consultation.proposeCorrections"].external_write is False

    def test_every_registered_node_activity_is_served_by_the_worker(self):
        """The gap this ticket found: the registry and the worker's activity list are two
        SEPARATE hand-maintained lists, and nothing checked they agree.

        `NODE_REGISTRY` decides what the interpreter DISPATCHES; `NODE_ACTIVITIES` decides what
        the worker SERVES (`worker.py` passes `INTERPRETER_ACTIVITIES` straight to `Worker(...)`).
        A node type present in the first but absent from the second compiles, validates, passes
        the cross-language parity guard — and then fails at runtime with an unregistered-activity
        error, because no worker can execute it. Every existing node happened to be in both;
        nothing enforced it.
        """
        from harness.temporal.interpreter.activities import NODE_ACTIVITIES
        from harness.temporal.interpreter.registry import NODE_REGISTRY

        served = {
            temporal_activity._Definition.from_callable(fn).name  # noqa: SLF001
            for fn in NODE_ACTIVITIES
        }
        missing = sorted(
            spec.activity_name
            for spec in NODE_REGISTRY.values()
            if spec.activity_name not in served
        )
        assert missing == [], f"registered node activities the worker does not serve: {missing}"
