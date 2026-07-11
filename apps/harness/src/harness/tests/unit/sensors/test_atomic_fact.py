"""Tests for the reference-free atomic-fact verifier (TASK-481 E2, Deliverable 1).

RED-first: written before ``sensors/inferential/atomic_fact.py`` exists. The verifier
is a **deterministic, reference-free** gate — it decomposes the note into atomic claims
(rule-based, NO model) and entails each against the transcript via an injected
:class:`NliEntailer` (a **self-hosted deterministic NLI**, NOT the LLM ``JudgeClient``;
a stub here — no network, no cloud). A grounded note passes; a note with a hallucinated
claim fails; an unverifiable/erroring backend DEGRADES (never auto-PASS) — the fail-safe
posture (the gate never silently affirms a claim on uncertainty or error).
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.inferential.atomic_fact import (
    NAME,
    AtomicFactSensor,
    DeterministicOverlapEntailer,
    decompose_claims,
)


class _StubNli:
    """Deterministic NLI stub: a hypothesis is entailed unless it carries a marker.

    Programmed, byte-deterministic, and NEVER touches a model/network — exactly the
    self-hosted-NLI contract the sensor entails against (no ``JudgeClient``).
    """

    def __init__(self, *, ungrounded_markers: tuple[str, ...] = (), error: Exception | None = None):
        self.calls: list[tuple[str, str]] = []
        self._markers = ungrounded_markers
        self._error = error

    async def entail(self, premise: str, hypothesis: str) -> bool:
        self.calls.append((premise, hypothesis))
        if self._error is not None:
            raise self._error
        return not any(m in hypothesis.lower() for m in self._markers)


def _ctx(note: str, transcript: str) -> SensorContext:
    return SensorContext(note_text=note, transcript_text=transcript)


_GROUNDED_NOTE = (
    '{"subjective": "Patient reports chest pain.", '
    '"objective": "Blood pressure is 140 over 90.", '
    '"assessment": "Hypertension.", "plan": "Start lisinopril."}'
)
_TRANSCRIPT = (
    "Patient reports chest pain. Blood pressure is 140 over 90. "
    "Assessment hypertension. Plan start lisinopril."
)


class TestDecomposition:
    def test_decomposes_soap_json_into_atomic_sentence_claims(self):
        claims = decompose_claims(_GROUNDED_NOTE)
        # One atomic claim per SOAP-section sentence (order-preserving), model-free.
        assert "Patient reports chest pain" in claims
        assert "Start lisinopril" in claims
        assert len(claims) >= 4

    def test_decomposes_plain_prose_into_sentences(self):
        claims = decompose_claims("Patient has a cough. Temperature is 38 degrees.")
        assert claims == ["Patient has a cough", "Temperature is 38 degrees"]

    def test_empty_or_whitespace_note_yields_no_claims(self):
        assert decompose_claims("") == []
        assert decompose_claims("   \n  ") == []


class TestAtomicFactSensor:
    @pytest.mark.asyncio
    async def test_grounded_note_passes(self):
        sensor = AtomicFactSensor(_StubNli(), threshold=0.8)
        result = await sensor.arun(_ctx(_GROUNDED_NOTE, _TRANSCRIPT))
        assert result.name == NAME
        assert result.passed is True
        assert result.score == 1.0
        assert result.claims_flagged == []
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_hallucinated_claim_fails(self):
        # The note asserts an ungrounded fact (a fabricated warfarin prescription);
        # the deterministic NLI marks it unentailed -> the claim is flagged, gate fails.
        note = (
            '{"subjective": "Patient reports chest pain.", '
            '"plan": "Start warfarin ten milligrams daily."}'
        )
        sensor = AtomicFactSensor(_StubNli(ungrounded_markers=("warfarin",)), threshold=0.8)
        result = await sensor.arun(_ctx(note, _TRANSCRIPT))
        assert result.passed is False
        assert result.score < 1.0
        assert any("warfarin" in c.lower() for c in result.claims_flagged)
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_backend_error_degrades_never_auto_passes(self):
        # A failing NLI backend must DEGRADE (passed=False, degraded=True) — never a
        # silent auto-PASS on an unverifiable claim (the fail-safe posture).
        sensor = AtomicFactSensor(_StubNli(error=RuntimeError("nli offline")), threshold=0.8)
        result = await sensor.arun(_ctx(_GROUNDED_NOTE, _TRANSCRIPT))
        assert result.passed is False
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_no_transcript_degrades_never_auto_passes(self):
        # A note with claims but no transcript to check against cannot be verified ->
        # degrade (never auto-PASS), mirroring entity_faithfulness.
        sensor = AtomicFactSensor(_StubNli(), threshold=0.8)
        result = await sensor.arun(_ctx(_GROUNDED_NOTE, ""))
        assert result.passed is False
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_no_claims_is_vacuous_pass(self):
        sensor = AtomicFactSensor(_StubNli(), threshold=0.8)
        result = await sensor.arun(_ctx("", _TRANSCRIPT))
        assert result.passed is True
        assert result.score == 1.0
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_deterministic_byte_identical_verdict_on_repeat(self):
        # AC-2: same input -> byte-identical SensorResult (no temperature/LLM nondeterminism).
        note = '{"plan": "Start warfarin."}'
        sensor = AtomicFactSensor(_StubNli(ungrounded_markers=("warfarin",)), threshold=0.8)
        first = await sensor.arun(_ctx(note, _TRANSCRIPT))
        second = await sensor.arun(_ctx(note, _TRANSCRIPT))
        assert first.model_dump() == second.model_dump()


class TestDeterministicOverlapEntailer:
    """The model-free default entailer — a self-hosted, deterministic, hermetic
    reference-free consistency check (NO model, NO network). The real NLI model
    (MiniCheck/AlignScore/HHEM-class) slots in behind the same interface later."""

    @pytest.mark.asyncio
    async def test_fully_grounded_claim_is_entailed(self):
        entailer = DeterministicOverlapEntailer()
        grounded = await entailer.entail("Patient has hypertension and diabetes.", "hypertension")
        assert grounded is True

    @pytest.mark.asyncio
    async def test_claim_with_novel_salient_token_not_entailed(self):
        # 'warfarin' never appears in the premise -> not entailed (catches fabrication).
        entailer = DeterministicOverlapEntailer()
        premise = "Patient was prescribed lisinopril for blood pressure."
        assert await entailer.entail(premise, "prescribed warfarin") is False

    @pytest.mark.asyncio
    async def test_deterministic_repeat(self):
        entailer = DeterministicOverlapEntailer()
        a = await entailer.entail("cough and fever noted", "cough noted")
        b = await entailer.entail("cough and fever noted", "cough noted")
        assert a == b
