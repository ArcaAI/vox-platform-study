"""TASK-1031 D-1/D-3 — LM Studio concurrency is one platform-governed number.

All 497 judge-route 503s in a week were the judge-lane semaphore timing out at
two permits. The fix is not a bigger hardcoded number but the one governed value
the platform admin already owns — `lmStudio.serving.parallel`, served to this
service as ``lmStudioServing.parallel`` — applied to both lanes of provider
``lm-studio``, with a floor of 10 (LM Studio's decode slots per model) when the
control plane has not answered.

What this suite pins:

  1. the floors: judge lane 10 (acquire 5 s, no queue), lm-studio user lane 10,
     every other provider's user lane unchanged;
  2. the served value is parsed tolerantly — absent / null / invalid is "no
     opinion", never a zero;
  3. the JUDGE lane always follows the served value; the USER lane follows it
     only when the SYSTEM runtime profile carries no ``maxConcurrent`` (an
     explicit connection ceiling keeps winning);
  4. a served change reaches a judge semaphore that ALREADY exists — no restart.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from text.api.endpoints.judge import _ensure_semaphore
from text.core.effective_config import EffectiveConfigSnapshot
from text.core.runtime_defaults import (
    JUDGE_LANE_FLOOR,
    LM_STUDIO_PARALLEL_FLOOR,
    LM_STUDIO_PROVIDER,
    PROVIDER_MAX_CONCURRENT_FLOOR,
    USER_LANE_FLOOR,
    lane_floor,
)
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.runtime_limits import (
    apply_lane_budgets,
    apply_provider_limits,
    lane_budget,
)


def _snapshot(
    parallel: object = None, *profiles: dict, served: bool = True
) -> EffectiveConfigSnapshot:
    raw: dict = {"runtimeProfiles": list(profiles)}
    if served:
        raw["lmStudioServing"] = {"parallel": parallel}
    return EffectiveConfigSnapshot(raw=raw, ok=True)


def _profile(provider: str = LM_STUDIO_PROVIDER, **fields: object) -> dict:
    return {"provider": provider, "modelSlug": "", **fields}


class TestFloors:
    def test_the_judge_lane_floor_is_ten(self):
        assert JUDGE_LANE_FLOOR.max_concurrent == 10
        # TASK-1059 OD-6: a 30 s wait in a bounded queue (was 5 s, no queue).
        assert JUDGE_LANE_FLOOR.acquire_timeout_s == 30.0
        assert JUDGE_LANE_FLOOR.queue_max_size == 20

    def test_the_lm_studio_user_lane_floor_matches_its_decode_slots(self):
        assert LM_STUDIO_PROVIDER == "lm-studio"
        assert LM_STUDIO_PARALLEL_FLOOR == 10
        assert lane_floor(LM_STUDIO_PROVIDER, "user").max_concurrent == 10
        assert lane_budget(SimpleNamespace(), LM_STUDIO_PROVIDER, "user").max_concurrent == 10

    def test_other_providers_keep_the_generic_floor(self):
        assert lane_floor("openai", "user") is USER_LANE_FLOOR
        assert USER_LANE_FLOOR.max_concurrent == PROVIDER_MAX_CONCURRENT_FLOOR == 4
        assert lane_floor("openai", "judge") is JUDGE_LANE_FLOOR
        assert lane_floor(LM_STUDIO_PROVIDER, "judge") is JUDGE_LANE_FLOOR


class TestParsing:
    def test_a_served_value_is_read(self):
        assert _snapshot(12).lm_studio_parallel() == 12

    @pytest.mark.parametrize("bad", [None, 0, -3, "10", True, [10]])
    def test_an_invalid_value_is_no_opinion(self, bad):
        assert _snapshot(bad).lm_studio_parallel() is None

    def test_an_absent_group_is_no_opinion(self):
        assert _snapshot(served=False).lm_studio_parallel() is None
        assert (
            EffectiveConfigSnapshot(raw={"lmStudioServing": None}, ok=True).lm_studio_parallel()
            is None
        )
        assert (
            EffectiveConfigSnapshot(raw={"lmStudioServing": 7}, ok=True).lm_studio_parallel()
            is None
        )


class TestUserLane:
    def test_served_parallel_sizes_the_lm_studio_semaphore(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(10), "openai": ResizableSemaphore(4)}
        apply_provider_limits(_snapshot(14), semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 14
        assert semaphores["openai"].limit == 4

    def test_an_explicit_connection_ceiling_keeps_winning(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(10)}
        apply_provider_limits(_snapshot(14, _profile(maxConcurrent=3)), semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 3

    def test_nothing_served_leaves_the_live_value(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(10)}
        apply_provider_limits(_snapshot(served=False), semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 10

    def test_gateway_down_changes_nothing(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(10)}
        down = EffectiveConfigSnapshot(raw={"lmStudioServing": {"parallel": 2}}, ok=False)
        apply_provider_limits(down, semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 10


class TestJudgeLane:
    def test_served_parallel_sets_the_judge_budget(self):
        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(12), state)
        assert lane_budget(state, LM_STUDIO_PROVIDER, "judge").max_concurrent == 12

    def test_the_judge_lane_follows_parallel_even_with_a_connection_ceiling(self):
        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(12, _profile(maxConcurrent=3)), state)
        assert lane_budget(state, LM_STUDIO_PROVIDER, "judge").max_concurrent == 12
        # The user lane's served row is untouched by it.
        assert lane_budget(state, LM_STUDIO_PROVIDER, "user").max_concurrent == 3

    def test_other_judge_budget_fields_keep_their_floor(self):
        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(12), state)
        budget = lane_budget(state, LM_STUDIO_PROVIDER, "judge")
        assert budget.acquire_timeout_s == JUDGE_LANE_FLOOR.acquire_timeout_s
        assert budget.queue_max_size == JUDGE_LANE_FLOOR.queue_max_size

    def test_other_providers_are_not_touched(self):
        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(12), state)
        assert lane_budget(state, "openai", "judge") is JUDGE_LANE_FLOOR


class TestLiveJudgeResize:
    @pytest.mark.asyncio
    async def test_an_existing_semaphore_grows_to_the_served_value(self):
        semaphores: dict[str, ResizableSemaphore] = {}
        small = JUDGE_LANE_FLOOR.merged({"max_concurrent": 2})
        first = _ensure_semaphore(semaphores, LM_STUDIO_PROVIDER, small)
        assert first.limit == 2

        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(10), state)
        served = lane_budget(state, LM_STUDIO_PROVIDER, "judge")
        again = _ensure_semaphore(semaphores, LM_STUDIO_PROVIDER, served)

        assert again is first  # same object: in-flight permits stay accounted
        for _ in range(10):
            await asyncio.wait_for(again.acquire(), timeout=0.1)
        assert again.in_flight == 10

    def test_a_shrink_applies_too(self):
        semaphores: dict[str, ResizableSemaphore] = {}
        _ensure_semaphore(semaphores, LM_STUDIO_PROVIDER, JUDGE_LANE_FLOOR)
        shrunk = _ensure_semaphore(
            semaphores, LM_STUDIO_PROVIDER, JUDGE_LANE_FLOOR.merged({"max_concurrent": 3})
        )
        assert shrunk.limit == 3
