"""Release-gate + report tests for the CI eval runner.

The gate is pure + deterministic (no LLM): it compares a run's
aggregates against the configured release-gate thresholds (faithfulness, PDSQI
accurate/thorough/mean, and judge↔clinician ICC) and decides pass/fail. The
``main`` CLI entrypoint must exit non-zero when the gate fails so it is
release-blocking in CI.
"""

from __future__ import annotations

import json
from typing import Any

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
    base: dict[str, Any] = {
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


class TestTask713IccBaselineGate:
    """TASK-713 closure (owner ruling, 2026-08-20): the release-gate ICC
    threshold was lowered from the literature-derived 0.80 target to **0.73**,
    the MEASURED baseline against the real `curated-v2.0.0` golden set
    (`icc=0.7306`, Gwet AC2=0.9196, n=288 — TASK-713 README §"Fresh run
    outcome"). Proves the gate now reflects that decision at today's actual
    quality: passes at the measured reading, and still fails a reading below
    the new floor — so an accidental future widen/narrow of `icc_threshold`
    is caught here, not discovered live in CI. The bar for restoring 0.80 is
    tracked as debt in TASK-780, not laundered by this test.
    """

    _CURATED_V2_AGGREGATES = {
        "pdsqi_mean": 4.875,
        "pdsqi_accurate": 4.833,
        "pdsqi_thorough": 4.833,
        "faithfulness": 0.9938,
    }

    def test_default_icc_threshold_is_the_recorded_baseline(self):
        assert EvalConfig().icc_threshold == 0.73

    def test_gate_passes_at_the_measured_curated_v2_icc(self):
        # The exact TASK-713 measured reading: icc=0.7306 on n=288.
        run = _run(dict(self._CURATED_V2_AGGREGATES))
        measured = CalibrationReport(
            icc=0.7306, ac2=0.9196, n=288, k=2, icc_threshold=EvalConfig().icc_threshold
        )
        gated = apply_gate(run, EvalConfig(), calibration=measured)
        assert gated.passed is True
        assert gated.failures == []
        assert gated.thresholds["icc"] == 0.73
        assert gated.aggregates["icc"] == 0.7306

    def test_gate_still_fails_below_the_new_threshold(self):
        # One thousandth below the new floor — the gate must not have been
        # loosened into a rubber stamp; a genuine regression below 0.73
        # still blocks release.
        run = _run(dict(self._CURATED_V2_AGGREGATES))
        below = CalibrationReport(
            icc=0.7299, ac2=0.90, n=288, k=2, icc_threshold=EvalConfig().icc_threshold
        )
        gated = apply_gate(run, EvalConfig(), calibration=below)
        assert gated.passed is False
        assert any("icc" in f.lower() for f in gated.failures)
        assert gated.thresholds["icc"] == 0.73


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

    @pytest.mark.asyncio
    async def test_icc_gate_disabled_skips_calibration_entirely(self):
        # TASK-713: a small CI judge that scores every case identically (a
        # ceiling effect) drives ICC to ~0 regardless of the underlying
        # agreement quality — `icc_threshold` is validated to [0, 1], so
        # lowering it can never accommodate that. `icc_gate_enabled=False`
        # is the escape hatch: calibration must not even be COMPUTED (no
        # `icc`/`gwet_ac2` in aggregates, no icc entry in thresholds, no
        # icc failure) even though clinician ratings ARE present and a judge
        # WAS supplied — the two preconditions that normally trigger it.
        # judge_clinician_icc needs >= 2 paired observations to compute
        # anything at all (see its own `len(judge_scores) < 2: return None`
        # guard) — two calibration cases with varied clinician labels so the
        # ICC gate genuinely engages (and would fail) absent the disable flag.
        cases = [
            GoldenCase(
                case_id="calib-1",
                source_documents=["s"],
                generated_note="n",
                role="calibration",
                clinician_pdsqi=_score(accurate=5, thorough=5),
            ),
            GoldenCase(
                case_id="calib-2",
                source_documents=["s"],
                generated_note="n",
                role="calibration",
                clinician_pdsqi=_score(accurate=1, thorough=1),
            ),
        ]
        # Judge scores both cases IDENTICALLY (the real ceiling-effect
        # failure mode this fix targets) — zero judge-side variance drives
        # ICC to ~0 regardless of the clinician labels' real spread.
        judge = PDSQI9Judge(
            StubJudgeClient(pdsqi_score_json(accurate=4, thorough=4)), output_mode=OutputMode.SCORE
        )
        source = InMemoryGoldenSetSource(GoldenSet(version="v", cases=cases))

        run = await run_and_gate(source, judge=judge, config=EvalConfig(icc_gate_enabled=False))

        assert "icc" not in run.aggregates
        assert "gwet_ac2" not in run.aggregates
        assert "icc" not in run.thresholds
        assert not any("icc" in f for f in run.failures)

    @pytest.mark.asyncio
    async def test_run_and_gate_threads_case_concurrency_into_the_runner(self, monkeypatch):
        # TASK-713: EvalConfig.case_concurrency (HARNESS_EVAL_CASE_CONCURRENCY in
        # CI) must actually reach GoldenSetRunner, not just exist as an unused
        # config field — the CI wall-clock budget depends on this wiring.
        seen: dict[str, object] = {}
        real_runner_cls = __import__(
            "harness.eval.golden.runner", fromlist=["GoldenSetRunner"]
        ).GoldenSetRunner

        class _RecordingRunner(real_runner_cls):  # type: ignore[misc, valid-type]
            def __init__(self, *args, **kwargs):
                seen["case_concurrency"] = kwargs.get("case_concurrency")
                super().__init__(*args, **kwargs)

        monkeypatch.setattr("harness.eval.ci.GoldenSetRunner", _RecordingRunner)

        judge = PDSQI9Judge(StubJudgeClient(pdsqi_score_json()), output_mode=OutputMode.SCORE)
        source = InMemoryGoldenSetSource(_pdsqi_only_golden_set())
        await run_and_gate(source, judge=judge, config=EvalConfig(case_concurrency=7))

        assert seen["case_concurrency"] == 7


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
