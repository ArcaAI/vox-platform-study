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

    def test_markdown_soap_note_attaches_section_cited_knowledge_chunk_ids(self):
        # Real-path defense: gemma3 may emit a MARKDOWN SOAP note (not the requested
        # JSON). The citationsMap must still parse the section headers so the inline
        # StrictCitations [[kb:]] markers attach to the substantive Plan claims (the
        # ▁-bearing, BIO-tokenized entities the live NLP returns).
        note = (
            "**Subjective:** Elevated home blood pressure readings.\n\n"
            "**Plan:** Start amlodipine 5 mg once daily [[kb:kc-htn]] for hypertension. "
            "Target blood pressure below 130/80 mmHg [[kb:kc-htn]]."
        )
        note_entities = [
            NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=20, end=31),
            NEREntity(text="\u2581130", type="B-LAB_VALUE", start=80, end=84),
            NEREntity(text="/", type="I-LAB_VALUE", start=84, end=85),
            NEREntity(text="80", type="I-LAB_VALUE", start=85, end=87),
            NEREntity(text="\u2581mmHg", type="I-LAB_VALUE", start=87, end=92),
        ]
        out = run_computational_sensors(
            note_text=note,
            transcript_text="",
            note_entities=note_entities,
            transcript_entities=[],
            response_format=_RESPONSE_FORMAT,
            retrieved_chunk_ids=["kc-htn"],
        )
        claims = out.citations_map["claims"]
        texts = {c["text"] for c in claims}
        # Subword lab tokens aggregate into one value claim (no unit-token flood).
        assert "130/80 mmHg" in texts
        amlodipine = next(c for c in claims if c["text"] == "amlodipine")
        bp_value = next(c for c in claims if c["text"] == "130/80 mmHg")
        # Markdown sections resolve to Plan, so the cited chunk id attaches.
        assert amlodipine["section"] == "P"
        assert amlodipine["knowledgeChunkIds"] == ["kc-htn"]
        assert bp_value["section"] == "P"
        assert bp_value["knowledgeChunkIds"] == ["kc-htn"]

    def test_markdown_parenthetical_letter_headers_attach_chunk_ids(self):
        # Live gemma-4-e4b emits SOAP headers as "**SUBJECTIVE (S)**" — the section
        # letter in parens, bold, and NO trailing colon — not "**Subjective:**". The
        # header parse must still split these so the inline StrictCitations [[kb:]]
        # markers attach per section (otherwise citation_verify sees total=0 even
        # though the note is full of explicit citations).
        note = (
            "**SUBJECTIVE (S)**\n"
            "Elevated home blood pressure readings around 150/95 [[kb:kc-htn]].\n\n"
            "**ASSESSMENT (A)**\n"
            "Stage 2 Hypertension.\n\n"
            "**PLAN (P)**\n"
            "Initiate amlodipine 5 mg once daily [[kb:kc-htn]] as first-line therapy."
        )
        note_entities = [
            NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=0, end=11),
        ]
        out = run_computational_sensors(
            note_text=note,
            transcript_text="",
            note_entities=note_entities,
            transcript_entities=[],
            response_format=_RESPONSE_FORMAT,
            retrieved_chunk_ids=["kc-htn"],
        )
        claims = out.citations_map["claims"]
        amlodipine = next(c for c in claims if c["text"] == "amlodipine")
        assert amlodipine["section"] == "P"
        assert amlodipine["knowledgeChunkIds"] == ["kc-htn"]

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
