"""The unfilled-secret sentinel must never be readable as a credential.

`CHANGE_ME` is a NON-EMPTY string, so every `if token:` / `token or fallback` guard written
against a secret accepts it and stops looking. That is not hypothetical: with
`INTERNAL_ACCESS_TOKEN=CHANGE_ME` in `.env.dev`, all five Python services presented the literal
string as their `X-Service-Token` on every outbound call, never reached their legacy fallback,
and every internal hop 401'd — a configuration bug wearing an authentication bug's clothes.

These tests pin the two properties that close it: the sentinel resolves to "" (the ALREADY
documented "auth disabled / use the fallback" path), and a real value is never altered.
"""

from __future__ import annotations

import pytest

from hope_env import PLACEHOLDER_SENTINEL, first_real_secret, is_placeholder, real_secret


class _Secret:
    """Stand-in for pydantic's ``SecretStr`` — the shape the settings classes pass in."""

    def __init__(self, value: str) -> None:
        self._value = value

    def get_secret_value(self) -> str:
        return self._value


class TestIsPlaceholder:
    def test_recognises_the_sentinel(self):
        assert is_placeholder(PLACEHOLDER_SENTINEL) is True

    @pytest.mark.parametrize("value", ["CHANGE_ME ", " CHANGE_ME", "  CHANGE_ME\t"])
    def test_tolerates_surrounding_whitespace(self, value):
        # A hand-edited env file routinely leaves trailing spaces; `KEY=CHANGE_ME ` is no more
        # configured than `KEY=CHANGE_ME`.
        assert is_placeholder(value) is True

    @pytest.mark.parametrize("value", ["", None, "change_me", "CHANGE_ME_TOO", "real-token"])
    def test_does_not_over_match(self, value):
        assert is_placeholder(value) is False


class TestRealSecret:
    def test_sentinel_reads_as_absent(self):
        assert real_secret(PLACEHOLDER_SENTINEL) == ""

    def test_a_real_value_is_returned_verbatim(self):
        assert real_secret("7d12dfc3") == "7d12dfc3"

    def test_unwraps_a_secretstr(self):
        assert real_secret(_Secret("abc")) == "abc"
        assert real_secret(_Secret(PLACEHOLDER_SENTINEL)) == ""

    @pytest.mark.parametrize("value", [None, ""])
    def test_absent_stays_absent(self, value):
        assert real_secret(value) == ""

    def test_a_value_merely_containing_the_sentinel_is_kept(self):
        # Only an EXACT match is the sentinel. A real secret that happens to embed the substring
        # must not be silently discarded — that would be the opposite failure.
        assert real_secret("CHANGE_ME_BUT_REAL") == "CHANGE_ME_BUT_REAL"


class TestFirstRealSecret:
    def test_sentinel_falls_through_to_the_legacy_value(self):
        # THE regression. `"CHANGE_ME" or "legacy"` evaluates to "CHANGE_ME"; this must not.
        assert first_real_secret(PLACEHOLDER_SENTINEL, "legacy") == "legacy"

    def test_a_configured_shared_token_wins(self):
        assert first_real_secret("shared", "legacy") == "shared"

    def test_all_unfilled_resolves_to_empty(self):
        # Empty is the documented local-dev / hermetic-CI bypass, not a third behaviour.
        assert first_real_secret(PLACEHOLDER_SENTINEL, PLACEHOLDER_SENTINEL) == ""
        assert first_real_secret(None, "") == ""

    def test_mixed_secretstr_and_plain_str(self):
        assert first_real_secret(_Secret(PLACEHOLDER_SENTINEL), _Secret("legacy")) == "legacy"
