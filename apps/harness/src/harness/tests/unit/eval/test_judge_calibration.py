"""Judge-calibration integration on the synthetic golden set (TASK-330, 0.7).

RED-first. Runs a *stubbed* PDSQI-9 judge through the real runner over the
shipped synthetic golden set (which carries fixture clinician ratings), pools the
Likert scores, and enforces the **ICC ≥ 0.8** release gate. Deterministic and
offline — no live LLM.
"""

from __future__ import annotations

import json

import pytest

from harness.eval.calibration import (
    CalibrationError,
    assert_judge_calibrated,
    calibration_report,
    pdsqi_likert_pairs,
)
from harness.eval.golden import GoldenSetRunner, default_golden_set_source
from harness.eval.judge import OutputMode, PDSQI9Judge
from harness.eval.models import PDSQI_DIMENSIONS, PDSQIScore

from ._stubs import MappingJudgeClient

# A small, deterministic per-case nudge so the "well-calibrated" judge agrees
# with clinicians WITHOUT being trivially identical (still ICC ≥ 0.8).
_CALIBRATED_NUDGE = {
    "synthetic-001-uri-good": {"succinct": +1},
    "synthetic-002-omission": {"thorough": +1},
    "synthetic-003-fabrication": {"accurate": +1},
    "synthetic-004-adequate": {"succinct": +1},
    "synthetic-005-verbose-disorganized": {"organized": +1},
}


def _score_to_json(score: PDSQIScore, nudge: dict[str, int] | None = None) -> str:
    out: dict[str, object] = {}
    for dim in PDSQI_DIMENSIONS:
        value = getattr(score, dim)
        if dim == "synthesized" and value is None:
            out[dim] = "NA"
            continue
        if nudge and dim in nudge and isinstance(value, int):
            value = max(1, min(5, value + nudge[dim]))
        out[dim] = value
    return json.dumps(out)


def _build_judge(mode: str) -> PDSQI9Judge:
    """Build a mapping-stub judge over the fixture, calibrated or not."""
    gs = default_golden_set_source().load()
    mapping: dict[str, str] = {}
    for case in gs.cases:
        key = case.generated_note[:28]
        clinician = case.clinician_pdsqi
        assert clinician is not None
        if mode == "calibrated":
            mapping[key] = _score_to_json(clinician, _CALIBRATED_NUDGE.get(case.case_id))
        else:  # "miscalibrated": invert each Likert score → strong disagreement
            inverted = clinician.model_copy()
            for dim in ("citation", "accurate", "thorough", "useful", "organized"):
                setattr(inverted, dim, 6 - getattr(clinician, dim))
            mapping[key] = _score_to_json(inverted)
    return PDSQI9Judge(
        MappingJudgeClient(mapping, default=_score_to_json(gs.cases[0].clinician_pdsqi)),
        output_mode=OutputMode.SCORE,
    )


async def _collect_pairs(mode: str):
    gs = default_golden_set_source().load()
    runner = GoldenSetRunner(judge=_build_judge(mode))
    result = await runner.run(gs)
    judge_scores = [cr.pdsqi.score for cr in result.case_results]
    clinician_scores = [c.clinician_pdsqi for c in gs.cases]
    return pdsqi_likert_pairs(judge_scores, clinician_scores)


class TestJudgeCalibrationGate:
    @pytest.mark.asyncio
    async def test_well_calibrated_judge_clears_icc_gate(self):
        judge, human = await _collect_pairs("calibrated")
        report = calibration_report(judge, human, icc_threshold=0.8)
        assert report.icc >= 0.8, f"calibrated judge ICC {report.icc:.4f} should clear 0.8"
        assert report.passed is True
        # Gwet AC2 reported alongside.
        assert -1.0 <= report.ac2 <= 1.0
        # The hard gate does not raise for a calibrated judge.
        assert_judge_calibrated(judge, human, icc_threshold=0.8)

    @pytest.mark.asyncio
    async def test_miscalibrated_judge_is_rejected(self):
        """The gate MUST fail when judge↔clinician ICC < 0.8."""
        judge, human = await _collect_pairs("miscalibrated")
        report = calibration_report(judge, human, icc_threshold=0.8)
        assert report.icc < 0.8
        with pytest.raises(CalibrationError):
            assert_judge_calibrated(judge, human, icc_threshold=0.8)
