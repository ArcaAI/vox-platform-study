"""TASK-358 — deterministic-sensor calibration over a labeled fixture set (RED-first).

The harness gate used to ``FLAG`` essentially every consultation for mechanical
(not clinical) reasons: a markdown SOAP note never matched the JSON-schema gate
(``schema_validity`` degraded/0.0), and SentencePiece (``▁``) / BIO subword NER
artifacts (plus mic-check counting words) drove ``entity_faithfulness`` below its
zero-tolerance threshold. The net effect was no discriminative signal — a good
note and a bad note both FLAG.

These tests pin the *calibrated* behaviour: over one shared transcript, a good
note PASSes and each seeded defect routes to the correct FLAG/REGEN, **on the
common department/CATCHALL path where ``responseFormat`` is null** (the case that
previously degraded). The conservative-safety directions are preserved
(fabrication / wrong-dose stay FLAG; degraded inputs stay FLAG).

Maps to the ticket TDD list T1–T9. Reuses the ``_fixtures`` helpers and runs the
full computational stack via ``run_computational_sensors`` + ``aggregate``.
"""

from __future__ import annotations

import json
from typing import Any

from harness.sensors.aggregator import GateDecision, Verdict, aggregate
from harness.sensors.base import NEREntity, SensorResult
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.sensor_runner import run_computational_sensors

from ._fixtures import ner, response_format

# ── One shared transcript that fully grounds the good note ──────────────────────
TRANSCRIPT = (
    "Patient reports worsening hypertension over the past two weeks with "
    "occasional headache. Blood pressure today is 150/95 and heart rate is 78 bpm. "
    "We will continue lisinopril 10 mg daily, add amlodipine 5 mg once daily, "
    "and follow up in 4 weeks."
)

# Clinical entities the NLP service would extract from the transcript (coverage set).
TRANSCRIPT_ENTITIES: list[NEREntity] = [
    ner("hypertension", "DISEASE"),
    ner("headache", "SYMPTOM"),
    ner("lisinopril", "MEDICATION"),
    ner("amlodipine", "MEDICATION"),
]

# Clean note entities for the faithful note — every one grounded in the transcript.
GOOD_NOTE_ENTITIES: list[NEREntity] = [
    ner("hypertension", "DISEASE"),
    ner("headache", "SYMPTOM"),
    ner("lisinopril", "MEDICATION"),
    ner("amlodipine", "MEDICATION"),
]


def good_note_json() -> str:
    """A faithful, complete JSON SOAP note that covers every transcript entity."""
    return json.dumps(
        {
            "subjective": "Patient reports worsening hypertension over two weeks with occasional headache.",
            "objective": "Blood pressure 150/95. Heart rate 78 bpm.",
            "assessment": "Essential hypertension, poorly controlled.",
            "plan": "Continue lisinopril 10 mg daily. Add amlodipine 5 mg once daily. Follow up in 4 weeks.",
        }
    )


def good_note_markdown() -> str:
    """The same faithful note as a MARKDOWN SOAP note (``**Subjective:**`` headers)."""
    return (
        "**Subjective:** Patient reports worsening hypertension over two weeks with occasional headache.\n\n"
        "**Objective:** Blood pressure 150/95. Heart rate 78 bpm.\n\n"
        "**Assessment:** Essential hypertension, poorly controlled.\n\n"
        "**Plan:** Continue lisinopril 10 mg daily. Add amlodipine 5 mg once daily. Follow up in 4 weeks."
    )


def good_note_markdown_paren() -> str:
    """The faithful note with ``**SUBJECTIVE (S)**`` parenthetical-letter headers."""
    return (
        "**SUBJECTIVE (S)**\n"
        "Patient reports worsening hypertension over two weeks with occasional headache.\n\n"
        "**OBJECTIVE (O)**\n"
        "Blood pressure 150/95. Heart rate 78 bpm.\n\n"
        "**ASSESSMENT (A)**\n"
        "Essential hypertension, poorly controlled.\n\n"
        "**PLAN (P)**\n"
        "Continue lisinopril 10 mg daily. Add amlodipine 5 mg once daily. Follow up in 4 weeks."
    )


