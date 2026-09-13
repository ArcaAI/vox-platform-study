"""CI eval runner: score a pinned golden set, apply the release gate, report.

This is the release-blocking entrypoint the GitHub Actions eval workflow calls.
It cleanly separates three concerns:

* **scoring** (needs a model) — delegated to :class:`GoldenSetRunner`,
* **calibration** (judge↔clinician ICC / Gwet AC2) — :func:`judge_clinician_icc`,
* **gating** (pure, deterministic) — :func:`apply_gate`, which compares the run's
  aggregates to the configured thresholds and decides pass/fail.

The pure pieces are unit-tested offline. The CLI (:func:`main`) wires a live,
model-agnostic judge (LM Studio / Azure / Bedrock via env) for real/nightly runs,
writes a JSON report, and exits non-zero when the gate fails.

The harness stays SELF-CONTAINED: results are emitted to a JSON file / stdout, never
to Postgres. DB persistence of eval runs is a later phase via ``apps/api``.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import structlog

from harness.eval.calibration import CalibrationReport, calibration_report, pdsqi_likert_pairs
from harness.eval.config import EvalConfig, get_eval_config
from harness.eval.golden.runner import GoldenSetRunner
from harness.eval.golden.sources import (
    GoldenSetSource,
    JSONFileGoldenSetSource,
    default_golden_set_source,
)
from harness.eval.models import EvalRunResult, GoldenSet

if TYPE_CHECKING:
    from harness.eval.judge.pdsqi import PDSQI9Judge
    from harness.eval.metrics.faithfulness import FaithfulnessEvaluator

logger = structlog.get_logger(__name__)

# Maps a release-gate aggregate key → the EvalConfig threshold attribute. Only
# metrics *present* in a run are gated, so a PDSQI-only run isn't failed by a
# missing faithfulness score.
_PDSQI_THRESHOLDS: tuple[tuple[str, str], ...] = (
    ("faithfulness", "faithfulness_threshold"),
    ("pdsqi_accurate", "pdsqi_accurate_threshold"),
    ("pdsqi_thorough", "pdsqi_thorough_threshold"),
    ("pdsqi_mean", "pdsqi_mean_threshold"),
)


def judge_clinician_icc(
    golden_set: GoldenSet,
    run: EvalRunResult,
    *,
    icc_threshold: float = 0.8,
) -> CalibrationReport | None:
    """ICC(2,1) + Gwet AC2 between judge scores and fixture clinician ratings.

    Returns ``None`` when there aren't ≥2 paired observations (e.g. the golden
    set carries no clinician ratings), so calibration is simply skipped rather
    than failing the gate spuriously.
    """
    judge_by_id = {cr.case_id: cr.pdsqi.score for cr in run.case_results if cr.pdsqi is not None}
    judge_scores = []
    human_scores = []
    for case in golden_set.cases:
        if case.clinician_pdsqi is not None and case.case_id in judge_by_id:
            judge_scores.append(judge_by_id[case.case_id])
            human_scores.append(case.clinician_pdsqi)

    if len(judge_scores) < 2:
        return None

    judge_arr, human_arr = pdsqi_likert_pairs(judge_scores, human_scores)
    if judge_arr.size < 2:
        return None
    return calibration_report(judge_arr, human_arr, icc_threshold=icc_threshold)


def apply_gate(
    run: EvalRunResult,
    config: EvalConfig,
    *,
    calibration: CalibrationReport | None = None,
) -> EvalRunResult:
    """Compare aggregates to release-gate thresholds; set pass/fail + failures.

    Returns a copy of ``run`` with ``thresholds``/``passed``/``failures`` filled
    (and ``icc``/``gwet_ac2`` folded into ``aggregates`` when calibration ran).
    Pure + deterministic — no I/O, no model calls.
    """
    thresholds: dict[str, float] = {}
    failures: list[str] = []

    for key, attr in _PDSQI_THRESHOLDS:
        if key in run.aggregates:
            limit = float(getattr(config, attr))
            thresholds[key] = limit
            if run.aggregates[key] < limit:
                failures.append(f"{key}={run.aggregates[key]:.4f} < {limit}")

    aggregates = dict(run.aggregates)
    if calibration is not None:
        thresholds["icc"] = calibration.icc_threshold
        aggregates["icc"] = calibration.icc
        aggregates["gwet_ac2"] = calibration.ac2
        if not calibration.passed:
            failures.append(
                f"icc={calibration.icc:.4f} < {calibration.icc_threshold} "
                f"(Gwet AC2={calibration.ac2:.4f}, n={calibration.n})"
            )

    return run.model_copy(
        update={
            "aggregates": aggregates,
            "thresholds": thresholds,
            "passed": not failures,
            "failures": failures,
        }
    )


async def run_and_gate(
    source: GoldenSetSource,
    *,
    judge: PDSQI9Judge | None = None,
    faithfulness: FaithfulnessEvaluator | None = None,
    config: EvalConfig | None = None,
) -> EvalRunResult:
    """Score the golden set, compute calibration (if possible), apply the gate."""
    config = config or get_eval_config()
    golden_set = source.load()
    runner = GoldenSetRunner(
        judge=judge, faithfulness=faithfulness, case_concurrency=config.case_concurrency
    )
    run = await runner.run(golden_set)

    calibration = None
    if judge is not None and config.icc_gate_enabled:
        calibration = judge_clinician_icc(golden_set, run, icc_threshold=config.icc_threshold)

    return apply_gate(run, config, calibration=calibration)


def write_report(run: EvalRunResult, path: str | Path) -> Path:
    """Persist the eval run as pretty JSON (the CI artifact)."""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(run.model_dump_json(indent=2), encoding="utf-8")
    return out


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m harness.eval.ci",
        description="Run the PDSQI-9 / faithfulness eval gate over a pinned golden set.",
    )
    parser.add_argument(
        "--golden-set",
        default=None,
        help="Path to a golden-set JSON file (defaults to the packaged synthetic fixture).",
    )
    parser.add_argument(
        "--output",
        default="eval-report.json",
        help="Where to write the JSON eval report.",
    )
    parser.add_argument(
        "--no-faithfulness",
        action="store_true",
        help="Skip the RAGAS-style faithfulness metric (PDSQI-9 only).",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    judge: PDSQI9Judge | None = None,
    faithfulness: FaithfulnessEvaluator | None = None,
) -> int:
    """CLI entrypoint. Returns 0 when the gate passes, 1 when it fails.

    ``judge``/``faithfulness`` can be injected (tests/offline); otherwise a live,
    model-agnostic judge is built from env/config.
    """
    args = _build_arg_parser().parse_args(argv)
    config = get_eval_config()

    source: GoldenSetSource = (
        JSONFileGoldenSetSource(args.golden_set) if args.golden_set else default_golden_set_source()
    )

    if judge is None:
        # Lazy: only construct a live backend when one wasn't injected.
        from harness.eval.judge.pdsqi import PDSQI9Judge
        from harness.eval.judge.prompts import OutputMode
        from harness.eval.judge.providers import build_judge_client
        from harness.eval.judge.selection import (
            JudgeSelectionUnavailable,
            resolve_eval_judge_selection,
        )
        from harness.eval.metrics.faithfulness import build_faithfulness_evaluator

        # Judge SELECTION is DB-resident and fail-closed (owner decision D-B): the
        # provider/model come from the SYSTEM ``harness.judge`` AiRoutingPolicy default row, exactly
        # as the Temporal runtime resolves them. Env keeps supplying only the
        # CONNECTION config (base_url / api_key / decoding knobs). There is no env
        # fallback for the selection — a gate that grades with a different judge than
        # the platform selects is worse than a gate that refuses to run.
        try:
            selection = asyncio.run(resolve_eval_judge_selection())
        except JudgeSelectionUnavailable as exc:
            print(f"[eval-gate] FAIL  judge selection unavailable (fail-closed): {exc}")
            logger.error("eval_gate_judge_selection_unavailable", error=str(exc))
            return 2
        judge_config = config.judge.model_copy(
            update={"provider": selection.provider, "model": selection.model}
        )
        config = config.model_copy(update={"judge": judge_config})
        print(
            f"[eval-gate] judge selection: {selection.model} "
            f"(provider={selection.provider}, slug={selection.model_slug}, "
            f"tier={selection.tier}) — resolved from the database, not the environment"
        )

        client = build_judge_client(config.judge)
        judge = PDSQI9Judge(
            client,
            output_mode=OutputMode(config.judge.output_mode),
            anchored=config.judge.anchored,
            self_consistency=config.judge.self_consistency,
            sc_temperature=config.judge.sc_temperature,
            seed=config.judge.seed,
            # TASK-968 — the CI gate runs on the in-code FLOOR (reasoning off), not on env
            # and not on the control plane: this is a `python -m harness.eval.ci` process in
            # a GitLab job, where the gateway is not reachable and a 5s pull per run would
            # buy a timeout rather than a value. A platform admin's tuning applies to the
            # deployed judge (the `/eval/run` endpoint and the live inferential pass); the
            # gate stays on one fixed, reproducible posture, which is what a gate wants.
            reasoning_mode=config.judge.reasoning_mode,
            suppress_reasoning=config.judge.suppress_reasoning,
        )
        if not args.no_faithfulness and faithfulness is None:
            faithfulness = build_faithfulness_evaluator(client)

    run = asyncio.run(run_and_gate(source, judge=judge, faithfulness=faithfulness, config=config))
    report_path = write_report(run, args.output)

    status = "PASS" if run.passed else "FAIL"
    logger.info(
        "eval_gate_complete",
        status=status,
        golden_set_version=run.golden_set_version,
        judge_model=run.judge_model,
        aggregates=run.aggregates,
        thresholds=run.thresholds,
        failures=run.failures,
        report=str(report_path),
    )
    print(f"[eval-gate] {status}  report={report_path}")
    for failure in run.failures:
        print(f"  - FAILED: {failure}")

    return 0 if run.passed else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
