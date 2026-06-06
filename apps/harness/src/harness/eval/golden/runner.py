"""Golden-set runner: score every case + aggregate.

Orchestrates the PDSQI-9 judge and (optionally) the faithfulness evaluator over
each case of a golden set, producing an :class:`EvalRunResult`. Threshold gating
lives in the CI runner (:mod:`harness.eval.ci`) so this stays a reusable
scoring primitive.
"""

from __future__ import annotations

from harness.eval.golden.sources import GoldenSetSource
from harness.eval.judge.pdsqi import PDSQI9Judge
from harness.eval.metrics.faithfulness import FaithfulnessEvaluator
from harness.eval.models import (
    PDSQI_LIKERT_DIMENSIONS,
    EvalCaseResult,
    EvalRunResult,
    GoldenSet,
)


class GoldenSetRunner:
    """Runs the configured metrics over a golden set."""

    def __init__(
        self,
        judge: PDSQI9Judge | None = None,
        faithfulness: FaithfulnessEvaluator | None = None,
    ) -> None:
        if judge is None and faithfulness is None:
            raise ValueError("GoldenSetRunner requires a judge and/or a faithfulness evaluator")
        self._judge = judge
        self._faithfulness = faithfulness

    async def run(self, golden_set: GoldenSet) -> EvalRunResult:
        case_results: list[EvalCaseResult] = []
        for case in golden_set.cases:
            pdsqi = await self._judge.score(case) if self._judge else None
            faith = await self._faithfulness.evaluate(case) if self._faithfulness else None
            case_results.append(
                EvalCaseResult(case_id=case.case_id, pdsqi=pdsqi, faithfulness=faith)
            )

        return EvalRunResult(
            golden_set_version=golden_set.version,
            judge_model=self._judge.model if self._judge else "n/a",
            case_results=case_results,
            aggregates=self._aggregate(case_results),
        )

    async def run_source(self, source: GoldenSetSource) -> EvalRunResult:
        return await self.run(source.load())

    def _aggregate(self, case_results: list[EvalCaseResult]) -> dict[str, float]:
        aggregates: dict[str, float] = {}

        if self._judge is not None:
            for dim in PDSQI_LIKERT_DIMENSIONS:
                values = [
                    cr.pdsqi.score.likert_items()[dim]
                    for cr in case_results
                    if cr.pdsqi is not None and dim in cr.pdsqi.score.likert_items()
                ]
                if values:
                    aggregates[f"pdsqi_{dim}"] = sum(values) / len(values)
            means = [cr.pdsqi.score.mean_quality() for cr in case_results if cr.pdsqi is not None]
            if means:
                aggregates["pdsqi_mean"] = sum(means) / len(means)

        if self._faithfulness is not None:
            scores = [cr.faithfulness.score for cr in case_results if cr.faithfulness is not None]
            if scores:
                aggregates["faithfulness"] = sum(scores) / len(scores)

        return aggregates
