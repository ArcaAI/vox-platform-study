"""Streaming runtime singleton accessors.

Provides module-level singletons for the ``SessionManager`` and
``ExecutionProfile`` that are initialized once during application startup
and shared across the streaming module.

These accessors are intentionally kept in a separate module (rather than
in ``__init__.py`` or ``session_manager.py``) to break import cycles and
to make it explicit that runtime state is mutable global state.
"""

from __future__ import annotations

import uuid
from typing import Any

import structlog

from stt_v2.streaming.execution_profile import ExecutionProfile
from stt_v2.streaming.session_manager import SessionManager

logger = structlog.get_logger(__name__)

# Module-level singletons — set during ``initialize_streaming()``
_session_manager: SessionManager | None = None
_execution_profile: ExecutionProfile | None = None
_redis_client: Any | None = None  # redis.asyncio.Redis


def get_session_manager() -> SessionManager | None:
    """Return the global ``SessionManager``, or ``None`` if not yet initialized."""
    return _session_manager


def get_execution_profile() -> ExecutionProfile | None:
    """Return the global ``ExecutionProfile``, or ``None`` if not yet initialized."""
    return _execution_profile


def get_redis_client() -> Any | None:
    """Return the global async Redis client, or ``None`` if not initialized."""
    return _redis_client


def set_session_manager(mgr: SessionManager) -> None:
    """Set the global ``SessionManager`` (called during startup)."""
    global _session_manager
    _session_manager = mgr


def set_execution_profile(profile: ExecutionProfile) -> None:
    """Set the global ``ExecutionProfile`` (called during startup)."""
    global _execution_profile
    _execution_profile = profile


def clear_runtime() -> None:
    """Reset all runtime singletons (used in tests and shutdown)."""
    global _session_manager, _execution_profile, _redis_client
    _session_manager = None
    _execution_profile = None
    _redis_client = None


async def initialize_streaming() -> None:
    """Initialize the streaming module: Redis client, ExecutionProfile, SessionManager.

    Called during application startup (FastAPI lifespan). Creates an
    ``redis.asyncio`` connection dedicated to the streaming module,
    detects the hardware execution profile, and starts the
    ``SessionManager`` (which launches heartbeat, reaper, and recovery
    background tasks).

    This function is idempotent — calling it when already initialized
    is a no-op with a warning.
    """
    global _session_manager, _execution_profile, _redis_client

    if _session_manager is not None:
        logger.warning("Streaming module already initialized, skipping")
        return

    from stt_v2.core.config.settings import get_settings
    from stt_v2.streaming.execution_profile import detect_execution_profile

    settings = get_settings()

    # 1. Create a dedicated redis.asyncio client for the streaming module.
    #    This is separate from the Dramatiq broker (which uses sync redis).
    try:
        import redis.asyncio as aioredis

        # NOTE on timeouts: the blocking XREADGROUP/XREAD readers in
        # redis_streams.py use BLOCK windows (default 5s). We deliberately do
        # NOT force a socket_timeout here — a socket_timeout shorter than BLOCK
        # would raise on every silence gap. Any socket_timeout supplied via
        # REDIS_URL is now tolerated gracefully by those readers (they treat a
        # read TimeoutError as an empty read and re-issue), so operator/env
        # config is respected without breaking the blocking reads.
        # health_check_interval lets redis-py detect a silently-dropped
        # connection on the next idle command rather than hanging indefinitely.
        _redis_client = aioredis.from_url(
            settings.redis_url,
            decode_responses=False,  # Streams use binary data
            health_check_interval=30,
        )
        # Verify connectivity
        await _redis_client.ping()
        logger.info(
            "Streaming Redis client connected",
            redis_url=settings.redis_url[:30] + "...",
        )
    except Exception as exc:
        logger.error(
            "Failed to connect streaming Redis client — streaming disabled",
            error=str(exc),
        )
        _redis_client = None
        return

    # 2. Detect hardware and build execution profile
    _execution_profile = detect_execution_profile()
    logger.info(
        "Execution profile detected",
        platform=getattr(_execution_profile.platform, "value", _execution_profile.platform),
        asr_device=_execution_profile.asr_device,
        max_concurrent=_execution_profile.max_concurrent_streams,
    )

    # 3. Create and start SessionManager
    worker_id = f"stt-v2-{uuid.uuid4().hex[:8]}"
    _session_manager = SessionManager(
        redis=_redis_client,
        profile=_execution_profile,
        worker_id=worker_id,
    )
    await _session_manager.start()

    logger.info(
        "Streaming module initialized",
        worker_id=worker_id,
        max_concurrent_streams=_execution_profile.max_concurrent_streams,
    )


async def shutdown_streaming() -> None:
    """Shut down the streaming module gracefully.

    Stops the ``SessionManager`` (which persists all active sessions,
    cancels background tasks, and unregisters the worker), then closes
    the dedicated Redis connection.
    """
    global _session_manager, _execution_profile, _redis_client

    if _session_manager is not None:
        logger.info("Stopping streaming SessionManager...")
        try:
            await _session_manager.stop()
        except Exception as exc:
            logger.error("Error stopping SessionManager", error=str(exc))
        _session_manager = None

    _execution_profile = None

    if _redis_client is not None:
        try:
            await _redis_client.aclose()
        except Exception as exc:
            logger.error("Error closing streaming Redis client", error=str(exc))
        _redis_client = None

    logger.info("Streaming module shut down")
