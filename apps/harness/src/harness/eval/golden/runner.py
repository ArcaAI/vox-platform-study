"""Golden-set runner: score every case + aggregate.

Orchestrates the PDSQI-9 judge and (optionally) the faithfulness evaluator over
each case of a golden set, producing an :class:`EvalRunResult`. Threshold gating
lives in the CI runner (:mod:`harness.eval.ci`) so this stays a reusable
scoring primitive.
"""

from __future__ import annotations

import structlog

from harness.eval.golden.sources import GoldenSetSource
from harness.eval.judge.base import JudgeParseError
from harness.eval.judge.pdsqi import PDSQI9Judge
from harness.eval.metrics.faithfulness import FaithfulnessEvaluator
from harness.eval.models import (
    PDSQI_LIKERT_DIMENSIONS,
    EvalCaseResult,
    EvalRunResult,
    GoldenSet,
)

logger = structlog.get_logger(__name__)


class GoldenSetRunner:
    """Runs the configured metrics over a golden set."""

    def __init__(
        self,
        judge: PDSQI9Judge | None = None,
        faithfulness: FaithfulnessEvaluator | None = None,
        *,
        tolerate_judge_errors: bool = True,
    ) -> None:
        if judge is None and faithfulness is None:
            raise ValueError("GoldenSetRunner requires a judge and/or a faithfulness evaluator")
        self._judge = judge
        self._faithfulness = faithfulness
        # A flaky small/local judge can fail to emit *parseable* JSON for an
        # occasional case. Rather than aborting an entire (potentially long) run,
        # drop that case (pdsqi=None → excluded from aggregates + ICC) and log it.
        # NOTE: only genuine parse failures are tolerated — transport/API/model-load
        # errors (JudgeConnectionError) still propagate so a broken backend can never
        # masquerade as a green gate built from zero scored cases.
        self._tolerate_judge_errors = tolerate_judge_errors

    async def run(self, golden_set: GoldenSet) -> EvalRunResult:
        case_results: list[EvalCaseResult] = []
        dropped: list[str] = []
        for case in golden_set.cases:
            # PDSQI is scored for EVERY case: quality cases feed the quality
            # aggregates, calibration cases feed the judge↔reference ICC.
            pdsqi = None
            if self._judge is not None:
                try:
                    pdsqi = await self._judge.score(case)
                except JudgeParseError as exc:
                    # Genuine "model couldn't produce parseable JSON" — tolerable.
                    # (Transport/model-load errors are JudgeConnectionError and are
                    # deliberately NOT caught here, so they abort the run.)
                    if not self._tolerate_judge_errors:
                        raise
                    dropped.append(case.case_id)
                    logger.warning(
                        "judge_score_failed_case_dropped",
                        case_id=case.case_id,
                        error=str(exc),
                    )
            # Faithfulness is a quality-lane gate, so it is only computed on
            # quality cases (calibration cases deliberately fail it and are
            # excluded from the aggregate anyway).
            faith = (
                await self._faithfulness.evaluate(case)
                if self._faithfulness and case.role == "quality"
                else None
            )
            case_results.append(
                EvalCaseResult(case_id=case.case_id, pdsqi=pdsqi, faithfulness=faith)
            )

        if dropped:
            logger.warning(
                "judge_dropped_cases_summary",
                dropped_count=len(dropped),
                total=len(golden_set.cases),
                dropped_case_ids=dropped,
            )

        quality_ids = {c.case_id for c in golden_set.cases if c.role == "quality"}
        return EvalRunResult(
            golden_set_version=golden_set.version,
            judge_model=self._judge.model if self._judge else "n/a",
            case_results=case_results,
            aggregates=self._aggregate(case_results, quality_ids),
        )

    async def run_source(self, source: GoldenSetSource) -> EvalRunResult:
        return await self.run(source.load())

    def _aggregate(
        self, case_results: list[EvalCaseResult], quality_ids: set[str]
    ) -> dict[str, float]:
        """Aggregate the *quality-lane* metrics only.

        The PDSQI quality dimensions and faithfulness gate measure note quality,
        so they are pooled over the ``quality`` lane exclusively. Calibration-lane
        cases are still scored (for ICC) but never contribute to these gate
        aggregates — a release gate must not be graded on adversarial inputs.
        """
        aggregates: dict[str, float] = {}
        quality = [cr for cr in case_results if cr.case_id in quality_ids]

        if self._judge is not None:
            for dim in PDSQI_LIKERT_DIMENSIONS:
                values = [
                    cr.pdsqi.score.likert_items()[dim]
                    for cr in quality
                    if cr.pdsqi is not None and dim in cr.pdsqi.score.likert_items()
                ]
                if values:
                    aggregates[f"pdsqi_{dim}"] = sum(values) / len(values)
            means = [cr.pdsqi.score.mean_quality() for cr in quality if cr.pdsqi is not None]
            if means:
                aggregates["pdsqi_mean"] = sum(means) / len(means)

        if self._faithfulness is not None:
            scores = [cr.faithfulness.score for cr in quality if cr.faithfulness is not None]
            if scores:
                aggregates["faithfulness"] = sum(scores) / len(scores)

        return aggregates
