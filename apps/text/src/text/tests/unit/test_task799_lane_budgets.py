"""TASK-799 lane B — `TEXT_CB_*` / `TEXT_QUEUE_*` / `TEXT_JUDGE_*` became ONE budget.

Twelve env vars expressed four concepts three times over, with different numbers
each time. The judge lane's own docstring called it "a separate budget, not a
separate mechanism" — which is exactly right, and is why one shape keyed
`(provider, lane ∈ {user, judge})` replaces all twelve rather than three
families being renamed.

What this suite pins:

  1. the floor is complete and the judge lane's is genuinely SMALLER (the
     isolation property those separate vars were bought for);
  2. a served value MERGES over the floor — an absent key keeps the floor rather
     than becoming a zero, which is what would silently take a provider offline;
  3. the live objects actually move: the semaphore's ceiling, the breaker's
     thresholds, and the vendor rate-limit tracker;
  4. a negative-cached snapshot (gateway down) changes nothing.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from text.core.effective_config import EffectiveConfigSnapshot
from text.core.runtime_defaults import JUDGE_LANE_FLOOR, USER_LANE_FLOOR, LaneBudget
from text.services.circuit_breaker import CircuitBreaker
from text.services.rate_limiter import RateLimitTracker
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.runtime_limits import (
    apply_lane_budgets,
    apply_provider_limits,
    lane_budget,
)


def _snapshot(*profiles: dict) -> EffectiveConfigSnapshot:
    return EffectiveConfigSnapshot(raw={"runtimeProfiles": list(profiles)}, ok=True)


class TestTheFloors:
    def test_the_judge_lane_is_smaller_than_the_user_lane(self):
        """The isolation property the three separate families were bought for.

        A saturated user pool must not starve a safety-plane judgement, and a
        wedged judge call must not eat the user-facing budget — so the judge lane
        is deliberately tight and fails fast rather than queueing.
        """
        assert JUDGE_LANE_FLOOR.max_concurrent < USER_LANE_FLOOR.max_concurrent
        assert JUDGE_LANE_FLOOR.acquire_timeout_s < USER_LANE_FLOOR.acquire_timeout_s
        assert JUDGE_LANE_FLOOR.timeout_s < USER_LANE_FLOOR.timeout_s

    def test_the_judge_lane_has_no_queue(self):
        """Queueing here would add latency to a call already on the critical path
        of a user-facing generation; guardrail owns the safety plane's retries."""
        assert JUDGE_LANE_FLOOR.queue_max_size == 0

    def test_the_breaker_nullables_preserve_pre_wiring_behaviour(self):
        """`None` is the deliberate no-op sentinel: unlimited HALF_OPEN trials and
        no failure-count decay. A literal here would start capping and decaying on
        every unconfigured deployment."""
        for floor in (USER_LANE_FLOOR, JUDGE_LANE_FLOOR):
            assert floor.half_open_max_calls is None
            assert floor.reset_timeout_s is None
            assert floor.count_rate_limits is True


class TestMergingOverTheFloor:
    def test_a_served_key_wins_and_the_rest_keep_the_floor(self):
        merged = USER_LANE_FLOOR.merged({"max_concurrent": 32})
        assert merged.max_concurrent == 32
        assert merged.timeout_s == USER_LANE_FLOOR.timeout_s
        assert merged.failure_threshold == USER_LANE_FLOOR.failure_threshold

    def test_an_empty_opinion_returns_the_floor_itself(self):
        assert USER_LANE_FLOOR.merged({}) is USER_LANE_FLOOR

    def test_a_null_value_is_not_an_opinion(self):
        assert USER_LANE_FLOOR.merged({"max_concurrent": None}).max_concurrent == (
            USER_LANE_FLOOR.max_concurrent
        )

    def test_an_unknown_key_is_ignored_rather_than_crashing(self):
        """The control plane may describe more than this version understands."""
        assert USER_LANE_FLOOR.merged({"someFutureKnob": 1}) is USER_LANE_FLOOR


class TestLaneParsing:
    def test_a_profile_with_no_lane_describes_the_user_path(self):
        """Every pre-existing provider-default row means the user-facing lane."""
        budgets = _snapshot(
            {"provider": "openai", "modelSlug": "", "maxConcurrent": 9}
        ).lane_budgets()
        assert budgets[("openai", "user")] == {"max_concurrent": 9}

    def test_the_two_lanes_are_separate_keys(self):
        budgets = _snapshot(
            {"provider": "openai", "modelSlug": "", "lane": "user", "maxConcurrent": 9},
            {"provider": "openai", "modelSlug": "", "lane": "judge", "maxConcurrent": 1},
        ).lane_budgets()
        assert budgets[("openai", "user")]["max_concurrent"] == 9
        assert budgets[("openai", "judge")]["max_concurrent"] == 1

    def test_a_model_specific_row_carries_no_lane_budget(self):
        """Capacity is a PROVIDER-level concern; a per-model row tunes generation."""
        assert (
            _snapshot(
                {"provider": "openai", "modelSlug": "gpt-4", "maxConcurrent": 9}
            ).lane_budgets()
            == {}
        )

    def test_a_zero_queue_size_is_a_real_opinion(self):
        """Zero means "no queue", not "misconfigured" — unlike a zero timeout."""
        budgets = _snapshot(
            {"provider": "openai", "modelSlug": "", "queueMaxSize": 0, "timeoutS": 0}
        ).lane_budgets()
        assert budgets[("openai", "user")] == {"queue_max_size": 0}


