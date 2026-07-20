"""TASK-525 DR-7 (revised) — an ENFORCED, resizable ceiling on batch jobs.

Why this exists rather than `settings.worker_threads`
-----------------------------------------------------
The first cut of DR-7 fed the control-plane worker ceiling into
``dramatiq.Worker(worker_threads=...)`` inside ``worker.py:main()``. That is dead
code in the shipped image: the Dockerfile runs

    python3.11 -m dramatiq stt_v2.worker --processes 2 --threads 4

and the dramatiq CLI *imports* ``stt_v2.worker`` (``importlib.import_module``)
rather than executing it as ``__main__``, then builds its own Worker from its own
``--threads`` flag. So ``worker.py:main()`` never runs in production and the
operator knob reached nothing — precisely the D-07 "wiring a dead field" failure
this ticket exists to close.

This gate is acquired INSIDE the actor, so it bounds jobs under ANY launch mode:
the dramatiq CLI, ``worker.py:main()``, or a direct call in a test.

Relationship to the two other limits
------------------------------------
``--threads`` (Dockerfile) is the OUTER bound: how many jobs a process can even
attempt. This gate is the INNER, operator-adjustable bound. Setting it above
``--threads`` therefore has no effect — the thread pool runs out first.

**PER-PROCESS scope.** ``--processes N`` forks N independent interpreters, each
with its own gate, so the fleet ceiling is ``N x limit``, not ``limit`` — the same
per-process caveat as the streaming ``CapacityGuard``. A fleet-wide bound would
need a shared (Redis) counter; that is out of scope here and belongs with the
retention/limits work in TASK-529.

Threading, not asyncio: Dramatiq actors run on worker THREADS, so this mirrors
``ResizableSemaphore`` (asyncio) with a ``Condition``-based implementation. Like
that class, capacity is admitted by comparing ``in_flight`` against the CURRENT
limit on each acquire, so a shrink binds immediately for new work while never
revoking a slot a running transcription already holds.
"""

from __future__ import annotations

import threading
from types import TracebackType

import structlog

logger = structlog.get_logger(__name__)


class ResizableThreadGate:
    """A thread-based semaphore whose limit can change while jobs are running."""

    def __init__(self, limit: int) -> None:
        self._validate(limit)
        self._limit = limit
        self._in_flight = 0
        self._condition = threading.Condition()

    @staticmethod
    def _validate(limit: int) -> None:
        if limit < 1:
            raise ValueError(f"job concurrency limit must be >= 1, got {limit}")

    @property
    def limit(self) -> int:
        """The current ceiling. May be below `in_flight` right after a shrink."""
        return self._limit

    @property
    def in_flight(self) -> int:
        """Jobs currently holding a slot."""
        return self._in_flight

    def set_limit(self, limit: int) -> None:
        """Move the ceiling. Idempotent; never revokes a running job's slot."""
        self._validate(limit)
        with self._condition:
            if limit == self._limit:
                return
            previous = self._limit
            self._limit = limit
            # On a grow this releases waiters; on a shrink the predicate below
            # simply stays false until enough jobs finish.
            self._condition.notify_all()

        logger.info(
            "stt_v2.job_concurrency.resized",
            previous=previous,
            current=limit,
            in_flight=self._in_flight,
        )

    def acquire(self) -> None:
        """Block until a slot is free, then take it."""
        with self._condition:
            self._condition.wait_for(lambda: self._in_flight < self._limit)
            self._in_flight += 1

    def try_acquire(self, timeout: float) -> bool:
        """Take a slot, waiting at most `timeout` seconds. False if none freed."""
        with self._condition:
            if not self._condition.wait_for(lambda: self._in_flight < self._limit, timeout=timeout):
                return False
            self._in_flight += 1
            return True

    def release(self) -> None:
        """Return a slot and wake a waiter."""
        with self._condition:
            if self._in_flight == 0:
                raise RuntimeError("ResizableThreadGate released more times than acquired")
            self._in_flight -= 1
            self._condition.notify_all()

    def __enter__(self) -> ResizableThreadGate:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()


_job_gate: ResizableThreadGate | None = None
_gate_lock = threading.Lock()


def get_job_gate() -> ResizableThreadGate:
    """The process-wide batch-job gate, sized from the bootstrap setting."""
    global _job_gate
    with _gate_lock:
        if _job_gate is None:
            from stt_v2.core.config.settings import get_settings

            _job_gate = ResizableThreadGate(max(1, get_settings().worker_threads))
        return _job_gate


def reset_job_gate() -> None:
    """Drop the singleton (tests only)."""
    global _job_gate
    with _gate_lock:
        _job_gate = None


async def refresh_job_concurrency_limit() -> None:
    """Resize the gate from the control plane. NEVER raises.

    Called from inside the actor's event loop. The calling job already holds its
    slot, so a resize applies to SUBSEQUENT admissions — the bound converges
    monotonically rather than disturbing work in flight.
    """
    try:
        from stt_v2.core.runtime_limits import resolve_worker_concurrency

        gate = get_job_gate()
        served = await resolve_worker_concurrency(gate.limit)
        if served != gate.limit:
            gate.set_limit(served)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never fail a job
        logger.warning(
            "stt_v2.job_concurrency.refresh_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
