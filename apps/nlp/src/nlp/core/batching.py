"""Coalescing micro-batcher — the primitive the 100-session target rests on.

`gliner2` exposes `batch_extract_entities` / `batch_classify_text`, which push N
texts through ONE encoder forward pass. Serving one HTTP request per pass wastes
almost all of that: an encoder pass over a batch of 8 costs far less than eight
passes of 1, because the fixed per-pass overhead (tokenisation dispatch, schema
encoding, kernel launch, Python↔torch boundary) is paid once.

`MicroBatcher` sits between the route and the runtime. Concurrent submissions
that share a GROUP — the same verb, taxonomy and threshold, i.e. everything that
would change the answer — are coalesced into one call.

Three bounds, all DECLARED rather than emergent:

===============  =========================================================
`max_batch_size` how many items may ride one forward pass
`max_queue`      beyond it, submissions are REJECTED (`InferenceQueueFull`)
`max_wait_s`     an item that waited longer is REJECTED
                 (`InferenceQueueTimeout`) instead of served stale
===============  =========================================================

Rejection is the point. An unbounded queue under overload converts a latency
problem into an out-of-memory kill and takes the safety plane down with it; a
503 at the edge is a bounded, observable, retryable failure. The route maps both
exceptions to 503 and increments `nlp_inference_rejections_total{reason}`.

FAIL-CLOSED: a batch that raises fails EVERY member with that exception. A
guard result is never fabricated, and an inference error never reads back as
"nothing found".
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, Protocol, TypeVar

import structlog

logger = structlog.get_logger(__name__)

ItemT = TypeVar("ItemT")
ResultT = TypeVar("ResultT")

# Bootstrap floors. These are TRANSPORT-shaped tuning knobs, not model or policy
# identity: the serving values come from the control plane through
# `nlp.core.config`/`effective_config`, exactly like `inference_max_concurrent`.
DEFAULT_MAX_BATCH_SIZE = 8
DEFAULT_LINGER_MS = 5
DEFAULT_MAX_QUEUE = 256
DEFAULT_MAX_WAIT_S = 20.0
DEFAULT_MAX_INFLIGHT_BATCHES = 2


class InflightGate(Protocol):
    """Whatever bounds concurrent forward passes against the underlying weights.

    Injectable because the bound belongs to the MODEL, not to the queue: once
    split the interactive and bulk lanes into two batchers over one
    weight slot, a per-batcher semaphore would let total in-flight passes
    DOUBLE, and would give the inline gate no way to overtake a bulk pass that
    is merely queued. `nlp.core.priority_gate.PriorityGate` is the shared,
    priority-ordered implementation; the default below is the single-lane one.
    """

    async def acquire(self, priority: int = ...) -> None: ...

    def release(self) -> None: ...


class _SemaphoreGate:
    """Default gate — one batcher, one bound, priority ignored."""

    def __init__(self, limit: int) -> None:
        self._semaphore = asyncio.Semaphore(limit)

    async def acquire(self, priority: int = 0) -> None:
        await self._semaphore.acquire()

    def release(self) -> None:
        self._semaphore.release()


class InferenceQueueFull(RuntimeError):
    """The bounded queue is at capacity — shed load rather than grow."""


class InferenceQueueTimeout(RuntimeError):
    """The item waited past the declared ceiling — reject rather than serve stale."""


@dataclass
class _Waiter(Generic[ItemT, ResultT]):
    group: str
    item: ItemT
    future: asyncio.Future[ResultT]
    enqueued_at: float = field(default=0.0)


class MicroBatcher(Generic[ItemT, ResultT]):
    """Coalesce same-group submissions into one `run_batch` call.

    `run_batch(group, items) -> list[O]` MUST return one result per item, in the
    same order. A length mismatch is treated as a failure for every member —
    silently zipping a short result would hand caller A caller B's answer, which
    across tenants is a data leak, not a glitch.
    """

    def __init__(
        self,
        *,
        run_batch: Callable[[str, list[ItemT]], Awaitable[list[ResultT]]],
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        linger_ms: int = DEFAULT_LINGER_MS,
        max_queue: int = DEFAULT_MAX_QUEUE,
        max_wait_s: float = DEFAULT_MAX_WAIT_S,
        max_inflight_batches: int = DEFAULT_MAX_INFLIGHT_BATCHES,
        name: str = "micro_batcher",
        on_batch: Callable[[str, int], None] | None = None,
        inflight_gate: InflightGate | None = None,
        priority: int = 0,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("max_batch_size must be >= 1")
        if max_queue < 1:
            raise ValueError("max_queue must be >= 1")
        if max_inflight_batches < 1:
            raise ValueError("max_inflight_batches must be >= 1")

        self._run_batch = run_batch
        self._max_batch_size = max_batch_size
        self._linger_s = max(linger_ms, 0) / 1000.0
        self._max_queue = max_queue
        self._max_wait_s = max_wait_s
        self._name = name
        self._on_batch = on_batch

        self._pending: deque[_Waiter[ItemT, ResultT]] = deque()
        self._arrival = asyncio.Event()
        # A SHARED gate (one per weight slot) when the caller supplies one, so
        # the two lanes bound the model rather than each bounding themselves.
        self._inflight: InflightGate = inflight_gate or _SemaphoreGate(max_inflight_batches)
        self._priority = priority
        self._dispatcher: asyncio.Task[None] | None = None
        self._running_batches: set[asyncio.Task[None]] = set()
        self._closed = False

    # ── observability ────────────────────────────────────────────────────

    @property
    def queue_depth(self) -> int:
        """Items waiting for a forward pass (excludes in-flight batches)."""
        return len(self._pending)

    @property
    def name(self) -> str:
        return self._name

    # ── submission ───────────────────────────────────────────────────────

    async def submit(self, group: str, item: ItemT) -> ResultT:
        """Enqueue one item and await its own result.

        Raises `InferenceQueueFull` immediately when the queue is at capacity,
        and `InferenceQueueTimeout` if the item is still waiting when the
        dispatcher reaches it past `max_wait_s`.
        """
        if self._closed:
            raise RuntimeError(f"{self._name} is closed")
        if len(self._pending) >= self._max_queue:
            raise InferenceQueueFull(
                f"{self._name}: inference queue full ({self._max_queue} waiting)"
            )

        loop = asyncio.get_running_loop()
        waiter: _Waiter[ItemT, ResultT] = _Waiter(
            group=group, item=item, future=loop.create_future(), enqueued_at=loop.time()
        )
        self._pending.append(waiter)
        self._arrival.set()
        self._ensure_dispatcher()
        return await waiter.future

    def _ensure_dispatcher(self) -> None:
        if self._dispatcher is None or self._dispatcher.done():
            self._dispatcher = asyncio.get_running_loop().create_task(self._dispatch_loop())

    # ── dispatch ─────────────────────────────────────────────────────────

    async def _dispatch_loop(self) -> None:
        while not self._closed:
            if not self._pending:
                self._arrival.clear()
                try:
                    await self._arrival.wait()
                except asyncio.CancelledError:
                    return
                continue

            # Linger briefly so requests that arrive within the window join the
            # SAME pass. The window is the entire latency cost of batching, so
            # it is small and explicit rather than "however long the loop takes".
            if self._linger_s and len(self._pending) < self._max_batch_size:
                await asyncio.sleep(self._linger_s)

            # Take the in-flight permit BEFORE removing items from the queue.
            # The other order looks equivalent and is not: a batch that has been
            # dequeued but is waiting for a permit is invisible to
            # `queue_depth` AND immune to the `max_wait_s` ceiling, so under
            # exactly the overload these bounds exist for, items would sit
            # unbounded in a blind spot and then be served stale.
            await self._inflight.acquire(self._priority)
            batch = self._take_batch()
            if not batch:
                self._inflight.release()
                continue

            task = asyncio.get_running_loop().create_task(self._run(batch))
            self._running_batches.add(task)
            task.add_done_callback(self._running_batches.discard)

    def _take_batch(self) -> list[_Waiter[ItemT, ResultT]]:
        """Pull up to `max_batch_size` items of the OLDEST waiting group.

        Items of other groups keep their queue position, so a busy group cannot
        starve a quiet one out of order — the next pass takes whatever is oldest
        at that moment.
        """
        loop = asyncio.get_running_loop()
        now = loop.time()

        # Expire first: an item past the ceiling must be rejected, not batched.
        self._reject_expired(now)
        if not self._pending:
            return []

        group = self._pending[0].group
        batch: list[_Waiter[ItemT, ResultT]] = []
        keep: deque[_Waiter[ItemT, ResultT]] = deque()
        while self._pending:
            waiter = self._pending.popleft()
            if waiter.group == group and len(batch) < self._max_batch_size:
                batch.append(waiter)
            else:
                keep.append(waiter)
        keep.extend(self._pending)
        self._pending = keep
        return batch

    def _reject_expired(self, now: float) -> None:
        if self._max_wait_s <= 0:
            return
        survivors: deque[_Waiter[ItemT, ResultT]] = deque()
        for waiter in self._pending:
            if now - waiter.enqueued_at > self._max_wait_s:
                self._fail(
                    waiter,
                    InferenceQueueTimeout(
                        f"{self._name}: waited {now - waiter.enqueued_at:.2f}s, "
                        f"ceiling is {self._max_wait_s:.2f}s"
                    ),
                )
            else:
                survivors.append(waiter)
        self._pending = survivors

    async def _run(self, batch: list[_Waiter[ItemT, ResultT]]) -> None:
        group = batch[0].group
        try:
            if self._on_batch is not None:
                self._on_batch(group, len(batch))
            results = await self._run_batch(group, [w.item for w in batch])
            if len(results) != len(batch):
                # NEVER zip a short result onto the waiters: caller A would
                # receive caller B's answer. Fail the whole pass instead.
                raise RuntimeError(
                    f"{self._name}: batch returned {len(results)} results "
                    f"for {len(batch)} items"
                )
        except Exception as exc:  # noqa: BLE001 — fail EVERY member, fabricate nothing
            for waiter in batch:
                self._fail(waiter, exc)
        else:
            for waiter, result in zip(batch, results, strict=True):
                if not waiter.future.done():
                    waiter.future.set_result(result)
        finally:
            self._inflight.release()

    @staticmethod
    def _fail(waiter: _Waiter[Any, Any], exc: BaseException) -> None:
        if not waiter.future.done():
            waiter.future.set_exception(exc)

    # ── shutdown ─────────────────────────────────────────────────────────

    async def aclose(self) -> None:
        """Stop the dispatcher and fail anything still waiting (never hang)."""
        self._closed = True
        self._arrival.set()
        if self._dispatcher is not None:
            self._dispatcher.cancel()
            try:
                await self._dispatcher
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._dispatcher = None
        for task in list(self._running_batches):
            try:
                await task
            except Exception:  # noqa: BLE001
                pass
        while self._pending:
            self._fail(self._pending.popleft(), RuntimeError(f"{self._name} closed"))
