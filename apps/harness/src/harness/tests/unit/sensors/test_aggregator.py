"""Verdict aggregator tests (RED-first).

Decision policy under test (clinical-safety > automation, fail-safe):
* all sensors pass -> PASS
* highest-harm flag (fabricated entity / dose mismatch) -> FLAG
* regen-fixable failure (schema / coverage / citation) with budget -> REGEN
* regen-fixable failure with budget exhausted -> FLAG
* degraded inputs (sensor degraded, ``degraded`` param, or a missing expected
  sensor) -> FLAG (never auto-PASS)
"""

from __future__ import annotations

from harness.sensors.aggregator import (
    DEFAULT_SOAP_SECTIONS,
    GateDecision,
    Verdict,
    aggregate,
)
from harness.sensors.base import SensorResult
from harness.sensors.computational import (
    citation_presence,
    coverage_omission,
    entity_faithfulness,
    numeric_dose,
    schema_validity,
)
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES


def _pass(name: str, score: float = 1.0) -> SensorResult:
    return SensorResult(name=name, score=score, passed=True)


def _all_pass() -> list[SensorResult]:
    return [
        _pass(entity_faithfulness.NAME),
        _pass(coverage_omission.NAME),
        _pass(schema_validity.NAME),
        _pass(citation_presence.NAME),
        _pass(numeric_dose.NAME),
    ]


class TestPass:
    def test_all_sensors_pass_yields_pass(self):
        verdict = aggregate(_all_pass())
        assert isinstance(verdict, Verdict)
        assert verdict.decision is GateDecision.PASS
        assert verdict.sections_to_regen == []
        assert verdict.claims_flagged == []
        assert set(verdict.scores) == set(COMPUTATIONAL_SENSOR_NAMES)


class TestFlagHighestHarm:
    def test_fabricated_entity_flags(self):
        results = _all_pass()
        results[0] = SensorResult(
            name=entity_faithfulness.NAME,
            score=0.66,
            passed=False,
            claims_flagged=["metformin"],
        )
        verdict = aggregate(results)
        assert verdict.decision is GateDecision.FLAG
        assert verdict.claims_flagged == ["metformin"]

    def test_dose_mismatch_flags(self):
        results = _all_pass()
        results[4] = SensorResult(
            name=numeric_dose.NAME, score=0.5, passed=False, claims_flagged=["20 mg"]
        )
        verdict = aggregate(results)
        assert verdict.decision is GateDecision.FLAG
        assert verdict.claims_flagged == ["20 mg"]

    def test_highest_harm_takes_precedence_over_regen(self):
        results = _all_pass()
        results[0] = SensorResult(
            name=entity_faithfulness.NAME, score=0.5, passed=False, claims_flagged=["metformin"]
        )
        results[2] = SensorResult(
            name=schema_validity.NAME, score=0.0, passed=False, details={"sections": ["P"]}
        )
        verdict = aggregate(results)
        assert verdict.decision is GateDecision.FLAG


class TestRegen:
    def test_schema_failure_regens_reported_section(self):
        results = _all_pass()
        results[2] = SensorResult(
            name=schema_validity.NAME,
            score=0.0,
            passed=False,
            details={"sections": ["P"], "errors": ["'plan' is a required property"]},
        )
        verdict = aggregate(results, regens_remaining=2)
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == ["P"]

    def test_coverage_failure_without_sections_regens_whole_note(self):
        results = _all_pass()
        results[1] = SensorResult(
            name=coverage_omission.NAME, score=0.6, passed=False, claims_flagged=["diabetes"]
        )
        verdict = aggregate(results, regens_remaining=1)
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == list(DEFAULT_SOAP_SECTIONS)
        assert verdict.claims_flagged == ["diabetes"]

    def test_citation_failure_regens(self):
        results = _all_pass()
        results[3] = SensorResult(
            name=citation_presence.NAME, score=0.5, passed=False, claims_flagged=["c2"]
        )
        assert aggregate(results, regens_remaining=2).decision is GateDecision.REGEN

    def test_regen_budget_exhausted_flags(self):
        results = _all_pass()
        results[2] = SensorResult(
            name=schema_validity.NAME, score=0.0, passed=False, details={"sections": ["P"]}
        )
        verdict = aggregate(results, regens_remaining=0)
        assert verdict.decision is GateDecision.FLAG


class TestDegradedAlwaysFlags:
    def test_degraded_param_flags(self):
        assert aggregate(_all_pass(), degraded=True).decision is GateDecision.FLAG

    def test_degraded_sensor_result_flags(self):
        results = _all_pass()
        results[0] = SensorResult(
            name=entity_faithfulness.NAME,
            score=0.0,
            passed=False,
            claims_flagged=["hypertension"],
            details={"degraded": True},
        )
        verdict = aggregate(results)
        assert verdict.decision is GateDecision.FLAG
        assert "hypertension" in verdict.claims_flagged

    def test_missing_expected_sensor_flags(self):
        # NLP/SMR degraded -> a sensor never ran -> never auto-PASS.
        partial = _all_pass()[:-1]  # drop numeric_dose
        verdict = aggregate(partial, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision is GateDecision.FLAG
