"""Release-gate + report tests for the CI eval runner (TASK-330, task 0.6).

RED-first. The gate is pure + deterministic (no LLM): it compares a run's
aggregates against the configured release-gate thresholds (faithfulness, PDSQI
accurate/thorough/mean, and judge↔clinician ICC) and decides pass/fail. The
``main`` CLI entrypoint must exit non-zero when the gate fails so it is
release-blocking in CI.
"""

from __future__ import annotations

import json

import pytest

from harness.eval.calibration import CalibrationReport
from harness.eval.ci import apply_gate, judge_clinician_icc, main, run_and_gate, write_report
from harness.eval.config import EvalConfig
from harness.eval.golden import InMemoryGoldenSetSource
from harness.eval.judge import OutputMode, PDSQI9Judge
from harness.eval.models import (
    EvalCaseResult,
    EvalRunResult,
    GoldenCase,
    GoldenSet,
    PDSQIResult,
    PDSQIScore,
)

from ._stubs import StubJudgeClient, pdsqi_score_json


def _score(**over: int) -> PDSQIScore:
    base = {
        "citation": 4,
        "accurate": 5,
        "thorough": 4,
        "useful": 5,
        "organized": 4,
        "comprehensible": 5,
        "succinct": 4,
        "synthesized": 4,
        "abstraction": 1,
        "voice_summ": 0,
        "voice_note": 0,
    }
    base.update(over)
    return PDSQIScore(**base)


def _run(aggregates: dict[str, float]) -> EvalRunResult:
    return EvalRunResult(
        golden_set_version="v-test", judge_model="stub", case_results=[], aggregates=aggregates
    )


class TestApplyGate:
    def test_passes_when_all_present_metrics_meet_thresholds(self):
        run = _run(
            {"faithfulness": 0.92, "pdsqi_accurate": 4.6, "pdsqi_thorough": 4.1, "pdsqi_mean": 4.3}
        )
        gated = apply_gate(run, EvalConfig())
        assert gated.passed is True
        assert gated.failures == []
        assert gated.thresholds["faithfulness"] == EvalConfig().faithfulness_threshold

    def test_fails_on_low_faithfulness(self):
        run = _run({"faithfulness": 0.50, "pdsqi_accurate": 4.6, "pdsqi_mean": 4.3})
        gated = apply_gate(run, EvalConfig())
        assert gated.passed is False
        assert any("faithfulness" in f for f in gated.failures)

    def test_fails_on_low_pdsqi_accuracy(self):
        run = _run({"pdsqi_accurate": 3.0, "pdsqi_thorough": 4.1, "pdsqi_mean": 4.3})
        gated = apply_gate(run, EvalConfig())
        assert gated.passed is False
        assert any("pdsqi_accurate" in f for f in gated.failures)

    def test_absent_metric_is_not_gated(self):
        # PDSQI-only run: a missing faithfulness aggregate must not fail the gate.
        gated = apply_gate(
            _run({"pdsqi_mean": 4.3, "pdsqi_accurate": 4.5, "pdsqi_thorough": 4.0}), EvalConfig()
        )
        assert gated.passed is True
        assert "faithfulness" not in gated.thresholds

    def test_icc_below_threshold_blocks_release(self):
        run = _run({"pdsqi_mean": 4.3})
        failing = CalibrationReport(icc=0.61, ac2=0.55, n=40, k=2, icc_threshold=0.8)
        gated = apply_gate(run, EvalConfig(), calibration=failing)
        assert gated.passed is False
        assert any("icc" in f.lower() for f in gated.failures)
        assert gated.thresholds["icc"] == 0.8
        assert gated.aggregates["icc"] == 0.61
        assert gated.aggregates["gwet_ac2"] == 0.55


