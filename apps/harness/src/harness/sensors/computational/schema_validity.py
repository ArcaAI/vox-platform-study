"""Schema-validity sensor — the SOAP note must conform to its activated contract.

Validates the parsed SOAP note object (``soap_sections``) against the ACTUAL
activated output contract:

* **JSON schema activated** (``PromptAssemblyService`` emits a ``responseFormat``
  of ``{type: 'json_schema', json_schema, strict}``) — validate the parsed
  structure against the schema's ``required`` keys + :mod:`jsonschema`
  (Draft 2020-12) type / ``additionalProperties`` constraints.
* **No schema** (``responseFormat`` is null — the common department/CATCHALL
  path, where the model emits a markdown SOAP note) — validate against the
  default S/O/A/P structural contract: all four sections present and non-empty.

A correctly-structured note scores ``1.0`` in **both** cases. On a structural
break (a section missing or empty) the implicated S/O/A/P codes are reported in
``details['sections']`` so the aggregator can target a regen. A genuinely
empty/unparseable note (no sections at all) is ``degraded`` — it cannot be
validated, so it never auto-PASSes and is not regenerated as an empty shell.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

from harness.sensors.base import SensorContext, SensorResult

NAME = "schema_validity"

# SOAP property name -> single-letter section code used in verdicts/citations.
_SECTION_CODES = {"subjective": "S", "objective": "O", "assessment": "A", "plan": "P"}

# The default structural contract when no JSON schema is activated: a SOAP note is
# the four S/O/A/P sections, each present and non-empty.
_DEFAULT_REQUIRED: tuple[str, ...] = ("subjective", "objective", "assessment", "plan")


def _unwrap_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Accept a raw JSON Schema or a ``responseFormat`` wrapper around one."""
    inner = schema.get("json_schema")
    if isinstance(inner, dict):
        return inner
    return schema


def _section_code(key: str) -> str:
    return _SECTION_CODES.get(key, key)


def _nonempty_str(value: Any) -> bool:
    """True when ``value`` is a non-blank string (a real section, not empty/typed)."""
    return isinstance(value, str) and bool(value.strip())


class SchemaValiditySensor:
    """Binary validity gate: ``score`` is 1.0 (valid) or 0.0 (invalid)."""

    name = NAME

    def run(self, ctx: SensorContext) -> SensorResult:
        schema = _unwrap_schema(ctx.soap_schema or {})
        instance = ctx.soap_sections if isinstance(ctx.soap_sections, dict) else {}

        schema_required = schema.get("required") if schema else None
        required = (
            [str(key) for key in schema_required]
            if isinstance(schema_required, list) and schema_required
            else list(_DEFAULT_REQUIRED)
        )

        present = [key for key in required if _nonempty_str(instance.get(key))]
        missing = [key for key in required if key not in present]

        # No usable sections at all -> cannot validate -> degraded (never auto-PASS,
        # and not a regen-fixable shell), whether or not a JSON schema was activated.
        if not present:
            return SensorResult(
                name=NAME,
                score=0.0,
                passed=False,
                details={"degraded": True, "reason": "no SOAP sections to validate", "errors": []},
            )

        # A required section missing or empty -> regen-fixable structural break.
        if missing:
            sections = sorted({_section_code(key) for key in missing})
            return SensorResult(
                name=NAME,
                score=0.0,
                passed=False,
                details={
                    "errors": [f"missing or empty section: {key}" for key in missing],
                    "sections": sections,
                },
            )

        # Every required section is present & non-empty. When a JSON schema is
        # activated, also enforce its full contract (types, additionalProperties, ...).
        if schema:
            try:
                validator = Draft202012Validator(schema)
                errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
            except Exception as exc:
                # A malformed/unprocessable activated schema (these are
                # admin-managed) must fail CLOSED: degrade rather than raise into the
                # sensor run, so the gate never auto-PASSes against an un-applicable
                # contract. The exception type (no PHI) is recorded for diagnosis.
                return SensorResult(
                    name=NAME,
                    score=0.0,
                    passed=False,
                    details={
                        "degraded": True,
                        "reason": "unprocessable JSON schema",
                        "errors": [type(exc).__name__],
                    },
                )
            if errors:
                messages = [err.message for err in errors]
                sections = sorted({_section_code(str(err.path[0])) for err in errors if err.path})
                return SensorResult(
                    name=NAME,
                    score=0.0,
                    passed=False,
                    details={"errors": messages, "sections": sections},
                )

        return SensorResult(name=NAME, score=1.0, passed=True, details={"errors": []})
