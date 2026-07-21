"""Coverage / omission sensor tests.

Heuristic under test: every clinical entity extracted from the *transcript* must
be reflected in the note (by a note NER span or a verbatim mention). Transcript
entities missing from the note are flagged as omissions — the #1 clinical error.
A transcript diagnosis absent from the note -> coverage fails.
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.computational.coverage_omission import NAME, CoverageOmissionSensor

from ._fixtures import ner


class TestCoverageOmission:
    def test_transcript_diagnosis_absent_from_note_fails(self):
        ctx = SensorContext(
            note_text="Patient has hypertension. Continue lisinopril.",
            transcript_entities=[
                ner("hypertension", "CONDITION"),
                ner("diabetes", "CONDITION"),  # discussed but omitted from the note
                ner("lisinopril", "MEDICATION"),
            ],
        )
        result = CoverageOmissionSensor().run(ctx)
        assert result.name == NAME
        assert result.passed is False
        assert result.claims_flagged == ["diabetes"]
        assert result.score == pytest.approx(2 / 3)

    def test_all_transcript_entities_covered_passes(self):
        ctx = SensorContext(
            note_text="Hypertension and diabetes managed with lisinopril.",
            transcript_entities=[ner("hypertension"), ner("diabetes"), ner("lisinopril")],
        )
        result = CoverageOmissionSensor().run(ctx)
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.claims_flagged == []

    def test_coverage_via_note_entities(self):
        ctx = SensorContext(
            note_text="",
            soap_sections={"assessment": "Essential hypertension."},
            note_entities=[ner("hypertension")],
            transcript_entities=[ner("hypertension")],
        )
        assert CoverageOmissionSensor().run(ctx).passed is True

    def test_no_transcript_entities_is_vacuously_covered(self):
        result = CoverageOmissionSensor().run(SensorContext(note_text="anything"))
        assert result.passed is True
        assert result.score == pytest.approx(1.0)

    def test_threshold_controls_pass(self):
        # 2/3 covered == 0.667.
        ctx = SensorContext(
            note_text="hypertension lisinopril",
            transcript_entities=[ner("hypertension"), ner("lisinopril"), ner("diabetes")],
        )
        assert CoverageOmissionSensor(threshold=0.8).run(ctx).passed is False
        assert CoverageOmissionSensor(threshold=0.5).run(ctx).passed is True
