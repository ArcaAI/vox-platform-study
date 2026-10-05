"""LM Studio receives the declared output schema itself, not the envelope that carries it.

Every caller that turns an agent's declared ``outputSchema`` into an engine constraint (the
gateway's agent invocation, the harness ``core.agent`` node, the realtime lane, the note-plan
executor) sends the OpenAI wire shape::

    {"type": "json_schema", "json_schema": {"name": ..., "schema": {...}, "strict": true}}

The base adapter reads ``json_schema`` as the schema itself, so LM Studio was handed a "schema"
whose root is ``{name, schema, strict}`` — no ``type``, no ``properties`` — and its grammar
constrained nothing. Found live on the fact-ledger extractor (gemma-4-e2b-it-qat): with the
envelope the model omitted ``kind`` and wrote ``citation`` as a string; with the schema itself
the shape was right.
"""

from __future__ import annotations

from typing import Any

from text.models.requests import GenerateRequest, ResponseFormat
from text.providers.lmstudio import LMStudioProvider

_DECLARED: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["facts"],
    "properties": {
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["key", "kind"],
                "properties": {"key": {"type": "string"}, "kind": {"type": "string"}},
            },
        }
    },
}


def _applied(response_format: ResponseFormat) -> dict[str, Any]:
    request = GenerateRequest(
        prompt="x",
        provider="lm-studio",
        model="gemma-4-e2b-it-qat",
        response_format=response_format,
    )
    kwargs: dict[str, Any] = {}
    LMStudioProvider()._apply_response_format(kwargs, request)
    return kwargs


class TestDeclaredSchemaEnvelope:
    def test_the_envelope_is_unwrapped_to_the_schema_it_carries(self) -> None:
        kwargs = _applied(
            ResponseFormat(
                type="json_schema",
                json_schema={
                    "name": "fact_ledger_extraction_output",
                    "schema": _DECLARED,
                    "strict": True,
                },
            )
        )

        assert kwargs["response_format"] == {
            "type": "json_schema",
            "json_schema": {
                "name": "fact_ledger_extraction_output",
                "schema": _DECLARED,
                "strict": True,
            },
        }

    def test_the_envelope_strict_flag_is_kept(self) -> None:
        kwargs = _applied(
            ResponseFormat(
                type="json_schema",
                json_schema={"name": "n", "schema": _DECLARED, "strict": False},
            )
        )

        assert kwargs["response_format"]["json_schema"]["strict"] is False

    def test_an_envelope_without_a_name_is_named_output(self) -> None:
        kwargs = _applied(ResponseFormat(type="json_schema", json_schema={"schema": _DECLARED}))

        assert kwargs["response_format"]["json_schema"]["name"] == "output"
        assert kwargs["response_format"]["json_schema"]["schema"] == _DECLARED

    def test_a_bare_schema_is_still_forwarded_as_is(self) -> None:
        """Text's own shape (the document-template lane): ``json_schema`` IS the schema."""
        bare = {"title": "soap", **_DECLARED}

        kwargs = _applied(ResponseFormat(type="json_schema", json_schema=bare, strict=True))

        assert kwargs["response_format"]["json_schema"]["schema"] == bare
        assert kwargs["response_format"]["json_schema"]["name"] == "soap"

    def test_a_schema_with_a_property_named_schema_is_not_mistaken_for_an_envelope(self) -> None:
        bare = {
            "type": "object",
            "properties": {"schema": {"type": "object"}},
            "schema": {"type": "object"},
        }

        kwargs = _applied(ResponseFormat(type="json_schema", json_schema=bare, strict=True))

        assert kwargs["response_format"]["json_schema"]["schema"] == bare