def wrong_dose_note_json() -> str:
    """Faithful structure but the lisinopril dose is wrong (note 20 mg vs tx 10 mg)."""
    return json.dumps(
        {
            "subjective": "Patient reports worsening hypertension over two weeks with occasional headache.",
            "objective": "Blood pressure 150/95. Heart rate 78 bpm.",
            "assessment": "Essential hypertension, poorly controlled.",
            "plan": "Continue lisinopril 20 mg daily. Add amlodipine 5 mg once daily. Follow up in 4 weeks.",
        }
    )


def omission_note_json() -> str:
    """A complete-structure note that OMITS headache and amlodipine (coverage < 0.8)."""
    return json.dumps(
        {
            "subjective": "Patient reports worsening hypertension over two weeks.",
            "objective": "Blood pressure 150/95. Heart rate 78 bpm.",
            "assessment": "Essential hypertension, poorly controlled.",
            "plan": "Continue lisinopril 10 mg daily. Follow up in 4 weeks.",
        }
    )


def schema_break_markdown() -> str:
    """A markdown note MISSING the Plan section (structural break, regen-fixable).

    All clinical content lives in S/O/A (so coverage still passes), and the word
    "Plan" only appears mid-line — never as a header — so the parser yields no
    ``plan`` section.
    """
    return (
        "**Subjective:** Patient reports worsening hypertension over two weeks with occasional headache.\n\n"
        "**Objective:** Blood pressure 150/95. Heart rate 78 bpm.\n\n"
        "**Assessment:** Essential hypertension, poorly controlled. Will continue lisinopril 10 mg "
        "daily and add amlodipine 5 mg once daily, with follow up in 4 weeks."
    )


def _run(
    note_text: str,
    *,
    note_entities: list[NEREntity],
    transcript_text: str = TRANSCRIPT,
    transcript_entities: list[NEREntity] | None = None,
    response_format_: dict[str, Any] | None = None,
) -> dict[str, SensorResult]:
    """Run the five computational sensors and return them keyed by name."""
    out = run_computational_sensors(
        note_text=note_text,
        transcript_text=transcript_text,
        note_entities=note_entities,
        transcript_entities=(
            TRANSCRIPT_ENTITIES if transcript_entities is None else transcript_entities
        ),
        response_format=response_format_,
        transcript_context_item_id="ctx-t1",
    )
    return {r.name: r for r in out.results}


def _verdict(
    note_text: str,
    *,
    note_entities: list[NEREntity],
    transcript_text: str = TRANSCRIPT,
    transcript_entities: list[NEREntity] | None = None,
    response_format_: dict[str, Any] | None = None,
    regens_remaining: int = 2,
) -> Verdict:
    out = run_computational_sensors(
        note_text=note_text,
        transcript_text=transcript_text,
        note_entities=note_entities,
        transcript_entities=(
            TRANSCRIPT_ENTITIES if transcript_entities is None else transcript_entities
        ),
        response_format=response_format_,
        transcript_context_item_id="ctx-t1",
    )
    return aggregate(
        out.results, regens_remaining=regens_remaining, expected=COMPUTATIONAL_SENSOR_NAMES
    )


