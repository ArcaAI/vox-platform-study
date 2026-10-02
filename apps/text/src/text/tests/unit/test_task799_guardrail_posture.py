"""lane B — the guardrail posture resolves, it is not read from env.

`core/guardrail_posture.py` is where the `TEXT_EXTERNAL_GUARDRAIL_*` env vars
landed after being split by CARDINALITY (owner decision D-1):

  * PLATFORM half (retry budget, timeout) — PULL channel, one value per service;
  * TENANT half (`include_reasoning`) — PUSH, per request, resolving
    tenant → platform and widening ONLY on absence.

TASK-1035 removed the platform switch (`enabled`, OD-4), the tenant opt-out
(OD-1) and `require_medical` (OD-5): what remains is tuning, and a served or
pushed value for any of the removed fields is ignored.

`ExternalGuardrailClient`'s own behaviour under each posture (retry, fail-closed,
headers) lives in `test_external_guardrail_client.py`; this file covers the
RESOLUTION, including the parsing of the served payload that
`effective-config.service.ts` emits.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from text.core.effective_config import EffectiveConfigSnapshot
from text.core.guardrail_posture import GuardrailPosture, platform_posture, resolve_posture
from text.core.runtime_defaults import (
    GUARDRAIL_INCLUDE_REASONING_FLOOR,
    GUARDRAIL_MAX_RETRIES_FLOOR,
    GUARDRAIL_RETRY_BACKOFF_FLOOR_MS,
    GUARDRAIL_TIMEOUT_FLOOR_S,
)
from text.models.requests import GuardrailPolicyOverride
from text.services.runtime_limits import apply_platform_posture


class TestTheFloors:
    def test_the_floor_is_the_tuning_floors(self):
        floor = GuardrailPosture()
        assert floor.timeout_s == GUARDRAIL_TIMEOUT_FLOOR_S == 120
        assert floor.max_retries == GUARDRAIL_MAX_RETRIES_FLOOR == 2
        assert floor.retry_backoff_ms == GUARDRAIL_RETRY_BACKOFF_FLOOR_MS == 100
        assert floor.include_reasoning is GUARDRAIL_INCLUDE_REASONING_FLOOR is False

    def test_there_is_no_fail_open_field(self):
        """Not a tunable: an errored guardrail must never return `allowed: True`."""
        assert "fail_open" not in GuardrailPosture.__dataclass_fields__

    def test_there_is_no_switch_left_to_turn_screening_off(self):
        fields = set(GuardrailPosture.__dataclass_fields__)
        assert fields.isdisjoint({"enabled", "opted_out", "require_medical"})


class TestPlatformPostureParsing:
    def test_an_absent_group_is_the_floor(self):
        assert platform_posture(None) == GuardrailPosture()
        assert platform_posture({}) == GuardrailPosture()

    def test_a_malformed_group_is_the_floor(self):
        """A control plane with no opinion must never be read as an opinion."""
        assert platform_posture("not-a-dict") == GuardrailPosture()  # type: ignore[arg-type]

    def test_served_values_win(self):
        posture = platform_posture(
            {"timeoutS": 3, "maxRetries": 0, "retryBackoffMs": 25, "includeReasoning": True}
        )
        assert posture == GuardrailPosture(
            timeout_s=3, max_retries=0, retry_backoff_ms=25, include_reasoning=True
        )

    def test_a_served_switch_from_an_older_control_plane_is_ignored(self):
        assert platform_posture({"enabled": False, "requireMedical": False}) == GuardrailPosture()

    def test_a_zero_retry_budget_is_a_real_opinion(self):
        """`maxRetries: 0` means "no retry", not "unset"."""
        assert platform_posture({"maxRetries": 0}).max_retries == 0

    def test_a_wrong_typed_value_keeps_the_floor(self):
        posture = platform_posture({"includeReasoning": "yes", "timeoutS": "soon"})
        assert posture.include_reasoning is GUARDRAIL_INCLUDE_REASONING_FLOOR
        assert posture.timeout_s == GUARDRAIL_TIMEOUT_FLOOR_S

    def test_the_snapshot_group_feeds_it(self):
        """`externalGuardrail` is the group name the gateway view must emit."""
        snapshot = EffectiveConfigSnapshot(raw={"externalGuardrail": {"timeoutS": 4}}, ok=True)
        assert platform_posture(snapshot.external_guardrail()).timeout_s == 4


class TestTenantOverThePlatform:
    """Resolution is tenant → platform, widening ONLY on absence."""

    @pytest.fixture
    def platform(self) -> GuardrailPosture:
        return GuardrailPosture(include_reasoning=False)

    def test_no_tenant_policy_leaves_the_platform_posture(self, platform):
        assert resolve_posture(platform, None) == platform

    def test_a_tenant_may_ask_for_reasoning(self, platform):
        assert resolve_posture(platform, GuardrailPolicyOverride(include_reasoning=True)) == (
            GuardrailPosture(include_reasoning=True)
        )

    def test_none_is_no_opinion_not_false(self):
        platform = GuardrailPosture(include_reasoning=True)
        assert resolve_posture(platform, GuardrailPolicyOverride()) == platform

    def test_a_tenant_cannot_touch_the_platform_tuning(self, platform):
        """The retry budget stays PLATFORM-scope: no request shape lengthens it."""
        resolved = resolve_posture(platform, GuardrailPolicyOverride(include_reasoning=True))
        assert resolved.timeout_s == platform.timeout_s
        assert resolved.max_retries == platform.max_retries
        assert set(GuardrailPolicyOverride.model_fields) == {"include_reasoning"}


class TestApplicationToLiveState:
    def test_a_served_posture_reaches_app_state(self):
        state = SimpleNamespace(guardrail_posture=None)
        apply_platform_posture(
            EffectiveConfigSnapshot(raw={"externalGuardrail": {"maxRetries": 5}}, ok=True),
            state,
        )
        assert state.guardrail_posture.max_retries == 5

    def test_a_negative_cached_snapshot_leaves_state_alone(self):
        """Gateway down ⇒ whatever was last served stands; it is not reset to the
        floor, because a fetch failure is not a statement about the value."""
        held = GuardrailPosture(max_retries=7)
        state = SimpleNamespace(guardrail_posture=held)
        apply_platform_posture(EffectiveConfigSnapshot(raw={}, ok=False), state)
        assert state.guardrail_posture is held
