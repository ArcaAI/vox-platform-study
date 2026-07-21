"""Numeric/dose sensor tests.

Heuristic under test: every number/dose token in the note must cross-check
against the transcript. A dose in the note that differs from the transcript
(e.g. note says 20 mg, transcript says 10 mg) is flagged as fabricated/mismatched.
Bare single-digit list markers are ignored; missing transcript -> degraded.
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.computational.numeric_dose import NAME, NumericDoseSensor


class TestNumericDose:
    def test_dose_mismatch_fails(self):
        ctx = SensorContext(
            note_text="Continue lisinopril 20 mg daily.",
            transcript_text="Start lisinopril 10 mg once daily.",
        )
        result = NumericDoseSensor().run(ctx)
        assert result.name == NAME
        assert result.passed is False
        assert "20 mg" in result.claims_flagged
        assert result.score < 1.0

    def test_matching_dose_passes(self):
        ctx = SensorContext(
            note_text="Continue lisinopril 10 mg daily.",
            transcript_text="Start lisinopril 10 mg once daily.",
        )
        result = NumericDoseSensor().run(ctx)
        assert result.passed is True
        assert result.claims_flagged == []
        assert result.score == pytest.approx(1.0)

    def test_vitals_with_slash_match(self):
        ctx = SensorContext(
            note_text="BP 120/80.",
            transcript_text="Blood pressure was 120/80 today.",
        )
        assert NumericDoseSensor().run(ctx).passed is True

    def test_bare_list_markers_ignored(self):
        ctx = SensorContext(
            note_text="Plan: 1. Continue lisinopril 10 mg. 2. Follow up.",
            transcript_text="Continue lisinopril 10 mg and follow up.",
        )
        # "1" and "2" are list ordinals (single digit, no unit) -> ignored.
        result = NumericDoseSensor().run(ctx)
        assert result.passed is True
        assert result.claims_flagged == []

    def test_no_numbers_in_note_passes(self):
        ctx = SensorContext(note_text="Patient stable.", transcript_text="All good.")
        assert NumericDoseSensor().run(ctx).passed is True

    def test_numbers_with_no_transcript_is_degraded(self):
        ctx = SensorContext(note_text="lisinopril 10 mg", transcript_text="")
        result = NumericDoseSensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False

    def test_scans_structured_sections_when_note_text_empty(self):
        ctx = SensorContext(
            soap_sections={"plan": "Atorvastatin 40 mg at night."},
            transcript_text="Start atorvastatin 80 mg nightly.",
        )
        result = NumericDoseSensor().run(ctx)
        assert result.passed is False
        assert "40 mg" in result.claims_flagged
