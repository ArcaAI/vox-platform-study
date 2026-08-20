"""Priority-ordered execution permit for one weight slot (TASK-782).

TASK-778 gave every batcher its own in-flight semaphore. That is right while
there is ONE queue per model, and wrong the moment there are two: the
synchronous inline gate and the asynchronous per-utterance redaction pass have
different latency budgets but drive the SAME tensor graph, so a bulk pass that
is already running blocks an inline pass no matter how short the inline queue
is. Separate queues remove queueing delay; only a shared, priority-ordered
permit removes head-of-line blocking at the model itself.

`PriorityGate` is that permit. It bounds concurrent forward passes against one
weight slot exactly as the semaphore did, and when passes compete for a free
permit it hands it to the LOWEST `priority` value first.

Two properties worth stating because they are easy to lose:

* **Within a priority, order is FIFO.** Priority reorders across lanes; it never
  reorders a lane against itself, so a busy interactive lane cannot starve its
  own older requests.
* **A permit is handed OVER, not re-counted.** `release()` transfers the permit
  directly to the chosen waiter rather than decrementing and letting anyone race
  for it, so a bulk waiter cannot slip in between a release and an interactive
  wake-up.

This is deliberately NOT pre-emption: a bulk pass already executing runs to
completion. The bulk lane's `max_batch_size` is therefore a latency bound on the
interactive lane, and that coupling is measured and recorded in the ticket
rather than hidden.
"""

from __future__ import annotations

import asyncio
import heapq

__all__ = ["PriorityGate", "PRIORITY_INTERACTIVE", "PRIORITY_BULK"]

# Lower value = served first. Named rather than numeric at the call sites so a
# future third class does not have to renumber the existing two.
PRIORITY_INTERACTIVE = 0
PRIORITY_BULK = 10


class PriorityGate:
    """Bound concurrent forward passes against one weight slot, priority-first."""

    def __init__(self, limit: int) -> None:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        self._limit = limit
        self._held = 0
        self._seq = 0
        # Heap of (priority, arrival_sequence, future). The sequence is the FIFO
        # tie-break AND makes the tuples orderable without comparing futures.
        self._waiters: list[tuple[int, int, asyncio.Future[None]]] = []

    @property
    def held(self) -> int:
        """Permits currently out — i.e. forward passes in flight."""
        return self._held

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    async def acquire(self, priority: int = PRIORITY_BULK) -> None:
        """Take a permit, waiting behind higher-priority claimants if needed."""
        if self._held < self._limit and not self._waiters:
            self._held += 1
            return

        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        heapq.heappush(self._waiters, (priority, self._seq, future))
        self._seq += 1
        try:
            await future
        except asyncio.CancelledError:
            # A client that disconnected between the grant and the resume still
            # HOLDS the permit at this point — the release below is what keeps a
            # cancellation from permanently shrinking the model's capacity.
            if future.done() and not future.cancelled():
                self.release()
            raise

    def release(self) -> None:
        """Return a permit, handing it straight to the best waiter if any."""
        if self._held <= 0:
            raise RuntimeError("PriorityGate.release() called with no permit held")
        while self._waiters:
            _priority, _seq, future = heapq.heappop(self._waiters)
            if future.cancelled() or future.done():
                continue  # a waiter that went away; its permit was never handed over
            future.set_result(None)  # transfer: `_held` deliberately unchanged
            return
        self._held -= 1
