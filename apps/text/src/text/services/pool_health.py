"""In-process pool-health cache — the degrade-routing signal.

Populated by `GET /health`'s existing per-provider `health_check()` loop
(`api/endpoints/health.py`) at the SAME call site that already sets the
`PROVIDER_HEALTH` Prometheus gauge — this is a second, queryable view of the
identical result, not a new probe. See
(b) for why
reading the gauge back (a private-API, write-only-by-convention channel) was
rejected in favor of this small explicit cache.

Fails OPEN on "unknown": a provider nobody has health-checked yet is NOT
treated as unhealthy. Degrade-routing only acts on a POSITIVELY known
unhealthy result.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime


class PoolHealthTracker:
    """Thread-safe last-known-health cache, one boolean + timestamp per provider."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, bool] = {}
        self._checked_at: dict[str, datetime] = {}

    def record(self, provider: str, healthy: bool) -> None:
        with self._lock:
            self._state[provider] = healthy
            self._checked_at[provider] = datetime.now(UTC)

    def is_healthy(self, provider: str) -> bool | None:
        """``True``/``False`` if a health check has run for ``provider``; ``None`` if
        never checked (never checked ⇒ never blocks routing — see module docstring).
        """
        with self._lock:
            return self._state.get(provider)

    def checked_at(self, provider: str) -> datetime | None:
        """When ``provider`` was last health-checked; ``None`` if never checked.
        Surfaced on the admin introspection endpoint (`api/endpoints/providers.py`,"""
        with self._lock:
            return self._checked_at.get(provider)
