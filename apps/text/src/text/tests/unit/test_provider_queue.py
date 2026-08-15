"""TDD tests for ProviderQueue and resilience patterns.

RED: Written before implementation.
"""

from __future__ import annotations

import asyncio

import pytest

# ── ProviderQueue ──


class TestProviderQueue:
    @pytest.mark.asyncio
    async def test_enqueue_and_dequeue(self):
        from text.services.provider_queue import ProviderQueue

        q = ProviderQueue(max_size=10)
        future = asyncio.get_event_loop().create_future()
        await q.enqueue(priority=1, future=future, request_id="r1")
        item = await q.dequeue()
        assert item.request_id == "r1"

    @pytest.mark.asyncio
    async def test_priority_ordering(self):
        from text.services.provider_queue import ProviderQueue

        q = ProviderQueue(max_size=10)
        f1 = asyncio.get_event_loop().create_future()
        f2 = asyncio.get_event_loop().create_future()
        f3 = asyncio.get_event_loop().create_future()
        await q.enqueue(priority=3, future=f3, request_id="low")
        await q.enqueue(priority=1, future=f1, request_id="high")
        await q.enqueue(priority=2, future=f2, request_id="mid")

        item1 = await q.dequeue()
        item2 = await q.dequeue()
        item3 = await q.dequeue()
        assert item1.request_id == "high"
        assert item2.request_id == "mid"
        assert item3.request_id == "low"

    @pytest.mark.asyncio
    async def test_rejects_when_full(self):
        from text.services.provider_queue import ProviderQueue, QueueFullError

        q = ProviderQueue(max_size=1)
        f1 = asyncio.get_event_loop().create_future()
        await q.enqueue(priority=1, future=f1, request_id="r1")
        f2 = asyncio.get_event_loop().create_future()
        with pytest.raises(QueueFullError):
            await q.enqueue(priority=1, future=f2, request_id="r2")

    @pytest.mark.asyncio
    async def test_current_size(self):
        from text.services.provider_queue import ProviderQueue

        q = ProviderQueue(max_size=10)
        assert q.size == 0
        f = asyncio.get_event_loop().create_future()
        await q.enqueue(priority=1, future=f, request_id="r1")
        assert q.size == 1

    @pytest.mark.asyncio
    async def test_is_full(self):
        from text.services.provider_queue import ProviderQueue

        q = ProviderQueue(max_size=1)
        assert q.is_full is False
        f = asyncio.get_event_loop().create_future()
        await q.enqueue(priority=1, future=f, request_id="r1")
        assert q.is_full is True


# ── RetryHandler ──


class TestRetryHandler:
    @pytest.mark.asyncio
    async def test_exponential_backoff_delay(self):
        from text.services.retry_handler import calculate_backoff

        d0 = calculate_backoff(attempt=0, base_delay=1.0, max_delay=60.0)
        d1 = calculate_backoff(attempt=1, base_delay=1.0, max_delay=60.0)
        d2 = calculate_backoff(attempt=2, base_delay=1.0, max_delay=60.0)
        assert d0 >= 1.0
        assert d1 >= 2.0
        assert d2 >= 4.0

    @pytest.mark.asyncio
    async def test_backoff_capped_at_max(self):
        from text.services.retry_handler import calculate_backoff

        d = calculate_backoff(attempt=100, base_delay=1.0, max_delay=60.0)
        assert d <= 60.0

    @pytest.mark.asyncio
    async def test_should_retry_on_retriable_error(self):
        from text.services.retry_handler import should_retry

        assert should_retry(error_type="timeout", retry_on=["timeout", "provider_error"]) is True

    @pytest.mark.asyncio
    async def test_should_not_retry_on_non_retriable(self):
        from text.services.retry_handler import should_retry

        assert (
            should_retry(error_type="validation_error", retry_on=["timeout", "provider_error"])
            is False
        )

    @pytest.mark.asyncio
    async def test_should_not_retry_when_max_reached(self):
        from text.services.retry_handler import should_retry

        assert (
            should_retry(
                error_type="timeout",
                retry_on=["timeout"],
                attempt=3,
                max_retries=3,
            )
            is False
        )


# ── GracefulShutdown ──


class TestGracefulShutdown:
    @pytest.mark.asyncio
    async def test_register_and_track_task(self):
        from text.services.shutdown_manager import ShutdownManager

        sm = ShutdownManager()
        sm.register_task("t1")
        assert sm.active_count == 1

    @pytest.mark.asyncio
    async def test_complete_task(self):
        from text.services.shutdown_manager import ShutdownManager

        sm = ShutdownManager()
        sm.register_task("t1")
        sm.complete_task("t1")
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_shutdown_waits_for_tasks(self):
        from text.services.shutdown_manager import ShutdownManager

        sm = ShutdownManager()
        sm.register_task("t1")

        async def _complete_later():
            await asyncio.sleep(0.05)
            sm.complete_task("t1")

        asyncio.create_task(_complete_later())
        await sm.wait_for_shutdown(timeout=1.0)
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_shutdown_respects_timeout(self):
        from text.services.shutdown_manager import ShutdownManager

        sm = ShutdownManager()
        sm.register_task("t1")
        timed_out = await sm.wait_for_shutdown(timeout=0.05)
        assert timed_out is True

    @pytest.mark.asyncio
    async def test_is_shutting_down(self):
        from text.services.shutdown_manager import ShutdownManager

        sm = ShutdownManager()
        assert sm.is_shutting_down is False
        sm.initiate_shutdown()
        assert sm.is_shutting_down is True
