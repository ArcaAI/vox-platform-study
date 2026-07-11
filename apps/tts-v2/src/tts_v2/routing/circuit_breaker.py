"""Minimal per-provider circuit breaker.

Trips open after ``failure_threshold`` consecutive failures; after
``recovery_timeout_s`` it half-opens (allows one trial). Kept intentionally
small — full rate-limit/queue machinery lives elsewhere if needed.
"""

from __future__ import annotations

import time


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, recovery_timeout_s: float = 30.0) -> None:
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self._failures = 0
        self._opened_at: float | None = None

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._opened_at = time.monotonic()

    def is_open(self) -> bool:
        if self._opened_at is None:
            return False
        if time.monotonic() - self._opened_at >= self.recovery_timeout_s:
            # Half-open: allow a trial and reset.
            self._opened_at = None
            self._failures = 0
            return False
        return True
