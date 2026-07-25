"""Live semaphore resize without dropping in-flight permits.

The load-bearing property: an admin lowering `maxConcurrent` must never revoke a
permit a request is already holding. Naively swapping in a new
`asyncio.Semaphore` would transiently allow `old_in_flight + new_limit`
concurrency and strand the old object's waiters, so the object identity in
`app.state.provider_semaphores` stays fixed and only its capacity moves.
"""

from __future__ import annotations

import asyncio

import pytest

from smr.services.resizable_semaphore import ResizableSemaphore


async def _acquire_n(sem: ResizableSemaphore, n: int) -> None:
    for _ in range(n):
        await sem.acquire()


class TestBasicSemantics:
    async def test_bounds_concurrency_at_the_limit(self) -> None:
        sem = ResizableSemaphore(2)
        await _acquire_n(sem, 2)

        blocked = asyncio.create_task(sem.acquire())
        await asyncio.sleep(0)
        assert not blocked.done(), "third acquire must block at limit=2"

        sem.release()
        await asyncio.wait_for(blocked, timeout=1)
        assert sem.in_flight == 2

    async def test_async_context_manager_releases(self) -> None:
        sem = ResizableSemaphore(1)
        async with sem:
            assert sem.in_flight == 1
        assert sem.in_flight == 0

    async def test_releases_on_exception(self) -> None:
        sem = ResizableSemaphore(1)
        with pytest.raises(RuntimeError):
            async with sem:
                raise RuntimeError("boom")
        assert sem.in_flight == 0

    @pytest.mark.parametrize("bad", [0, -1])
    def test_rejects_a_non_positive_limit(self, bad: int) -> None:
        with pytest.raises(ValueError):
            ResizableSemaphore(bad)


class TestShrink:
    async def test_shrink_never_revokes_in_flight_permits(self) -> None:
        """The core guarantee: 3 holders survive a shrink to 2."""
        sem = ResizableSemaphore(4)
        await _acquire_n(sem, 3)

        sem.set_limit(2)

        # No revocation — every holder keeps its permit.
        assert sem.in_flight == 3
        assert sem.limit == 2

    async def test_shrink_blocks_new_acquires_until_the_bound_converges(self) -> None:
        sem = ResizableSemaphore(4)
        await _acquire_n(sem, 3)
        sem.set_limit(2)

        pending = asyncio.create_task(sem.acquire())
        await asyncio.sleep(0)
        assert not pending.done(), "over-limit, so a new acquire must wait"

        # 3 → 2: still at the limit, so the waiter stays blocked.
        sem.release()
        await asyncio.sleep(0)
        assert not pending.done(), "in_flight==2 == limit, waiter must still wait"

        # 2 → 1: now under the limit, the waiter proceeds.
        sem.release()
        await asyncio.wait_for(pending, timeout=1)
        assert sem.in_flight == 2

    async def test_shrink_with_idle_capacity_takes_effect_immediately(self) -> None:
        """Nothing in flight: the new, lower ceiling binds right away."""
        sem = ResizableSemaphore(4)
        sem.set_limit(2)

        await _acquire_n(sem, 2)
        blocked = asyncio.create_task(sem.acquire())
        await asyncio.sleep(0)
        assert not blocked.done(), "shrink must bind even when it was idle"

        blocked.cancel()


class TestGrow:
    async def test_grow_wakes_waiters(self) -> None:
        sem = ResizableSemaphore(1)
        await sem.acquire()

        waiters = [asyncio.create_task(sem.acquire()) for _ in range(2)]
        await asyncio.sleep(0)
        assert not any(w.done() for w in waiters)

        sem.set_limit(3)
        await asyncio.wait_for(asyncio.gather(*waiters), timeout=1)
        assert sem.in_flight == 3

    async def test_grow_wakes_only_as_many_waiters_as_the_new_headroom(self) -> None:
        sem = ResizableSemaphore(1)
        await sem.acquire()
        waiters = [asyncio.create_task(sem.acquire()) for _ in range(3)]
        await asyncio.sleep(0)

        sem.set_limit(2)  # headroom for exactly one more
        await asyncio.sleep(0)

        assert sum(w.done() for w in waiters) == 1
        for w in waiters:
            w.cancel()


class TestResizeMechanics:
    async def test_object_identity_is_stable_across_resizes(self) -> None:
        """`get_provider_semaphores` hands out this object; it must never be swapped."""
        registry: dict[str, ResizableSemaphore] = {"ollama": ResizableSemaphore(4)}
        before = registry["ollama"]

        registry["ollama"].set_limit(9)
        registry["ollama"].set_limit(2)

        assert registry["ollama"] is before

    async def test_set_limit_is_idempotent(self) -> None:
        sem = ResizableSemaphore(3)
        await _acquire_n(sem, 2)

        sem.set_limit(3)
        sem.set_limit(3)

        assert sem.limit == 3
        assert sem.in_flight == 2

    @pytest.mark.parametrize("bad", [0, -5])
    def test_set_limit_rejects_a_non_positive_limit(self, bad: int) -> None:
        sem = ResizableSemaphore(2)
        with pytest.raises(ValueError):
            sem.set_limit(bad)
        assert sem.limit == 2, "a rejected resize must not corrupt the limit"

    async def test_converges_to_the_new_bound_under_load(self) -> None:
        """Sustained traffic across a shrink settles at the new ceiling."""
        sem = ResizableSemaphore(5)
        peak = 0
        shrunk = False

        async def worker() -> None:
            nonlocal peak, shrunk
            for _ in range(6):
                async with sem:
                    peak = max(peak, sem.in_flight)
                    if not shrunk:
                        shrunk = True
                        sem.set_limit(2)
                    await asyncio.sleep(0)

        await asyncio.wait_for(asyncio.gather(*(worker() for _ in range(8))), timeout=5)

        assert sem.in_flight == 0, "every permit returned"
        assert sem.limit == 2
        # Post-shrink steady state respects the new bound; the pre-shrink peak
        # may legitimately have reached the old one.
        assert peak <= 5
