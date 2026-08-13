"""The aggregator's supersede rule.

When an inference-aware entity sensor ran, it REPLACES its lexical counterpart in the gate
decision. The rule is three lines; the ways it can go wrong are not:

* **the auto-PASS trap** — supersede the lexical result without registering the inferential
  name in a severity tuple, and the entity check drops out of the decision entirely. The
  gate would then PASS a note with fabricated entities. Guarded here.
* **the blanket-FLAG trap** — the workflow passes ``expected=COMPUTATIONAL_SENSOR_NAMES``,
  which names the lexical sensor. If superseding removed it from the completeness check it
  would read as *missing*, and the aggregator FLAGs on any missing expected sensor — so
  turning the escalation on would FLAG everything. Guarded here.
* **severity drift** — the faithfulness pair must stay FLAG-on-failure and the coverage pair
  REGEN-on-failure. Guarded here.

Run: ``pnpm harness:test -k aggregator_supersede``
"""

from __future__ import annotations

from harness.sensors.aggregator import (
    HIGHEST_HARM_SENSORS,
    REGEN_FIXABLE_SENSORS,
    SUPERSEDED_BY,
    GateDecision,
    aggregate,
)
from harness.sensors.base import SensorResult
from harness.sensors.inferential.entity_grounding import NAME_COVERAGE, NAME_FAITHFULNESS
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES

PASSING = ("schema_validity", "citation_presence", "numeric_dose")


def _ok(name: str) -> SensorResult:
    return SensorResult(name=name, score=1.0, passed=True)


def _fail(name: str, *claims: str) -> SensorResult:
    return SensorResult(name=name, score=0.0, passed=False, claims_flagged=list(claims))


def _baseline(*extra: SensorResult) -> list[SensorResult]:
    return [_ok(n) for n in PASSING] + list(extra)


class TestWiring:
    def test_supersede_map_matches_the_sensor_names(self) -> None:
        assert SUPERSEDED_BY[NAME_FAITHFULNESS] == "entity_faithfulness"
        assert SUPERSEDED_BY[NAME_COVERAGE] == "coverage_omission"

    def test_superseding_preserves_severity(self) -> None:
        """The auto-PASS trap: a superseding sensor MUST carry its counterpart's severity."""
        assert NAME_FAITHFULNESS in HIGHEST_HARM_SENSORS
        assert NAME_COVERAGE in REGEN_FIXABLE_SENSORS
        for inferential, lexical in SUPERSEDED_BY.items():
            same_class = (
                (inferential in HIGHEST_HARM_SENSORS) == (lexical in HIGHEST_HARM_SENSORS)
                and (inferential in REGEN_FIXABLE_SENSORS) == (lexical in REGEN_FIXABLE_SENSORS)
            )
            assert same_class, f"{inferential} does not inherit {lexical}'s severity"


class TestRecovery:
    def test_a_recovered_note_passes_despite_the_lexical_flag(self) -> None:
        """The whole point: lexical says fabricated, entailment says grounded, gate PASSes."""
        verdict = aggregate(
            _baseline(
                _fail("entity_faithfulness", "paracetamol"),
                _ok(NAME_FAITHFULNESS),
                _fail("coverage_omission", "Tylenol"),
                _ok(NAME_COVERAGE),
            ),
            regens_remaining=1,
        )
        assert verdict.decision == GateDecision.PASS
        assert verdict.claims_flagged == []

    def test_both_scores_are_still_reported(self) -> None:
        """A superseded score stays visible — it is what makes the recovery auditable."""
        verdict = aggregate(
            _baseline(_fail("entity_faithfulness", "paracetamol"), _ok(NAME_FAITHFULNESS)),
            regens_remaining=1,
        )
        assert verdict.scores["entity_faithfulness"] == 0.0
        assert verdict.scores[NAME_FAITHFULNESS] == 1.0


class TestRetention:
    def test_a_fabrication_the_escalation_also_rejects_still_flags(self) -> None:
        verdict = aggregate(
            _baseline(
                _fail("entity_faithfulness", "tramadol"),
                _fail(NAME_FAITHFULNESS, "tramadol"),
            ),
            regens_remaining=1,
        )
        assert verdict.decision == GateDecision.FLAG
        assert "tramadol" in verdict.claims_flagged

    def test_coverage_stays_regen_fixable_not_flag(self) -> None:
        verdict = aggregate(
            _baseline(_fail("coverage_omission", "cough"), _fail(NAME_COVERAGE, "cough")),
            regens_remaining=1,
        )
        assert verdict.decision == GateDecision.REGEN

    def test_no_escalation_leaves_the_incumbent_behaviour_untouched(self) -> None:
        """Kill-switch OFF / backend absent: the gate is byte-for-byte what it was."""
        verdict = aggregate(
            _baseline(_fail("entity_faithfulness", "tramadol")), regens_remaining=1
        )
        assert verdict.decision == GateDecision.FLAG


class TestExpectedCompleteness:
    def test_superseded_sensor_is_not_treated_as_missing(self) -> None:
        """The blanket-FLAG trap: `expected` names the lexical sensor, which DID run."""
        verdict = aggregate(
            _baseline(
                _fail("entity_faithfulness", "paracetamol"),
                _ok(NAME_FAITHFULNESS),
                _fail("coverage_omission", "Tylenol"),
                _ok(NAME_COVERAGE),
            ),
            regens_remaining=1,
            expected=list(COMPUTATIONAL_SENSOR_NAMES) + [NAME_FAITHFULNESS, NAME_COVERAGE],
        )
        assert verdict.decision == GateDecision.PASS

    def test_a_genuinely_missing_sensor_still_degrades(self) -> None:
        verdict = aggregate(
            _baseline(_ok(NAME_FAITHFULNESS)),
            regens_remaining=1,
            expected=list(COMPUTATIONAL_SENSOR_NAMES),
        )
        assert verdict.decision == GateDecision.FLAG
