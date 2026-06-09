"""Registry + wired-pipeline tests (RED-first).

The registry instantiates the five computational sensors (in canonical order)
for the loop to consume; the pipeline tests run the *real* sensors over crafted
contexts and aggregate the results end-to-end (PASS / REGEN / FLAG).
"""

from __future__ import annotations

from typing import Any

from harness.sensors.aggregator import GateDecision, aggregate
from harness.sensors.base import Sensor, SensorContext
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import (
    COMPUTATIONAL_SENSOR_NAMES,
    computational_sensors,
)

from ._fixtures import claim, evidence, ner, soap_schema, valid_soap


class TestRegistry:
    def test_returns_five_sensors_in_canonical_order(self):
        sensors = computational_sensors()
        assert [s.name for s in sensors] == list(COMPUTATIONAL_SENSOR_NAMES)
        assert len(sensors) == 5

    def test_every_sensor_satisfies_the_protocol(self):
        for sensor in computational_sensors():
            assert isinstance(sensor, Sensor)

    def test_thresholds_are_wired_through(self):
        sensors = computational_sensors(SensorThresholds(coverage_threshold=0.5))
        coverage = next(s for s in sensors if s.name == "coverage_omission")
        assert coverage.threshold == 0.5


def _run_all(ctx: SensorContext):
    return [s.run(ctx) for s in computational_sensors()]


class TestWiredPipeline:
    def _clean_ctx(self, **over) -> SensorContext:
        base: dict[str, Any] = {
            "note_text": "Patient has hypertension. Continue lisinopril 10 mg daily.",
            "soap_sections": valid_soap(),
            "soap_schema": soap_schema(),
            "transcript_text": (
                "Patient reports hypertension. Continue lisinopril 10 mg daily. BP 150/95."
            ),
            "note_entities": [ner("hypertension"), ner("lisinopril")],
            "transcript_entities": [ner("hypertension"), ner("lisinopril")],
            "citations_map": {
                "claims": [
                    claim("c1", evidence=[evidence(quote="hypertension")]),
                    claim("c2", evidence=[evidence(quote="lisinopril 10 mg")]),
                ]
            },
        }
        base.update(over)
        return SensorContext(**base)

    def test_clean_context_passes(self):
        verdict = aggregate(_run_all(self._clean_ctx()), expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision is GateDecision.PASS

    def test_fabricated_entity_flags(self):
        ctx = self._clean_ctx(
            note_entities=[ner("hypertension"), ner("lisinopril"), ner("warfarin", "MEDICATION")]
        )
        verdict = aggregate(_run_all(ctx), expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision is GateDecision.FLAG
        assert "warfarin" in verdict.claims_flagged

    def test_malformed_schema_regens(self):
        bad = valid_soap()
        del bad["plan"]
        ctx = self._clean_ctx(soap_sections=bad)
        verdict = aggregate(_run_all(ctx), regens_remaining=2, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision is GateDecision.REGEN
        assert "P" in verdict.sections_to_regen
