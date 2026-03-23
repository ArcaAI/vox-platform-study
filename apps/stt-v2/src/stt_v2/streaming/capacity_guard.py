"""Capacity guard for concurrent stream limiting.

Tracks the number of active streaming sessions against the hardware
profile's ``max_concurrent_streams`` limit. When the limit is reached,
new session requests are rejected with a capacity-exceeded signal so
the API Gateway can return **HTTP 503** with a ``Retry-After`` header.
"""

from __future__ import annotations

import asyncio

import structlog

logger = structlog.get_logger(__name__)


class CapacityGuard:
    """Asyncio-based concurrent stream limiter.

    Thread-safe via ``asyncio.Lock`` — all callers must be on the same
    event loop.

    Usage::

        guard = CapacityGuard(max_streams=100)

        if await guard.try_acquire("sess_abc"):
            try:
                # ... process session ...
            finally:
                await guard.release("sess_abc")
        else:
            # at capacity — reject with 503
            pass
    """

    def __init__(self, max_streams: int) -> None:
        if max_streams < 1:
            raise ValueError(f"max_streams must be >= 1, got {max_streams}")
        self._max_streams = max_streams
        self._active_sessions: set[str] = set()
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def try_acquire(self, session_id: str) -> bool:
        """Attempt to reserve a slot for the given session.

        Returns ``True`` if the session was admitted, ``False`` if at
        capacity. Idempotent — calling with an already-admitted session
        returns ``True`` without incrementing the count.
        """
        async with self._lock:
            if session_id in self._active_sessions:
                return True  # already admitted
            if len(self._active_sessions) >= self._max_streams:
                logger.warning(
                    "Capacity reached, rejecting session",
                    session_id=session_id,
                    active=len(self._active_sessions),
                    max=self._max_streams,
                )
                return False
            self._active_sessions.add(session_id)
            logger.debug(
                "Session admitted",
                session_id=session_id,
                active=len(self._active_sessions),
                max=self._max_streams,
            )
            return True

    async def release(self, session_id: str) -> None:
        """Release the slot held by the given session.

        No-op if the session was not tracked (safe to call multiple times).
        """
        async with self._lock:
            self._active_sessions.discard(session_id)
            logger.debug(
                "Session released",
                session_id=session_id,
                active=len(self._active_sessions),
                max=self._max_streams,
            )

    # ------------------------------------------------------------------
    # Read-only introspection
    # ------------------------------------------------------------------

    @property
    def active_count(self) -> int:
        """Number of currently active sessions (lock-free read)."""
        return len(self._active_sessions)

    @property
    def max_streams(self) -> int:
        """Configured maximum concurrent streams."""
        return self._max_streams

    @property
    def available_slots(self) -> int:
        """Number of remaining slots."""
        return max(0, self._max_streams - len(self._active_sessions))

    @property
    def active_session_ids(self) -> frozenset[str]:
        """Snapshot of currently active session IDs."""
        return frozenset(self._active_sessions)

    def to_dict(self) -> dict[str, object]:
        """Snapshot for health / status endpoints."""
        return {
            "active_sessions": self.active_count,
            "max_concurrent_streams": self._max_streams,
            "available_slots": self.available_slots,
        }
