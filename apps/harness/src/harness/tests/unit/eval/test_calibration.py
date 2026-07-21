"""Judge-calibration reliability tests.

These tests pin the statistics used to validate the PDSQI-9
LLM-as-judge against clinician ratings BEFORE trusting any automated score:

* ICC(2,1) — two-way random-effects, absolute-agreement, single rater. The
  research target is the reasoning-judge ICC ≈0.818 vs clinicians
  (npj Digital Medicine 2025 / Epic PDSQI-9), so the release gate is **ICC ≥ 0.8**.
* Gwet's AC2 — chance-corrected agreement robust to the prevalence/"paradox"
  problems of Cohen's κ, with ordinal weights for 1–5 Likert scores.

All data here is deterministic and offline (no LLM calls). Reference values:

* ICC(2,1) for the canonical Shrout & Fleiss (1979) 6×4 matrix = 0.2898.
* Gwet AC1 (identity weights) for the hand example = 0.6279.
* Gwet AC2 (quadratic weights) for the same example = 0.8182.
"""

from __future__ import annotations

import numpy as np
import pytest

from harness.eval.calibration import (
    CalibrationError,
    assert_judge_calibrated,
    calibration_report,
    gwet_ac2,
    intraclass_correlation,
)

# Shrout & Fleiss (1979) — 6 targets × 4 raters; ICC(2,1) is a widely published 0.2898.
SHROUT_FLEISS = np.array(
    [
        [9, 2, 5, 8],
        [6, 1, 3, 2],
        [8, 4, 6, 8],
        [7, 1, 2, 6],
        [10, 5, 6, 9],
        [6, 2, 4, 7],
    ],
    dtype=float,
)


class TestIntraclassCorrelation:
    def test_perfect_agreement_is_one(self):
        ratings = np.array([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]], dtype=float)
        assert intraclass_correlation(ratings) == pytest.approx(1.0, abs=1e-9)

    def test_matches_shrout_fleiss_reference(self):
        """ICC(2,1) on the canonical matrix is 0.2898 (Shrout & Fleiss 1979)."""
        assert intraclass_correlation(SHROUT_FLEISS) == pytest.approx(0.2898, abs=0.01)

    def test_requires_at_least_two_raters(self):
        with pytest.raises(ValueError):
            intraclass_correlation(np.array([[1.0], [2.0], [3.0]]))


class TestGwetAC2:
    EXAMPLE = np.array([[1, 1], [2, 2], [1, 2], [3, 3]], dtype=float)

    def test_perfect_agreement_is_one(self):
        ratings = np.array([[1, 1], [2, 2], [3, 3], [5, 5]], dtype=float)
        assert gwet_ac2(ratings, categories=[1, 2, 3, 4, 5]) == pytest.approx(1.0, abs=1e-9)

    def test_identity_weights_match_ac1_reference(self):
        # Identity weights reduce AC2 to Gwet's AC1: hand-computed 0.6279.
        ac1 = gwet_ac2(self.EXAMPLE, categories=[1, 2, 3], weights="identity")
        assert ac1 == pytest.approx(0.6279, abs=1e-3)

    def test_quadratic_weights_reference(self):
        # Quadratic (ordinal) weights: hand-computed 0.8182.
        ac2 = gwet_ac2(self.EXAMPLE, categories=[1, 2, 3], weights="quadratic")
        assert ac2 == pytest.approx(0.8182, abs=1e-3)


class TestCalibrationGate:
    """The release gate: judge↔clinician agreement must clear ICC ≥ 0.8."""

    @staticmethod
    def _well_calibrated() -> tuple[np.ndarray, np.ndarray]:
        """A judge that agrees with clinicians within ±1 on a spread of scores
        → ICC ≥ 0.8 (deterministic)."""
        human = np.array([5, 4, 3, 5, 2, 4, 1, 5, 3, 4, 2, 5, 1, 3, 4, 5, 2, 4, 3, 5], dtype=float)
        judge = human.copy()
        # small, structured deviations on a few items (still strongly concordant)
        judge[2] += 1
        judge[6] += 1
        judge[10] -= 1
        judge[16] += 1
        return judge, human

    @staticmethod
    def _poorly_calibrated() -> tuple[np.ndarray, np.ndarray]:
        """A judge that systematically disagrees → ICC < 0.8."""
        human = np.array([5, 4, 3, 5, 2, 4, 1, 5, 3, 4, 2, 5, 1, 3, 4, 5, 2, 4, 3, 5], dtype=float)
        judge = np.array([1, 5, 2, 1, 5, 1, 5, 2, 1, 5, 4, 1, 5, 1, 2, 1, 5, 1, 5, 2], dtype=float)
        return judge, human

    def test_well_calibrated_judge_passes_icc_gate(self):
        judge, human = self._well_calibrated()
        report = calibration_report(judge, human, icc_threshold=0.8)
        assert report.icc >= 0.8
        assert report.passed is True
        assert report.n == 20
        # AC2 is reported alongside ICC for robustness.
        assert -1.0 <= report.ac2 <= 1.0
        # Does not raise.
        assert_judge_calibrated(judge, human, icc_threshold=0.8)

    def test_poorly_calibrated_judge_fails_icc_gate(self):
        """This is the hard gate: a judge below ICC 0.8 MUST be rejected."""
        judge, human = self._poorly_calibrated()
        report = calibration_report(judge, human, icc_threshold=0.8)
        assert report.icc < 0.8
        assert report.passed is False
        with pytest.raises(CalibrationError):
            assert_judge_calibrated(judge, human, icc_threshold=0.8)
