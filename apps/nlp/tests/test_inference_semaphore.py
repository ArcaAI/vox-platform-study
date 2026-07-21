"""nlp gains the inference bound it never had.

Without it the service had ZERO `asyncio.Semaphore`: concurrent
NER/classification/diagnosis requests all piled onto the model unbounded. These
tests lock the bound itself and its live resize.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core.concurrency import (
    ResizableSemaphore,
    get_inference_semaphore,
    reset_inference_semaphore,
)


@pytest.fixture(autouse=True)
def _fresh_singleton():
    reset_inference_semaphore()
    yield
    reset_inference_semaphore()


class TestSingleton:
    def test_returns_the_same_object(self) -> None:
        assert get_inference_semaphore() is get_inference_semaphore()

    def test_defaults_to_the_configured_bound(self) -> None:
        # Bootstrap fallback — matches `nlp.inference.maxConcurrent`'s code default.
        assert get_inference_semaphore().limit == 4

    def test_reset_replaces_the_singleton(self) -> None:
        first = get_inference_semaphore()
        reset_inference_semaphore()
        assert get_inference_semaphore() is not first


class TestBoundsConcurrency:
    async def test_at_most_n_inferences_run_concurrently(self) -> None:
        """An instrumented fake model never sees more than N concurrent calls."""
        sem = ResizableSemaphore(3)
        concurrent = 0
        peak = 0
        release = asyncio.Event()

        async def fake_inference() -> None:
            nonlocal concurrent, peak
            async with sem:
                concurrent += 1
                peak = max(peak, concurrent)
                await release.wait()
                concurrent -= 1

        tasks = [asyncio.create_task(fake_inference()) for _ in range(10)]
        await asyncio.sleep(0)

        assert peak <= 3, f"unbounded inference: {peak} concurrent"

        release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
        assert peak == 3, "the bound should actually be saturated"

    async def test_all_requests_eventually_complete(self) -> None:
        """Bounding must throttle, never drop."""
        sem = ResizableSemaphore(2)
        done = 0

        async def fake_inference() -> None:
            nonlocal done
            async with sem:
                await asyncio.sleep(0)
                done += 1

        await asyncio.wait_for(asyncio.gather(*(fake_inference() for _ in range(12))), timeout=5)
        assert done == 12

    async def test_a_failing_inference_releases_its_permit(self) -> None:
        sem = ResizableSemaphore(1)

        with pytest.raises(RuntimeError):
            async with sem:
                raise RuntimeError("model exploded")

        assert sem.in_flight == 0
        async with sem:  # must not deadlock
            pass


class TestLiveResize:
    async def test_limit_resizes_on_refresh(self) -> None:
        sem = get_inference_semaphore()
        assert sem.limit == 4

        sem.set_limit(9)

        assert get_inference_semaphore().limit == 9
        assert get_inference_semaphore() is sem, "resize must not swap the object"

    async def test_shrink_does_not_revoke_in_flight_inferences(self) -> None:
        sem = ResizableSemaphore(4)
        await sem.acquire()
        await sem.acquire()
        await sem.acquire()

        sem.set_limit(1)

        assert sem.in_flight == 3, "in-flight inferences must never be revoked"
        assert sem.limit == 1
