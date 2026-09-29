"""TASK-1009 — cross-stream batch scheduler for a shared ASR model.

Every realtime session decodes its own windows, and until this module each
decode was its own call into the engine: N sessions on one model meant N
serial encoder passes (TASK-1007 F-1 — the throughput ceiling that breaks
first). A batching engine (CTranslate2) can run those N windows through the
encoder and decoder as ONE batch, for far less than N times the cost — but only
if something collects them. This is that something.

Shape
-----
One ``CrossStreamBatcher`` per LOADED MODEL, shared by every session using it.
A caller :meth:`~CrossStreamBatcher.submit`\\ s a ``(key, payload)`` and gets a
``concurrent.futures.Future``. A single flusher thread per batcher:

* groups pending requests by ``key`` — requests whose decode parameters differ
  (task, language, decode knobs) are NEVER mixed into one decode, because a
  batched decode takes ONE set of parameters and mixing would silently hand a
  session another session's settings;
* flushes a group the moment it holds ``max_batch_size`` requests, or once its
  OLDEST request has waited ``max_wait_ms`` — so a lone stream pays at most
  ``max_wait_ms`` of extra latency and a busy model fills batches for free
  while the previous batch decodes;
* runs ``decode_batch(key, payloads)`` with the lock released, then fans each
  result back to its own future.

Batches run one at a time per model, on purpose: they share one device, and a
second concurrent batch would only contend with the first.

Failure isolation
-----------------
``decode_batch`` returns one entry per payload; an entry that is an exception
fails only that caller. If the batched call ITSELF raises (or returns the wrong
number of results), a single malformed request must not take its batch-mates
down with it, so each request is re-decoded on its own and only the ones that
still fail see an error. That retry costs nothing on the happy path.

The queue is bounded: :meth:`submit` raises :class:`BatchQueueFullError`
immediately when ``max_queue`` requests are already waiting, rather than
growing a backlog that no session will live to read. Admission control belongs
to the session tier (``CapacityGuard``); this bound is the last-resort guard.

Engine-agnostic: nothing here knows about Whisper. The faster-whisper decode
lives in :mod:`stt.streaming.faster_whisper_batch_decoder`.
"""

from __future__ import annotations

import concurrent.futures
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Hashable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

logger = structlog.get_logger(__name__)

DecodeBatch = Callable[[Any, list[Any]], Sequence[Any]]


class BatchQueueFullError(RuntimeError):
    """Raised by :meth:`CrossStreamBatcher.submit` when the queue is at capacity."""


class BatchObserver(Protocol):
    """Metric hooks. Called from the flusher thread; must not raise or block."""

    def batch_decoded(self, *, size: int, queue_waits_s: list[float], decode_s: float) -> None:
        """One batched decode finished: its size, each item's queue wait, its wall time."""

    def queue_depth(self, depth: int) -> None:
        """The number of requests waiting (not yet in a running batch)."""


@dataclass
class _Request:
    payload: Any
    future: concurrent.futures.Future
    enqueued_at: float


@dataclass
class _Group:
    requests: deque[_Request] = field(default_factory=deque)


def _validate_limits(max_batch_size: int, max_wait_ms: float, max_queue: int) -> None:
    if isinstance(max_batch_size, bool) or not isinstance(max_batch_size, int):
        raise ValueError(f"max_batch_size must be an int, got {max_batch_size!r}")
    if max_batch_size < 1:
        raise ValueError(f"max_batch_size must be >= 1, got {max_batch_size}")
    if isinstance(max_wait_ms, bool) or not isinstance(max_wait_ms, (int, float)):
        raise ValueError(f"max_wait_ms must be a number, got {max_wait_ms!r}")
    if max_wait_ms < 0:
        raise ValueError(f"max_wait_ms must be >= 0, got {max_wait_ms}")
    if isinstance(max_queue, bool) or not isinstance(max_queue, int):
        raise ValueError(f"max_queue must be an int, got {max_queue!r}")
    if max_queue < 1:
        raise ValueError(f"max_queue must be >= 1, got {max_queue}")


