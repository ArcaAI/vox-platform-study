"""Judge-calibration reliability.

Compute inter-rater reliability between the LLM-as-judge and clinician ratings,
and enforce the release gate (ICC ≥ 0.8) before the judge is trusted.
"""

from __future__ import annotations

from harness.eval.calibration.pairing import pdsqi_likert_pairs
from harness.eval.calibration.reliability import (
    CalibrationError,
    CalibrationReport,
    assert_judge_calibrated,
    calibration_report,
    gwet_ac2,
    intraclass_correlation,
)

__all__ = [
    "CalibrationError",
    "CalibrationReport",
    "assert_judge_calibrated",
    "calibration_report",
    "gwet_ac2",
    "intraclass_correlation",
    "pdsqi_likert_pairs",
]
