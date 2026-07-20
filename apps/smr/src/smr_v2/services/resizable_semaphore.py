"""TASK-525 §3.4 — a semaphore whose capacity can move at runtime.

`asyncio.Semaphore` has no public resize, and swapping the object out from under
`app.state.provider_semaphores` is unsafe: requests already holding permits on
the old object would be invisible to the new one, transiently allowing
``old_in_flight + new_limit`` concurrency, and the old object's waiters would
never see a release. So the object lives for the process's lifetime and only its
``limit`` moves.

Design note — this admits capacity by comparing ``in_flight`` against the CURRENT
limit on every acquire, rather than by tracking a shrink "deficit" against a
fixed-size inner semaphore. Same guarantees, less bookkeeping, and it also gets
the idle-shrink case right (lowering the limit while nothing is in flight binds
immediately, whereas a deficit counter would leave the already-free permits
claimable).

Guarantees:
  * A shrink NEVER revokes an in-flight permit. The bound converges downward as
    holders finish; until then the semaphore is legitimately over its limit.
  * A grow wakes exactly as many waiters as the new headroom allows.
  * Object identity is stable, so every `async with` call site is untouched.
"""

from __future__ import annotations

import asyncio
from collections import deque
from types import TracebackType


class ResizableSemaphore:
    """An asyncio semaphore whose limit can be changed while it is in use."""

    def __init__(self, limit: int) -> None:
        self._validate(limit)
        self._limit = limit
        self._in_flight = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    @staticmethod
    def _validate(limit: int) -> None:
        if limit < 1:
            raise ValueError(f"semaphore limit must be >= 1, got {limit}")

    @property
    def limit(self) -> int:
        """The current ceiling. May be below `in_flight` right after a shrink."""
        return self._limit

    @property
    def in_flight(self) -> int:
        """Permits currently held."""
        return self._in_flight

    def set_limit(self, limit: int) -> None:
        """Move the ceiling. Idempotent; never revokes an in-flight permit."""
        self._validate(limit)
        if limit == self._limit:
            return

        self._limit = limit
        # On a grow this hands the new headroom to waiters. On a shrink it is a
        # no-op: `_wake` only releases while `in_flight < limit`.
        self._wake()

    async def acquire(self) -> None:
        """Wait for capacity, then take a permit."""
        # `while`, not `if`: a woken waiter must re-check, because several
        # waiters can be woken by one grow and only some will still fit.
        while self._in_flight >= self._limit:
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            try:
                await waiter
            except asyncio.CancelledError:
                # Drop our own (possibly already-fulfilled) slot, then pass the
                # capacity on so a cancellation cannot strand the queue.
                self._discard(waiter)
                if waiter.done() and not waiter.cancelled():
                    self._wake()
                raise

        self._in_flight += 1

    def release(self) -> None:
        """Return a permit and hand the capacity to the next waiter."""
        if self._in_flight == 0:
            raise RuntimeError("ResizableSemaphore released more times than acquired")
        self._in_flight -= 1
        self._wake()

    def _wake(self) -> None:
        """Fulfil waiters while there is headroom under the current limit."""
        # `_in_flight` only rises when a woken waiter actually resumes, so cap
        # the wake-ups by the pending count as well to avoid over-waking.
        headroom = self._limit - self._in_flight
        while headroom > 0 and self._waiters:
            waiter = self._waiters.popleft()
            if waiter.done():
                continue  # already cancelled — it consumes no capacity
            waiter.set_result(None)
            headroom -= 1

    def _discard(self, waiter: asyncio.Future[None]) -> None:
        try:
            self._waiters.remove(waiter)
        except ValueError:
            pass

    async def __aenter__(self) -> ResizableSemaphore:
        await self.acquire()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
