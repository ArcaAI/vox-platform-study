"""Tests for the deterministic Phase-1 provenance (citationsMap) builder.

RED-first: written before ``harness.services.provenance`` exists. Phase-1 has no
LLM claim-extractor, so the loop derives a deterministic ``citationsMap`` from the
note entities: a note entity grounded in the transcript becomes a *verified*
claim carrying the transcript evidence span; an ungrounded one becomes an
*unverified* claim with no evidence (so citation-presence/faithfulness can act).
"""

from __future__ import annotations

from harness.sensors.base import NEREntity
from harness.services.provenance import build_citations_map


class TestBuildCitationsMap:
    def test_grounded_entity_becomes_verified_claim_with_transcript_evidence(self):
        cmap = build_citations_map(
            soap_sections={"plan": "Continue lisinopril 10 mg daily."},
            note_entities=[NEREntity(text="lisinopril", type="MEDICATION", start=9, end=19)],
            transcript_entities=[NEREntity(text="lisinopril", type="MEDICATION", start=40, end=50)],
            transcript_text="Doctor: start lisinopril at 10 mg.",
            transcript_context_item_id="ctx-t1",
        )

        claims = cmap["claims"]
        assert len(claims) == 1
        claim = claims[0]
        assert claim["text"] == "lisinopril"
        assert claim["section"] == "P"
        assert claim["status"] == "verified"
        assert claim["evidence"] == [
            {
                "transcriptContextItemId": "ctx-t1",
                "startOffset": 40,
                "endOffset": 50,
                "quote": "lisinopril",
            }
        ]

    def test_ungrounded_entity_is_unverified_without_evidence(self):
        cmap = build_citations_map(
            soap_sections={"assessment": "Patient has lupus."},
            note_entities=[NEREntity(text="lupus", type="DISEASE", start=12, end=17)],
            transcript_entities=[],
            transcript_text="Patient reports a mild cough.",
            transcript_context_item_id="ctx-t1",
        )

        claim = cmap["claims"][0]
        assert claim["section"] == "A"
        assert claim["status"] == "unverified"
        assert claim["evidence"] == []

    def test_section_is_derived_from_the_containing_soap_section(self):
        cmap = build_citations_map(
            soap_sections={
                "subjective": "Reports headache.",
                "objective": "Temp 38C.",
            },
            note_entities=[NEREntity(text="headache", type="SYMPTOM")],
            transcript_entities=[NEREntity(text="headache", type="SYMPTOM", start=5, end=13)],
            transcript_text="I have a headache.",
            transcript_context_item_id="ctx-t1",
        )
        assert cmap["claims"][0]["section"] == "S"

    def test_no_note_entities_yields_no_claims(self):
        cmap = build_citations_map(
            soap_sections={"plan": "x"}, note_entities=[], transcript_entities=[]
        )
        assert cmap == {"claims": []}

    def test_repeated_entity_is_deduped_into_one_claim(self):
        cmap = build_citations_map(
            soap_sections={"assessment": "asthma; asthma flare"},
            note_entities=[
                NEREntity(text="asthma", type="DISEASE"),
                NEREntity(text="Asthma", type="DISEASE"),
            ],
            transcript_entities=[NEREntity(text="asthma", type="DISEASE", start=3, end=9)],
            transcript_text="hx asthma",
            transcript_context_item_id="ctx-t1",
        )
        assert len(cmap["claims"]) == 1