class TestLabeledDiscrimination:
    # ── T1 — a faithful good note PASSes on the common (responseFormat=null) path ──
    def test_t1_good_json_passes(self):
        verdict = _verdict(good_note_json(), note_entities=GOOD_NOTE_ENTITIES)
        assert verdict.decision == GateDecision.PASS

    def test_t1_good_markdown_passes(self):
        verdict = _verdict(good_note_markdown(), note_entities=GOOD_NOTE_ENTITIES)
        assert verdict.decision == GateDecision.PASS

    # ── T2 — fabrication FLAGs via entity_faithfulness, NOT via schema ─────────────
    def test_t2_fabrication_flags_on_entity_faithfulness(self):
        fabricated = [*GOOD_NOTE_ENTITIES, ner("warfarin", "MEDICATION")]
        sensors = _run(good_note_json(), note_entities=fabricated)
        # The FLAG must come from the highest-harm fabrication check, not schema noise.
        assert sensors["schema_validity"].passed is True
        assert sensors["entity_faithfulness"].passed is False
        assert "warfarin" in sensors["entity_faithfulness"].claims_flagged

        verdict = _verdict(good_note_json(), note_entities=fabricated)
        assert verdict.decision == GateDecision.FLAG
        assert "warfarin" in verdict.claims_flagged

    # ── T3 — wrong dose FLAGs via numeric_dose, NOT via schema ─────────────────────
    def test_t3_wrong_dose_flags_on_numeric_dose(self):
        sensors = _run(wrong_dose_note_json(), note_entities=GOOD_NOTE_ENTITIES)
        assert sensors["schema_validity"].passed is True
        assert sensors["entity_faithfulness"].passed is True
        assert sensors["numeric_dose"].passed is False
        assert "20 mg" in sensors["numeric_dose"].claims_flagged

        verdict = _verdict(wrong_dose_note_json(), note_entities=GOOD_NOTE_ENTITIES)
        assert verdict.decision == GateDecision.FLAG

    # ── T4 — omission and schema-break are REGEN-fixable (budget remaining) ─────────
    def test_t4_omission_regens(self):
        sensors = _run(omission_note_json(), note_entities=[ner("hypertension"), ner("lisinopril")])
        assert sensors["schema_validity"].passed is True
        assert sensors["entity_faithfulness"].passed is True
        assert sensors["numeric_dose"].passed is True
        assert sensors["coverage_omission"].passed is False

        verdict = _verdict(
            omission_note_json(), note_entities=[ner("hypertension"), ner("lisinopril")]
        )
        assert verdict.decision == GateDecision.REGEN

    def test_t4_schema_break_regens_and_targets_plan(self):
        sensors = _run(schema_break_markdown(), note_entities=GOOD_NOTE_ENTITIES)
        assert sensors["schema_validity"].passed is False
        assert sensors["schema_validity"].degraded is False  # regen-fixable, not degraded
        assert "P" in sensors["schema_validity"].details["sections"]
        assert sensors["entity_faithfulness"].passed is True

        verdict = _verdict(schema_break_markdown(), note_entities=GOOD_NOTE_ENTITIES)
        assert verdict.decision == GateDecision.REGEN
        assert "P" in verdict.sections_to_regen

    # ── T5 — the D-A core: a complete markdown note scores schema_validity == 1.0 ──
    # in BOTH the responseFormat=null path AND the json_schema path.
    def test_t5_markdown_schema_validity_is_one_without_schema(self):
        for builder in (good_note_markdown, good_note_markdown_paren):
            sensors = _run(builder(), note_entities=GOOD_NOTE_ENTITIES, response_format_=None)
            sv = sensors["schema_validity"]
            assert sv.score == 1.0, builder.__name__
            assert sv.passed is True, builder.__name__

    def test_t5_markdown_schema_validity_is_one_with_json_schema(self):
        for builder in (good_note_markdown, good_note_markdown_paren):
            sensors = _run(
                builder(), note_entities=GOOD_NOTE_ENTITIES, response_format_=response_format()
            )
            sv = sensors["schema_validity"]
            assert sv.score == 1.0, builder.__name__
            assert sv.passed is True, builder.__name__

    def test_t5_json_schema_validity_is_one(self):
        sensors = _run(
            good_note_json(), note_entities=GOOD_NOTE_ENTITIES, response_format_=response_format()
        )
        assert sensors["schema_validity"].score == 1.0
        assert sensors["schema_validity"].passed is True

    # ── T6 — noisy-good: ▁/BIO subword note entities are cleaned/merged on the ─────
    # entity_faithfulness path, so a faithful note is no longer spuriously unfaithful.
    def test_t6_subword_note_entities_cleaned_on_faithfulness_path(self):
        noisy_entities = [
            NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=0, end=11),
            NEREntity(text="\u25815", type="B-DOSAGE", start=11, end=13),
            NEREntity(text="\u2581mg", type="I-DOSAGE", start=13, end=16),
            NEREntity(text="\u2581once", type="I-DOSAGE", start=16, end=21),
            NEREntity(text="\u2581daily", type="I-DOSAGE", start=21, end=27),
            NEREntity(text="\u2581One", type="O", start=40, end=44),  # mic-check artifact
            ner("hypertension", "DISEASE"),
        ]
        sensors = _run(good_note_json(), note_entities=noisy_entities)
        ef = sensors["entity_faithfulness"]
        # Subwords merge to amlodipine + "5 mg once daily"; ▁One is dropped → 3 entities.
        assert ef.details["total"] == 3
        assert ef.passed is True
        assert ef.score == 1.0
        assert ef.claims_flagged == []

        verdict = _verdict(good_note_json(), note_entities=noisy_entities)
        assert verdict.decision == GateDecision.PASS

    # ── T7 — mic-check counting tokens do not count as clinical entities ───────────
    def test_t7_mic_check_counting_tokens_are_not_clinical_entities(self):
        noisy_entities = [
            ner("hypertension", "DISEASE"),
            ner("lisinopril", "MEDICATION"),
            NEREntity(text="\u2581One", type="O", start=0, end=4),
            NEREntity(text="\u2581two", type="O", start=4, end=8),
            NEREntity(text="\u2581three", type="O", start=8, end=14),
        ]
        sensors = _run(good_note_json(), note_entities=noisy_entities)
        ef = sensors["entity_faithfulness"]
        # Only the two clinical entities survive the noise filter.
        assert ef.details["total"] == 2
        flagged = " ".join(ef.claims_flagged).lower()
        for word in ("one", "two", "three"):
            assert word not in flagged
        assert ef.passed is True

    # ── T8 — degraded inputs (no transcript) still FLAG (never auto-PASS) ──────────
    def test_t8_no_transcript_still_flags(self):
        sensors = _run(
            good_note_json(),
            note_entities=[ner("hypertension"), ner("lisinopril")],
            transcript_text="",
            transcript_entities=[],
        )
        assert sensors["entity_faithfulness"].degraded is True

        verdict = _verdict(
            good_note_json(),
            note_entities=[ner("hypertension"), ner("lisinopril")],
            transcript_text="",
            transcript_entities=[],
        )
        assert verdict.decision == GateDecision.FLAG

    # ── T9 — discrimination confusion summary over the labeled set ─────────────────
    def test_t9_confusion_summary_discriminates(self):
        cases: list[tuple[str, str, list[NEREntity], GateDecision]] = [
            ("good_json", good_note_json(), GOOD_NOTE_ENTITIES, GateDecision.PASS),
            ("good_markdown", good_note_markdown(), GOOD_NOTE_ENTITIES, GateDecision.PASS),
            (
                "good_markdown_paren",
                good_note_markdown_paren(),
                GOOD_NOTE_ENTITIES,
                GateDecision.PASS,
            ),
            (
                "fabrication",
                good_note_json(),
                [*GOOD_NOTE_ENTITIES, ner("warfarin", "MEDICATION")],
                GateDecision.FLAG,
            ),
            ("wrong_dose", wrong_dose_note_json(), GOOD_NOTE_ENTITIES, GateDecision.FLAG),
            (
                "omission",
                omission_note_json(),
                [ner("hypertension"), ner("lisinopril")],
                GateDecision.REGEN,
            ),
            ("schema_break", schema_break_markdown(), GOOD_NOTE_ENTITIES, GateDecision.REGEN),
        ]
        summary = {
            label: _verdict(note, note_entities=ents).decision for label, note, ents, _ in cases
        }
        # Degraded (no transcript) is its own row — exercised separately so the
        # shared-transcript cases above stay grounded.
        summary["degraded"] = _verdict(
            good_note_json(),
            note_entities=[ner("hypertension"), ner("lisinopril")],
            transcript_text="",
            transcript_entities=[],
        ).decision

        expected = {label: decision for label, _, _, decision in cases}
        expected["degraded"] = GateDecision.FLAG
        assert summary == expected
        # Not FLAG-always: the gate now produces all three decisions.
        assert set(summary.values()) == {GateDecision.PASS, GateDecision.REGEN, GateDecision.FLAG}
