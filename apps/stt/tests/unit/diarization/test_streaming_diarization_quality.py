"""Hermetic unit tests for the diarization-accuracy metric scaffold.

Diarization scoring is a distinct metric owned separately from the streaming
quality scorecard. The math is pure stdlib (no model, no infra) so it is unit-testable with
nothing staged — the live capture on real 2-speaker clinical audio is what is
BLOCKED on the un-staged Sortformer model. These tests lock:

* DER decomposition (missed / false-alarm / confusion) with the optimal
  2-speaker label mapping (swapped hyp labels still score DER 0),
* Jaccard Error Rate, speaker-confusion rate, per-time attribution accuracy,
* the regression gate FAILS on a synthetic diarization regression and PASSES on a
  good scorecard (the "does the gate actually fail" adversarial-review focus),
* the de-identified synthetic 2-speaker clinical fixture loads and self-scores 0.

The module lives beside ``streaming_quality.py`` (a sibling, NOT a fork
of it).
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from tests.integration.streaming_diarization_quality import (
    assert_no_diarization_regression,
    attribution_accuracy,
    build_diarization_scorecard,
    diarization_error_rate,
    diarization_regression_report,
    jaccard_error_rate,
    load_diarization_thresholds,
    load_turns_fixture,
    speaker_confusion_rate,
)

REF = [(0.0, 2.0, "clinician"), (2.0, 4.0, "patient")]

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "e2e"
    / "fixtures"
    / "clinical"
    / "two_speaker_consult_01.turns.json"
)


def _approx(value: float, expected: float) -> bool:
    return math.isclose(value, expected, abs_tol=1e-9)


# ---------------------------------------------------------------------------
# DER + optimal 2-speaker mapping
# ---------------------------------------------------------------------------


class TestDiarizationErrorRate:
    def test_perfect_with_swapped_labels_is_zero(self) -> None:
        """The metric must be label-permutation invariant (hyp uses S0/S1)."""
        hyp = [(0.0, 2.0, "S1"), (2.0, 4.0, "S0")]
        report = diarization_error_rate(REF, hyp)
        assert _approx(report["der"], 0.0)
        assert _approx(report["confusion"], 0.0)
        assert _approx(report["missed"], 0.0)
        assert _approx(report["false_alarm"], 0.0)

    def test_single_speaker_hyp_is_half_confusion(self) -> None:
        hyp = [(0.0, 4.0, "S0")]
        report = diarization_error_rate(REF, hyp)
        assert _approx(report["confusion"], 2.0)
        assert _approx(report["der"], 0.5)

    def test_missed_detection(self) -> None:
        hyp = [(0.0, 2.0, "S0")]  # patient turn absent
        report = diarization_error_rate(REF, hyp)
        assert _approx(report["missed"], 2.0)
        assert _approx(report["false_alarm"], 0.0)
        assert _approx(report["der"], 0.5)

    def test_false_alarm(self) -> None:
        ref = [(0.0, 2.0, "clinician")]  # total ref speech = 2s
        hyp = [(0.0, 2.0, "S0"), (2.0, 4.0, "S1")]  # extra 2s of hyp speech
        report = diarization_error_rate(ref, hyp)
        assert _approx(report["false_alarm"], 2.0)
        assert _approx(report["der"], 1.0)

    def test_empty_hypothesis_is_all_missed(self) -> None:
        report = diarization_error_rate(REF, [])
        assert _approx(report["missed"], 4.0)
        assert _approx(report["der"], 1.0)

    def test_no_reference_speech_der_is_zero(self) -> None:
        report = diarization_error_rate([], [])
        assert _approx(report["der"], 0.0)


class TestJaccardErrorRate:
    def test_perfect_is_zero(self) -> None:
        hyp = [(0.0, 2.0, "S1"), (2.0, 4.0, "S0")]
        assert _approx(jaccard_error_rate(REF, hyp), 0.0)

    def test_single_speaker_hyp(self) -> None:
        # clinician matched to S0: union 4, err 2 -> 0.5; patient unmatched -> 1.0; mean 0.75
        hyp = [(0.0, 4.0, "S0")]
        assert _approx(jaccard_error_rate(REF, hyp), 0.75)


class TestConfusionAndAttribution:
    def test_confusion_rate(self) -> None:
        hyp = [(0.0, 4.0, "S0")]
        assert _approx(speaker_confusion_rate(REF, hyp), 0.5)

    def test_attribution_accuracy_perfect(self) -> None:
        hyp = [(0.0, 2.0, "S1"), (2.0, 4.0, "S0")]
        assert _approx(attribution_accuracy(REF, hyp), 1.0)

    def test_attribution_accuracy_half(self) -> None:
        hyp = [(0.0, 4.0, "S0")]
        assert _approx(attribution_accuracy(REF, hyp), 0.5)


# ---------------------------------------------------------------------------
# Scorecard + regression gate (must actually fail on regression)
# ---------------------------------------------------------------------------


class TestScorecardAndGate:
    def test_build_scorecard_shape(self) -> None:
        hyp = [(0.0, 2.0, "S1"), (2.0, 4.0, "S0")]
        card = build_diarization_scorecard(reference=REF, hypothesis=hyp)
        diar = card["diarization"]
        assert _approx(diar["der"], 0.0)
        assert _approx(diar["attribution_accuracy"], 1.0)
        assert "jaccard_error_rate" in diar
        assert "speaker_confusion_rate" in diar

    def test_good_scorecard_passes(self) -> None:
        thresholds = load_diarization_thresholds()
        card = {
            "diarization": {
                "der": 0.05,
                "jaccard_error_rate": 0.10,
                "speaker_confusion_rate": 0.02,
                "attribution_accuracy": 0.95,
            }
        }
        report = diarization_regression_report(card, thresholds)
        assert report["passed"] is True

    def test_regressed_der_fails_the_gate(self) -> None:
        """A synthetic DER regression must be caught (not asserted-only)."""
        thresholds = load_diarization_thresholds()
        card = {
            "diarization": {
                "der": 0.60,  # well past the bootstrap ceiling
                "jaccard_error_rate": 0.10,
                "speaker_confusion_rate": 0.02,
                "attribution_accuracy": 0.95,
            }
        }
        report = diarization_regression_report(card, thresholds)
        assert report["passed"] is False
        with pytest.raises(AssertionError):
            assert_no_diarization_regression(card, thresholds)

    def test_regressed_attribution_fails_the_gate(self) -> None:
        thresholds = load_diarization_thresholds()
        card = {
            "diarization": {
                "der": 0.05,
                "jaccard_error_rate": 0.10,
                "speaker_confusion_rate": 0.02,
                "attribution_accuracy": 0.10,  # below the floor
            }
        }
        report = diarization_regression_report(card, thresholds)
        assert report["passed"] is False

    def test_empty_scorecard_never_passes_vacuously(self) -> None:
        thresholds = load_diarization_thresholds()
        report = diarization_regression_report({"diarization": {}}, thresholds)
        assert report["passed"] is False


# ---------------------------------------------------------------------------
# De-identified synthetic 2-speaker clinical fixture
# ---------------------------------------------------------------------------


class TestClinicalFixture:
    def test_fixture_loads_two_speakers(self) -> None:
        fixture = load_turns_fixture(FIXTURE)
        roles = {t[2] for t in fixture.reference_turns}
        assert roles == {"clinician", "patient"}
        assert fixture.audio_seconds > 0

    def test_fixture_self_scores_zero_error(self) -> None:
        """A hypothesis identical to ground truth must score DER 0 / attribution 1."""
        fixture = load_turns_fixture(FIXTURE)
        report = diarization_error_rate(fixture.reference_turns, fixture.reference_turns)
        assert _approx(report["der"], 0.0)
        assert _approx(attribution_accuracy(fixture.reference_turns, fixture.reference_turns), 1.0)

    def test_fixture_turns_are_ordered_and_non_overlapping(self) -> None:
        fixture = load_turns_fixture(FIXTURE)
        turns = fixture.reference_turns
        for current, following in zip(turns, turns[1:], strict=False):
            assert current[1] <= following[0]  # sorted, non-overlapping (2-speaker scope)
