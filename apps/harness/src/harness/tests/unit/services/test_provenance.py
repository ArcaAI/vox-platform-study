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

    # ── TASK-330 follow-up: strip SentencePiece word-boundary markers ──────────
    # NER spans tokenized by a SentencePiece model carry the U+2581 "▁"
    # word-boundary marker (e.g. "▁October"). It must never leak into the
    # human-readable citation claim text or evidence quotes.
    def test_claim_text_strips_sentencepiece_word_boundary_markers(self):
        cmap = build_citations_map(
            soap_sections={"plan": "Follow up in October 2025."},
            note_entities=[NEREntity(text="\u2581October \u25812025", type="DATE")],
            transcript_entities=[
                NEREntity(text="\u2581October \u25812025", type="DATE", start=10, end=22)
            ],
            transcript_text="See you in October 2025.",
            transcript_context_item_id="ctx-t1",
        )

        claim = cmap["claims"][0]
        assert claim["text"] == "October 2025"
        assert "\u2581" not in claim["text"]
        # The transcript evidence quote is human-readable too (no markers).
        assert claim["evidence"][0]["quote"] == "October 2025"
        assert "\u2581" not in claim["evidence"][0]["quote"]

    def test_leading_marker_and_collapsed_whitespace_are_cleaned(self):
        cmap = build_citations_map(
            soap_sections={"assessment": "Type 2 diabetes mellitus."},
            note_entities=[NEREntity(text="\u2581Type \u25812 \u2581diabetes", type="DISEASE")],
            transcript_entities=[],
            transcript_text="",
        )
        assert cmap["claims"][0]["text"] == "Type 2 diabetes"

    def test_normalization_preserves_legitimate_punctuation_and_digits(self):
        # No markers present → content (digits, punctuation) is untouched.
        cmap = build_citations_map(
            soap_sections={"objective": "BP 120/80 mmHg."},
            note_entities=[NEREntity(text="120/80 mmHg", type="VITAL")],
            transcript_entities=[],
            transcript_text="",
        )
        assert cmap["claims"][0]["text"] == "120/80 mmHg"


# ── TASK-330 Phase 3: per-claim knowledgeChunkIds from StrictCitations markers ──
class TestKnowledgeChunkCitations:
    def test_attaches_section_cited_ids_strictly(self):
        cmap = build_citations_map(
            soap_sections={
                "plan": "Start a thiazide [[kb:kc-1]] for blood pressure.",
                "assessment": "Type 2 diabetes [[kb:kc-2]] [[kb:kc-999]].",
            },
            note_entities=[
                NEREntity(text="thiazide", type="MEDICATION"),
                NEREntity(text="diabetes", type="DISEASE"),
            ],
            transcript_entities=[],
            transcript_text="",
            retrieved_chunk_ids=["kc-1", "kc-2"],
        )
        by_section = {c["section"]: c for c in cmap["claims"]}
        # Section-level attribution; hallucinated kc-999 (not retrieved) is dropped.
        assert by_section["P"]["knowledgeChunkIds"] == ["kc-1"]
        assert by_section["A"]["knowledgeChunkIds"] == ["kc-2"]

    def test_no_retrieved_ids_leaves_knowledge_chunk_ids_empty(self):
        cmap = build_citations_map(
            soap_sections={"plan": "Start a thiazide [[kb:kc-1]]."},
            note_entities=[NEREntity(text="thiazide", type="MEDICATION")],
            transcript_entities=[],
            transcript_text="",
        )
        # No retrieval context -> markers are ignored, the field stays empty.
        assert cmap["claims"][0]["knowledgeChunkIds"] == []


