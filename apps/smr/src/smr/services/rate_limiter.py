"""Sliding-window rate-limit tracker with adaptive limits and token estimation."""

from __future__ import annotations

import time
from collections import deque
from typing import NamedTuple

from smr.models.provider import RateLimitState


def estimate_tokens(text: str) -> int:
    """Heuristic token estimator (~1.3 tokens per word for English)."""
    if not text:
        return 0
    words = text.split()
    if not words:
        return 0
    return max(1, int(len(words) * 1.3))


class _Entry(NamedTuple):
    timestamp: float
    value: int


class SlidingWindowCounter:
    """Sliding-window counter that evicts entries older than *window_seconds*."""

    def __init__(self, window_seconds: float = 60.0) -> None:
        self._window = window_seconds
        self._entries: deque[_Entry] = deque()

    def _evict(self) -> None:
        cutoff = time.monotonic() - self._window
        while self._entries and self._entries[0].timestamp < cutoff:
            self._entries.popleft()

    def record(self, value: int = 1) -> None:
        self._entries.append(_Entry(time.monotonic(), value))

    def current_total(self) -> int:
        self._evict()
        return sum(e.value for e in self._entries)

    def remaining(self, limit: int) -> int:
        return max(0, limit - self.current_total())

    def seconds_until_capacity(self, limit: int, need: int) -> float:
        self._evict()
        if self.remaining(limit) >= need:
            return 0.0
        if not self._entries:
            return 0.0
        must_free = self.current_total() + need - limit
        freed = 0
        for entry in self._entries:
            freed += entry.value
            if freed >= must_free:
                return max(0.0, (entry.timestamp + self._window) - time.monotonic())
        return self._window


class RateLimitTracker:
    """Per-provider rate-limit tracker using sliding windows for RPM and TPM."""

    def __init__(self, rpm_limit: int = 0, tpm_limit: int = 0) -> None:
        self.rpm_limit = rpm_limit
        self.tpm_limit = tpm_limit
        self._rpm_counter = SlidingWindowCounter(window_seconds=60.0)
        self._tpm_counter = SlidingWindowCounter(window_seconds=60.0)
        self._rate_limited_until: float = 0.0
        self._retry_after: float | None = None

    def can_proceed(self, estimated_tokens: int) -> bool:
        if self.rpm_limit == 0 and self.tpm_limit == 0:
            return True
        if time.monotonic() < self._rate_limited_until:
            return False
        if self.rpm_limit > 0 and self._rpm_counter.remaining(self.rpm_limit) < 1:
            return False
        if self.tpm_limit > 0 and self._tpm_counter.remaining(self.tpm_limit) < estimated_tokens:
            return False
        return True

    def record_request(self, estimated_tokens: int) -> None:
        self._rpm_counter.record(1)
        self._tpm_counter.record(estimated_tokens)

    def update_limits(self, rpm_limit: int | None = None, tpm_limit: int | None = None) -> None:
        if rpm_limit is not None:
            self.rpm_limit = rpm_limit
        if tpm_limit is not None:
            self.tpm_limit = tpm_limit

    def mark_rate_limited(self, retry_after: float) -> None:
        self._rate_limited_until = time.monotonic() + retry_after
        self._retry_after = retry_after

    def get_wait_seconds(self, estimated_tokens: int) -> float:
        if self.can_proceed(estimated_tokens):
            return 0.0
        now = time.monotonic()
        if now < self._rate_limited_until:
            return self._rate_limited_until - now
        rpm_wait = (
            self._rpm_counter.seconds_until_capacity(self.rpm_limit, 1) if self.rpm_limit else 0.0
        )
        tpm_wait = (
            self._tpm_counter.seconds_until_capacity(self.tpm_limit, estimated_tokens)
            if self.tpm_limit
            else 0.0
        )
        return max(rpm_wait, tpm_wait)

    def get_state(self, provider: str) -> RateLimitState:
        now = time.monotonic()
        is_limited = now < self._rate_limited_until
        return RateLimitState(
            provider=provider,
            rpm_limit=self.rpm_limit,
            rpm_remaining=self._rpm_counter.remaining(self.rpm_limit),
            rpm_reset_seconds=self._rpm_counter.seconds_until_capacity(self.rpm_limit, 1),
            tpm_limit=self.tpm_limit,
            tpm_remaining=self._tpm_counter.remaining(self.tpm_limit),
            tpm_reset_seconds=self._tpm_counter.seconds_until_capacity(self.tpm_limit, 1),
            is_rate_limited=is_limited,
            retry_after_seconds=self._retry_after if is_limited else None,
        )