class CrossStreamBatcher:
    """Collects decode requests across sessions and runs them as batches.

    Parameters
    ----------
    decode_batch:
        ``(key, payloads) -> results`` — one result per payload, in order; an
        entry may be an exception instance to fail that one caller.
    max_batch_size / max_wait_ms / max_queue:
        Flush and bound limits; see the module docstring. Changeable at runtime
        through :meth:`configure`.
    name:
        Label for logs (the model slug).
    observer:
        Optional :class:`BatchObserver` for metrics.
    """

    def __init__(
        self,
        decode_batch: DecodeBatch,
        *,
        max_batch_size: int,
        max_wait_ms: float,
        max_queue: int,
        name: str = "",
        observer: BatchObserver | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        _validate_limits(max_batch_size, max_wait_ms, max_queue)
        self._decode_batch = decode_batch
        self._max_batch_size = max_batch_size
        self._max_wait_s = float(max_wait_ms) / 1000.0
        self._max_queue = max_queue
        self._name = name
        self._observer = observer
        self._clock = clock

        self._cond = threading.Condition()
        # Insertion-ordered so, among groups that are equally due, the one that
        # started waiting first is served first.
        self._groups: OrderedDict[Hashable, _Group] = OrderedDict()
        self._depth = 0
        self._closed = False
        self._thread: threading.Thread | None = None

    # ── public API ──────────────────────────────────────────────────────────

    @property
    def queue_depth(self) -> int:
        """Requests waiting for a batch (excludes the batch currently decoding)."""
        with self._cond:
            return self._depth

    def configure(self, *, max_batch_size: int, max_wait_ms: float, max_queue: int) -> None:
        """Replace the limits; applies to every flush decided after the call."""
        _validate_limits(max_batch_size, max_wait_ms, max_queue)
        with self._cond:
            self._max_batch_size = max_batch_size
            self._max_wait_s = float(max_wait_ms) / 1000.0
            self._max_queue = max_queue
            self._cond.notify_all()

    def submit(self, key: Hashable, payload: Any) -> concurrent.futures.Future:
        """Queue one decode request. Never blocks on the decode itself.

        Raises
        ------
        BatchQueueFullError
            ``max_queue`` requests are already waiting.
        RuntimeError
            The batcher was closed.
        """
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._cond:
            if self._closed:
                raise RuntimeError(f"cross-stream batcher {self._name!r} is closed")
            if self._depth >= self._max_queue:
                raise BatchQueueFullError(
                    f"cross-stream batcher {self._name!r} queue is full "
                    f"({self._depth}/{self._max_queue})"
                )
            group = self._groups.get(key)
            if group is None:
                group = _Group()
                self._groups[key] = group
            group.requests.append(_Request(payload, future, self._clock()))
            self._depth += 1
            self._ensure_thread_locked()
            self._report_depth_locked()
            self._cond.notify_all()
        return future

    def close(self, timeout: float | None = None) -> None:
        """Stop the flusher. A batch already decoding completes; waiting requests fail."""
        with self._cond:
            if self._closed:
                thread = self._thread
            else:
                self._closed = True
                abandoned = [r for g in self._groups.values() for r in g.requests]
                self._groups.clear()
                self._depth = 0
                self._cond.notify_all()
                thread = self._thread
                for request in abandoned:
                    if request.future.set_running_or_notify_cancel():
                        request.future.set_exception(
                            RuntimeError(f"cross-stream batcher {self._name!r} closed")
                        )
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)

    # ── flusher ─────────────────────────────────────────────────────────────

    def _ensure_thread_locked(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._run,
                name=f"cross-stream-batcher:{self._name}",
                daemon=True,
            )
            self._thread.start()

    def _report_depth_locked(self) -> None:
        if self._observer is None:
            return
        try:
            self._observer.queue_depth(self._depth)
        except Exception:  # noqa: BLE001 — metrics must never break decoding
            pass

    def _next_batch_locked(self) -> tuple[Hashable, list[_Request]] | None:
        """Return a batch that is due now, or ``None`` after waiting for one."""
        now = self._clock()
        due_key: Hashable | None = None
        earliest_deadline: float | None = None
        for key, group in self._groups.items():
            if not group.requests:
                continue
            if len(group.requests) >= self._max_batch_size:
                due_key = key
                break
            deadline = group.requests[0].enqueued_at + self._max_wait_s
            if deadline <= now:
                due_key = key
                break
            if earliest_deadline is None or deadline < earliest_deadline:
                earliest_deadline = deadline

        if due_key is None:
            timeout = None if earliest_deadline is None else max(0.0, earliest_deadline - now)
            self._cond.wait(timeout)
            return None

        group = self._groups[due_key]
        batch: list[_Request] = []
        while group.requests and len(batch) < self._max_batch_size:
            request = group.requests.popleft()
            self._depth -= 1
            # A caller that gave up (its session closed) is not decoded at all.
            if request.future.set_running_or_notify_cancel():
                batch.append(request)
        if not group.requests:
            del self._groups[due_key]
        self._report_depth_locked()
        if not batch:
            return None
        return due_key, batch

    def _run(self) -> None:
        while True:
            with self._cond:
                if self._closed:
                    return
                picked = self._next_batch_locked()
            if picked is not None:
                self._decode(*picked)

    def _decode(self, key: Hashable, batch: list[_Request]) -> None:
        started = self._clock()
        queue_waits = [max(0.0, started - r.enqueued_at) for r in batch]
        payloads = [r.payload for r in batch]
        try:
            results = list(self._decode_batch(key, payloads))
            if len(results) != len(batch):
                raise RuntimeError(
                    f"decode_batch returned {len(results)} results for {len(batch)} requests"
                )
        except Exception as exc:  # noqa: BLE001 — isolated per request below
            if len(batch) == 1:
                results = [exc]
            else:
                logger.warning(
                    "stt.asr_batch.batch_failed_retrying_singly",
                    model=self._name,
                    size=len(batch),
                    error=str(exc),
                )
                results = [self._decode_one(key, r.payload) for r in batch]
        decode_s = max(0.0, self._clock() - started)

        for request, result in zip(batch, results, strict=True):
            if isinstance(result, BaseException):
                request.future.set_exception(result)
            else:
                request.future.set_result(result)

        if self._observer is not None:
            try:
                self._observer.batch_decoded(
                    size=len(batch), queue_waits_s=queue_waits, decode_s=decode_s
                )
            except Exception:  # noqa: BLE001 — metrics must never break decoding
                pass

    def _decode_one(self, key: Hashable, payload: Any) -> Any:
        try:
            results = list(self._decode_batch(key, [payload]))
        except Exception as exc:  # noqa: BLE001 — returned as this caller's error
            return exc
        if len(results) != 1:
            return RuntimeError(f"decode_batch returned {len(results)} results for 1 request")
        return results[0]
