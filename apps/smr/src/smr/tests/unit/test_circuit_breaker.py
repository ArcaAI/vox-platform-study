"""TDD tests for CircuitBreaker.

RED: Written before implementation.
"""

from __future__ import annotations

import time


class TestCircuitBreakerStates:
    def test_initial_state_is_closed(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        assert cb.state == CircuitState.CLOSED

    def test_stays_closed_under_threshold(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.CLOSED

    def test_opens_at_threshold(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.OPEN

    def test_half_open_after_recovery_timeout(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.05)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.OPEN
        time.sleep(0.06)
        assert cb.state == CircuitState.HALF_OPEN

    def test_closes_after_success_in_half_open(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.06)
        assert cb.state == CircuitState.HALF_OPEN
        cb.record_success()
        assert cb.state == CircuitState.CLOSED

    def test_reopens_after_failure_in_half_open(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.06)
        assert cb.state == CircuitState.HALF_OPEN
        cb.record_failure()
        assert cb.state == CircuitState.OPEN


class TestCircuitBreakerAllowRequest:
    def test_allows_when_closed(self):
        from smr.services.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        assert cb.allow_request() is True

    def test_rejects_when_open(self):
        from smr.services.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        assert cb.allow_request() is False

    def test_allows_probe_in_half_open(self):
        from smr.services.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.06)
        assert cb.allow_request() is True


class TestCircuitBreakerSuccessResets:
    def test_success_resets_failure_count(self):
        from smr.services.circuit_breaker import CircuitBreaker
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert cb.failure_count == 0

    def test_manual_reset(self):
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=5.0)
        cb.record_failure()
        cb.record_failure()
        cb.reset()
        assert cb.state == CircuitState.CLOSED
        assert cb.failure_count == 0


class TestCircuitBreakerWiredConfigFields:
    """ D6 (dead-config sweep) — ``CircuitBreakerConfig.half_open_max_calls``,
    ``.reset_timeout_s`` and ``.count_rate_limits`` were defined but never read by
    ``CircuitBreaker``. Defaults (``None``, ``None``, ``True``) must reproduce the
    exact pre-wiring behavior: unlimited trial calls while HALF_OPEN, no
    time-based failure-count decay, and every failure (rate-limit or not)
    counts toward the threshold.
    """

    def test_half_open_max_calls_caps_probe_requests(self):
        """RED: half_open_max_calls is currently not even an accepted kwarg."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.0, half_open_max_calls=1)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.HALF_OPEN

        assert cb.allow_request() is True  # first probe consumes the single slot
        assert cb.allow_request() is False  # second probe rejected — cap reached

    def test_half_open_max_calls_default_is_unlimited(self):
        """Default (None) preserves today's behavior: every request is allowed
        while HALF_OPEN, with no cap."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.0)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.HALF_OPEN

        for _ in range(10):
            assert cb.allow_request() is True

    def test_reset_timeout_decays_failure_count_after_quiet_period(self):
        """RED: reset_timeout_s is currently not even an accepted kwarg."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=300.0, reset_timeout_s=0.05)
        cb.record_failure()
        cb.record_failure()
        assert cb.failure_count == 2
        assert cb.state == CircuitState.CLOSED

        time.sleep(0.06)

        assert cb.state == CircuitState.CLOSED  # never reached threshold, still closed
        assert cb.failure_count == 0  # but the quiet period decayed the count

    def test_reset_timeout_default_never_decays(self):
        """Default (None) preserves today's behavior: failure_count persists
        indefinitely until a success or explicit reset()."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=300.0)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.06)
        assert cb.state == CircuitState.CLOSED
        assert cb.failure_count == 2

    def test_count_rate_limits_false_ignores_rate_limit_failures(self):
        """RED: record_failure() currently has no is_rate_limit parameter, and
        count_rate_limits is never consulted."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=30.0, count_rate_limits=False)
        cb.record_failure(is_rate_limit=True)
        cb.record_failure(is_rate_limit=True)
        assert cb.failure_count == 0
        assert cb.state == CircuitState.CLOSED

    def test_count_rate_limits_default_true_counts_rate_limit_failures(self):
        """Default (True) preserves today's behavior: every failure counts,
        rate-limit or not."""
        from smr.services.circuit_breaker import CircuitBreaker, CircuitState

        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=30.0)
        cb.record_failure(is_rate_limit=True)
        cb.record_failure(is_rate_limit=True)
        assert cb.failure_count == 2
        assert cb.state == CircuitState.OPEN
