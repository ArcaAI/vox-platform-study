"""Golden-set runner + pluggable source tests.

The golden-set source is an interface (Protocol) so the real
clinician-authored set (SME prerequisite) can be dropped in later; today a small
synthetic JSON fixture ships with the package. The runner scores every case with
the PDSQI-9 judge (+ optional faithfulness) and aggregates the results. No live LLM.
"""

from __future__ import annotations

import asyncio

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


def _n_cases(n: int) -> GoldenSet:
    return GoldenSet(
        version="test-v1",
        cases=[
            GoldenCase(
                case_id=f"c{i}",
                source_documents=[f"finding {i}"],
                generated_note=f"Note {i}. <Note ID:1>",
            )
            for i in range(n)
        ],
    )


class _ConcurrencyTrackingJudgeClient:
    """Stub judge client that records the peak number of in-flight calls.

    TASK-713 — proves ``GoldenSetRunner`` actually overlaps case scoring
    (rather than awaiting one case fully before starting the next), which is
    the lever the CI wall-clock budget depends on. A short ``asyncio.sleep``
    per call gives concurrent tasks a window to overlap; without it every
    ``await`` could resolve on the same event-loop tick and hide a bug where
    concurrency is silently 1 regardless of the configured bound.
    """

    def __init__(self, response: str, *, delay_s: float = 0.02) -> None:
        self._response = response
        self._delay_s = delay_s
        self.model = "stub-judge"
        self.in_flight = 0
        self.max_in_flight = 0

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        json_mode: bool = False,
        temperature: float | None = None,
        seed: int | None = None,
    ) -> str:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self._delay_s)
            return self._response
        finally:
            self.in_flight -= 1


class TestRunnerConcurrency:
    """``GoldenSetRunner`` fans case scoring out concurrently (TASK-713).

    CI wall-clock for the 18-case golden set is only viable against a live
    judge backend if cases overlap rather than run strictly one-at-a-time; see
    ``docs/implementation/TASK-713-Harness-Eval-Gate/README.md`` §7 for the
    measured per-call latency this is derisking.
    """

    @pytest.mark.asyncio
    async def test_default_concurrency_is_sequential(self):
        client = _ConcurrencyTrackingJudgeClient(pdsqi_score_json())
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge)  # case_concurrency defaults to 1

        result = await runner.run(_n_cases(5))

        assert client.max_in_flight == 1
        assert len(result.case_results) == 5

    @pytest.mark.asyncio
    async def test_case_concurrency_overlaps_judge_calls(self):
        client = _ConcurrencyTrackingJudgeClient(pdsqi_score_json())
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge, case_concurrency=4)

        result = await runner.run(_n_cases(6))

        # 6 cases, cap 4 → peak overlap must exceed 1 and never exceed the cap.
        assert client.max_in_flight > 1
        assert client.max_in_flight <= 4
        assert len(result.case_results) == 6

    @pytest.mark.asyncio
    async def test_concurrent_run_aggregates_match_sequential_run(self):
        # Same cases/scores, only concurrency differs → aggregates must be
        # identical (concurrency is a scheduling detail, never a scoring one).
        cases = _n_cases(6)

        seq_judge = PDSQI9Judge(
            _ConcurrencyTrackingJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE
        )
        seq_runner = GoldenSetRunner(judge=seq_judge)
        seq_result = await seq_runner.run(cases)

        conc_judge = PDSQI9Judge(
            _ConcurrencyTrackingJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE
        )
        conc_runner = GoldenSetRunner(judge=conc_judge, case_concurrency=4)
        conc_result = await conc_runner.run(cases)

        assert seq_result.aggregates == conc_result.aggregates
        assert {cr.case_id for cr in seq_result.case_results} == {
            cr.case_id for cr in conc_result.case_results
        }

    @pytest.mark.asyncio
    async def test_concurrent_run_still_tolerates_a_dropped_parse_failure(self):
        # One case's judge response is unparseable JSON → JudgeParseError is
        # still tolerated (case dropped) under concurrency, exactly as the
        # sequential path already tolerates it (runner.py's own contract).
        def flaky(messages: list[dict[str, str]]) -> str:
            # StubJudgeClient calls a callable response synchronously (see
            # ``_stubs.py``) — not a coroutine function.
            blob = " ".join(m["content"] for m in messages)
            if "Note 2." in blob:
                return "not json at all"
            return pdsqi_score_json()

        client = StubJudgeClient(flaky)
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge, case_concurrency=4)

        result = await runner.run(_n_cases(5))

        dropped = [cr for cr in result.case_results if cr.pdsqi is None]
        assert len(dropped) == 1
        assert dropped[0].case_id == "c2"
        assert len(result.case_results) == 5

    @pytest.mark.asyncio
    async def test_connection_error_still_propagates_under_concurrency(self):
        class _AlwaysConnectionError:
            model = "stub-judge"

            async def complete(self, messages, *, json_mode=False, temperature=None, seed=None):
                from harness.eval.judge.base import JudgeConnectionError

                raise JudgeConnectionError("backend unreachable")

        judge = PDSQI9Judge(_AlwaysConnectionError(), output_mode=OutputMode.SCORE)
        runner = GoldenSetRunner(judge=judge, case_concurrency=4)

        with pytest.raises(Exception):  # noqa: B017 — JudgeConnectionError, imported above
            await runner.run(_n_cases(5))
