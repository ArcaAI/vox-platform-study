"""Per-provider circuit breaker to prevent cascading failures."""

from __future__ import annotations

import time
from enum import StrEnum


class CircuitState(StrEnum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Simple circuit breaker with failure threshold and recovery timeout.

    ``half_open_max_calls``, ``reset_timeout_s`` and ``count_rate_limits`` wire
    ``CircuitBreakerConfig`` (TASK-508 D6 dead-config sweep — these three fields
    were previously defined but never read). Their defaults (``None``, ``None``,
    ``True``) reproduce this class's exact pre-wiring behavior: unlimited trial
    calls while HALF_OPEN, no time-based failure-count decay, and every failure
    (rate-limit or not) counts toward the threshold.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
        half_open_max_calls: int | None = None,
        reset_timeout_s: float | None = None,
        count_rate_limits: bool = True,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._half_open_max_calls = half_open_max_calls
        self._reset_timeout_s = reset_timeout_s
        self._count_rate_limits = count_rate_limits
        self._failure_count = 0
        self._last_failure_time: float = 0.0
        self._state = CircuitState.CLOSED
        self._half_open_calls = 0

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
                self._state = CircuitState.HALF_OPEN
                self._half_open_calls = 0
        elif (
            self._state == CircuitState.CLOSED
            and self._reset_timeout_s is not None
            and self._failure_count > 0
            and time.monotonic() - self._last_failure_time >= self._reset_timeout_s
        ):
            self._failure_count = 0
        return self._state

    @property
    def failure_count(self) -> int:
        return self._failure_count

    def allow_request(self) -> bool:
        current = self.state
        if current == CircuitState.OPEN:
            return False
        if current == CircuitState.HALF_OPEN and self._half_open_max_calls is not None:
            if self._half_open_calls >= self._half_open_max_calls:
                return False
            self._half_open_calls += 1
        return True

    def record_success(self) -> None:
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self._half_open_calls = 0

    def record_failure(self, *, is_rate_limit: bool = False) -> None:
        if is_rate_limit and not self._count_rate_limits:
            return
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        if self._state == CircuitState.HALF_OPEN:
            self._state = CircuitState.OPEN
        elif self._failure_count >= self._failure_threshold:
            self._state = CircuitState.OPEN

    def reset(self) -> None:
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self._last_failure_time = 0.0
        self._half_open_calls = 0
