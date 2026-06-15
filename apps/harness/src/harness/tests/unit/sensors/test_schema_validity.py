"""Schema-validity sensor tests (RED-first).

Heuristic under test: the parsed SOAP note object must conform to the activated
SOAP JSON Schema (jsonschema, Draft 2020-12). Malformed SOAP -> schema fails,
and the implicated SOAP section codes (S/O/A/P) are reported for targeted regen.

TASK-358 (D-A): the validator must reflect the *actual* activated output
contract. On the common department/CATCHALL path ``responseFormat`` is null —
a complete S/O/A/P note must then validate against the default structural
contract and score 1.0 (it must NOT degrade just because no JSON schema was
activated). A genuinely empty/unparseable note (no sections at all) still
degrades (cannot validate -> never auto-PASS).
"""

from __future__ import annotations

from harness.sensors.base import SensorContext
from harness.sensors.computational.schema_validity import NAME, SchemaValiditySensor

from ._fixtures import response_format, soap_schema, valid_soap


class TestSchemaValidity:
    def test_valid_soap_passes(self):
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema=soap_schema())
        result = SchemaValiditySensor().run(ctx)
        assert result.name == NAME
        assert result.passed is True
        assert result.score == 1.0

    def test_missing_required_section_fails_and_reports_section(self):
        bad = valid_soap()
        del bad["plan"]
        ctx = SensorContext(soap_sections=bad, soap_schema=soap_schema())
        result = SchemaValiditySensor().run(ctx)
        assert result.passed is False
        assert result.score == 0.0
        assert "P" in result.details["sections"]
        assert result.details["errors"]

    def test_wrong_type_fails_and_reports_section(self):
        bad = valid_soap()
        bad["assessment"] = 42  # schema requires a string
        ctx = SensorContext(soap_sections=bad, soap_schema=soap_schema())
        result = SchemaValiditySensor().run(ctx)
        assert result.passed is False
        assert "A" in result.details["sections"]

    def test_additional_property_rejected(self):
        bad = valid_soap()
        bad["extra"] = "not allowed"  # additionalProperties: false
        ctx = SensorContext(soap_sections=bad, soap_schema=soap_schema())
        assert SchemaValiditySensor().run(ctx).passed is False

    def test_malformed_schema_degrades_fail_closed(self):
        # TASK-358 hardening (defensive parsing): a malformed/unprocessable activated
        # JSON schema (TASK-356 will let admins manage these) must DEGRADE — never
        # raise an uncaught exception and never auto-PASS — even for a complete note.
        # The required sections are all present, so the failure can only come from the
        # jsonschema pass, which must be caught and turned into a degraded result.
        bad_schema = {"type": "object", "properties": {"subjective": {"type": "nonsense"}}}
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema=bad_schema)
        result = SchemaValiditySensor().run(ctx)  # must not raise
        assert result.degraded is True
        assert result.passed is False
        assert result.score == 0.0

    def test_accepts_response_format_wrapper(self):
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema=response_format())
        assert SchemaValiditySensor().run(ctx).passed is True

    # ── TASK-358 (D-A): the responseFormat=null structural contract ────────────
    def test_complete_note_without_schema_passes_structural_contract(self):
        # The common department/CATCHALL path: no JSON schema activated, but a
        # complete S/O/A/P note must validate against the default contract -> 1.0
        # (must NOT degrade just because responseFormat is null).
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema={})
        result = SchemaValiditySensor().run(ctx)
        assert result.passed is True
        assert result.score == 1.0
        assert result.degraded is False

    def test_incomplete_note_without_schema_is_regen_fixable(self):
        # Missing a section (here Plan) is a regen-fixable structural break, not a
        # degraded input: 0.0, passed=False, the missing section reported, and NOT
        # degraded (so the aggregator can REGEN it).
        bad = valid_soap()
        del bad["plan"]
        ctx = SensorContext(soap_sections=bad, soap_schema={})
        result = SchemaValiditySensor().run(ctx)
        assert result.passed is False
        assert result.degraded is False
        assert "P" in result.details["sections"]

    def test_empty_note_without_schema_is_degraded(self):
        # No sections at all and no schema -> cannot validate -> degraded (FLAG).
        ctx = SensorContext(soap_sections={}, soap_schema={})
        result = SchemaValiditySensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False

    def test_empty_note_with_schema_is_degraded(self):
        # A truly unparseable note yields no sections; even with a schema present
        # there is nothing to validate -> degraded (never auto-PASS, never REGEN
        # an empty shell). Preserves AC-5's conservative direction.
        ctx = SensorContext(soap_sections={}, soap_schema=soap_schema())
        result = SchemaValiditySensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False
