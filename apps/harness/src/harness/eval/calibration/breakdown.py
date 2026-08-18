"""Decompose a completed eval run's judge↔reference agreement by stratum.

The gate reports ONE pooled ICC. That number alone cannot distinguish "the judge
disagrees" from "one lane contributes no variance", which is exactly the confusion that
made the `curated-v1.0.0` failure hard to read. This module re-computes ICC(2,1) and
Gwet AC2 over the same pairs, sliced by lane / split / level / dimension, from an
already-written `eval-report.json` — **no additional model calls**, so it is free to run
and can never change the run it describes.

It is also how the held-out split is honoured: `dev` and `holdout` ICC are reported
separately, so a reader can check whether a labelling rule generalises instead of taking
it on trust.

Usage::

    python -m harness.eval.calibration.breakdown \\
        --golden-set src/harness/eval/golden/fixtures/curated_v2.json \\
        --report      eval-report-curated-v2.json
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from harness.eval.calibration.reliability import calibration_report
from harness.eval.models import PDSQI_LIKERT_DIMENSIONS


@dataclass(frozen=True)
class Stratum:
    """Agreement statistics over one slice of the paired ratings."""

    name: str
    n: int
    icc: float | None
    ac2: float | None
    judge_mean: float
    ref_mean: float
    judge_sd: float
    ref_sd: float
    exact_agreement: float
    within_one: float

    def row(self) -> str:
        icc = "n/a" if self.icc is None else f"{self.icc:+.4f}"
        ac2 = "n/a" if self.ac2 is None else f"{self.ac2:.4f}"
        return (
            f"| {self.name} | {self.n} | {icc} | {ac2} | {self.judge_mean:.3f} | "
            f"{self.ref_mean:.3f} | {self.judge_sd:.3f} | {self.ref_sd:.3f} | "
            f"{self.exact_agreement:.3f} | {self.within_one:.3f} |"
        )


def _pairs(
    golden: dict[str, Any],
    report: dict[str, Any],
    predicate: Callable[[dict[str, Any]], bool],
) -> tuple[list[float], list[float]]:
    """Collect (judge, reference) Likert pairs for cases matching ``predicate``."""
    judge_by_id = {
        cr["case_id"]: (cr.get("pdsqi") or {}).get("score")
        for cr in report.get("case_results", [])
        if cr.get("pdsqi")
    }
    judge: list[float] = []
    human: list[float] = []
    for case in golden["cases"]:
        ref = case.get("clinician_pdsqi")
        got = judge_by_id.get(case["case_id"])
        if ref is None or got is None or not predicate(case):
            continue
        for dim in PDSQI_LIKERT_DIMENSIONS:
            a, b = got.get(dim), ref.get(dim)
            if a is None or b is None:
                continue
            judge.append(float(a))
            human.append(float(b))
    return judge, human


def stratum(name: str, judge: list[float], human: list[float]) -> Stratum:
    j = np.asarray(judge, dtype=float)
    h = np.asarray(human, dtype=float)
    if j.size == 0:
        return Stratum(name, 0, None, None, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    icc = ac2 = None
    if j.size >= 2:
        rep = calibration_report(j, h)
        icc, ac2 = rep.icc, rep.ac2
    return Stratum(
        name=name,
        n=int(j.size),
        icc=icc,
        ac2=ac2,
        judge_mean=float(j.mean()),
        ref_mean=float(h.mean()),
        judge_sd=float(j.std(ddof=1)) if j.size > 1 else 0.0,
        ref_sd=float(h.std(ddof=1)) if h.size > 1 else 0.0,
        exact_agreement=float(np.mean(j == h)),
        within_one=float(np.mean(np.abs(j - h) <= 1)),
    )


def _meta(case: dict[str, Any], key: str, default: str = "?") -> str:
    return str((case.get("metadata") or {}).get(key, default))


def breakdown(golden: dict[str, Any], report: dict[str, Any]) -> list[Stratum]:
    """Every stratum the set declares, plus a pooled row."""
    strata: list[Stratum] = [stratum("ALL", *_pairs(golden, report, lambda c: True))]

    def add(label: str, values: Iterable[str], key: str) -> None:
        for value in values:

            def matches(case: dict[str, Any], _v: str = value, _k: str = key) -> bool:
                return _meta(case, _k) == _v

            strata.append(stratum(f"{label}={value}", *_pairs(golden, report, matches)))

    strata.append(
        stratum("lane=quality", *_pairs(golden, report, lambda c: c.get("role") == "quality"))
    )
    strata.append(
        stratum(
            "lane=calibration", *_pairs(golden, report, lambda c: c.get("role") == "calibration")
        )
    )
    add("split", ["dev", "holdout"], "split")
    add("level", ["L5", "L4", "L3", "L2", "L1"], "level")
    add("complexity", ["low", "moderate", "high"], "complexity")
    return strata


def per_dimension(golden: dict[str, Any], report: dict[str, Any]) -> list[Stratum]:
    """Agreement for each PDSQI Likert dimension across all cases."""
    judge_by_id = {
        cr["case_id"]: (cr.get("pdsqi") or {}).get("score")
        for cr in report.get("case_results", [])
        if cr.get("pdsqi")
    }
    out: list[Stratum] = []
    for dim in PDSQI_LIKERT_DIMENSIONS:
        j: list[float] = []
        h: list[float] = []
        for case in golden["cases"]:
            ref = case.get("clinician_pdsqi")
            got = judge_by_id.get(case["case_id"])
            if ref is None or got is None:
                continue
            a, b = got.get(dim), ref.get(dim)
            if a is None or b is None:
                continue
            j.append(float(a))
            h.append(float(b))
        out.append(stratum(dim, j, h))
    return out


_HEAD = (
    "| stratum | n | ICC(2,1) | Gwet AC2 | judge mean | ref mean | judge SD | ref SD | "
    "exact | within 1 |\n|---|---|---|---|---|---|---|---|---|---|"
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m harness.eval.calibration.breakdown")
    parser.add_argument("--golden-set", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)

    golden = json.loads(Path(args.golden_set).read_text(encoding="utf-8"))
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))

    print(f"golden set : {golden['version']}  ({len(golden['cases'])} cases)")
    print(f"judge      : {report.get('judge_model')}")
    print(f"gate       : {'PASS' if report.get('passed') else 'FAIL'}  {report.get('failures')}")
    print()
    print("### By stratum\n")
    print(_HEAD)
    for row in breakdown(golden, report):
        if row.n:
            print(row.row())
    print()
    print("### By PDSQI dimension\n")
    print(_HEAD)
    for row in per_dimension(golden, report):
        if row.n:
            print(row.row())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
