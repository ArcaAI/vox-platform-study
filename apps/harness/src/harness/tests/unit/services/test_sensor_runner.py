"""Tests for the deterministic sensor runner that wires the loop to Lane H.

RED-first: written before ``harness.services.sensor_runner`` exists. The runner
parses the generated SOAP JSON, builds the provenance citationsMap, assembles a
:class:`SensorContext`, runs all five computational sensors, and returns the
results + citationsMap + scores so the workflow can ``aggregate(...)`` them.
"""

from __future__ import annotations

import json

from harness.sensors.aggregator import GateDecision, aggregate
from harness.sensors.base import NEREntity
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.sensor_runner import run_computational_sensors

_SOAP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "subjective": {"type": "string"},
        "objective": {"type": "string"},
        "assessment": {"type": "string"},
        "plan": {"type": "string"},
    },
    "required": ["subjective", "objective", "assessment", "plan"],
}
_RESPONSE_FORMAT = {"type": "json_schema", "json_schema": _SOAP_SCHEMA, "strict": True}


def _grounded_inputs():
    note = json.dumps(
        {
            "subjective": "Patient reports worsening hypertension.",
            "objective": "BP 150/95.",
            "assessment": "Essential hypertension, poorly controlled.",
            "plan": "Continue lisinopril 10 mg daily.",
        }
    )
    transcript = "Patient has hypertension. BP is 150/95. Continue lisinopril 10 mg daily."
    note_entities = [
        NEREntity(text="hypertension", type="DISEASE"),
        NEREntity(text="lisinopril", type="MEDICATION"),
    ]
    transcript_entities = [
        NEREntity(text="hypertension", type="DISEASE", start=12, end=24),
        NEREntity(text="lisinopril", type="MEDICATION", start=49, end=59),
    ]
    return note, transcript, note_entities, transcript_entities


class TestSensorRunner:
    def test_runs_all_five_sensors_and_grounded_note_aggregates_to_pass(self):
        note, transcript, note_entities, transcript_entities = _grounded_inputs()

        out = run_computational_sensors(
            note_text=note,
            transcript_text=transcript,
            note_entities=note_entities,
            transcript_entities=transcript_entities,
            response_format=_RESPONSE_FORMAT,
            transcript_context_item_id="ctx-t1",
        )

        assert {r.name for r in out.results} == set(COMPUTATIONAL_SENSOR_NAMES)
        assert out.citations_map["claims"]
        assert set(out.scores) == set(COMPUTATIONAL_SENSOR_NAMES)
        assert out.soap_sections["plan"].startswith("Continue lisinopril")

        verdict = aggregate(out.results, regens_remaining=2, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision == GateDecision.PASS

    def test_malformed_soap_fails_schema_validity(self):
        note, transcript, note_entities, transcript_entities = _grounded_inputs()
        out = run_computational_sensors(
            note_text="this is not valid json",
            transcript_text=transcript,
            note_entities=note_entities,
            transcript_entities=transcript_entities,
            response_format=_RESPONSE_FORMAT,
            transcript_context_item_id="ctx-t1",
        )

        schema = next(r for r in out.results if r.name == "schema_validity")
        assert schema.passed is False
        verdict = aggregate(out.results, regens_remaining=2, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision == GateDecision.REGEN

    def test_fabricated_note_entity_aggregates_to_flag(self):
        note, transcript, _note_entities, transcript_entities = _grounded_inputs()
        # A medication that never appears in the transcript = fabrication.
        note_entities = [
            NEREntity(text="hypertension", type="DISEASE"),
            NEREntity(text="warfarin", type="MEDICATION"),
        ]
        out = run_computational_sensors(
            note_text=note,
            transcript_text=transcript,
            note_entities=note_entities,
            transcript_entities=transcript_entities,
            response_format=_RESPONSE_FORMAT,
            transcript_context_item_id="ctx-t1",
        )

        verdict = aggregate(out.results, regens_remaining=2, expected=COMPUTATIONAL_SENSOR_NAMES)
        assert verdict.decision == GateDecision.FLAG
        assert "warfarin" in verdict.claims_flagged
