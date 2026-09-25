"""Unit tests for initial_prompt module."""

from __future__ import annotations

from stt.core.initial_prompt import compose_prompt


class TestComposePrompt:

    def test_both_none(self):
        assert compose_prompt(None, None) is None

    def test_both_empty(self):
        assert compose_prompt("", "") is None

    def test_both_whitespace(self):
        assert compose_prompt("   ", "  ") is None

    def test_initial_prompt_only(self):
        assert compose_prompt("medical terms", None) == "medical terms"

    def test_previous_text_only(self):
        assert compose_prompt(None, "prior context") == "prior context"

    def test_both_present(self):
        result = compose_prompt("medical terms", "prior context")
        assert result == "medical terms prior context"

    def test_strips_whitespace(self):
        result = compose_prompt("  medical terms  ", "  prior context  ")
        assert result == "medical terms prior context"

    def test_initial_prompt_empty_previous_present(self):
        assert compose_prompt("", "prior context") == "prior context"

    def test_initial_prompt_present_previous_empty(self):
        assert compose_prompt("medical terms", "") == "medical terms"
