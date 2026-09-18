"""PHI helpers (R-3, R-7, docs/operations/telemetry-phi-guardrails.md)."""

from __future__ import annotations

from typing import Any

from hope_obs import redact_id
from hope_obs.phi import phi_sanitization_hook


class TestRedactId:
    def test_stable_for_the_same_input(self) -> None:
        assert redact_id("consultation-1") == redact_id("consultation-1")

    def test_twelve_hex_characters(self) -> None:
        token = redact_id("consultation-1")
        assert len(token) == 12
        assert all(char in "0123456789abcdef" for char in token)

    def test_never_returns_the_input(self) -> None:
        for value in ("consultation-1", "a", "0", 12345):
            assert redact_id(value) != str(value)

    def test_distinct_inputs_give_distinct_tokens(self) -> None:
        assert redact_id("a") != redact_id("b")

    def test_none_and_empty_render_as_dash(self) -> None:
        assert redact_id(None) == "-"
        assert redact_id("") == "-"

    def test_non_string_values_are_accepted(self) -> None:
        assert redact_id(42) == redact_id("42")


class _FakeSpan:
    def __init__(self, recording: bool, attributes: dict[str, Any] | None = None) -> None:
        self._recording = recording
        self.attributes = attributes or {}
        self.set: dict[str, Any] = {}

    def is_recording(self) -> bool:
        return self._recording

    def set_attribute(self, key: str, value: Any) -> None:
        self.set[key] = value


class TestPhiSanitizationHook:
    def test_redacts_captured_bodies(self) -> None:
        span = _FakeSpan(
            recording=True,
            attributes={
                "http.request.body.content": "patient says ...",
                "http.response.body.content": "note ...",
                "http.method": "POST",
            },
        )

        phi_sanitization_hook(span, {"type": "http"})

        assert span.set == {
            "http.request.body.content": "[REDACTED]",
            "http.response.body.content": "[REDACTED]",
        }

    def test_no_op_when_the_span_is_not_recording(self) -> None:
        span = _FakeSpan(recording=False, attributes={"http.request.body.content": "phi"})
        phi_sanitization_hook(span, {"type": "http"})
        assert span.set == {}

    def test_no_op_when_no_body_was_captured(self) -> None:
        span = _FakeSpan(recording=True, attributes={"http.method": "GET"})
        phi_sanitization_hook(span, {"type": "http"})
        assert span.set == {}

    def test_survives_a_span_with_no_attributes(self) -> None:
        span = _FakeSpan(recording=True)
        span.attributes = None  # type: ignore[assignment]
        phi_sanitization_hook(span, {"type": "http"})
        assert span.set == {}
