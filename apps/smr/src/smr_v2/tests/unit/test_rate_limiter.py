"""TDD tests for RateLimitTracker and token estimation.

RED: Written before implementation.
"""

from __future__ import annotations

import asyncio
import time

import pytest


# ── estimate_tokens ──


class TestEstimateTokens:
    def test_empty_string(self):
        from smr_v2.services.rate_limiter import estimate_tokens
        assert estimate_tokens("") == 0

    def test_short_sentence(self):
        from smr_v2.services.rate_limiter import estimate_tokens
        result = estimate_tokens("Hello world")
        assert 2 <= result <= 5

    def test_longer_text(self):
        from smr_v2.services.rate_limiter import estimate_tokens
        text = "The quick brown fox jumps over the lazy dog near the river bank"
        result = estimate_tokens(text)
        assert 10 <= result <= 25

    def test_code_with_special_chars(self):
        from smr_v2.services.rate_limiter import estimate_tokens
        code = "def hello(name: str) -> str:\n    return f'Hello {name}!'"
        result = estimate_tokens(code)
        assert result > 5

    def test_respects_word_ratio(self):
        from smr_v2.services.rate_limiter import estimate_tokens
        words_100 = " ".join(["word"] * 100)
        result = estimate_tokens(words_100)
        assert 100 <= result <= 200


# ── SlidingWindowCounter ──


class TestSlidingWindowCounter:
    def test_record_and_count(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=60.0)
        counter.record(10)
        counter.record(20)
        assert counter.current_total() == 30

    def test_expired_entries_evicted(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=0.05)
        counter.record(100)
        time.sleep(0.06)
        assert counter.current_total() == 0

    def test_remaining_with_limit(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=60.0)
        counter.record(30)
        assert counter.remaining(100) == 70

    def test_remaining_never_negative(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=60.0)
        counter.record(200)
        assert counter.remaining(100) == 0

    def test_seconds_until_capacity(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=1.0)
        counter.record(100)
        reset = counter.seconds_until_capacity(100, need=50)
        assert 0.0 < reset <= 1.0

    def test_seconds_until_capacity_when_available(self):
        from smr_v2.services.rate_limiter import SlidingWindowCounter
        counter = SlidingWindowCounter(window_seconds=60.0)
        counter.record(10)
        assert counter.seconds_until_capacity(100, need=10) == 0.0


# ── RateLimitTracker ──


class TestRateLimitTracker:
    def test_create_tracker(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=480, tpm_limit=80000)
        assert tracker.rpm_limit == 480
        assert tracker.tpm_limit == 80000

    def test_can_proceed_when_under_limits(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        assert tracker.can_proceed(estimated_tokens=100) is True

    def test_record_request(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        tracker.record_request(estimated_tokens=500)
        state = tracker.get_state("test_provider")
        assert state.rpm_remaining < 100
        assert state.tpm_remaining < 10000

    def test_cannot_proceed_when_rpm_exhausted(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=2, tpm_limit=100000)
        tracker.record_request(10)
        tracker.record_request(10)
        assert tracker.can_proceed(10) is False

    def test_cannot_proceed_when_tpm_exhausted(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=1000, tpm_limit=100)
        tracker.record_request(100)
        assert tracker.can_proceed(50) is False

    def test_update_limits_from_headers(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        tracker.update_limits(rpm_limit=200, tpm_limit=20000)
        assert tracker.rpm_limit == 200
        assert tracker.tpm_limit == 20000

    def test_get_state_returns_model(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        state = tracker.get_state("azure_openai")
        assert state.provider == "azure_openai"
        assert state.rpm_limit == 100
        assert state.is_rate_limited is False

    def test_get_wait_seconds_zero_when_available(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        assert tracker.get_wait_seconds(100) == 0.0

    def test_mark_rate_limited(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        tracker.mark_rate_limited(retry_after=30.0)
        state = tracker.get_state("test")
        assert state.is_rate_limited is True
        assert state.retry_after_seconds == 30.0

    def test_rate_limit_expires(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=100, tpm_limit=10000)
        tracker.mark_rate_limited(retry_after=0.05)
        time.sleep(0.06)
        assert tracker.can_proceed(10) is True

    def test_zero_limits_means_unlimited(self):
        from smr_v2.services.rate_limiter import RateLimitTracker
        tracker = RateLimitTracker(rpm_limit=0, tpm_limit=0)
        assert tracker.can_proceed(999999) is True
