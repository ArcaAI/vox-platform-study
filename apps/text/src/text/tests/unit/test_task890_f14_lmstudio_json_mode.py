"""F14 — LM Studio's structured-output wire has no ``json_object``.

`ResponseFormat.type == "json"` is Text's OWN vocabulary for "answer in JSON, no
schema", and the OpenAI-compatible adapter spells that on the wire as
``{"type": "json_object"}``. LM Studio's server rejects it outright::

    400 {'error': "'response_format.type' must be 'json_schema' or 'text'"}

Measured live 2026-09-07 against LM Studio serving ``gemma-4-e2b-it-qat``: the
``json_object`` control 400s, while a ``json_schema`` carrying a permissive
object schema is accepted and returns valid JSON. So every published agent whose
``parameters.responseFormat`` is ``json`` — the platform's own key-points agent
among them — could never generate on this engine.

The translation belongs in the ENGINE's adapter, which is exactly why
`LMStudioProvider` is a class (see its module header: "a subclass cannot be wrong
about which engine it is"). Nothing about the request changes: the caller still
asks for `json`, and OpenAI/Azure keep sending `json_object`.
"""

from __future__ import annotations

from typing import Any

from text.models.requests import GenerateRequest, ResponseFormat
from text.providers.lmstudio import LMStudioProvider
from text.providers.openai_compat import OpenAICompatProvider


def _request(**overrides: Any) -> GenerateRequest:
    defaults: dict[str, Any] = {
        "prompt": "Summarise this.",
        "provider": "lm-studio",
        "model": "gemma-4-e2b-it-qat",
    }
    defaults.update(overrides)
    return GenerateRequest(**defaults)


def _applied(provider: Any, request: GenerateRequest) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    provider._apply_response_format(kwargs, request)
    return kwargs


class TestJsonModeOnLmStudio:
    def test_json_never_reaches_the_wire_as_json_object(self) -> None:
        kwargs = _applied(LMStudioProvider(), _request(response_format=ResponseFormat(type="json")))

        assert kwargs["response_format"]["type"] == "json_schema"

    def test_json_becomes_a_permissive_object_schema(self) -> None:
        """Permissive, not invented: the caller asked for "some JSON" and declared
        no shape, so the grammar constrains the OUTPUT FORMAT and nothing else."""
        kwargs = _applied(LMStudioProvider(), _request(response_format=ResponseFormat(type="json")))

        schema = kwargs["response_format"]["json_schema"]
        assert schema["schema"] == {"type": "object"}
        # `strict` would demand a closed property set the caller never named.
        assert schema["strict"] is False

    def test_a_declared_schema_is_forwarded_untouched(self) -> None:
        declared = {
            "title": "key_points",
            "type": "object",
            "properties": {"points": {"type": "array", "items": {"type": "string"}}},
            "required": ["points"],
        }

        kwargs = _applied(
            LMStudioProvider(),
            _request(
                response_format=ResponseFormat(
                    type="json_schema", json_schema=declared, strict=True
                )
            ),
        )

        assert kwargs["response_format"]["json_schema"]["schema"] == declared
        assert kwargs["response_format"]["json_schema"]["name"] == "key_points"
        assert kwargs["response_format"]["json_schema"]["strict"] is True

    def test_no_response_format_stays_absent(self) -> None:
        assert _applied(LMStudioProvider(), _request()) == {}

    def test_the_generic_openai_wire_is_unchanged(self) -> None:
        """The translation is LM Studio's, not everyone's: an engine that DOES
        implement `json_object` must keep getting it."""
        kwargs = _applied(
            OpenAICompatProvider(), _request(response_format=ResponseFormat(type="json"))
        )

        assert kwargs["response_format"] == {"type": "json_object"}
