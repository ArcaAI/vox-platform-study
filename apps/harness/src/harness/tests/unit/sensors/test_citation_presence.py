"""Citation-presence sensor tests.

Heuristic under test: every provenance claim in ``citationsMap.claims`` must
carry at least one evidence span. A claim with no evidence -> citation-presence
fails (the claim is flagged as unverifiable). Per the degradation policy, a note
with no citations map at all is degraded (cannot verify -> never auto-pass).
"""

from __future__ import annotations

import pytest

from harness.sensors.base import SensorContext
from harness.sensors.computational.citation_presence import NAME, CitationPresenceSensor

from ._fixtures import claim, evidence


def _ctx(claims):
    return SensorContext(note_text="a note", citations_map={"claims": claims})


class TestCitationPresence:
    def test_claim_without_evidence_fails(self):
        claims = [
            claim("c1", evidence=[evidence(quote="lisinopril 10 mg", start=20, end=36)]),
            claim("c2"),  # no evidence
        ]
        result = CitationPresenceSensor().run(_ctx(claims))
        assert result.name == NAME
        assert result.passed is False
        assert result.claims_flagged == ["c2"]
        assert result.score == pytest.approx(0.5)

    def test_all_claims_evidenced_passes(self):
        claims = [
            claim("c1", evidence=[evidence(quote="hypertension")]),
            claim("c2", evidence=[evidence(quote="lisinopril 10 mg")]),
        ]
        result = CitationPresenceSensor().run(_ctx(claims))
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.claims_flagged == []

    def test_empty_evidence_list_counts_as_unevidenced(self):
        result = CitationPresenceSensor().run(_ctx([claim("c1", evidence=[])]))
        assert result.passed is False
        assert result.claims_flagged == ["c1"]

    def test_no_claims_but_note_present_is_degraded(self):
        ctx = SensorContext(note_text="a generated note", citations_map={})
        result = CitationPresenceSensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False

    def test_no_claims_and_no_note_is_vacuously_ok(self):
        result = CitationPresenceSensor().run(SensorContext())
        assert result.passed is True
        assert result.score == pytest.approx(1.0)

    # ── `[[seg:]]` StrictCitations credit (disjoint from the NER-claims lane) ──

    def test_no_claims_but_segment_markers_cited_credits_instead_of_degrading(self):
        """The claims lane is empty/degraded, but the model cited real transcript
        segments inline (`[[seg:<id>]]`, already extracted+validated upstream into
        `cited_segment_ids`). That is still verifiable provenance -> the sensor must
        NOT degrade; it credits the marker-evidenced statements instead."""
        ctx = SensorContext(
            note_text="Plan: metformin 500mg twice daily.",
            citations_map={},
            cited_segment_ids=["seg-a", "seg-b"],
        )
        result = CitationPresenceSensor().run(ctx)
        assert result.degraded is False
        assert result.passed is True
        assert result.score == pytest.approx(1.0)
        assert result.details["citedSegmentIds"] == ["seg-a", "seg-b"]

    def test_no_claims_and_no_segment_markers_still_degrades(self):
        """No NER claims AND no segment-marker credit -> the existing degrade
        behaviour (never silently auto-pass an unverifiable note) is unchanged."""
        ctx = SensorContext(note_text="a generated note", citations_map={}, cited_segment_ids=[])
        result = CitationPresenceSensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False
