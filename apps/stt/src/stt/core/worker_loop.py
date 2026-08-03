"""One event loop for the whole Dramatiq worker process (BUG-016).

The worker used to call ``asyncio.run()`` inside the actor, so every message got
its own event loop. Dramatiq runs several worker THREADS, so the process held
many short-lived loops at once — while the things jobs share are bound to the
loop that created them. That mismatch produced three separate production
symptoms before the cause was named:

* a job stalled 300s on a connection pool owned by a closed loop (BUG-015);
* connection pools accumulated per job until Postgres refused connections;
* concurrent jobs wanting the SAME model died on
  ``got Future … attached to a different loop`` — ``hope_runtime_models``
  single-flights loads through a process-wide ``_inflight`` dict of futures
  (``cache.py:509``) that every other caller awaits via ``asyncio.shield``
  (``cache.py:518``).

Per-THREAD loops would not have fixed the third one: four live loops still
cannot share one future. Only a single loop can, so the worker now runs exactly
one, on its own thread, and the actor dispatches onto it.

**Why this is safe here.** The loop never does CPU work. Every blocking step —
model loading (``whisper_cpp_loader``, ``faster_whisper_loader``, …), ASR
inference (``batch_service``), weight downloads and hashing
(``source_resolver``) — already runs under ``asyncio.to_thread``. The loop only
awaits. Job concurrency is unchanged: it is still bounded by the THREAD gate the
actor holds (``core/job_concurrency.py``) and by ``--threads``.

**What it fixes beyond the crash.** Single-flight now actually works. With a loop
per message, two concurrent jobs on one pipeline could never share a load — each
would have loaded its own copy of a 1.6 GB model.
"""

import asyncio
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

import structlog

logger = structlog.get_logger(__name__)

T = TypeVar("T")

_loop: asyncio.AbstractEventLoop | None = None
_thread: threading.Thread | None = None
# Guards start/stop. Held only around bookkeeping — never while awaiting a job.
_STATE_LOCK = threading.RLock()


def _run_forever(loop: asyncio.AbstractEventLoop, ready: threading.Event) -> None:
    asyncio.set_event_loop(loop)
    loop.call_soon(ready.set)
    try:
        loop.run_forever()
    finally:
        # Drain whatever the stop left behind so the loop closes cleanly and
        # `to_thread` executors are not orphaned.
        try:
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.run_until_complete(loop.shutdown_default_executor())
        except Exception as exc:  # noqa: BLE001 — shutdown must not raise
            logger.warning(
                "stt.worker_loop.drain_error", error=str(exc), error_type=type(exc).__name__
            )
        finally:
            loop.close()


def get_worker_loop() -> asyncio.AbstractEventLoop:
    """The process-wide worker loop, started on first use."""
    global _loop, _thread

    with _STATE_LOCK:
        if _loop is not None and not _loop.is_closed():
            return _loop

        loop = asyncio.new_event_loop()
        ready = threading.Event()
        thread = threading.Thread(
            target=_run_forever,
            args=(loop, ready),
            name="stt-worker-loop",
            daemon=True,  # never let a wedged loop hold up process exit
        )
        thread.start()
        # Publish only once `run_forever` is actually consuming callbacks, so a
        # caller can never submit into a loop that is not yet running.
        ready.wait()

        _loop, _thread = loop, thread
        logger.info("stt.worker_loop.started")
        return loop


def worker_loop_is_running() -> bool:
    with _STATE_LOCK:
        return _loop is not None and not _loop.is_closed() and _loop.is_running()


def run_on_worker_loop(coro: Coroutine[Any, Any, T], timeout: float | None = None) -> T:
    """Run ``coro`` on the shared loop from a worker thread and block for it.

    The coroutine's exception propagates to the caller with its ORIGINAL type and
    traceback, which is what Dramatiq's retry taxonomy keys off.

    If the calling thread is interrupted — Dramatiq's time limit, a shutdown
    signal — the submitted coroutine is cancelled rather than left running on the
    shared loop, where it would keep touching a job nobody is waiting for.
    """
    loop = get_worker_loop()

    # `future.result()` on the loop thread would block the loop against itself.
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        coro.close()
        raise RuntimeError(
            "run_on_worker_loop() was called from inside the worker loop; "
            "await the coroutine directly instead."
        )

    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return future.result(timeout)
    except BaseException:
        future.cancel()
        raise


def shutdown_worker_loop(timeout: float = 10.0) -> None:
    """Stop the loop and join its thread. Idempotent; safe to call at exit."""
    global _loop, _thread

    with _STATE_LOCK:
        loop, thread = _loop, _thread
        _loop, _thread = None, None

    if loop is None:
        return

    if not loop.is_closed():
        loop.call_soon_threadsafe(loop.stop)
    if thread is not None and thread.is_alive():
        thread.join(timeout)
        if thread.is_alive():
            logger.warning("stt.worker_loop.shutdown_timeout", timeout=timeout)
    logger.info("stt.worker_loop.stopped")