class TestJudgeClinicianICC:
    def _gs_and_run(self, judge_scores: list[PDSQIScore], clinician_scores: list[PDSQIScore]):
        cases = [
            GoldenCase(
                case_id=f"c{i}",
                source_documents=["src"],
                generated_note="note",
                clinician_pdsqi=clin,
            )
            for i, clin in enumerate(clinician_scores)
        ]
        gs = GoldenSet(version="v", cases=cases)
        run = EvalRunResult(
            golden_set_version="v",
            judge_model="stub",
            case_results=[
                EvalCaseResult(
                    case_id=f"c{i}",
                    pdsqi=PDSQIResult(case_id=f"c{i}", score=js, model="stub"),
                )
                for i, js in enumerate(judge_scores)
            ],
        )
        return gs, run

    def test_perfect_agreement_passes(self):
        scores = [
            _score(accurate=5, thorough=3),
            _score(accurate=4, thorough=5),
            _score(accurate=2, thorough=4),
        ]
        gs, run = self._gs_and_run(scores, [s.model_copy() for s in scores])
        report = judge_clinician_icc(gs, run, icc_threshold=0.8)
        assert report is not None
        assert report.passed is True
        assert report.icc >= 0.8

    def test_returns_none_without_clinician_ratings(self):
        cases = [GoldenCase(case_id="c0", source_documents=["s"], generated_note="n")]
        gs = GoldenSet(version="v", cases=cases)
        run = EvalRunResult(
            golden_set_version="v",
            judge_model="stub",
            case_results=[
                EvalCaseResult(
                    case_id="c0", pdsqi=PDSQIResult(case_id="c0", score=_score(), model="s")
                )
            ],
        )
        assert judge_clinician_icc(gs, run) is None


class TestReport:
    def test_write_report_roundtrips(self, tmp_path):
        gated = apply_gate(_run({"pdsqi_mean": 4.3}), EvalConfig())
        out = tmp_path / "eval-report.json"
        write_report(gated, out)
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["passed"] is True
        assert data["aggregates"]["pdsqi_mean"] == 4.3
        assert data["golden_set_version"] == "v-test"


def _pdsqi_only_golden_set() -> GoldenSet:
    return GoldenSet(
        version="synthetic-cli-v0",
        cases=[
            GoldenCase(case_id="cli-1", source_documents=["s1"], generated_note="note one"),
            GoldenCase(case_id="cli-2", source_documents=["s2"], generated_note="note two"),
        ],
    )


class TestRunAndGate:
    @pytest.mark.asyncio
    async def test_run_and_gate_pdsqi_only(self):
        judge = PDSQI9Judge(
            StubJudgeClient(pdsqi_score_json(), model="local-14b"), output_mode=OutputMode.SCORE
        )
        source = InMemoryGoldenSetSource(_pdsqi_only_golden_set())
        run = await run_and_gate(source, judge=judge, config=EvalConfig())
        assert run.passed is True
        assert run.aggregates["pdsqi_mean"] >= 4.0
        assert run.judge_model == "local-14b"


class TestMainCLI:
    def test_main_exits_zero_when_gate_passes(self, tmp_path):
        gs_path = tmp_path / "golden.json"
        gs_path.write_text(_pdsqi_only_golden_set().model_dump_json(), encoding="utf-8")
        report = tmp_path / "report.json"
        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)

        code = main(
            ["--golden-set", str(gs_path), "--output", str(report), "--no-faithfulness"],
            judge=judge,
        )
        assert code == 0
        assert json.loads(report.read_text(encoding="utf-8"))["passed"] is True

    def test_main_exits_nonzero_when_gate_fails(self, tmp_path):
        gs_path = tmp_path / "golden.json"
        gs_path.write_text(_pdsqi_only_golden_set().model_dump_json(), encoding="utf-8")
        report = tmp_path / "report.json"
        # accurate=2 (< 4.0 threshold) → release-blocking failure.
        judge = PDSQI9Judge(
            StubJudgeClient(pdsqi_score_json(accurate=2)), output_mode=OutputMode.SCORE
        )

        code = main(
            ["--golden-set", str(gs_path), "--output", str(report), "--no-faithfulness"],
            judge=judge,
        )
        assert code == 1
        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["passed"] is False
        assert any("pdsqi_accurate" in f for f in data["failures"])
