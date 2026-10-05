"""Per-session outbox that ships FINAL segments to the gateway as they happen.

The gateway builds the consultation record from these segments
(``POST internal/stt/segments``), so a final has to reach it while the session
is still live — not only in the aggregate transcript posted at finalize.

Batching: at most :data:`MAX_BATCH` segments per POST, or whatever is pending
once :data:`FLUSH_INTERVAL_S` has passed since the oldest unsent final, and
immediately whenever the session manager calls :meth:`SegmentOutbox.flush`
(pause, finalize). Times are SESSION-relative milliseconds; the gateway adds the
binding's recording offset.

Durability reuses the transcript outbox's redrive pattern: a batch whose inline
POST fails transiently is parked in the shared Redis hash
:data:`SEGMENT_OUTBOX_KEY` and re-driven by the reaper loop (any worker) under a
soft lease, deleted only after a confirmed 2xx; a permanent 4xx is dropped with
an alert. Delivery is at-least-once and the gateway dedups on
``(sttSessionId, utteranceIndex)``, so a redelivery is harmless. Locally the
outbox never sends the same ``utteranceIndex`` twice.

The parked body carries transcript text (PHI) exactly as the transcript outbox
does; logs never do.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import structlog
from hope_obs import redact_id

from stt.streaming.schemas import SegmentResult

logger = structlog.get_logger(__name__)

#: Shared Redis hash of segment batches whose inline POST failed transiently.
SEGMENT_OUTBOX_KEY = "stt:segment_outbox"

#: Contract bounds for one POST (TASK-1045 P-AB §1.5).
MAX_BATCH = 25
FLUSH_INTERVAL_S = 1.5

#: Soft lease a redriving worker stamps on an entry (same reasoning and value as
#: the transcript outbox's ``OUTBOX_LEASE_TTL_S``).
LEASE_TTL_S = 90.0

_RETRYABLE_4XX = frozenset({408, 425, 429})

PostSegments = Callable[[dict[str, Any]], Awaitable[Any]]


def is_permanent_gateway_error(exc: BaseException) -> bool:
    """True for a non-retryable 4xx; 408/425/429, 5xx and transport errors are transient."""
    details = getattr(exc, "details", None)
    status = details.get("status_code") if isinstance(details, dict) else None
    return isinstance(status, int) and 400 <= status < 500 and status not in _RETRYABLE_4XX


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SegmentOutbox:
    """Batches one session's finals and posts them to the gateway."""

    def __init__(
        self,
        *,
        redis: Any,
        session_id: str,
        tenant_id: str,
        consultation_id: str,
        post: PostSegments,
        audio_offset_ms: Callable[[], int],
        max_batch: int = MAX_BATCH,
        flush_interval_s: float = FLUSH_INTERVAL_S,
        inline_attempts: int = 1,
    ) -> None:
        self._redis = redis
        self._session_id = session_id
        self._tenant_id = tenant_id
        self._consultation_id = consultation_id
        self._post = post
        self._audio_offset_ms = audio_offset_ms
        self._max_batch = max(1, max_batch)
        self._flush_interval_s = flush_interval_s
        self._inline_attempts = max(1, inline_attempts)

        self._pending: list[dict[str, Any]] = []
        self._first_pending_at: float | None = None
        self._seen: set[int] = set()
        self._next_index = 0
        self._parked: set[str] = set()
        self._flush_lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    # ------------------------------------------------------------------
    # Intake (synchronous: called from ``StreamSession.add_result``)
    # ------------------------------------------------------------------

    def add(self, result: SegmentResult) -> None:
        """Queue one final; duplicates by ``utterance_index`` are ignored."""
        if self._closed or not result.is_final or not (result.text or "").strip():
            return
        index = result.utterance_index
        if index is None:
            index = self._next_index
        if index in self._seen:
            return
        self._seen.add(index)
        self._next_index = max(self._next_index, index + 1)

        segment: dict[str, Any] = {
            "utteranceIndex": index,
            "text": result.text,
            "startMs": int(round(result.start_time * 1000)),
            "endMs": int(round(result.end_time * 1000)),
            "capturedAt": _utc_now_iso(),
        }
        if result.speaker_id:
            segment["speaker"] = result.speaker_id
        if result.language:
            segment["language"] = result.language
        self._pending.append(segment)
        if self._first_pending_at is None:
            self._first_pending_at = time.monotonic()
        self._ensure_ticker()
        self._wake.set()

    def _ensure_ticker(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no loop: the next explicit flush() ships it
        self._task = loop.create_task(self._run(), name=f"segment-outbox-{self._session_id}")

    async def _run(self) -> None:
        while not self._closed:
            if self._pending and self._first_pending_at is not None:
                due = time.monotonic() - self._first_pending_at >= self._flush_interval_s
                if due or len(self._pending) >= self._max_batch:
                    await self._flush(full_batches_only=not due)
                    continue
            timeout: float | None = None
            if self._pending and self._first_pending_at is not None:
                timeout = max(
                    0.0, self._first_pending_at + self._flush_interval_s - time.monotonic()
                )
            # No await between the state check above and this clear, so no add() is missed.
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=timeout)
            except TimeoutError:
                pass

    # ------------------------------------------------------------------
    # Delivery
    # ------------------------------------------------------------------

    async def flush(self) -> None:
        """Post everything pending now (pause / finalize). Never raises."""
        await self._flush(full_batches_only=False)

    async def _flush(self, *, full_batches_only: bool) -> None:
        async with self._flush_lock:
            while self._pending:
                if full_batches_only and len(self._pending) < self._max_batch:
                    break
                batch = sorted(self._pending[: self._max_batch], key=lambda s: s["utteranceIndex"])
                del self._pending[: self._max_batch]
                await self._deliver(batch)
            self._first_pending_at = time.monotonic() if self._pending else None

    def _body(self, segments: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            offset = int(self._audio_offset_ms())
        except Exception:  # noqa: BLE001 — a clock read never blocks delivery
            offset = 0
        return {
            "tenantId": self._tenant_id,
            "consultationId": self._consultation_id,
            "sttSessionId": self._session_id,
            "audioOffsetMs": offset,
            "segments": segments,
        }

    async def _deliver(self, segments: list[dict[str, Any]]) -> None:
        body = self._body(segments)
        last_error: BaseException | None = None
        for _ in range(self._inline_attempts):
            try:
                await self._post(body)
                return
            except Exception as exc:  # noqa: BLE001 — classified below
                last_error = exc
                if is_permanent_gateway_error(exc):
                    logger.error(
                        "stt.segments.permanent_drop",
                        session=redact_id(self._session_id),
                        consultation=redact_id(self._consultation_id),
                        segment_count=len(segments),
                        error_type=type(exc).__name__,
                    )
                    return
        await self._park(body, last_error)

    async def _park(self, body: dict[str, Any], last_error: BaseException | None) -> None:
        indices = [s["utteranceIndex"] for s in body["segments"]]
        field = f"{self._session_id}:{min(indices)}-{max(indices)}"
        entry = {"body": body, "attempts": 0, "lease_expiry": 0, "processing_by": None}
        try:
            await self._redis.hset(SEGMENT_OUTBOX_KEY, field, json.dumps(entry))
            self._parked.add(field)
            logger.warning(
                "stt.segments.outbox_enqueued",
                session=redact_id(self._session_id),
                segment_count=len(indices),
                error_type=type(last_error).__name__ if last_error else None,
            )
        except Exception as exc:  # noqa: BLE001 — never fail the live session
            logger.error(
                "stt.segments.outbox_enqueue_failed",
                session=redact_id(self._session_id),
                segment_count=len(indices),
                error_type=type(exc).__name__,
            )

    async def close(self) -> None:
        """Flush what is pending, re-drive this session's parked batches once, stop."""
        await self.flush()
        self._closed = True
        self._wake.set()
        task, self._task = self._task, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._parked:
            await drain_segment_outbox(
                self._redis,
                self._post,
                worker_id=f"session:{self._session_id}",
                max_attempts=None,
                only_fields=set(self._parked),
            )
            self._parked.clear()


async def drain_segment_outbox(
    redis: Any,
    post: PostSegments,
    *,
    worker_id: str,
    max_attempts: int | None,
    only_fields: set[str] | None = None,
) -> int:
    """Re-drive parked segment batches, at-least-once. Returns the number delivered.

    Called from the reaper loop (and by :meth:`SegmentOutbox.close` for its own
    entries, with ``max_attempts=None`` so a close never drops a batch). Never raises.
    """
    delivered = 0
    try:
        entries = await redis.hgetall(SEGMENT_OUTBOX_KEY)
        if not isinstance(entries, dict) or not entries:
            return 0
        now = time.time()
        for raw_field, raw_value in list(entries.items()):
            field = raw_field.decode() if isinstance(raw_field, bytes) else raw_field
            if only_fields is not None and field not in only_fields:
                continue
            value = raw_value.decode() if isinstance(raw_value, bytes) else raw_value
            try:
                entry = json.loads(value)
                body = entry["body"]
            except (ValueError, TypeError, KeyError):
                await redis.hdel(SEGMENT_OUTBOX_KEY, field)
                logger.error("stt.segments.outbox_corrupt_drop", field=redact_id(field))
                continue
            lease_expiry = entry.get("lease_expiry", 0)
            if only_fields is None and isinstance(lease_expiry, int | float) and lease_expiry > now:
                continue
            if await _redrive_entry(redis, post, field, entry, body, now, worker_id, max_attempts):
                delivered += 1
    except Exception as exc:  # noqa: BLE001
        logger.warning("stt.segments.outbox_drain_error", error_type=type(exc).__name__)
    return delivered


async def _redrive_entry(
    redis: Any,
    post: PostSegments,
    field: str,
    entry: dict[str, Any],
    body: dict[str, Any],
    now: float,
    worker_id: str,
    max_attempts: int | None,
) -> bool:
    entry["processing_by"] = worker_id
    entry["lease_expiry"] = now + LEASE_TTL_S
    try:
        await redis.hset(SEGMENT_OUTBOX_KEY, field, json.dumps(entry))
    except Exception as exc:  # noqa: BLE001
        logger.warning("stt.segments.outbox_claim_failed", error_type=type(exc).__name__)
        return False

    try:
        await post(body)
    except Exception as exc:  # noqa: BLE001 — classified below
        attempts = int(entry.get("attempts", 0)) + 1
        permanent = is_permanent_gateway_error(exc)
        exhausted = max_attempts is not None and attempts >= max_attempts
        if permanent or exhausted:
            await redis.hdel(SEGMENT_OUTBOX_KEY, field)
            logger.error(
                "stt.segments.outbox_drop",
                session=redact_id(str(body.get("sttSessionId"))),
                attempts=attempts,
                permanent=permanent,
                error_type=type(exc).__name__,
            )
            return False
        entry["attempts"] = attempts
        entry["lease_expiry"] = 0
        entry["processing_by"] = None
        await redis.hset(SEGMENT_OUTBOX_KEY, field, json.dumps(entry))
        logger.warning(
            "stt.segments.outbox_retry_deferred",
            session=redact_id(str(body.get("sttSessionId"))),
            attempts=attempts,
            error_type=type(exc).__name__,
        )
        return False

    await redis.hdel(SEGMENT_OUTBOX_KEY, field)
    logger.info(
        "stt.segments.outbox_drained",
        session=redact_id(str(body.get("sttSessionId"))),
        segment_count=len(body.get("segments") or []),
    )
    return True
