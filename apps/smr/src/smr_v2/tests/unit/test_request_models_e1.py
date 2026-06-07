"""TDD tests for E1 — ResponseFormat model + updated GenerateRequest.

Written BEFORE implementation — these must fail first (RED),
then we write minimal code to make them pass (GREEN).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

# ── ResponseFormat model ──


class TestResponseFormat:
    """Tests for the new ResponseFormat model."""

    def test_import_exists(self):
        from smr_v2.models.requests import ResponseFormat
        assert ResponseFormat is not None

    def test_default_is_text(self):
        from smr_v2.models.requests import ResponseFormat
        fmt = ResponseFormat()
        assert fmt.type == "text"
        assert fmt.json_schema is None
        assert fmt.strict is True

    def test_json_mode(self):
        from smr_v2.models.requests import ResponseFormat
        fmt = ResponseFormat(type="json")
        assert fmt.type == "json"
        assert fmt.json_schema is None

    def test_json_schema_mode(self):
        from smr_v2.models.requests import ResponseFormat
        schema = {
            "type": "object",
            "properties": {"subjective": {"type": "string"}, "objective": {"type": "string"}},
            "required": ["subjective", "objective"],
        }
        fmt = ResponseFormat(type="json_schema", json_schema=schema, strict=True)
        assert fmt.type == "json_schema"
        assert fmt.json_schema == schema
        assert fmt.strict is True

    def test_json_schema_mode_non_strict(self):
        from smr_v2.models.requests import ResponseFormat
        fmt = ResponseFormat(type="json_schema", json_schema={"type": "object"}, strict=False)
        assert fmt.strict is False

    def test_invalid_type_rejected(self):
        from smr_v2.models.requests import ResponseFormat
        with pytest.raises(ValidationError):
            ResponseFormat(type="xml")

    def test_serialization_roundtrip(self):
        from smr_v2.models.requests import ResponseFormat
        schema = {"type": "object", "properties": {"plan": {"type": "string"}}}
        fmt = ResponseFormat(type="json_schema", json_schema=schema)
        data = fmt.model_dump()
        restored = ResponseFormat(**data)
        assert restored.type == "json_schema"
        assert restored.json_schema == schema


# ── GenerateRequest — Optional hyperparameters ──


class TestGenerateRequestOptionalHyperparams:
    """Tests that temperature, max_tokens, top_p are Optional[float/int] with None default."""

    def test_temperature_defaults_to_none(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.temperature is None

    def test_max_tokens_defaults_to_none(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.max_tokens is None

    def test_top_p_defaults_to_none(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.top_p is None

    def test_explicit_temperature_is_preserved(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello", temperature=0.1)
        assert req.temperature == 0.1

    def test_explicit_max_tokens_is_preserved(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello", max_tokens=6000)
        assert req.max_tokens == 6000

    def test_explicit_top_p_is_preserved(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello", top_p=0.95)
        assert req.top_p == 0.95

    def test_temperature_zero_is_valid(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello", temperature=0.0)
        assert req.temperature == 0.0

    def test_temperature_boundary_2_is_valid(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello", temperature=2.0)
        assert req.temperature == 2.0

    def test_temperature_above_2_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hello", temperature=3.0)

    def test_max_tokens_zero_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hello", max_tokens=0)

    def test_max_tokens_negative_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hello", max_tokens=-1)

    def test_top_p_negative_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hello", top_p=-0.1)

    def test_top_p_above_1_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="hello", top_p=1.1)


# ── GenerateRequest — response_format field ──


class TestGenerateRequestResponseFormat:
    """Tests for the optional response_format field on GenerateRequest."""

    def test_response_format_defaults_to_none(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.response_format is None

    def test_response_format_accepts_text(self):
        from smr_v2.models.requests import GenerateRequest, ResponseFormat
        fmt = ResponseFormat(type="text")
        req = GenerateRequest(prompt="hello", response_format=fmt)
        assert req.response_format.type == "text"

    def test_response_format_accepts_json_schema(self):
        from smr_v2.models.requests import GenerateRequest, ResponseFormat
        schema = {"type": "object", "properties": {"assessment": {"type": "string"}}}
        fmt = ResponseFormat(type="json_schema", json_schema=schema)
        req = GenerateRequest(prompt="hello", response_format=fmt)
        assert req.response_format.type == "json_schema"
        assert req.response_format.json_schema == schema

    def test_full_request_with_all_new_fields(self):
        from smr_v2.models.requests import GenerateRequest, ResponseFormat
        schema = {"type": "object", "properties": {"plan": {"type": "string"}}}
        req = GenerateRequest(
            prompt="Summarize this",
            system_prompt="You are helpful",
            provider="azure_openai",
            model="gpt-4o",
            temperature=0.1,
            max_tokens=6000,
            top_p=0.95,
            stream=True,
            response_format=ResponseFormat(type="json_schema", json_schema=schema, strict=True),
            context={"department": "surgery"},
        )
        assert req.temperature == 0.1
        assert req.max_tokens == 6000
        assert req.top_p == 0.95
        assert req.response_format.type == "json_schema"
        assert req.stream is True

    def test_serialization_roundtrip_with_response_format(self):
        from smr_v2.models.requests import GenerateRequest, ResponseFormat
        schema = {"type": "object", "properties": {"s": {"type": "string"}}}
        req = GenerateRequest(
            prompt="hello",
            temperature=0.1,
            response_format=ResponseFormat(type="json_schema", json_schema=schema),
        )
        data = req.model_dump()
        restored = GenerateRequest(**data)
        assert restored.response_format.type == "json_schema"
        assert restored.response_format.json_schema == schema
        assert restored.temperature == 0.1

    def test_serialization_with_none_response_format(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        data = req.model_dump()
        assert data["response_format"] is None
        restored = GenerateRequest(**data)
        assert restored.response_format is None


# ── GenerateRequest — existing validation still works ──


class TestGenerateRequestExistingValidation:
    """Ensure existing validations remain intact after refactor."""

    def test_empty_prompt_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="")

    def test_whitespace_only_prompt_rejected(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest(prompt="   ")

    def test_prompt_required(self):
        from smr_v2.models.requests import GenerateRequest
        with pytest.raises(ValidationError):
            GenerateRequest()

    def test_default_provider_is_lm_studio(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.provider == "lm-studio"

    def test_default_stream_is_false(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.stream is False

    def test_retry_config_default(self):
        from smr_v2.models.requests import GenerateRequest
        req = GenerateRequest(prompt="hello")
        assert req.retry_config.max_retries == 3
