"""TDD tests for E1.2 — Default resolution and provider payload building.

Tests for resolve_request_defaults() which applies sensible fallbacks
ONLY when the request body omits hyperparameters (None).
"""

from __future__ import annotations


class TestResolveRequestDefaults:
    """Test the resolve_request_defaults() utility function."""

    def test_import_exists(self):
        from smr.core.defaults import resolve_request_defaults

        assert resolve_request_defaults is not None

    def test_none_temperature_becomes_default(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.1

    def test_none_max_tokens_becomes_default(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["max_tokens"] == 16_384

    def test_none_top_p_becomes_default(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["top_p"] == 0.95

    def test_explicit_temperature_preserved(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.3)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.3

    def test_explicit_max_tokens_preserved(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", max_tokens=6000)
        resolved = resolve_request_defaults(req)
        assert resolved["max_tokens"] == 6000

    def test_explicit_top_p_preserved(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", top_p=0.8)
        resolved = resolve_request_defaults(req)
        assert resolved["top_p"] == 0.8

    def test_zero_temperature_is_preserved(self):
        """temperature=0.0 is a valid explicit value, not None."""
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.0)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.0

    def test_all_none_returns_all_defaults(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved == {"temperature": 0.1, "max_tokens": 16_384, "top_p": 0.95}

    def test_mixed_none_and_explicit(self):
        from smr.core.defaults import resolve_request_defaults
        from smr.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.5, max_tokens=8000)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.5
        assert resolved["max_tokens"] == 8000
        assert resolved["top_p"] == 0.95


class TestDefaultConstants:
    """Verify the default constants are accessible and correct."""

    def test_defaults_dict_exists(self):
        from smr.core.defaults import GENERATION_DEFAULTS

        assert isinstance(GENERATION_DEFAULTS, dict)

    def test_default_temperature_is_0_1(self):
        from smr.core.defaults import GENERATION_DEFAULTS

        assert GENERATION_DEFAULTS["temperature"] == 0.1

    def test_default_max_tokens_is_16_384(self):
        from smr.core.defaults import GENERATION_DEFAULTS

        assert GENERATION_DEFAULTS["max_tokens"] == 16_384

    def test_default_top_p_is_0_95(self):
        from smr.core.defaults import GENERATION_DEFAULTS

        assert GENERATION_DEFAULTS["top_p"] == 0.95
