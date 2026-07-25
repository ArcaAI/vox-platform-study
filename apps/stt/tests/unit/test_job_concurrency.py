"""The batch-job concurrency ceiling is ENFORCED.

An earlier wiring attempt fed `settings.worker_threads` into `Worker(...)` inside
`worker.py:main()`. That is dead code in the shipped image: the Dockerfile runs
`python -m dramatiq stt.worker --processes 2 --threads 4`, and the dramatiq
CLI IMPORTS the module rather than executing it as `__main__`, then builds its
own Worker from its own `--threads` flag. So the operator knob reached nothing —
exactly the "wiring a dead field" failure this module exists to close.

The fix is an in-actor gate: a thread-based counterpart to `ResizableSemaphore`
that bounds jobs wherever the actor runs, under ANY launch mode.
"""

from __future__ import annotations

import threading
import time

import pytest

from stt.core.job_concurrency import (
    ResizableThreadGate,
    get_job_gate,
    reset_job_gate,
)


@pytest.fixture(autouse=True)
def _fresh_gate():
    reset_job_gate()
    yield
    reset_job_gate()


class TestSingleton:
    def test_returns_the_same_object(self) -> None:
        assert get_job_gate() is get_job_gate()

    def test_reset_replaces_it(self) -> None:
        first = get_job_gate()
        reset_job_gate()
        assert get_job_gate() is not first


class TestBoundsConcurrency:
    def test_at_most_n_jobs_run_concurrently(self) -> None:
        gate = ResizableThreadGate(3)
        peak = 0
        concurrent = 0
        counter_lock = threading.Lock()
        release = threading.Event()

        def job() -> None:
            nonlocal peak, concurrent
            with gate:
                with counter_lock:
                    concurrent += 1
                    peak = max(peak, concurrent)
                release.wait(timeout=5)
                with counter_lock:
                    concurrent -= 1

        threads = [threading.Thread(target=job) for _ in range(10)]
        for t in threads:
            t.start()

        # Let the admitted batch settle, then assert the ceiling held.
        time.sleep(0.2)
        with counter_lock:
            assert peak <= 3, f"unbounded batch concurrency: {peak} jobs at once"

        release.set()
        for t in threads:
            t.join(timeout=5)
        assert peak == 3, "the bound should actually be saturated"

    def test_every_job_eventually_runs(self) -> None:
        """Bounding must throttle, never drop."""
        gate = ResizableThreadGate(2)
        done = 0
        lock = threading.Lock()

        def job() -> None:
            nonlocal done
            with gate:
                with lock:
                    done += 1

        threads = [threading.Thread(target=job) for _ in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert done == 12

    def test_a_failing_job_releases_its_slot(self) -> None:
        gate = ResizableThreadGate(1)

        with pytest.raises(RuntimeError):
            with gate:
                raise RuntimeError("transcription exploded")

        assert gate.in_flight == 0
        with gate:  # must not deadlock
            pass


class TestResize:
    def test_shrink_never_revokes_a_running_job(self) -> None:
        gate = ResizableThreadGate(4)
        gate.acquire()
        gate.acquire()
        gate.acquire()

        gate.set_limit(1)

        assert gate.in_flight == 3, "a running transcription must never be revoked"
        assert gate.limit == 1

    def test_shrink_with_idle_capacity_binds_immediately(self) -> None:
        gate = ResizableThreadGate(4)
        gate.set_limit(1)
        gate.acquire()

        assert gate.try_acquire(timeout=0.05) is False, "the lowered ceiling must bind"

    def test_grow_admits_waiters(self) -> None:
        gate = ResizableThreadGate(1)
        gate.acquire()
        admitted = threading.Event()

        def waiter() -> None:
            with gate:
                admitted.set()

        t = threading.Thread(target=waiter)
        t.start()
        assert not admitted.wait(timeout=0.1), "should be blocked at limit=1"

        gate.set_limit(2)

        assert admitted.wait(timeout=2), "growing must wake the waiter"
        t.join(timeout=2)

    def test_set_limit_is_idempotent(self) -> None:
        gate = ResizableThreadGate(3)
        gate.acquire()
        gate.set_limit(3)
        gate.set_limit(3)

        assert (gate.limit, gate.in_flight) == (3, 1)

    @pytest.mark.parametrize("bad", [0, -2])
    def test_rejects_a_non_positive_limit(self, bad: int) -> None:
        gate = ResizableThreadGate(2)
        with pytest.raises(ValueError):
            gate.set_limit(bad)
        assert gate.limit == 2, "a rejected resize must not corrupt the limit"


class TestPerProcessScope:
    def test_documents_that_the_gate_is_per_process(self) -> None:
        """`--processes N` gives N independent gates; the docstring must say so,
        because the effective fleet ceiling is N x limit, not limit."""
        import stt.core.job_concurrency as mod

        assert "per-process" in (mod.__doc__ or "").lower()
