"""VAD session state lifecycle manager.

Manages per-session LSTM state for streaming VAD. Each active streaming
session gets its own ``VADSessionState`` so that consecutive audio chunks
carry forward the LSTM hidden state without interference from other
sessions.

For 100+ concurrent sessions, memory is negligible: each session holds
a (2, 1, 128) float32 tensor = 1 KiB.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from .dto import VADSessionState
from .silero_service import SileroVADService, get_vad_service

logger = logging.getLogger(__name__)


class VADSessionManager:
    """Manage VAD session states with automatic expiry."""

    def __init__(
        self,
        vad_service: SileroVADService | None = None,
        max_idle_seconds: int = 3600,
    ) -> None:
        self._vad_service = vad_service
        self._sessions: dict[str, VADSessionState] = {}
        self._max_idle_seconds = max_idle_seconds
        self._lock = asyncio.Lock()

    @property
    def vad_service(self) -> SileroVADService:
        if self._vad_service is None:
            self._vad_service = get_vad_service()
        return self._vad_service

    # ------------------------------------------------------------------
    # Session CRUD
    # ------------------------------------------------------------------

    async def get_or_create(
        self,
        session_id: str,
        sample_rate: int = 16000,
    ) -> VADSessionState:
        """Get existing session state or create a new one."""
        async with self._lock:
            if session_id in self._sessions:
                return self._sessions[session_id]

            state = self.vad_service.create_session_state(
                session_id=session_id,
                sample_rate=sample_rate,
            )
            self._sessions[session_id] = state
            logger.debug("Created VAD session state: %s", session_id)
            return state

    async def get(self, session_id: str) -> VADSessionState | None:
        """Get session state if it exists."""
        return self._sessions.get(session_id)

    async def remove(self, session_id: str) -> None:
        """Remove and clean up a session state."""
        async with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                logger.debug("Removed VAD session state: %s", session_id)

    async def reset(self, session_id: str) -> None:
        """Reset session state without removing it (for session reuse)."""
        async with self._lock:
            state = self._sessions.get(session_id)
            if state:
                state.reset()
                logger.debug("Reset VAD session state: %s", session_id)

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------

    async def cleanup_expired(self) -> int:
        """Remove sessions idle longer than ``max_idle_seconds``.

        Returns:
            Number of sessions cleaned up.
        """
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=self._max_idle_seconds)
        expired: list[str] = []

        async with self._lock:
            for sid, state in self._sessions.items():
                if state.last_activity < cutoff:
                    expired.append(sid)

            for sid in expired:
                del self._sessions[sid]

        if expired:
            logger.info("Cleaned up %d expired VAD sessions", len(expired))
        return len(expired)

    @property
    def active_session_count(self) -> int:
        return len(self._sessions)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_manager: VADSessionManager | None = None


def get_vad_session_manager() -> VADSessionManager:
    """Get singleton VAD session manager."""
    global _manager
    if _manager is None:
        _manager = VADSessionManager()
    return _manager
