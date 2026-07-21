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
import time
import uuid
from collections.abc import Callable, Coroutine
from typing import Any

import structlog
from redis.exceptions import TimeoutError as RedisTimeoutError

from stt_v2.core.config.settings import get_settings
from stt_v2.streaming.schemas import (
    AudioFrame,
    SegmentResult,
    SessionControl,
)

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Consumer-group constants
# ---------------------------------------------------------------------------

#: Consumer-group name on every per-session ``stt:audio:{sid}`` stream. Because
#: the stream is per-session, one constant group name is unambiguous — a single
#: group with normally one live consumer (the owning worker). A recovering
#: worker joins the SAME group under a new consumer name and reclaims the dead
#: consumer's in-flight (unacked) entries via ``XAUTOCLAIM``.
AUDIO_CONSUMER_GROUP = "stt-ingest"

#: Minimum idle time (ms) before a periodic ``XAUTOCLAIM`` steals another
#: consumer's pending entry. Large enough that a live consumer (which acks in
#: milliseconds) never has its own in-flight reclaimed; small enough that a
#: dead consumer's audio is handed off promptly.
_DEFAULT_CLAIM_MIN_IDLE_MS = 30_000

#: Throttle (s) between periodic ``XAUTOCLAIM`` scans for dead-consumer handoff.
_DEFAULT_CLAIM_INTERVAL_S = 15.0


