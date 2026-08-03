"""BUG-016 — the Dramatiq worker runs ONE event loop for the whole process.

The worker used to call `asyncio.run()` per message, so every job got its own
event loop while the objects jobs share are bound to the loop that built them.
BUG-015 fixed three such singletons one at a time; this is the root fix.

The defect that forced it: `hope_runtime_models.ModelCache` single-flights model
loads through a process-wide `_inflight: dict[str, asyncio.Future]` — the future
is created on the owner's loop (`cache.py:509`) and every other caller awaits it
via `asyncio.shield(future)` (`cache.py:518`). With a loop per message, two
concurrent jobs wanting the SAME model put the waiter on a different loop than
the future, and it dies with:

    got Future <Future pending cb=[shield.<locals>._outer_done_callback()]>
    attached to a different loop

Observed live: 3 concurrent jobs on one whisper pipeline → the owner completed,
both waiters FAILED at progress 5. Per-THREAD loops would not have fixed it
either — four live loops still cannot share one future. Only a single loop can.

Note this also makes single-flight do its job: before, concurrent jobs never
shared a load, so each would have loaded its own 1.6 GB copy of the model.
"""

import asyncio
import threading
import time

import pytest
from hope_runtime_models import ModelCache

from stt.core.worker_loop import (
    get_worker_loop,
    run_on_worker_loop,
    shutdown_worker_loop,
    worker_loop_is_running,
)


@pytest.fixture(autouse=True)
def _stop_loop():
    yield
    shutdown_worker_loop()


class TestRunOnWorkerLoop:
    def test_returns_the_coroutine_result(self) -> None:
        async def work() -> str:
            await asyncio.sleep(0)
            return "done"

        assert run_on_worker_loop(work()) == "done"

    def test_propagates_the_original_exception(self) -> None:
        class Boom(RuntimeError):
            pass

        async def work() -> None:
            raise Boom("job failed")

        # Dramatiq's retry taxonomy keys off the exception type, so the type and
        # message must survive the hop between threads.
        with pytest.raises(Boom, match="job failed"):
            run_on_worker_loop(work())

    def test_every_calling_thread_shares_one_loop(self) -> None:
        """The whole point: 4 worker threads, ONE loop."""
        seen: list[int] = []
        lock = threading.Lock()

        async def work() -> None:
            with lock:
                seen.append(id(asyncio.get_running_loop()))

        threads = [threading.Thread(target=lambda: run_on_worker_loop(work())) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)

        assert len(seen) == 4
        assert len(set(seen)) == 1, "each thread must run on the same shared loop"

    def test_shutdown_stops_the_loop_and_a_later_call_restarts_it(self) -> None:
        async def work() -> int:
            return 1

        assert run_on_worker_loop(work()) == 1
        assert worker_loop_is_running()

        shutdown_worker_loop()
        assert not worker_loop_is_running()

        # A worker that keeps consuming after a restart must not be wedged.
        assert run_on_worker_loop(work()) == 1

    def test_refuses_to_be_called_from_inside_the_worker_loop(self) -> None:
        """Submitting from the loop thread and blocking on it would deadlock."""

        async def reentrant() -> None:
            run_on_worker_loop(_noop())

        async def _noop() -> None:
            return None

        with pytest.raises(RuntimeError, match="worker loop"):
            run_on_worker_loop(reentrant())


