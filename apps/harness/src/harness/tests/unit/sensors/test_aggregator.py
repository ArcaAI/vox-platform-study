"""Verdict aggregator tests.

Decision policy under test (clinical-safety > automation, fail-safe):
* all sensors pass -> PASS
* highest-harm flag (fabricated entity / dose mismatch / unsafe content) -> FLAG
* regen-fixable failure (schema / coverage / citation / groundedness) with
  budget -> REGEN
* regen-fixable failure with budget exhausted -> FLAG
* degraded inputs (sensor degraded, ``degraded`` param, or a missing expected
  sensor) -> FLAG (never auto-PASS)
* reduced assurance (Phase 2): a degraded *inferential* sensor is
  omitted from ``expected`` (and from ``results``) so the gate proceeds on the
  computational verdict instead of a blanket FLAG.
"""

from __future__ import annotations

from harness.sensors.aggregator import (
    DEFAULT_SOAP_SECTIONS,
    HIGHEST_HARM_SENSORS,
    REGEN_FIXABLE_SENSORS,
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
from harness.sensors.inferential.groundedness import NAME as GROUNDEDNESS_NAME
from harness.sensors.inferential.safety import NAME as SAFETY_NAME
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
        # NLP/Text degraded -> a sensor never ran -> never auto-PASS.
        partial = _all_pass()[:-1]  # drop numeric_dose
        verdict = aggregate(partial, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision is GateDecision.FLAG


def _groundedness(passed: bool, *, sections=None, ungrounded=None, score=0.5) -> SensorResult:
    return SensorResult(
        name=GROUNDEDNESS_NAME,
        score=1.0 if passed else score,
        passed=passed,
        claims_flagged=list(ungrounded or []),
        details={"sections": list(sections or []), "ungrounded": list(ungrounded or [])},
    )


def _safety(unsafe: bool, *, dimensions=None) -> SensorResult:
    flagged = list(dimensions or (["violence"] if unsafe else []))
    return SensorResult(
        name=SAFETY_NAME,
        score=0.0 if unsafe else 1.0,
        passed=not unsafe,
        claims_flagged=flagged,
        details={"unsafe": unsafe, "flagged_dimensions": flagged},
    )


class TestSafetyHighestHarm:
    """``safety`` (Granite Guardian) is a highest-harm gate: unsafe -> always FLAG."""

    def test_safety_registered_as_highest_harm(self):
        # Drift guard: the aggregator's policy must reference the sensor's NAME.
        assert SAFETY_NAME in HIGHEST_HARM_SENSORS

    def test_unsafe_content_flags_and_reports_dimensions(self):
        results = [*_all_pass(), _safety(unsafe=True, dimensions=["violence", "harm"])]
        verdict = aggregate(results, regens_remaining=2)
        assert verdict.decision is GateDecision.FLAG
        assert verdict.sections_to_regen == []  # never auto-regen unsafe content
        assert set(verdict.claims_flagged) == {"violence", "harm"}

    def test_safe_content_does_not_flag(self):
        results = [*_all_pass(), _safety(unsafe=False)]
        verdict = aggregate(results, expected=[*COMPUTATIONAL_SENSOR_NAMES, SAFETY_NAME])
        assert verdict.decision is GateDecision.PASS

    def test_unsafe_safety_takes_precedence_over_groundedness_regen(self):
        # Both fail: safety FLAG wins -> unsafe content is never auto-regenerated.
        results = [
            *_all_pass(),
            _groundedness(passed=False, sections=["P"], ungrounded=["c-pen"]),
            _safety(unsafe=True),
        ]
        verdict = aggregate(results, regens_remaining=2)
        assert verdict.decision is GateDecision.FLAG
        assert verdict.sections_to_regen == []


class TestGroundednessRegenFixable:
    """``groundedness`` is regen-fixable: regen offending sections, FLAG on exhaustion."""

    def test_groundedness_registered_as_regen_fixable(self):
        assert GROUNDEDNESS_NAME in REGEN_FIXABLE_SENSORS

    def test_ungrounded_regens_reported_sections(self):
        results = [*_all_pass(), _groundedness(passed=False, sections=["P"], ungrounded=["c-pen"])]
        verdict = aggregate(results, regens_remaining=1)
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == ["P"]
        assert verdict.claims_flagged == ["c-pen"]

    def test_ungrounded_without_sections_regens_whole_note(self):
        results = [*_all_pass(), _groundedness(passed=False, sections=[], ungrounded=["c-x"])]
        verdict = aggregate(results, regens_remaining=2)
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == list(DEFAULT_SOAP_SECTIONS)

    def test_ungrounded_with_budget_exhausted_flags(self):
        results = [*_all_pass(), _groundedness(passed=False, sections=["A"], ungrounded=["c-x"])]
        verdict = aggregate(results, regens_remaining=0)
        assert verdict.decision is GateDecision.FLAG

    def test_grounded_passes(self):
        results = [*_all_pass(), _groundedness(passed=True)]
        verdict = aggregate(results, regens_remaining=2)
        assert verdict.decision is GateDecision.PASS


class TestCitationVerifyRegenFixable:
    """``citation_verify`` (Phase 3) is regen-fixable, like groundedness."""

    def test_citation_verify_registered_as_regen_fixable(self):
        from harness.sensors.inferential.citation_verify import NAME as CITATION_VERIFY_NAME

        assert CITATION_VERIFY_NAME in REGEN_FIXABLE_SENSORS

    def test_unverified_citation_regens_reported_sections(self):
        from harness.sensors.inferential.citation_verify import NAME as CITATION_VERIFY_NAME

        cv = SensorResult(
            name=CITATION_VERIFY_NAME,
            score=0.5,
            passed=False,
            claims_flagged=["c-bad"],
            details={"sections": ["A"]},
        )
        verdict = aggregate([*_all_pass(), cv], regens_remaining=1)
        assert verdict.decision is GateDecision.REGEN
        assert verdict.sections_to_regen == ["A"]


class TestAtomicFactRegenFixable:
    """``atomic_fact`` is regen-fixable, like groundedness: an ungrounded
    atomic claim regens the note, FLAGs on budget exhaustion (feeding the retraction gate)."""

    def test_atomic_fact_registered_as_regen_fixable(self):
        from harness.sensors.inferential.atomic_fact import NAME as ATOMIC_FACT_NAME

        assert ATOMIC_FACT_NAME in REGEN_FIXABLE_SENSORS

    def test_ungrounded_atomic_claim_regens_with_budget(self):
        from harness.sensors.inferential.atomic_fact import NAME as ATOMIC_FACT_NAME

        af = SensorResult(
            name=ATOMIC_FACT_NAME,
            score=0.5,
            passed=False,
            claims_flagged=["Start warfarin"],
            details={"ungrounded": ["Start warfarin"]},
        )
        verdict = aggregate([*_all_pass(), af], regens_remaining=1)
        assert verdict.decision is GateDecision.REGEN
        assert "Start warfarin" in verdict.claims_flagged

    def test_ungrounded_atomic_claim_flags_on_budget_exhaustion(self):
        from harness.sensors.inferential.atomic_fact import NAME as ATOMIC_FACT_NAME

        af = SensorResult(name=ATOMIC_FACT_NAME, score=0.0, passed=False, claims_flagged=["c-x"])
        verdict = aggregate([*_all_pass(), af], regens_remaining=0)
        assert verdict.decision is GateDecision.FLAG


class TestReducedAssurance:
    """A degraded inferential backend must NOT force a blanket FLAG (reduced assurance)."""

    def test_omitting_degraded_inferential_from_expected_avoids_blanket_flag(self):
        # If 'safety' were still required while its backend was down, the missing
        # sensor would force a blanket FLAG (the existing fail-safe):
        flagged = aggregate(_all_pass(), expected=[*COMPUTATIONAL_SENSOR_NAMES, SAFETY_NAME])
        assert flagged.decision is GateDecision.FLAG
        # Reduced-assurance contract: the workflow OMITS the degraded inferential
        # name from `expected` (and excludes its degraded result) -> the gate
        # proceeds on the computational verdict (PASS), never a blanket FLAG. It is
        # never a silent auto-PASS: the omission is logged out-of-band via
        # reduced_assurance -> REDUCED_ASSURANCE WORM.
        proceed = aggregate(_all_pass(), expected=list(COMPUTATIONAL_SENSOR_NAMES))
        assert proceed.decision is GateDecision.PASS

    def test_computational_verdict_still_holds_under_reduced_assurance(self):
        # Reduced assurance proceeds on the computational verdict — including a
        # computational FLAG (e.g. fabricated entity) which still escalates.
        results = _all_pass()
        results[0] = SensorResult(
            name=entity_faithfulness.NAME, score=0.0, passed=False, claims_flagged=["warfarin"]
        )
        verdict = aggregate(results, expected=list(COMPUTATIONAL_SENSOR_NAMES))
        assert verdict.decision is GateDecision.FLAG