def _err_has(exc: Exception, token: str) -> bool:
    """True when a Redis error string carries ``token`` (e.g. BUSYGROUP/NOGROUP)."""
    return token in str(exc).upper()


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

    Reads ``stt:audio:{session_id}`` through a Redis
    **consumer group** (``XREADGROUP`` + ``XACK``), so delivery is
    at-least-once and a worker crash never strands in-flight audio: on
    recovery a new consumer reclaims the dead consumer's pending (unacked)
    entries via ``XAUTOCLAIM``. The stream is per-session, so a single
    constant group (:data:`AUDIO_CONSUMER_GROUP`) with one live consumer is
    the natural single-owner mechanism.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        The session to consume audio for.
    on_frame:
        Async callback invoked for each decoded ``AudioFrame``.
    on_batch:
        Optional async callback invoked once per processed batch with the
        last processed stream entry ID (used to persist the
        resume position and trim the consumed audio stream). Errors raised by
        the callback are logged and never stop the consumer.
    last_id:
        Stream entry ID the consumer group is CREATED at when it does not yet
        exist (default ``"0-0"`` = deliver from the start). Once the group
        exists, Redis owns the cursor — this is only the create-time seed, so
        a recovered session whose group was lost recreates at its persisted
        position. Ignored (BUSYGROUP) when the group already exists.
    block_ms:
        ``XREADGROUP BLOCK`` timeout in milliseconds (0 = indefinite).
    group_name:
        Consumer-group name (default :data:`AUDIO_CONSUMER_GROUP`).
    consumer_name:
        Unique consumer name within the group (default: generated). The
        session manager passes the worker id so a different worker recovering
        the session reclaims the dead worker's pending via ``XAUTOCLAIM``.
    """

    def __init__(
        self,
        redis: Any,
        session_id: str,
        on_frame: Callable[[AudioFrame], Coroutine[Any, Any, None]],
        last_id: str = "0-0",
        block_ms: int = 5000,
        on_batch: Callable[[str], Coroutine[Any, Any, None]] | None = None,
        group_name: str = AUDIO_CONSUMER_GROUP,
        consumer_name: str | None = None,
        claim_min_idle_ms: int | None = None,
        claim_interval_s: float | None = None,
    ) -> None:
        self._redis = redis
        self._session_id = session_id
        self._on_frame = on_frame
        self._on_batch = on_batch
        self._last_id = last_id
        self._block_ms = block_ms
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._group_name = group_name
        self._consumer_name = consumer_name or f"consumer-{uuid.uuid4().hex[:8]}"
        # Group-create seed: "0" means "deliver every entry"; a persisted
        # resume cursor (non-"0-0") recreates the group at that point.
        self._group_start_id = last_id if last_id and last_id != "0-0" else "0"
        self._claim_min_idle_ms = (
            claim_min_idle_ms if claim_min_idle_ms is not None else _DEFAULT_CLAIM_MIN_IDLE_MS
        )
        self._claim_interval_s = (
            claim_interval_s if claim_interval_s is not None else _DEFAULT_CLAIM_INTERVAL_S
        )
        self._last_claim_at = 0.0
        self._group_ready = False

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

    async def _ensure_group(self, stream_key: str) -> None:
        """Create the consumer group (idempotent). Swallows BUSYGROUP."""
        try:
            await self._redis.xgroup_create(
                stream_key,
                self._group_name,
                id=self._group_start_id,
                mkstream=True,
            )
            logger.info(
                "Audio consumer group created",
                session_id=self._session_id,
                group=self._group_name,
                start_id=self._group_start_id,
            )
        except Exception as exc:
            if _err_has(exc, "BUSYGROUP"):
                pass  # already exists — Redis owns the cursor
            else:
                logger.warning(
                    "XGROUP CREATE failed (continuing)",
                    session_id=self._session_id,
                    group=self._group_name,
                    error=str(exc),
                )
        self._group_ready = True

    async def _dispatch_frame(self, entry_id: str, fields: Any) -> None:
        """Decode + forward one frame. A bad frame is skipped (logged), never fatal."""
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

    async def _ack(self, stream_key: str, ack_ids: list[str]) -> None:
        """XACK processed entries (non-fatal — a redelivery is preferable to a crash)."""
        if not ack_ids:
            return
        try:
            await self._redis.xack(stream_key, self._group_name, *ack_ids)
        except Exception as exc:
            logger.warning(
                "XACK failed (non-fatal)",
                session_id=self._session_id,
                error=str(exc),
            )

    async def _reclaim_pending(self, stream_key: str, min_idle_ms: int, force: bool = False) -> None:
        """Reclaim + process another consumer's idle pending entries via XAUTOCLAIM.

        On the first pass (``force``, ``min_idle_ms=0``) this also drains this
        consumer's OWN pending (unacked-before-restart) for immediate recovery.
        Thereafter it hands off only entries idle beyond ``min_idle_ms`` — a
        dead consumer's in-flight audio — without stealing a live consumer's
        just-delivered frames. Throttled and always non-fatal.
        """
        now = time.monotonic()
        if not force and (now - self._last_claim_at) < self._claim_interval_s:
            return
        self._last_claim_at = now
        try:
            result = await self._redis.xautoclaim(
                stream_key,
                self._group_name,
                self._consumer_name,
                min_idle_time=min_idle_ms,
                start_id="0-0",
                count=100,
            )
        except Exception as exc:
            if _err_has(exc, "NOGROUP"):
                await self._ensure_group(stream_key)
            else:
                logger.debug(
                    "XAUTOCLAIM failed (non-fatal)",
                    session_id=self._session_id,
                    error=str(exc),
                )
            return

        # redis-py >= 4.2 returns [cursor, [(id, fields), ...], [deleted_ids]].
        claimed = result[1] if isinstance(result, (list, tuple)) and len(result) >= 2 else []
        if not claimed:
            return
        ack_ids: list[str] = []
        for entry_id, fields in claimed:
            eid = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
            if fields:  # None/empty ⇒ tombstone surfaced by autoclaim; just ack it
                await self._dispatch_frame(eid, fields)
                self._last_id = eid
            ack_ids.append(eid)
        await self._ack(stream_key, ack_ids)
        logger.info(
            "Reclaimed pending audio via XAUTOCLAIM",
            session_id=self._session_id,
            group=self._group_name,
            consumer=self._consumer_name,
            claimed=len(ack_ids),
            min_idle_ms=min_idle_ms,
        )

    async def _run(self) -> None:
        """Main read loop — consumer-group semantics (XREADGROUP + XACK)."""
        stream_key = audio_stream_key(self._session_id)
        await self._ensure_group(stream_key)
        first_pass = True
        try:
            while self._running:
                # Hand off in-flight from a dead consumer (and, on the first
                # pass with min_idle=0, our own unacked pending) so a worker
                # crash never strands clinical audio.
                await self._reclaim_pending(
                    stream_key,
                    min_idle_ms=0 if first_pass else self._claim_min_idle_ms,
                    force=first_pass,
                )
                first_pass = False

                try:
                    entries = await self._redis.xreadgroup(
                        self._group_name,
                        self._consumer_name,
                        {stream_key: ">"},
                        count=100,
                        block=self._block_ms,
                    )
                except RedisTimeoutError:
                    # A redis-py socket_timeout shorter than BLOCK surfaces here
                    # every time the block elapses on a SILENT stream (a speech
                    # pause, or the quiet tail while the session finalizes). No
                    # entry was delivered, so it is BENIGN — treat it exactly like
                    # an empty read and re-issue immediately. The consumer-group
                    # ">" cursor is server-side and intact, so a later frame
                    # (including the terminal one) is still delivered; nothing is
                    # lost. Deliberately NOT the fatal-error path below: no error
                    # spam, no 1s backoff. (The committed client sets no
                    # socket_timeout; this keeps the reader correct under any that
                    # an operator/env injects — see _runtime.initialize_streaming.)
                    continue
                except Exception as exc:
                    if _err_has(exc, "NOGROUP"):
                        # Stream/group was trimmed away — recreate and retry.
                        await self._ensure_group(stream_key)
                        continue
                    logger.error(
                        "XREADGROUP failed, retrying",
                        session_id=self._session_id,
                        error=str(exc),
                    )
                    await asyncio.sleep(1)
                    continue

                if not entries:
                    continue  # timeout, no new entries

                # entries format: [[stream_name, [(entry_id, fields), ...]]]
                processed_any = False
                ack_ids: list[str] = []
                for _stream_name, messages in entries:
                    for entry_id, fields in messages:
                        eid = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
                        await self._dispatch_frame(eid, fields)
                        # Advance + ack unconditionally: a permanently bad frame
                        # is skipped (logged) but still acked so it never poisons
                        # the group's pending list.
                        self._last_id = eid
                        ack_ids.append(eid)
                        processed_any = True

                await self._ack(stream_key, ack_ids)

                # Report the batch position for resume
                # tracking and audio stream trimming. Never fatal.
                if processed_any and self._on_batch is not None:
                    try:
                        await self._on_batch(self._last_id)
                    except Exception as exc:
                        logger.warning(
                            "on_batch callback failed (non-fatal)",
                            session_id=self._session_id,
                            last_id=self._last_id,
                            error=str(exc),
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

    Every ``XADD`` carries an approximate ``MAXLEN`` so the
    result stream stays bounded DURING an active session (previously it grew
    unbounded until the post-close ``EXPIRE``). The bound is high enough that
    a keeping-up reader never misses a result; overflowed finals remain in the
    durable transcript (the clinical system of record) rather than only in the
    ephemeral stream.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    session_id:
        Target session.
    maxlen:
        Approximate ``MAXLEN`` for the result stream. ``None`` resolves from
        ``settings.streaming_result_stream_maxlen``.
    """

    def __init__(self, redis: Any, session_id: str, maxlen: int | None = None) -> None:
        self._redis = redis
        self._session_id = session_id
        self._maxlen = maxlen

    def _resolve_maxlen(self) -> int:
        if self._maxlen is not None:
            return self._maxlen
        return get_settings().streaming_result_stream_maxlen

    async def publish(self, result: SegmentResult) -> str:
        """Write a ``SegmentResult`` to the result stream.

        Returns the Redis Stream entry ID.
        """
        key = result_stream_key(self._session_id)
        entry_id = await self._redis.xadd(
            key,
            result.to_redis_dict(),
            maxlen=self._resolve_maxlen(),
            approximate=True,
        )
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
            maxlen=self._resolve_maxlen(),
            approximate=True,
        )
        entry_id_str = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
        return entry_id_str

    async def publish_status(self, status: str) -> str:
        """Publish a status update (e.g. 'finalizing', 'closed') to the result stream."""
        key = result_stream_key(self._session_id)
        entry_id = await self._redis.xadd(
            key,
            {"type": "status", "status": status},
            maxlen=self._resolve_maxlen(),
            approximate=True,
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
                except RedisTimeoutError:
                    # Benign: a socket_timeout shorter than BLOCK elapsed on a
                    # quiet control stream. Re-issue with the same last_id — a
                    # finalize/cancel that arrives later is still read (XREAD
                    # returns everything after last_id). Not an error, no backoff;
                    # otherwise the 1s backoff + error spam would delay the very
                    # finalize command that ends the session. See the twin catch
                    # in IngestionConsumer._run.
                    continue
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

    The default (``settings.streaming_audio_stream_maxlen``)
    is the SINGLE source of truth for the audio-stream bound and is kept equal
    to the TS gateway bridge's ``XADD MAXLEN`` (the sole production writer of
    ``stt:audio``); this helper's only caller is the test suite.

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
