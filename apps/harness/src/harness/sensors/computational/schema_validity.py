"""Schema-validity sensor — the SOAP note must conform to its activated schema.

Validates the parsed SOAP note object (``soap_sections``) against the SOAP JSON
Schema the prompt activated (``PromptAssemblyService`` emits a ``responseFormat``
of ``{type: 'json_schema', json_schema, strict}``). Uses :mod:`jsonschema`
(Draft 2020-12). On failure, the implicated top-level SOAP sections are mapped to
their S/O/A/P codes and reported in ``details['sections']`` so the aggregator can
target a regen. A missing schema is treated as degraded (cannot validate ->
never auto-PASS).
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from harness.sensors.base import SensorContext, SensorResult

NAME = "schema_validity"

# SOAP property name -> single-letter section code used in verdicts/citations.
_SECTION_CODES = {"subjective": "S", "objective": "O", "assessment": "A", "plan": "P"}


def _unwrap_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Accept a raw JSON Schema or a ``responseFormat`` wrapper around one."""
    inner = schema.get("json_schema")
    if isinstance(inner, dict):
        return inner
    return schema


def _section_code(key: str) -> str:
    return _SECTION_CODES.get(key, key)


class SchemaValiditySensor:
    """Binary validity gate: ``score`` is 1.0 (valid) or 0.0 (invalid)."""

    name = NAME

    def run(self, ctx: SensorContext) -> SensorResult:
        schema = _unwrap_schema(ctx.soap_schema or {})
        if not schema:
            return SensorResult(
                name=NAME,
                score=0.0,
                passed=False,
                details={"degraded": True, "reason": "no SOAP schema provided", "errors": []},
            )

        instance = ctx.soap_sections
        validator = Draft202012Validator(schema)
        errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
        if not errors:
            return SensorResult(name=NAME, score=1.0, passed=True, details={"errors": []})

        messages: list[str] = []
        sections: set[str] = set()
        for err in errors:
            messages.append(err.message)
            if err.path:
                sections.add(_section_code(str(err.path[0])))

        # ``required`` failures have an empty path; derive the missing keys directly.
        required = schema.get("required", []) if isinstance(schema, dict) else []
        present = set(instance.keys()) if isinstance(instance, dict) else set()
        for key in required:
            if key not in present:
                sections.add(_section_code(str(key)))

        return SensorResult(
            name=NAME,
            score=0.0,
            passed=False,
            details={"errors": messages, "sections": sorted(sections)},
        )
