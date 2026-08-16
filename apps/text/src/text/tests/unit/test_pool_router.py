"""Degrade-away-from-unhealthy routing (TASK-725 Task 2).

Hermetic unit tests for `services/pool_health.PoolHealthTracker` and
`services/pool_router.resolve_pool_route`. RED: written before implementation.
"""

from __future__ import annotations

import pytest

from text.core.exceptions import PoolUnhealthyError
from text.services.pool_health import PoolHealthTracker
from text.services.pool_router import resolve_pool_route


class TestPoolHealthTracker:
    def test_unknown_provider_reports_none(self):
        tracker = PoolHealthTracker()
        assert tracker.is_healthy("ollama") is None

    def test_records_and_reads_back_healthy(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", True)
        assert tracker.is_healthy("ollama") is True

    def test_records_and_reads_back_unhealthy(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        assert tracker.is_healthy("ollama") is False

    def test_later_record_overwrites_earlier(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        tracker.record("ollama", True)
        assert tracker.is_healthy("ollama") is True

    def test_unknown_provider_has_no_checked_at(self):
        tracker = PoolHealthTracker()
        assert tracker.checked_at("ollama") is None

    def test_record_stamps_checked_at(self):
        import datetime as dt

        tracker = PoolHealthTracker()
        before = dt.datetime.now(dt.UTC)
        tracker.record("ollama", True)
        after = dt.datetime.now(dt.UTC)
        stamped = tracker.checked_at("ollama")
        assert stamped is not None
        assert before <= stamped <= after


class TestResolvePoolRoute:
    def test_unknown_health_dispatches_unchanged(self):
        tracker = PoolHealthTracker()
        assert resolve_pool_route("ollama", tracker=tracker) == "ollama"

    def test_healthy_dispatches_unchanged(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", True)
        assert resolve_pool_route("ollama", tracker=tracker) == "ollama"

    def test_unhealthy_no_fallback_raises_pool_unhealthy(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        with pytest.raises(PoolUnhealthyError) as exc_info:
            resolve_pool_route("ollama", tracker=tracker)
        assert exc_info.value.provider == "ollama"
        assert exc_info.value.error_code == "POOL_UNHEALTHY"

    def test_unhealthy_with_registered_fallback_reroutes(self):
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        result = resolve_pool_route(
            "ollama", tracker=tracker, fallback="lm-studio", fallback_registered=True
        )
        assert result == "lm-studio"

    def test_unhealthy_with_unregistered_fallback_still_raises(self):
        """A declared fallback the registry doesn't actually know is not usable —
        never silently queue into a dead engine, and never claim to have
        rerouted to a provider that doesn't exist."""
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        with pytest.raises(PoolUnhealthyError):
            resolve_pool_route(
                "ollama", tracker=tracker, fallback="nonexistent", fallback_registered=False
            )

    def test_unhealthy_fallback_itself_also_unhealthy_still_reroutes(self):
        """resolve_pool_route only vets fallback REGISTRATION, not the fallback's
        own health — a caller-declared fallback is dispatched to as-is; if it's
        also down, the provider call fails there (existing retry/circuit-breaker
        machinery), which is a real distinct failure from 'no route at all'."""
        tracker = PoolHealthTracker()
        tracker.record("ollama", False)
        tracker.record("lm-studio", False)
        result = resolve_pool_route(
            "ollama", tracker=tracker, fallback="lm-studio", fallback_registered=True
        )
        assert result == "lm-studio"
