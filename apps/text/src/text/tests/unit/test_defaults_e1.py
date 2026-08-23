"""TDD tests for E1.2 — Default resolution and provider payload building.

Tests for resolve_request_defaults() which applies sensible fallbacks
ONLY when the request body omits hyperparameters (None).
"""

from __future__ import annotations

import pytest


class TestResolveRequestDefaults:
    """Test the resolve_request_defaults() utility function."""

    def test_import_exists(self):
        from text.core.defaults import resolve_request_defaults

        assert resolve_request_defaults is not None

    def test_none_temperature_becomes_default(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.1

    def test_none_max_tokens_becomes_default(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["max_tokens"] == 16_384

    def test_none_top_p_becomes_default(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved["top_p"] == 0.95

    def test_explicit_temperature_preserved(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.3)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.3

    def test_explicit_max_tokens_preserved(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", max_tokens=6000)
        resolved = resolve_request_defaults(req)
        assert resolved["max_tokens"] == 6000

    def test_explicit_top_p_preserved(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", top_p=0.8)
        resolved = resolve_request_defaults(req)
        assert resolved["top_p"] == 0.8

    def test_zero_temperature_is_preserved(self):
        """temperature=0.0 is a valid explicit value, not None."""
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.0)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.0

    def test_all_none_returns_all_defaults(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello")
        resolved = resolve_request_defaults(req)
        assert resolved == {"temperature": 0.1, "max_tokens": 16_384, "top_p": 0.95}

    def test_mixed_none_and_explicit(self):
        from text.core.defaults import resolve_request_defaults
        from text.models.requests import GenerateRequest

        req = GenerateRequest(prompt="hello", temperature=0.5, max_tokens=8000)
        resolved = resolve_request_defaults(req)
        assert resolved["temperature"] == 0.5
        assert resolved["max_tokens"] == 8000
        assert resolved["top_p"] == 0.95


class TestGenerationFloor:
    """The in-code FLOOR — the last fallback, not the intended value.

    Renamed from `GENERATION_DEFAULTS` in TASK-799 lane B, and the rename is the
    point: these three numbers had NO config surface at all, so "default" was a
    euphemism for "hardcoded". They are the last of three sources now — the
    caller's own value, then the platform generation profile from the control
    plane, then this.
    """

    def test_the_floor_exists(self):
        from text.core.defaults import GENERATION_FLOOR

        assert isinstance(GENERATION_FLOOR, dict)

    def test_floor_temperature_is_0_1(self):
        from text.core.defaults import GENERATION_FLOOR

        assert GENERATION_FLOOR["temperature"] == 0.1

    def test_floor_max_tokens_is_16_384(self):
        from text.core.defaults import GENERATION_FLOOR

        assert GENERATION_FLOOR["max_tokens"] == 16_384

    def test_floor_top_p_is_0_95(self):
        from text.core.defaults import GENERATION_FLOOR

        assert GENERATION_FLOOR["top_p"] == 0.95


class TestGenerationDefaultsHaveAControlPlaneHome:
    """The three-source resolution: caller > control plane > floor."""

    @pytest.fixture(autouse=True)
    def _reset(self):
        from text.core.defaults import apply_generation_defaults

        apply_generation_defaults({})
        yield
        apply_generation_defaults({})

    def test_a_served_profile_overrides_the_floor(self):
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults
        from text.models.requests import GenerateRequest

        apply_generation_defaults({"temperature": 0.7, "max_tokens": 512})
        resolved = resolve_request_defaults(GenerateRequest(prompt="hi", model="m"))

        assert resolved["temperature"] == 0.7
        assert resolved["max_tokens"] == 512
        # A key the control plane did not serve keeps its floor.
        assert resolved["top_p"] == 0.95

    def test_the_caller_still_wins_over_a_served_profile(self):
        from text.core.defaults import apply_generation_defaults, resolve_request_defaults
        from text.models.requests import GenerateRequest

        apply_generation_defaults({"temperature": 0.7})
        resolved = resolve_request_defaults(
            GenerateRequest(prompt="hi", model="m", temperature=0.0)
        )

        # 0.0 is a real caller value, not "unset" — it must not fall through.
        assert resolved["temperature"] == 0.0

    def test_an_empty_profile_restores_the_floor(self):
        """A control plane with no opinion is not an opinion of zero."""
        from text.core.defaults import (
            GENERATION_FLOOR,
            active_generation_defaults,
            apply_generation_defaults,
        )

        apply_generation_defaults({"temperature": 0.7})
        apply_generation_defaults({})
        assert active_generation_defaults() == GENERATION_FLOOR

    def test_the_snapshot_group_feeds_it(self):
        """End to end from the served payload — `generation` is the group name
        `effective-config.service.ts` must emit."""
        from text.core.effective_config import EffectiveConfigSnapshot

        snapshot = EffectiveConfigSnapshot(
            raw={"generation": {"temperature": 0.3, "topP": 0.8, "maxTokens": 2048}}, ok=True
        )
        assert snapshot.generation_defaults() == {
            "temperature": 0.3,
            "top_p": 0.8,
            "max_tokens": 2048,
        }

    def test_a_negative_cached_snapshot_changes_nothing(self):
        """Gateway down ⇒ the floors stand, exactly as with no opinion."""
        from text.core.defaults import GENERATION_FLOOR, active_generation_defaults
        from text.core.effective_config import EffectiveConfigSnapshot
        from text.services.runtime_limits import apply_platform_posture

        class _State:
            guardrail_posture = None

        apply_platform_posture(EffectiveConfigSnapshot(raw={}, ok=False), _State())
        assert active_generation_defaults() == GENERATION_FLOOR
