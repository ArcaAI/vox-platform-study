"""Admission control — bounded concurrency with DECLARED backpressure.

Guardrail is on the critical path of every generation and fails CLOSED, so a
guardrail that saturates is a denial of *generation* for every tenant. Before
TASK-777 there was no bound anywhere: load arrived at `apps/text` and `apps/nlp`
exactly as fast as clients offered it, and the only "limit" was the httpx pool —
which, with no pool timeout, expressed itself as an unbounded wait rather than a
refusal.

Two rules this module exists to enforce:

1. **Never an unbounded `gather`.** A caller-supplied batch is fanned out through
   :meth:`AdmissionGate.map`, which is bounded by the same semaphore as everything
   else, so one large request cannot consume the whole service.
2. **Backpressure is DECLARED, not implicit.** Past the queue-wait ceiling the
   caller is TOLD — :class:`AdmissionRejected`, mapped to HTTP 503 with
   `Retry-After` — rather than parked behind an unbounded queue that turns a
   throughput problem into a latency problem and then into a timeout storm.

A rejection is emphatically NOT a fail-open: nothing was checked, so nothing is
reported safe. 503 is the same status an undetermined verdict already uses, and
`apps/text` already treats it as retryable rather than as a content rejection.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from typing import TypeVar, cast

from guardrail.core.metrics import (
    observe_admission_wait,
    record_admission_rejection,
    set_queue_depth,
    set_requests_in_flight,
)

T = TypeVar("T")
R = TypeVar("R")


class AdmissionRejected(RuntimeError):
    """The service is at capacity and declined to queue this work any longer."""

    def __init__(self, gate: str, waited_s: float, retry_after_s: float) -> None:
        self.gate = gate
        self.waited_s = waited_s
        self.retry_after_s = retry_after_s
        super().__init__(
            f"guardrail gate {gate!r} is saturated: waited {waited_s:.3f}s for "
            f"admission (ceiling exceeded) — retry after {retry_after_s:.0f}s"
        )


class AdmissionGate:
    """A named semaphore with a queue-wait ceiling and observable depth."""

    def __init__(
        self,
        *,
        name: str,
        max_concurrent: int,
        max_wait_s: float,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        self.name = name
        self.max_concurrent = max_concurrent
        self.max_wait_s = max_wait_s
        self._sem = asyncio.Semaphore(max_concurrent)
        self._time = time_func
        self.in_flight = 0
        self.queue_depth = 0
        self.rejections = 0

    def _publish(self) -> None:
        set_requests_in_flight(self.name, self.in_flight)
        set_queue_depth(self.name, self.queue_depth)

    @asynccontextmanager
    async def admit(self) -> AsyncIterator[None]:
        """Hold one admission slot for the duration of the block.

        Waits at most ``max_wait_s`` for a slot; past that the work is REFUSED.
        """
        started = self._time()
        self.queue_depth += 1
        self._publish()
        try:
            await asyncio.wait_for(self._sem.acquire(), timeout=self.max_wait_s)
        except TimeoutError as exc:
            self.rejections += 1
            record_admission_rejection(self.name)
            waited = self._time() - started
            raise AdmissionRejected(
                self.name,
                waited,
                # A retry hint the caller can act on: one queue-wait window is the
                # shortest interval after which capacity could plausibly exist.
                retry_after_s=max(1.0, round(self.max_wait_s)),
            ) from exc
        finally:
            self.queue_depth -= 1
            self._publish()

        observe_admission_wait(self.name, self._time() - started)
        self.in_flight += 1
        self._publish()
        try:
            yield
        finally:
            self.in_flight -= 1
            self._sem.release()
            self._publish()

    async def map(
        self,
        work: Callable[[T], Awaitable[R]],
        items: Iterable[T],
        *,
        return_exceptions: bool = False,
    ) -> list[R]:
        """Run ``work`` over ``items`` bounded by this gate, preserving order.

        The replacement for a bare ``asyncio.gather`` over a caller-supplied list.
        """

        async def _one(item: T) -> R:
            async with self.admit():
                return await work(item)

        gathered = await asyncio.gather(
            *(_one(item) for item in items), return_exceptions=return_exceptions
        )
        # `return_exceptions=True` widens the element type to `R | BaseException`;
        # callers that ask for it handle both, per-element (that IS the point of a
        # batch multiplex), so the cast is the honest spelling.
        return cast("list[R]", list(gathered))
