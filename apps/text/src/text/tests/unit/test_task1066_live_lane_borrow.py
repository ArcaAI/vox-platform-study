"""Live-lane admission under concurrency: borrow idle user-lane capacity, wait a governed time.

Under three concurrent consultations every realtime call (warm-start pre-summary, each
section flush) of every session contends for the 2-permit live lane. One live generation
on the cluster takes ~40 s, and the lane waited a hardcoded 30 s for a permit, so the
third waiter was always refused with ``CONCURRENCY_LIMIT`` while user-lane permits sat
idle.

What this suite pins:

  1. ``ResizableSemaphore.try_acquire`` takes a free permit without queueing;
     ``acquire(priority=True)`` is woken ahead of ordinary waiters.
  2. ``acquire_live_permit`` takes the reserved live permit first, BORROWS an idle
     user-lane permit when the live lane is full (ahead of queued user work), waits for
     whichever frees first, and times out without leaking a permit.
  3. The live queue wait is the platform setting ``lmStudio.serving.liveLaneQueueTimeoutSeconds``
     (served as ``lmStudioServing.liveLaneQueueTimeoutS``), tolerant parse, floor before
     the control plane answers, gateway-down keeps the live value.
  4. The endpoint: a live request on a full live lane runs on a borrowed user permit and
     hands it back; with both lanes full it answers 503 ``CONCURRENCY_LIMIT`` after the
     governed wait.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.core.effective_config import EffectiveConfigSnapshot
from text.core.runtime_defaults import LIVE_LANE_QUEUE_TIMEOUT_FLOOR_S, LM_STUDIO_PROVIDER
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry
from text.services.lane_admission import acquire_live_permit
from text.services.resizable_semaphore import ResizableSemaphore
from text.services.runtime_limits import (
    apply_live_lane,
    live_lane_queue_timeout_s,
    live_lane_semaphore,
)

# ── 1. semaphore primitives ──────────────────────────────────────────────────


class TestTryAcquire:
    def test_takes_a_free_permit(self):
        sem = ResizableSemaphore(1)
        assert sem.try_acquire() is True
        assert sem.in_flight == 1

    def test_refuses_without_queueing_when_full(self):
        sem = ResizableSemaphore(1)
        assert sem.try_acquire() is True
        assert sem.try_acquire() is False
        assert sem.in_flight == 1


class TestPriorityAcquire:
    @pytest.mark.asyncio
    async def test_a_priority_waiter_is_woken_before_an_earlier_ordinary_waiter(self):
        sem = ResizableSemaphore(1)
        await sem.acquire()
        order: list[str] = []

        async def take(name: str, priority: bool) -> None:
            await sem.acquire(priority=priority)
            order.append(name)

        ordinary = asyncio.create_task(take("ordinary", False))
        await asyncio.sleep(0)
        urgent = asyncio.create_task(take("urgent", True))
        await asyncio.sleep(0)

        sem.release()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert order == ["urgent"]
        sem.release()
        await asyncio.gather(ordinary, urgent)
        assert order == ["urgent", "ordinary"]


# ── 2. live admission ────────────────────────────────────────────────────────


class TestAcquireLivePermit:
    @pytest.mark.asyncio
    async def test_the_reserved_live_permit_comes_first(self):
        live, user = ResizableSemaphore(1), ResizableSemaphore(1)
        got = await acquire_live_permit(live, user, timeout=1)
        assert got is live
        assert (live.in_flight, user.in_flight) == (1, 0)

    @pytest.mark.asyncio
    async def test_a_full_live_lane_borrows_an_idle_user_permit(self):
        live, user = ResizableSemaphore(1), ResizableSemaphore(2)
        await live.acquire()
        got = await acquire_live_permit(live, user, timeout=1)
        assert got is user
        assert (live.in_flight, user.in_flight) == (1, 1)

    @pytest.mark.asyncio
    async def test_waits_for_whichever_lane_frees_first(self):
        live, user = ResizableSemaphore(1), ResizableSemaphore(1)
        await live.acquire()
        await user.acquire()
        waiter = asyncio.create_task(acquire_live_permit(live, user, timeout=2))
        await asyncio.sleep(0.01)
        user.release()
        got = await asyncio.wait_for(waiter, timeout=1)
        assert got is user
        assert (live.in_flight, user.in_flight) == (1, 1)
        # the losing wait left nothing queued behind: a release on live is takeable
        live.release()
        assert live.try_acquire() is True

    @pytest.mark.asyncio
    async def test_a_live_waiter_overtakes_queued_user_work_on_a_freed_user_permit(self):
        live, user = ResizableSemaphore(1), ResizableSemaphore(1)
        await live.acquire()
        await user.acquire()
        queued_user = asyncio.create_task(user.acquire())
        await asyncio.sleep(0)
        waiter = asyncio.create_task(acquire_live_permit(live, user, timeout=2))
        await asyncio.sleep(0.01)
        user.release()
        got = await asyncio.wait_for(waiter, timeout=1)
        assert got is user
        assert not queued_user.done()
        user.release()
        await asyncio.wait_for(queued_user, timeout=1)

    @pytest.mark.asyncio
    async def test_times_out_without_leaking_a_permit(self):
        live, user = ResizableSemaphore(1), ResizableSemaphore(1)
        await live.acquire()
        await user.acquire()
        with pytest.raises(TimeoutError):
            await acquire_live_permit(live, user, timeout=0.05)
        assert (live.in_flight, user.in_flight) == (1, 1)
        live.release()
        user.release()
        assert live.try_acquire() and user.try_acquire()

    @pytest.mark.asyncio
    async def test_no_user_lane_means_live_only(self):
        live = ResizableSemaphore(1)
        await live.acquire()
        with pytest.raises(TimeoutError):
            await acquire_live_permit(live, None, timeout=0.05)


# ── 3. the governed queue wait ───────────────────────────────────────────────


def _snapshot(timeout: object = None, *, ok: bool = True) -> EffectiveConfigSnapshot:
    group: dict = {"parallel": 8, "liveLaneSlots": 2}
    if timeout is not None:
        group["liveLaneQueueTimeoutS"] = timeout
    return EffectiveConfigSnapshot(raw={"lmStudioServing": group}, ok=ok)


class TestQueueTimeoutSetting:
    def test_a_served_value_is_read(self):
        assert _snapshot(120).lm_studio_live_lane_queue_timeout_s() == 120

    @pytest.mark.parametrize("bad", [0, -5, "90", True, [90]])
    def test_an_invalid_value_is_no_opinion(self, bad):
        assert _snapshot(bad).lm_studio_live_lane_queue_timeout_s() is None

    def test_the_floor_before_the_control_plane_answers(self):
        assert live_lane_queue_timeout_s(SimpleNamespace()) == LIVE_LANE_QUEUE_TIMEOUT_FLOOR_S
        # longer than one live generation (~40 s), shorter than the gateway's TEXT timeout
        assert 40 < LIVE_LANE_QUEUE_TIMEOUT_FLOOR_S < 300

    def test_applied_from_effective_config(self):
        state = SimpleNamespace()
        apply_live_lane(_snapshot(150), state)
        assert live_lane_queue_timeout_s(state) == 150

    def test_unserved_keeps_the_floor(self):
        state = SimpleNamespace()
        apply_live_lane(_snapshot(), state)
        assert live_lane_queue_timeout_s(state) == LIVE_LANE_QUEUE_TIMEOUT_FLOOR_S

    def test_gateway_down_keeps_the_live_value(self):
        state = SimpleNamespace()
        apply_live_lane(_snapshot(150), state)
        apply_live_lane(_snapshot(10, ok=False), state)
        assert live_lane_queue_timeout_s(state) == 150


# ── 4. the request path ──────────────────────────────────────────────────────


def _task_manager():
    tm = AsyncMock()
    state = TaskState(task_id="t-1", status=TaskStatus.PENDING, provider="lm-studio", model="m")
    tm.create_task = AsyncMock(return_value=state)
    tm.update_task = AsyncMock(return_value=state)
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _app(user_limit: int):
    from text.main import create_app

    seen: list[tuple[int, int]] = []
    app_ref: dict = {}

    async def _generate(*args, **kwargs):
        state = app_ref["app"].state
        seen.append(
            (
                state.provider_semaphores[LM_STUDIO_PROVIDER].in_flight,
                live_lane_semaphore(state).in_flight,
            )
        )
        return "ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}

    provider = AsyncMock()
    provider.generate = AsyncMock(side_effect=_generate)
    provider.health_check = AsyncMock(return_value=True)
    registry = ProviderRegistry()
    registry.register(LM_STUDIO_PROVIDER, provider)
    settings = Settings(port=5099, log_level="debug")
    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = _task_manager()
    app.state.settings = settings
    app.state.provider_semaphores = {LM_STUDIO_PROVIDER: ResizableSemaphore(user_limit)}
    app_ref["app"] = app
    return app, seen


async def _post_live(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/api/v1/generate",
            json={"prompt": "hello", "provider": LM_STUDIO_PROVIDER, "model": "m"},
            headers={"X-Hope-Lane": "live"},
        )


class TestEndpoint:
    @pytest.mark.asyncio
    async def test_a_full_live_lane_runs_on_a_borrowed_user_permit(self):
        app, seen = _app(user_limit=2)
        live = live_lane_semaphore(app.state)
        for _ in range(live.limit):
            await live.acquire()  # two other consultations' flushes hold the live lane
        try:
            resp = await asyncio.wait_for(_post_live(app), timeout=5)
        finally:
            for _ in range(live.limit):
                live.release()
        assert resp.status_code == 200
        assert seen == [(1, 2)]
        assert app.state.provider_semaphores[LM_STUDIO_PROVIDER].in_flight == 0  # handed back

    @pytest.mark.asyncio
    async def test_both_lanes_full_answers_503_after_the_governed_wait(self):
        app, seen = _app(user_limit=1)
        app.state.live_lane_queue_timeout_s = 0.05
        live = live_lane_semaphore(app.state)
        user = app.state.provider_semaphores[LM_STUDIO_PROVIDER]
        for _ in range(live.limit):
            await live.acquire()
        await user.acquire()
        try:
            resp = await asyncio.wait_for(_post_live(app), timeout=5)
        finally:
            for _ in range(live.limit):
                live.release()
            user.release()
        assert resp.status_code == 503
        assert "CONCURRENCY_LIMIT" in resp.text
        assert seen == []
        assert (live.in_flight, user.in_flight) == (0, 0)
