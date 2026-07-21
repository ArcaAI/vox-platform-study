"""Golden-set runner + pluggable source tests.

The golden-set source is an interface (Protocol) so the real
clinician-authored set (SME prerequisite) can be dropped in later; today a small
synthetic JSON fixture ships with the package. The runner scores every case with
the PDSQI-9 judge (+ optional faithfulness) and aggregates the results. No live LLM.
"""

from __future__ import annotations

import pytest

from harness.eval.golden import (
    GoldenSetRunner,
    InMemoryGoldenSetSource,
    JSONFileGoldenSetSource,
    default_golden_set_source,
)
from harness.eval.judge import OutputMode, PDSQI9Judge
from harness.eval.metrics.faithfulness import FaithfulnessEvaluator
from harness.eval.models import EvalRunResult, GoldenCase, GoldenSet

from ._stubs import StubClaimExtractor, StubClaimVerifier, StubJudgeClient, pdsqi_score_json


def _small_set() -> GoldenSet:
    return GoldenSet(
        version="test-v1",
        cases=[
            GoldenCase(
                case_id="a",
                source_documents=["cough, afebrile"],
                generated_note="Acute cough. <Note ID:1>",
            ),
            GoldenCase(
                case_id="b",
                source_documents=["BP 120/80, lisinopril 10mg"],
                generated_note="HTN on lisinopril 10 mg. <Note ID:1>",
            ),
        ],
    )


class TestSources:
    def test_inmemory_source_roundtrip(self):
        gs = _small_set()
        assert InMemoryGoldenSetSource(gs).load() is gs

    def test_json_file_source_loads_pinned_fixture(self):
        gs = default_golden_set_source().load()
        assert gs.version == "synthetic-v0.1.0"
        assert len(gs.cases) >= 3
        # the synthetic set carries fixture clinician ratings for calibration
        assert all(c.clinician_pdsqi is not None for c in gs.cases)

    def test_default_source_is_a_json_file_source(self):
        assert isinstance(default_golden_set_source(), JSONFileGoldenSetSource)

    def test_custom_source_is_pluggable(self):
        gs = _small_set()

        class _CustomSource:
            def load(self) -> GoldenSet:
                return gs

        # duck-typed Protocol — no inheritance needed
        assert _CustomSource().load() is gs


class TestRunner:
    @pytest.mark.asyncio
    async def test_runs_pdsqi_and_faithfulness_over_all_cases(self):
        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)
        faithfulness = FaithfulnessEvaluator(
            StubClaimExtractor(["c1", "c2"]), StubClaimVerifier({"c1"})
        )
        runner = GoldenSetRunner(judge=judge, faithfulness=faithfulness)

        result = await runner.run(_small_set())

        assert isinstance(result, EvalRunResult)
        assert result.golden_set_version == "test-v1"
        assert result.judge_model == "stub-judge"
        assert len(result.case_results) == 2
        for cr in result.case_results:
            assert cr.pdsqi is not None
            assert cr.faithfulness is not None
        # aggregates expose per-dimension PDSQI means + faithfulness mean
        assert result.aggregates["pdsqi_accurate"] == pytest.approx(5.0)
        assert result.aggregates["faithfulness"] == pytest.approx(0.5)
        assert "pdsqi_mean" in result.aggregates

    @pytest.mark.asyncio
    async def test_pdsqi_only_run(self):
        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)
        result = await runner.run(_small_set())
        assert all(cr.faithfulness is None for cr in result.case_results)
        assert "faithfulness" not in result.aggregates
        assert "pdsqi_accurate" in result.aggregates

    @pytest.mark.asyncio
    async def test_run_source_loads_then_runs(self):
        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)
        result = await runner.run_source(InMemoryGoldenSetSource(_small_set()))
        assert len(result.case_results) == 2

    @pytest.mark.asyncio
    async def test_requires_at_least_one_metric(self):
        with pytest.raises(ValueError):
            GoldenSetRunner()