# ── TASK-330 ▁-attribution fix: section matching + subword claim aggregation ────
# The live NLP ``/classify/tokens`` returns per-TOKEN BIO entities (``B-``/``I-``
# tags) whose surface carries the SentencePiece "▁" (U+2581) word-boundary marker.
# Two interacting defects this guards against:
#   (1) ``_derive_section`` compared the ▁-bearing normalized entity against plain
#       section text -> never matched -> every claim collapsed to the default "A",
#       so the StrictCitations chunk id (attributed section-level) never attached.
#   (2) one claim per subword token fragmented "5 mg once daily" / "130/80 mmHg"
#       into unit tokens, flooding citation_verify with bare-token "claims".
# Fix: strip ▁ on the matching path, and aggregate a ``B-``/bare token with its
# trailing CONTIGUOUS ``I-*`` tokens into one coherent phrase-claim.
class TestSubwordAttribution:
    @staticmethod
    def _amlodipine_plan_tokens():
        """Live-shaped BIO tokens for 'amlodipine 5 mg once daily' (offsets contiguous)."""
        return [
            NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=25, end=36),
            NEREntity(text="\u25815", type="B-DOSAGE", start=36, end=38),
            NEREntity(text="\u2581mg", type="I-DOSAGE", start=38, end=41),
            NEREntity(text="\u2581once", type="I-DOSAGE", start=41, end=46),
            NEREntity(text="\u2581daily", type="I-DOSAGE", start=46, end=52),
        ]

    def test_marker_bearing_entity_resolves_to_real_section_not_default_A(self):
        cmap = build_citations_map(
            soap_sections={
                "subjective": "Blood pressure has been elevated.",
                "plan": "Start amlodipine 5 mg once daily.",
            },
            note_entities=[
                NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=6, end=17)
            ],
            transcript_entities=[],
            transcript_text="",
        )
        # ▁amlodipine lives in the Plan; it must NOT collapse to the default "A".
        assert cmap["claims"][0]["section"] == "P"

    def test_contiguous_bio_subwords_aggregate_into_one_phrase_claim(self):
        cmap = build_citations_map(
            soap_sections={"plan": "Start amlodipine 5 mg once daily."},
            note_entities=self._amlodipine_plan_tokens(),
            transcript_entities=[],
            transcript_text="",
        )
        texts = [c["text"] for c in cmap["claims"]]
        # B-DOSAGE + 3×I-DOSAGE collapse to one claim; the B-MEDICATION stays separate.
        assert "amlodipine" in texts
        assert "5 mg once daily" in texts
        # No per-subword fragment claims survive.
        for fragment in ("mg", "once", "daily"):
            assert fragment not in texts

    def test_lab_value_subwords_do_not_flood_into_unit_token_claims(self):
        cmap = build_citations_map(
            soap_sections={"plan": "Target blood pressure below 130/80 mmHg."},
            note_entities=[
                NEREntity(text="\u2581130", type="B-LAB_VALUE", start=28, end=32),
                NEREntity(text="/", type="I-LAB_VALUE", start=32, end=33),
                NEREntity(text="80", type="I-LAB_VALUE", start=33, end=35),
                NEREntity(text="\u2581mmHg", type="I-LAB_VALUE", start=35, end=40),
            ],
            transcript_entities=[],
            transcript_text="",
        )
        # The 4 subword tokens detokenize to a single coherent value claim.
        assert [c["text"] for c in cmap["claims"]] == ["130/80 mmHg"]

    def test_b_token_starts_a_new_claim_even_when_offset_contiguous(self):
        # Two adjacent B- entities (touching offsets) must NOT merge — a B- marker
        # is a new entity, so a comma-separated list stays as distinct claims.
        cmap = build_citations_map(
            soap_sections={"plan": "salt reduction, weight loss."},
            note_entities=[
                NEREntity(text="\u2581salt", type="B-THERAPEUTIC", start=0, end=5),
                NEREntity(text="\u2581reduction", type="I-THERAPEUTIC", start=5, end=15),
                NEREntity(text="\u2581weight", type="B-THERAPEUTIC", start=15, end=22),
                NEREntity(text="\u2581loss", type="I-THERAPEUTIC", start=22, end=27),
            ],
            transcript_entities=[],
            transcript_text="",
        )
        texts = [c["text"] for c in cmap["claims"]]
        assert texts == ["salt reduction", "weight loss"]

    def test_aggregated_plan_claim_carries_section_cited_chunk_id(self):
        cmap = build_citations_map(
            soap_sections={
                "plan": "Start amlodipine 5 mg once daily [[kb:kc-htn]] for hypertension.",
            },
            note_entities=self._amlodipine_plan_tokens(),
            transcript_entities=[],
            transcript_text="",
            retrieved_chunk_ids=["kc-htn"],
        )
        # Section resolves to P (▁ stripped) so the section-cited id attaches to the
        # substantive medication/dosage claims — not dropped on the default "A".
        amlodipine = next(c for c in cmap["claims"] if c["text"] == "amlodipine")
        assert amlodipine["section"] == "P"
        assert amlodipine["knowledgeChunkIds"] == ["kc-htn"]
        assert all(c["knowledgeChunkIds"] == ["kc-htn"] for c in cmap["claims"])

    def test_marker_bearing_entity_grounds_against_plain_transcript(self):
        # Evidence matching must also be ▁-insensitive: a ▁-bearing note entity is
        # grounded by the plain-text transcript mention (no marker in the quote).
        cmap = build_citations_map(
            soap_sections={"plan": "Start amlodipine."},
            note_entities=[
                NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=6, end=17)
            ],
            transcript_entities=[
                NEREntity(text="\u2581amlodipine", type="B-MEDICATION", start=14, end=25)
            ],
            transcript_text="I will start amlodipine today.",
            transcript_context_item_id="ctx-t1",
        )
        claim = cmap["claims"][0]
        assert claim["status"] == "verified"
        assert claim["evidence"][0]["quote"] == "amlodipine"
        assert "\u2581" not in claim["evidence"][0]["quote"]
