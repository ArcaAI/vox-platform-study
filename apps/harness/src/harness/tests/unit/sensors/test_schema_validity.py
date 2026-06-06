"""Schema-validity sensor tests (RED-first).

Heuristic under test: the parsed SOAP note object must conform to the activated
SOAP JSON Schema (jsonschema, Draft 2020-12). Malformed SOAP -> schema fails,
and the implicated SOAP section codes (S/O/A/P) are reported for targeted regen.
A missing schema is treated as degraded (cannot validate -> never auto-pass).
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

    def test_accepts_response_format_wrapper(self):
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema=response_format())
        assert SchemaValiditySensor().run(ctx).passed is True

    def test_missing_schema_is_degraded(self):
        ctx = SensorContext(soap_sections=valid_soap(), soap_schema={})
        result = SchemaValiditySensor().run(ctx)
        assert result.degraded is True
        assert result.passed is False