class TestModelCacheSingleFlightRegression:
    """The reported failure, driven through the real shared-package cache."""

    def test_concurrent_threads_share_one_load(self) -> None:
        loads: list[str] = []
        started = threading.Event()
        release = threading.Event()

        async def factory(key: str) -> str:
            loads.append(key)
            started.set()
            # Hold the load open the way a 1.6 GB whisper load does.
            await asyncio.get_running_loop().run_in_executor(None, release.wait)
            return f"model:{key}"

        cache = ModelCache(factory=factory, ttl_seconds=60, max_size=4)
        results: dict[int, str] = {}
        errors: dict[int, BaseException] = {}

        def job(n: int) -> None:
            try:
                results[n] = run_on_worker_loop(cache.get("whisper-large"))
            except BaseException as exc:  # noqa: BLE001 — recorded for the assert
                errors[n] = exc

        owner = threading.Thread(target=job, args=(1,))
        owner.start()
        assert started.wait(5), "the owning load never started"

        waiter = threading.Thread(target=job, args=(2,))
        waiter.start()
        time.sleep(0.2)  # let the waiter reach `await asyncio.shield(future)`
        release.set()

        owner.join(10)
        waiter.join(10)

        assert not errors, f"cross-loop failure: {errors}"
        assert results == {1: "model:whisper-large", 2: "model:whisper-large"}
        assert loads == ["whisper-large"], "single-flight must load exactly once"


class TestWitnessOfTheOldModel:
    """Pins WHY the loop had to be shared — not just that sharing works."""

    def test_a_loop_per_message_breaks_single_flight(self) -> None:
        started = threading.Event()
        release = threading.Event()

        async def factory(key: str) -> str:
            started.set()
            await asyncio.get_running_loop().run_in_executor(None, release.wait)
            return f"model:{key}"

        cache = ModelCache(factory=factory, ttl_seconds=60, max_size=4)
        errors: dict[int, BaseException] = {}

        def job(n: int) -> None:
            try:
                asyncio.run(cache.get("whisper-large"))  # the OLD per-message model
            except BaseException as exc:  # noqa: BLE001
                errors[n] = exc

        owner = threading.Thread(target=job, args=(1,))
        owner.start()
        assert started.wait(5)

        waiter = threading.Thread(target=job, args=(2,))
        waiter.start()
        time.sleep(0.2)
        release.set()

        owner.join(10)
        waiter.join(10)

        assert 2 in errors, "expected the waiter to fail on a foreign-loop future"
        assert "attached to a different loop" in str(errors[2])


class TestWorkerLoopAccessor:
    def test_get_worker_loop_is_stable_and_running(self) -> None:
        first = get_worker_loop()
        assert first is get_worker_loop()
        assert first.is_running()
        assert not first.is_closed()


class TestWorkerInitMiddlewareUsesTheSharedLoop:
    """Boot/cleanup must run on the SAME loop the jobs will run on.

    `after_process_boot` used to call `asyncio.run(initialize_services())`, so
    the VAD / embedding / punctuation services were constructed on a throwaway
    loop that was closed before the first job ever ran. Any asyncio primitive
    they hold was bound to a dead loop from startup — the same defect as the
    per-message loops, one layer earlier.
    """

    def test_boot_initializes_on_the_worker_loop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import stt.worker as worker_module
        from stt.core.messaging.worker_init_middleware import WorkerInitMiddleware

        seen: dict[str, int] = {}

        async def fake_initialize() -> None:
            seen["loop"] = id(asyncio.get_running_loop())

        monkeypatch.setattr(worker_module, "initialize_services", fake_initialize)

        WorkerInitMiddleware().after_process_boot(broker=None)

        assert seen["loop"] == id(get_worker_loop())

    def test_shutdown_cleans_up_on_the_worker_loop_then_stops_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import stt.worker as worker_module
        from stt.core.messaging.worker_init_middleware import WorkerInitMiddleware

        seen: dict[str, int] = {}

        async def fake_cleanup() -> None:
            seen["loop"] = id(asyncio.get_running_loop())

        monkeypatch.setattr(worker_module, "cleanup_services", fake_cleanup)

        loop_id = id(get_worker_loop())
        WorkerInitMiddleware().before_worker_shutdown(broker=None, worker=None)

        assert seen["loop"] == loop_id, "cleanup must run where the services were built"
        assert not worker_loop_is_running(), "the loop must not outlive the worker"
