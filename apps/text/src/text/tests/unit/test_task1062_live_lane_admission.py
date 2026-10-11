"""TASK-1062 D-2 A — the live-documentation lane has its own LM Studio admission budget.

At x3 concurrent consultations the live flushes queued behind finalize / pre-summary
generations on the one `lm-studio` user-lane semaphore and arrived late. The fix is a
second semaphore for generations the gateway marks ``X-Hope-Lane: live``, sized by the
platform setting `lmStudio.serving.liveLaneSlots` (served as
``lmStudioServing.liveLaneSlots``, default 2); the user lane keeps
``parallel - liveLaneSlots`` (minimum 1).

What this suite pins:

  1. the served value is parsed tolerantly (absent / invalid = no opinion);
  2. the split: user = parallel - live, live clamped to parallel, user never below 1;
  3. both semaphores resize live from effective-config, on the SAME objects;
  4. the endpoint admits a live-marked lm-studio request into the live semaphore, so a
     saturated user lane does not block it; an unknown marker, an absent marker, or a
     non-lm-studio provider stays on the user lane;
  5. the judge lane is unchanged.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.core.effective_config import EffectiveConfigSnapshot
from text.core.runtime_defaults import (
    LIVE_LANE_SLOTS_FLOOR,
    LM_STUDIO_PROVIDER,
    split_lm_studio_slots,
)
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.runtime_limits import (
    apply_lane_budgets,
    apply_live_lane,
    apply_provider_limits,
    lane_budget,
    live_lane_semaphore,
)


def _snapshot(
    parallel: object = 8, live: object = None, *, ok: bool = True
) -> EffectiveConfigSnapshot:
    group: dict = {"parallel": parallel}
    if live is not None:
        group["liveLaneSlots"] = live
    return EffectiveConfigSnapshot(raw={"lmStudioServing": group}, ok=ok)


class TestParsing:
    def test_a_served_value_is_read(self):
        assert _snapshot(8, 3).lm_studio_live_lane_slots() == 3

    @pytest.mark.parametrize("bad", [0, -1, "2", True, [2]])
    def test_an_invalid_value_is_no_opinion(self, bad):
        assert _snapshot(8, bad).lm_studio_live_lane_slots() is None

    def test_absent_is_no_opinion(self):
        assert _snapshot(8).lm_studio_live_lane_slots() is None
        assert EffectiveConfigSnapshot(raw={}, ok=True).lm_studio_live_lane_slots() is None


class TestSplit:
    def test_the_floor_is_two(self):
        assert LIVE_LANE_SLOTS_FLOOR == 2

    def test_the_user_lane_keeps_the_rest(self):
        assert split_lm_studio_slots(8, 2) == (6, 2)
        assert split_lm_studio_slots(10, 3) == (7, 3)

    @pytest.mark.parametrize(
        ("parallel", "live", "expected"), [(8, 8, (1, 8)), (8, 12, (1, 8)), (1, 2, (1, 1))]
    )
    def test_a_live_budget_at_or_above_parallel_is_clamped(self, parallel, live, expected):
        assert split_lm_studio_slots(parallel, live) == expected

    def test_live_never_drops_below_one(self):
        assert split_lm_studio_slots(8, 0) == (7, 1)


class TestResizeFromEffectiveConfig:
    def test_the_user_lane_is_parallel_minus_the_live_budget(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(8), "openai": ResizableSemaphore(4)}
        apply_provider_limits(_snapshot(8, 3), semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 5
        assert semaphores["openai"].limit == 4

    def test_an_unserved_live_budget_reserves_the_floor(self):
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(8)}
        apply_provider_limits(_snapshot(8), semaphores, {})
        assert semaphores[LM_STUDIO_PROVIDER].limit == 8 - LIVE_LANE_SLOTS_FLOOR

    def test_the_live_semaphore_is_sized_and_resized_on_the_same_object(self):
        state = SimpleNamespace()
        apply_live_lane(_snapshot(8, 3), state)
        first = live_lane_semaphore(state)
        assert first.limit == 3

        apply_live_lane(_snapshot(8, 5), state)
        assert live_lane_semaphore(state) is first
        assert first.limit == 5

    def test_a_live_budget_at_parallel_is_clamped_and_the_user_lane_keeps_one(self):
        state = SimpleNamespace()
        semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(8)}
        apply_provider_limits(_snapshot(4, 9), semaphores, {})
        apply_live_lane(_snapshot(4, 9), state)
        assert live_lane_semaphore(state).limit == 4
        assert semaphores[LM_STUDIO_PROVIDER].limit == 1

    def test_the_floor_before_the_control_plane_answers(self):
        assert live_lane_semaphore(SimpleNamespace()).limit == LIVE_LANE_SLOTS_FLOOR

    def test_gateway_down_changes_nothing(self):
        state = SimpleNamespace()
        apply_live_lane(_snapshot(8, 3), state)
        apply_live_lane(_snapshot(8, 6, ok=False), state)
        assert live_lane_semaphore(state).limit == 3

    def test_the_judge_lane_still_follows_parallel(self):
        state = SimpleNamespace(circuit_breakers={})
        apply_lane_budgets(_snapshot(8, 3), state)
        assert lane_budget(state, LM_STUDIO_PROVIDER, "judge").max_concurrent == 8


# ── The request path ─────────────────────────────────────────────────────────


def _task_manager():
    tm = AsyncMock()
    state = TaskState(task_id="t-1", status=TaskStatus.PENDING, provider="lm-studio", model="m")
    tm.create_task = AsyncMock(return_value=state)
    tm.update_task = AsyncMock(return_value=state)
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _recording_provider(seen: list[tuple[int, int]], app_ref: dict):
    async def _generate(*args, **kwargs):
        state = app_ref["app"].state
        seen.append(
            (
                state.provider_semaphores[app_ref["provider"]].in_flight,
                live_lane_semaphore(state).in_flight,
            )
        )
        return "ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}

    provider = AsyncMock()
    provider.generate = AsyncMock(side_effect=_generate)
    provider.health_check = AsyncMock(return_value=True)
    return provider


def _app(provider_name: str, user_limit: int = 4):
    from text.main import create_app

    seen: list[tuple[int, int]] = []
    app_ref: dict = {"provider": provider_name}
    registry = ProviderRegistry()
    registry.register(provider_name, _recording_provider(seen, app_ref))
    settings = Settings(port=5099, log_level="debug")
    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = _task_manager()
    app.state.settings = settings
    app.state.provider_semaphores = {provider_name: ResizableSemaphore(user_limit)}
    app_ref["app"] = app
    return app, seen


async def _post(app, provider: str, lane: str | None):
    headers = {"X-Hope-Lane": lane} if lane is not None else {}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": provider, "model": "m"},
            headers=headers,
        )


class TestLaneSelection:
    @pytest.mark.asyncio
    async def test_a_live_marked_lm_studio_request_takes_the_live_semaphore(self):
        app, seen = _app(LM_STUDIO_PROVIDER)
        resp = await _post(app, LM_STUDIO_PROVIDER, "live")
        assert resp.status_code == 200
        assert seen == [(0, 1)]

    @pytest.mark.asyncio
    async def test_the_marker_is_case_insensitive(self):
        app, seen = _app(LM_STUDIO_PROVIDER)
        assert (await _post(app, LM_STUDIO_PROVIDER, " Live ")).status_code == 200
        assert seen == [(0, 1)]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("lane", [None, "judge", "user", "bogus", ""])
    async def test_an_absent_or_unknown_marker_is_the_user_lane(self, lane):
        app, seen = _app(LM_STUDIO_PROVIDER)
        assert (await _post(app, LM_STUDIO_PROVIDER, lane)).status_code == 200
        assert seen == [(1, 0)]

    @pytest.mark.asyncio
    async def test_a_non_lm_studio_provider_ignores_the_marker(self):
        app, seen = _app("ollama")
        assert (await _post(app, "ollama", "live")).status_code == 200
        assert seen == [(1, 0)]

    @pytest.mark.asyncio
    async def test_a_saturated_user_lane_does_not_block_a_live_request(self):
        app, seen = _app(LM_STUDIO_PROVIDER, user_limit=1)
        user = app.state.provider_semaphores[LM_STUDIO_PROVIDER]
        await user.acquire()  # every user-lane permit is held by a finalize generation
        try:
            resp = await asyncio.wait_for(_post(app, LM_STUDIO_PROVIDER, "live"), timeout=5)
        finally:
            user.release()
        assert resp.status_code == 200
        assert seen == [(1, 1)]
        assert live_lane_semaphore(app.state).in_flight == 0  # released