class TestLiveObjectsMove:
    def test_the_semaphore_ceiling_moves(self):
        semaphores = {"openai": ResizableSemaphore(4)}
        apply_provider_limits(
            _snapshot({"provider": "openai", "modelSlug": "", "maxConcurrent": 12}),
            semaphores,
            {},
        )
        assert semaphores["openai"].limit == 12

    def test_the_breaker_thresholds_move_on_the_live_object(self):
        """A fresh breaker would discard the failure count and open/closed state
        of the very provider being retuned, so the thresholds move in place."""
        breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
        breaker.record_failure()
        state = SimpleNamespace(circuit_breakers={"openai": breaker}, lane_budgets={})

        apply_lane_budgets(
            _snapshot(
                {
                    "provider": "openai",
                    "modelSlug": "",
                    "failureThreshold": 2,
                    "recoveryTimeoutS": 5.0,
                }
            ),
            state,
        )

        assert breaker._failure_threshold == 2
        assert breaker._recovery_timeout == 5.0
        # Retuning is not forgiveness.
        assert breaker.failure_count == 1

    def test_vendor_quotas_move(self):
        tracker = RateLimitTracker(rpm_limit=0, tpm_limit=0)
        apply_provider_limits(
            _snapshot({"provider": "openai", "modelSlug": "", "rpmLimit": 60, "tpmLimit": 90_000}),
            {},
            {},
            {"openai": tracker},
        )
        assert tracker.rpm_limit == 60
        assert tracker.tpm_limit == 90_000

    def test_a_zero_quota_means_unlimited_and_is_applied(self):
        """`_positive_int` would have dropped it; quotas use the non-negative
        coercion because zero is how "no client-side rate limiting" is said."""
        tracker = RateLimitTracker(rpm_limit=60, tpm_limit=60)
        apply_provider_limits(
            _snapshot({"provider": "openai", "modelSlug": "", "rpmLimit": 0, "tpmLimit": 0}),
            {},
            {},
            {"openai": tracker},
        )
        assert tracker.rpm_limit == 0
        assert tracker.tpm_limit == 0

    def test_a_provider_this_process_does_not_serve_is_skipped(self):
        semaphores = {"openai": ResizableSemaphore(4)}
        apply_provider_limits(
            _snapshot({"provider": "not-registered", "modelSlug": "", "maxConcurrent": 12}),
            semaphores,
            {},
        )
        assert semaphores["openai"].limit == 4


class TestGatewayDownChangesNothing:
    """A negative-cached snapshot is not an opinion of zero."""

    @pytest.fixture
    def down(self) -> EffectiveConfigSnapshot:
        return EffectiveConfigSnapshot(raw={}, ok=False)

    def test_semaphores_untouched(self, down):
        semaphores = {"openai": ResizableSemaphore(4)}
        apply_provider_limits(down, semaphores, {})
        assert semaphores["openai"].limit == 4

    def test_breakers_untouched(self, down):
        breaker = CircuitBreaker(failure_threshold=5)
        state = SimpleNamespace(circuit_breakers={"openai": breaker}, lane_budgets={})
        apply_lane_budgets(down, state)
        assert breaker._failure_threshold == 5
        assert state.lane_budgets == {}


class TestLaneBudgetLookup:
    def test_no_state_yields_the_floor(self):
        assert lane_budget(SimpleNamespace(), "openai", "user") is USER_LANE_FLOOR
        assert lane_budget(SimpleNamespace(), "openai", "judge") is JUDGE_LANE_FLOOR

    def test_an_unknown_lane_falls_back_to_the_user_floor(self):
        assert lane_budget(SimpleNamespace(), "openai", "nonsense") is USER_LANE_FLOOR

    def test_a_served_budget_is_merged_for_the_right_lane_only(self):
        state = SimpleNamespace(lane_budgets={("openai", "judge"): {"max_concurrent": 7}})
        judge = lane_budget(state, "openai", "judge")
        user = lane_budget(state, "openai", "user")

        assert isinstance(judge, LaneBudget)
        assert judge.max_concurrent == 7
        assert user is USER_LANE_FLOOR
