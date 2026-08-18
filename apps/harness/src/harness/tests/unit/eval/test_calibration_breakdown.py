"""Per-stratum decomposition of judge↔reference agreement (offline, no model calls).

The pooled ICC the gate prints cannot distinguish "the judge disagrees" from "one lane
contributes no variance". These tests lock the decomposition that tells them apart — the
analysis that diagnosed the `curated-v1.0.0` failure — and the split reporting that keeps
the held-out cases honest.
"""

from __future__ import annotations

from harness.eval.calibration.breakdown import breakdown, per_dimension, stratum
from harness.eval.models import PDSQI_LIKERT_DIMENSIONS


def _case(case_id: str, role: str, split: str, level: str, scores: dict[str, int]) -> dict:
    return {
        "case_id": case_id,
        "role": role,
        "source_documents": ["s"],
        "generated_note": "n",
        "clinician_pdsqi": {**scores, "abstraction": 1, "voice_summ": 0, "voice_note": 0},
        "metadata": {"split": split, "level": level, "complexity": "low"},
    }


def _flat(value: int) -> dict[str, int]:
    return dict.fromkeys(PDSQI_LIKERT_DIMENSIONS, value)


def _report(rows: dict[str, dict[str, int]]) -> dict:
    return {
        "case_results": [
            {
                "case_id": cid,
                "pdsqi": {
                    "case_id": cid,
                    "model": "m",
                    "score": {**scores, "abstraction": 1, "voice_summ": 0, "voice_note": 0},
                },
            }
            for cid, scores in rows.items()
        ]
    }


def test_a_zero_variance_lane_is_visible_as_zero_variance() -> None:
    """The v1 failure signature: perfect agreement, SD 0.000, and ICC that cannot lift."""
    golden = {
        "version": "t",
        "cases": [
            _case("q1", "quality", "dev", "L5", _flat(5)),
            _case("q2", "quality", "dev", "L5", _flat(5)),
            _case("c1", "calibration", "dev", "L2", _flat(2)),
            _case("c2", "calibration", "dev", "L1", _flat(1)),
        ],
    }
    report = _report({"q1": _flat(5), "q2": _flat(5), "c1": _flat(2), "c2": _flat(1)})

    rows = {row.name: row for row in breakdown(golden, report)}
    quality = rows["lane=quality"]
    assert quality.judge_sd == 0.0
    assert quality.ref_sd == 0.0
    assert quality.exact_agreement == 1.0
    # Pooled across lanes there IS variance, and agreement is perfect -> ICC ~ 1.
    assert rows["ALL"].icc is not None
    assert rows["ALL"].icc > 0.99


def test_dev_and_holdout_are_reported_separately() -> None:
    golden = {
        "version": "t",
        "cases": [
            _case("d1", "calibration", "dev", "L5", _flat(5)),
            _case("d2", "calibration", "dev", "L1", _flat(1)),
            _case("h1", "calibration", "holdout", "L5", _flat(5)),
            _case("h2", "calibration", "holdout", "L1", _flat(1)),
        ],
    }
    # Judge agrees perfectly on dev, and is systematically off by 2 on holdout.
    report = _report({"d1": _flat(5), "d2": _flat(1), "h1": _flat(3), "h2": _flat(3)})

    rows = {row.name: row for row in breakdown(golden, report)}
    assert rows["split=dev"].n == 8 * 2
    assert rows["split=holdout"].n == 8 * 2
    assert rows["split=dev"].exact_agreement == 1.0
    assert rows["split=holdout"].exact_agreement == 0.0
    assert rows["split=dev"].icc > rows["split=holdout"].icc


def test_per_dimension_isolates_a_single_bad_dimension() -> None:
    golden = {
        "version": "t",
        "cases": [
            _case("a", "calibration", "dev", "L2", {**_flat(5), "accurate": 2}),
            _case("b", "calibration", "dev", "L1", {**_flat(1), "accurate": 1}),
        ],
    }
    report = _report(
        {"a": {**_flat(5), "accurate": 5}, "b": {**_flat(1), "accurate": 5}},
    )
    rows = {row.name: row for row in per_dimension(golden, report)}
    assert rows["accurate"].exact_agreement == 0.0
    assert rows["organized"].exact_agreement == 1.0


def test_within_one_is_the_tolerant_agreement_signal() -> None:
    row = stratum("x", [5, 4, 3], [4, 4, 4])  # off by +1, exact, off by -1
    assert row.exact_agreement == 1 / 3
    assert row.within_one == 1.0
    assert row.n == 3

    two_off = stratum("y", [5, 4, 3], [4, 4, 5])  # the last pair is off by 2
    assert two_off.within_one == 2 / 3


def test_unscored_cases_are_excluded_not_imputed() -> None:
    """A dropped case must shrink n, never be filled in with a fabricated score."""
    golden = {
        "version": "t",
        "cases": [
            _case("a", "calibration", "dev", "L5", _flat(5)),
            _case("dropped", "calibration", "dev", "L1", _flat(1)),
        ],
    }
    rows = {row.name: row for row in breakdown(golden, _report({"a": _flat(5)}))}
    assert rows["ALL"].n == 8
