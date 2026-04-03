"""Redis Streams integration for streaming audio ingestion and result publishing.

Three async components communicate via Redis Streams:

* **IngestionConsumer** — reads ``stt:audio:{session_id}`` with blocking
  ``XREAD`` and dispatches frames to the session manager.
* **ResultPublisher** — writes ``SegmentResult`` entries to
  ``stt:result:{session_id}`` via ``XADD``.
* **ControlListener** — reads ``stt:control:{session_id}`` for
  finalize / pause / cancel commands.

All I/O uses ``redis.asyncio`` for non-blocking operation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.streaming.schemas import (
    AudioFrame,
    SegmentResult,
    SessionControl,
)

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Key helpers
# ---------------------------------------------------------------------------


def audio_stream_key(session_id: str) -> str:
    """Redis key for the audio input stream."""
    return f"stt:audio:{session_id}"


def result_stream_key(session_id: str) -> str:
    """Redis key for the result output stream."""
    return f"stt:result:{session_id}"


def control_stream_key(session_id: str) -> str:
    """Redis key for the session control stream."""
    return f"stt:control:{session_id}"


def session_meta_key(session_id: str) -> str:
    """Redis key for the session metadata hash."""
    return f"stt:session:{session_id}"


def worker_key(worker_id: str) -> str:
    """Redis key for the worker heartbeat."""
    return f"stt:worker:{worker_id}"


# ---------------------------------------------------------------------------
# IngestionConsumer
# ---------------------------------------------------------------------------


class IngestionConsumer:
    """Asyncio task that reads audio frames from a per-session Redis Stream.

    Reads from ``stt:audio:{session_id}`` using ``XREAD`` with a
    configurable block timeout. Decoded frames are forwarded to the
    ``on_frame`` callback.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        The session to consume audio for.
    on_frame:
        Async callback invoked for each decoded ``AudioFrame``.
    last_id:
        Redis Stream entry ID to resume from (default ``"0-0"`` = start).
    block_ms:
        ``XREAD BLOCK`` timeout in milliseconds (0 = indefinite).
    """

    def __init__(
        self,
        redis: Any,
        session_id: str,
        on_frame: Callable[[AudioFrame], Coroutine[Any, Any, None]],
        last_id: str = "0-0",
        block_ms: int = 5000,
    ) -> None:
        self._redis = redis
        self._session_id = session_id
        self._on_frame = on_frame
        self._last_id = last_id
        self._block_ms = block_ms
        self._running = False
        self._task: asyncio.Task[None] | None = None

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> None:
        """Start the consumer as a background asyncio task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run(), name=f"ingestion-{self._session_id}")
        logger.info("IngestionConsumer started", session_id=self._session_id)

    async def stop(self) -> None:
        """Gracefully stop the consumer."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("IngestionConsumer stopped", session_id=self._session_id)

    async def _run(self) -> None:
        """Main read loop."""
        stream_key = audio_stream_key(self._session_id)
        try:
            while self._running:
                try:
                    entries = await self._redis.xread(
                        {stream_key: self._last_id},
                        count=100,
                        block=self._block_ms,
                    )
                except Exception as exc:
                    logger.error(
                        "XREAD failed, retrying",
                        session_id=self._session_id,
                        error=str(exc),
                    )
                    await asyncio.sleep(1)
                    continue

                if not entries:
                    continue  # timeout, no new entries

                # entries format: [[stream_name, [(entry_id, fields), ...]]]
                for _stream_name, messages in entries:
                    for entry_id, fields in messages:
                        try:
                            frame = AudioFrame.from_redis_dict(fields)
                            await self._on_frame(frame)
                        except Exception as exc:
                            logger.warning(
                                "Failed to process audio frame, skipping",
                                session_id=self._session_id,
                                entry_id=entry_id,
                                error=str(exc),
                            )
                        finally:
                            # Always advance last_id to avoid poisoning
                            # the stream with a permanently failing entry.
                            self._last_id = (
                                entry_id.decode() if isinstance(entry_id, bytes) else entry_id
                            )
        except asyncio.CancelledError:
            logger.debug("IngestionConsumer cancelled", session_id=self._session_id)
        finally:
            self._running = False


# ---------------------------------------------------------------------------
# ResultPublisher
# ---------------------------------------------------------------------------


class ResultPublisher:
    """Publishes transcription results to ``stt:result:{session_id}``.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        Target session.
    """

    def __init__(self, redis: Any, session_id: str) -> None:
        self._redis = redis
        self._session_id = session_id

    async def publish(self, result: SegmentResult) -> str:
        """Write a ``SegmentResult`` to the result stream.

        Returns the Redis Stream entry ID.
        """
        key = result_stream_key(self._session_id)
        entry_id = await self._redis.xadd(key, result.to_redis_dict())
        entry_id_str = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
        logger.debug(
            "Result published",
            session_id=self._session_id,
            entry_id=entry_id_str,
            text_preview=result.text[:80] if result.text else "",
        )
        return entry_id_str

    async def publish_error(self, error_message: str) -> str:
        """Publish an error entry to the result stream."""
        key = result_stream_key(self._session_id)
        entry_id = await self._redis.xadd(
            key,
            {"type": "error", "message": error_message},
        )
        entry_id_str = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
        return entry_id_str

    async def publish_status(self, status: str) -> str:
        """Publish a status update (e.g. 'finalizing', 'closed') to the result stream."""
        key = result_stream_key(self._session_id)
        entry_id = await self._redis.xadd(
            key,
            {"type": "status", "status": status},
        )
        entry_id_str = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
        return entry_id_str


# ---------------------------------------------------------------------------
# ControlListener
# ---------------------------------------------------------------------------


class ControlListener:
    """Asyncio task that listens for session control commands.

    Reads from ``stt:control:{session_id}`` and invokes the appropriate
    callback when a control command is received.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        The session to listen for control commands.
    on_control:
        Async callback invoked for each decoded ``SessionControl``.
    last_id:
        Redis Stream entry ID to resume from (default ``"0-0"``).
    block_ms:
        ``XREAD BLOCK`` timeout in milliseconds.
    """

    def __init__(
        self,
        redis: Any,
        session_id: str,
        on_control: Callable[[SessionControl], Coroutine[Any, Any, None]],
        last_id: str = "0-0",
        block_ms: int = 5000,
    ) -> None:
        self._redis = redis
        self._session_id = session_id
        self._on_control = on_control
        self._last_id = last_id
        self._block_ms = block_ms
        self._running = False
        self._task: asyncio.Task[None] | None = None

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> None:
        """Start the listener as a background asyncio task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run(), name=f"control-{self._session_id}")
        logger.info("ControlListener started", session_id=self._session_id)

    async def stop(self) -> None:
        """Gracefully stop the listener."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("ControlListener stopped", session_id=self._session_id)

    async def _run(self) -> None:
        """Main read loop for control commands."""
        stream_key = control_stream_key(self._session_id)
        try:
            while self._running:
                try:
                    entries = await self._redis.xread(
                        {stream_key: self._last_id},
                        count=10,
                        block=self._block_ms,
                    )
                except Exception as exc:
                    logger.error(
                        "Control XREAD failed, retrying",
                        session_id=self._session_id,
                        error=str(exc),
                    )
                    await asyncio.sleep(1)
                    continue

                if not entries:
                    continue

                for _stream_name, messages in entries:
                    for entry_id, fields in messages:
                        try:
                            control = SessionControl.from_redis_dict(fields)
                            logger.info(
                                "Control command received",
                                session_id=self._session_id,
                                action=control.action.value,
                            )
                            await self._on_control(control)
                        except Exception as exc:
                            logger.warning(
                                "Failed to process control command, skipping",
                                session_id=self._session_id,
                                entry_id=entry_id,
                                error=str(exc),
                            )
                        finally:
                            # Always advance to avoid poisoning the stream.
                            self._last_id = (
                                entry_id.decode() if isinstance(entry_id, bytes) else entry_id
                            )
        except asyncio.CancelledError:
            logger.debug("ControlListener cancelled", session_id=self._session_id)
        finally:
            self._running = False


# ---------------------------------------------------------------------------
# Audio Stream helpers (XADD with MAXLEN trimming)
# ---------------------------------------------------------------------------


async def xadd_audio_frame(
    redis: Any,
    session_id: str,
    frame: AudioFrame,
    maxlen: int | None = None,
) -> str:
    """Write an audio frame to the session's audio stream with trimming.

    Uses ``XADD ... MAXLEN ~ {maxlen}`` to keep the stream bounded.
    The ``~`` (approximate) flag lets Redis optimise by trimming in
    blocks rather than entry-by-entry.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        Target session.
    frame:
        The audio frame to write.
    maxlen:
        Approximate max entries to retain (default from settings).

    Returns
    -------
    str:
        The Redis Stream entry ID.
    """
    if maxlen is None:
        maxlen = get_settings().streaming_audio_stream_maxlen
    key = audio_stream_key(session_id)
    entry_id = await redis.xadd(
        key,
        frame.to_redis_dict(),
        maxlen=maxlen,
        approximate=True,
    )
    return entry_id.decode() if isinstance(entry_id, bytes) else entry_id
