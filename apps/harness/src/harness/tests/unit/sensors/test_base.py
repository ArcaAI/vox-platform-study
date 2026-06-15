"""Contract tests for the sensor framework base types (RED-first).

Covers the ``SensorResult`` / ``SensorContext`` / ``NEREntity`` value objects,
the ``normalize_text`` helper, and the runtime-checkable ``Sensor`` protocol.
"""

from __future__ import annotations

from harness.sensors.base import (
    NEREntity,
    Sensor,
    SensorContext,
    SensorResult,
    normalize_text,
)


class TestNormalizeText:
    def test_casefolds_and_collapses_whitespace(self):
        assert normalize_text("  Lisinopril   10  MG\n") == "lisinopril 10 mg"

    def test_empty(self):
        assert normalize_text("") == ""

    # TASK-358: the entity-level matching path must be ▁-insensitive too (the live
    # NER returns SentencePiece "▁" (U+2581) surfaces). Strip ▁ so a marker-bearing
    # note entity matches the plain transcript — consistent with the claims path.
    def test_strips_sentencepiece_word_boundary_marker(self):
        assert normalize_text("\u2581amlodipine") == "amlodipine"
        assert NEREntity(text="\u2581amlodipine", type="B-MEDICATION").normalized == "amlodipine"

    def test_strips_marker_and_preserves_legitimate_content(self):
        assert normalize_text("\u2581130/\u258180 \u2581mmHg") == "130/ 80 mmhg"


class TestNEREntity:
    def test_normalized_surface_form(self):
        assert NEREntity(text="  Hypertension ", type="CONDITION").normalized == "hypertension"

    def test_offsets_default_to_sentinel(self):
        e = NEREntity(text="fever")
        assert e.start == -1 and e.end == -1 and e.type == ""


class TestSensorResult:
    def test_defaults(self):
        r = SensorResult(name="x", score=1.0, passed=True)
        assert r.claims_flagged == []
        assert r.details == {}
        assert r.degraded is False

    def test_degraded_flag_reads_details(self):
        r = SensorResult(name="x", score=0.0, passed=False, details={"degraded": True})
        assert r.degraded is True


class TestSensorContext:
    def test_note_blob_prefers_note_text(self):
        ctx = SensorContext(note_text="full note", soap_sections={"plan": "p"})
        assert ctx.note_blob() == "full note"

    def test_note_blob_falls_back_to_sections(self):
        ctx = SensorContext(soap_sections={"subjective": "s", "plan": "p"})
        assert "s" in ctx.note_blob() and "p" in ctx.note_blob()

    def test_claims_filters_non_dict_entries(self):
        ctx = SensorContext(citations_map={"claims": [{"id": "c1"}, "bogus", 3]})
        assert ctx.claims() == [{"id": "c1"}]

    def test_claims_empty_when_absent(self):
        assert SensorContext().claims() == []


class TestSensorProtocol:
    def test_conforming_object_is_a_sensor(self):
        class _Dummy:
            name = "dummy"

            def run(self, ctx: SensorContext) -> SensorResult:
                return SensorResult(name=self.name, score=1.0, passed=True)

        assert isinstance(_Dummy(), Sensor)

    def test_non_conforming_object_is_not_a_sensor(self):
        assert not isinstance(object(), Sensor)
