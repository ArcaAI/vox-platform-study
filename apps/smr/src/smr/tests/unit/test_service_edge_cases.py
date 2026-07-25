"""Edge case tests for services — rate_limiter, task_manager, circuit_breaker, etc."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

# ── estimate_tokens edge cases ──


class TestEstimateTokensEdgeCases:
    def test_none_like_empty_returns_zero(self):
        from smr.services.rate_limiter import estimate_tokens
        assert estimate_tokens("") == 0

    def test_single_word(self):
        from smr.services.rate_limiter import estimate_tokens
        result = estimate_tokens("hello")
        assert result >= 1

    def test_whitespace_only(self):
        from smr.services.rate_limiter import estimate_tokens
        result = estimate_tokens("   \n\t  ")
        assert result == 0

    def test_unicode_text(self):
        from smr.services.rate_limiter import estimate_tokens
        result = estimate_tokens("你好世界 这是一个测试")
        assert result >= 1

    def test_very_long_text(self):
        from smr.services.rate_limiter import estimate_tokens
        text = " ".join(["word"] * 10000)
        result = estimate_tokens(text)
        assert 10000 <= result <= 20000


# ── SlidingWindowCounter edge cases ──


class TestSlidingWindowEdgeCases:
    def test_empty_counter_total_is_zero(self):
        from smr.services.rate_limiter import SlidingWindowCounter
        c = SlidingWindowCounter()
        assert c.current_total() == 0

    def test_empty_counter_remaining_equals_limit(self):
        from smr.services.rate_limiter import SlidingWindowCounter
        c = SlidingWindowCounter()
        assert c.remaining(100) == 100

    def test_seconds_until_capacity_empty_counter(self):
        from smr.services.rate_limiter import SlidingWindowCounter
        c = SlidingWindowCounter()
        assert c.seconds_until_capacity(100, 50) == 0.0

    def test_seconds_until_capacity_exceeds_all_entries(self):
        from smr.services.rate_limiter import SlidingWindowCounter
        c = SlidingWindowCounter(window_seconds=60.0)
        c.record(10)
        result = c.seconds_until_capacity(5, 100)
        assert result == 60.0

    def test_multiple_records_accumulate(self):
        from smr.services.rate_limiter import SlidingWindowCounter
        c = SlidingWindowCounter()
        for _ in range(10):
            c.record(5)
        assert c.current_total() == 50


# ── RateLimitTracker edge cases ──


class TestRateLimitTrackerEdgeCases:
    def test_get_wait_seconds_when_rate_limited(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        t.mark_rate_limited(retry_after=1.0)
        wait = t.get_wait_seconds(10)
        assert 0.5 < wait <= 1.0

    def test_get_wait_seconds_when_rpm_exhausted(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=1, tpm_limit=100000)
        t.record_request(10)
        wait = t.get_wait_seconds(10)
        assert wait > 0

    def test_update_limits_partial(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        t.update_limits(rpm_limit=200)
        assert t.rpm_limit == 200
        assert t.tpm_limit == 10000

    def test_update_limits_tpm_only(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        t.update_limits(tpm_limit=50000)
        assert t.rpm_limit == 100
        assert t.tpm_limit == 50000

    def test_get_state_not_limited_has_none_retry(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        state = t.get_state("p")
        assert state.retry_after_seconds is None

    def test_can_proceed_with_only_rpm_limit(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=2, tpm_limit=0)
        t.record_request(999)
        t.record_request(999)
        assert t.can_proceed(999) is False

    def test_can_proceed_with_only_tpm_limit(self):
        from smr.services.rate_limiter import RateLimitTracker
        t = RateLimitTracker(rpm_limit=0, tpm_limit=100)
        t.record_request(100)
        assert t.can_proceed(50) is False


# ── CircuitBreaker edge cases ──


class TestCircuitBreakerEdgeCases:
    def test_threshold_of_one(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=5.0)
        cb.record_failure()
        assert cb.state == CircuitState.OPEN

    def test_consecutive_successes_keep_closed(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        for _ in range(100):
            cb.record_success()
        assert cb.state == CircuitState.CLOSED
        assert cb.failure_count == 0

    def test_success_before_threshold_resets(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.CLOSED


# ── TaskManager edge cases ──


class TestTaskManagerEdgeCases:
    @pytest.mark.asyncio
    async def test_create_task_with_custom_retries(self):
        from smr.services.task_manager import TaskManager
        mock_redis = AsyncMock()
        tm = TaskManager(redis=mock_redis)
        state = await tm.create_task(provider="p", model="m", max_retries=10)
        assert state.max_retries == 10

    @pytest.mark.asyncio
    async def test_get_chunks_with_string_keys(self):
        """Redis with decode_responses=True returns strings, not bytes."""
        from smr.services.task_manager import TaskManager
        mock_redis = AsyncMock()
        mock_redis.xrange = AsyncMock(return_value=[
            ("1-0", {"data": '{"type":"chunk","content":"hello"}'}),
        ])
        tm = TaskManager(redis=mock_redis)
        chunks = await tm.get_chunks("t1")
        assert len(chunks) == 1
        assert chunks[0].content == "hello"

    @pytest.mark.asyncio
    async def test_update_preserves_existing_fields(self):
        from smr.models.task import TaskState, TaskStatus
        from smr.services.task_manager import TaskManager
        updated_state = TaskState(task_id="t", status=TaskStatus.RUNNING, provider="p", model="m", max_retries=5)
        mock_redis = AsyncMock()
        mock_redis.eval = AsyncMock(return_value=updated_state.model_dump_json().encode())
        tm = TaskManager(redis=mock_redis)
        updated = await tm.update_task("t", status=TaskStatus.RUNNING)
        assert updated.status == TaskStatus.RUNNING
        assert updated.max_retries == 5

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_returns_none(self):
        from smr.services.task_manager import TaskManager
        mock_redis = AsyncMock()
        mock_redis.eval = AsyncMock(return_value=None)
        tm = TaskManager(redis=mock_redis)
        result = await tm.cancel_task("nope")
        assert result is None

    @pytest.mark.asyncio
    async def test_append_chunk_uses_stream_key(self):
        from smr.models.stream import StreamChunk
        from smr.services.task_manager import TaskManager
        mock_redis = AsyncMock()
        mock_redis.xadd = AsyncMock(return_value=b"1-0")
        tm = TaskManager(redis=mock_redis)
        await tm.append_chunk("task-abc", StreamChunk(type="chunk", content="hi"))
        key_arg = mock_redis.xadd.call_args[0][0]
        assert "stream:" in key_arg
        assert "task-abc" in key_arg


# ── ProviderQueue edge cases ──


class TestProviderQueueEdgeCases:
    @pytest.mark.asyncio
    async def test_dequeue_blocks_until_item(self):
        from smr.services.provider_queue import ProviderQueue
        q = ProviderQueue(max_size=10)
        f = asyncio.get_event_loop().create_future()

        async def _enqueue_later():
            await asyncio.sleep(0.05)
            await q.enqueue(priority=1, future=f, request_id="delayed")

        asyncio.create_task(_enqueue_later())
        item = await asyncio.wait_for(q.dequeue(), timeout=1.0)
        assert item.request_id == "delayed"


# ── RetryHandler edge cases ──


class TestRetryHandlerEdgeCases:
    def test_backoff_attempt_zero(self):
        from smr.services.retry_handler import calculate_backoff
        d = calculate_backoff(attempt=0, base_delay=1.0, max_delay=60.0)
        assert 1.0 <= d <= 1.1

    def test_should_retry_attempt_zero(self):
        from smr.services.retry_handler import should_retry
        assert should_retry("timeout", ["timeout"], attempt=0, max_retries=3) is True

    def test_should_retry_at_max_minus_one(self):
        from smr.services.retry_handler import should_retry
        assert should_retry("timeout", ["timeout"], attempt=2, max_retries=3) is True

    def test_should_retry_empty_retry_on(self):
        from smr.services.retry_handler import should_retry
        assert should_retry("timeout", [], attempt=0, max_retries=3) is False


# ── ShutdownManager edge cases ──


class TestShutdownManagerEdgeCases:
    @pytest.mark.asyncio
    async def test_complete_unregistered_task_is_noop(self):
        from smr.services.shutdown_manager import ShutdownManager
        sm = ShutdownManager()
        sm.complete_task("unknown")
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_shutdown_with_no_tasks(self):
        from smr.services.shutdown_manager import ShutdownManager
        sm = ShutdownManager()
        timed_out = await sm.wait_for_shutdown(timeout=0.1)
        assert timed_out is False

    @pytest.mark.asyncio
    async def test_multiple_tasks_all_must_complete(self):
        from smr.services.shutdown_manager import ShutdownManager
        sm = ShutdownManager()
        sm.register_task("t1")
        sm.register_task("t2")
        sm.register_task("t3")

        async def _complete_all():
            await asyncio.sleep(0.02)
            sm.complete_task("t1")
            await asyncio.sleep(0.02)
            sm.complete_task("t2")
            await asyncio.sleep(0.02)
            sm.complete_task("t3")

        asyncio.create_task(_complete_all())
        timed_out = await sm.wait_for_shutdown(timeout=1.0)
        assert timed_out is False
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_initiate_shutdown_then_wait(self):
        from smr.services.shutdown_manager import ShutdownManager
        sm = ShutdownManager()
        sm.initiate_shutdown()
        timed_out = await sm.wait_for_shutdown(timeout=0.1)
        assert timed_out is False
