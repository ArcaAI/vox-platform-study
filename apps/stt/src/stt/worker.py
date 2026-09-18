"""STT Service - Dramatiq Worker Entry Point.

This module configures and starts Dramatiq workers for processing
transcription jobs from the Redis message queue.

Worker architecture for 100+ concurrent users:
- Dramatiq processes: one per CPU core (CPU inference) or per GPU
- Dramatiq threads: 2–4 per process (low for CPU-bound ML work)
- ProcessPoolExecutor: optional in-process parallelism for lightweight tasks
- VAD service: Silero ONNX loaded once per worker process (single-threaded CPU)
- Speaker tracking: in-memory, session-scoped (no external vector store)
- Diarization model: pyannote loaded once per worker process (GPU if available)

Usage:
    # Via entry point (recommended):
    stt-worker

    # Via dramatiq CLI (alternative):
    dramatiq stt.worker

    # Via Python module:
    python -m stt.worker
"""

import asyncio
import os
import signal
import threading
import time
from collections.abc import Callable
from pathlib import Path
from types import FrameType
from typing import Any

import dramatiq
import httpx
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration
from hope_obs import configure_worker_observability
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from stt.core.config.settings import get_settings
from stt.core.logging import get_logger
from stt.core.messaging.broker import configure_broker
from stt.core.telemetry import build_observability_config

settings = get_settings()

# F-04: installs the SAME logging chain as the API AND a real TracerProvider
# (`hope_obs.runtime.worker_service_name` applies the no-double-suffix rule —
# a worker Deployment that already names itself `hope-stt-v2-worker` via
# `OTEL_SERVICE_NAME` is not mangled into `…-worker-worker`). Before this the
# worker only exported logs: every span it opened was non-recording, so a
# batch transcription could never be joined to the request that enqueued it.
_worker_observability = configure_worker_observability(build_observability_config(settings))
logger = get_logger(__name__)

# Configure the Dramatiq broker FIRST (before importing actors)
broker = configure_broker(settings.redis_url)

# Import actors to register them with the broker
# These imports MUST happen after broker configuration
from stt.transcription.workers import transcribe_file  # noqa: E402, F401

# ── Liveness heartbeat (TASK-990 F10) ───────────────────────────────────────
#
# WHERE THIS RUNS, AND WHY IT IS NOT IN `main()`
#
# The image runs `python -m dramatiq stt.worker` (docker/Dockerfile, worker
# stage), NOT `stt.worker.main()`. The dramatiq CLI forks `--processes N`
# children; each child IMPORTS this module, builds its own `Worker`, and calls
# `worker.start()`. Anything started inside `main()` therefore never runs in the
# deployed container. The heartbeat is installed as broker middleware at module
# import instead, and started from `after_worker_boot` — so it runs under the
# CLI *and* under `main()`, from inside each worker process.
#
# WHAT THE OLD PROBE PROVED (nothing useful)
#
# The manifest probes :9191 — dramatiq's Prometheus exposition server, which the
# CLI runs in a SEPARATE forked process from the workers. A `tcpSocket :9191`
# check is green while every worker process is wedged.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT
#
# The probe reads the file's MTIME (`find <dir> -type f -mmin -1`), so the file
# must be REWRITTEN each tick; a probe that merely checked existence would pass
# forever after the first write. A fresh file proves, for THIS process:
#   * the process exists and its interpreter is still scheduling threads — a
#     hard deadlock, a GIL held forever inside a C extension (ONNX/CUDA), a
#     SIGSTOP or a frozen container all stop the touch;
#   * no ConsumerThread or WorkerThread has exited (checked every tick, against
#     the live sets — consumers are added lazily as queues are declared);
#   * the process is not wedged in the one sense we can honestly detect: EVERY
#     worker thread in-flight on a message for longer than `stall_after_s`.
#
# It does NOT prove messages are flowing. An idle queue is the normal state, so
# requiring progress would restart a healthy worker every time the queue drains;
# and a ConsumerThread blocked forever inside a socket read still reports
# `is_alive()`. The stall rule is the honest middle ground: it fires only when
# no further progress is POSSIBLE in this process.
#
# The stall rule is deliberately ALL threads, not any. `stall_after_s` defaults
# to twice the job time limit (`TimeLimit(transcription_timeout_seconds)`), so a
# thread that trips it has already outlived the interrupt dramatiq raises to
# stop it — which is exactly the case TimeLimit cannot recover from, because the
# interrupt cannot land while the thread is inside a C extension. Killing the
# pod then loses nothing: those messages are past their limit and are redelivered.
# Withholding on ONE stuck thread would restart a pod whose other threads are
# still completing jobs.
#
# One file PER PROCESS, named after the PID. With `--processes N` a single
# shared file lets one healthy fork mask a hung sibling — the exact hole this
# closes. The probe must therefore require that EVERY file is fresh (command in
# `docker/Dockerfile`, worker stage). A fork that DIES needs no heartbeat: the
# dramatiq master shuts the whole container down when a child exits unexpectedly.
#
# Interval is 15s against a 60s probe window (the harness Temporal worker's
# numbers — apps/harness/src/harness/temporal/worker.py), so three consecutive
# misses are needed before a restart and one slow tick under load is survivable.
HEARTBEAT_DIR = Path("/tmp/stt-worker-heartbeat")  # noqa: S108 - container-local, not shared


class WorkerHeartbeatSettings(BaseSettings):
    """Liveness knobs. Defaults must be WORKING defaults.

    Per-concern `BaseSettings` with an explicit `env_prefix`, the pattern
    06-python-services.md §Configuration prescribes. This is a container-local
    liveness mechanism — not an engine, model, endpoint or credential — so
    defaults here are correct and are not the hardcoded-configuration smell that
    rule forbids: an unset variable must never silently disable the probe.
    """

    model_config = SettingsConfigDict(env_prefix="STT_WORKER_HEARTBEAT_", extra="ignore")

    directory: Path = Field(
        default=HEARTBEAT_DIR,
        description="Directory holding one heartbeat file per worker process, named by PID.",
    )
    interval_s: float = Field(
        default=15.0,
        gt=0,
        description="Seconds between heartbeat writes. Must divide the probe window at least 3x.",
    )
    stall_after_s: float = Field(
        default_factory=lambda: float(get_settings().transcription_timeout_seconds * 2),
        gt=0,
        description=(
            "Withhold the heartbeat once EVERY worker thread has been in-flight this long. "
            "Defaults to twice the job time limit, so only work that outlived its own "
            "TimeLimit interrupt counts as wedged."
        ),
    )


class WorkerHeartbeat:
    """Touches one file per worker process while that process can still progress."""

    def __init__(
        self,
        worker: Any,
        *,
        directory: Path,
        interval_s: float,
        stall_after_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._worker = worker
        self.path = Path(directory) / str(os.getpid())
        self._interval_s = interval_s
        self._stall_after_s = stall_after_s
        self._clock = clock
        self._in_flight: dict[int, float] = {}
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._withheld = False

    # -- dramatiq message hooks ---------------------------------------------

    def message_started(self, ident: int | None = None) -> None:
        with self._lock:
            self._in_flight[ident if ident is not None else threading.get_ident()] = self._clock()

    def message_finished(self, ident: int | None = None) -> None:
        with self._lock:
            self._in_flight.pop(ident if ident is not None else threading.get_ident(), None)

    @property
    def in_flight_count(self) -> int:
        with self._lock:
            return len(self._in_flight)

    # -- liveness -----------------------------------------------------------

    def _dead_threads(self) -> list[str]:
        """Re-read the live sets every tick: consumers are added as queues are declared."""
        dead = [
            f"consumer:{name}"
            for name, thread in dict(getattr(self._worker, "consumers", {})).items()
            if not thread.is_alive()
        ]
        dead += [
            f"worker:{index}"
            for index, thread in enumerate(list(getattr(self._worker, "workers", [])))
            if not thread.is_alive()
        ]
        return dead

    def _is_wedged(self) -> bool:
        worker_threads = len(list(getattr(self._worker, "workers", [])))
        if worker_threads == 0:
            return False

        now = self._clock()
        with self._lock:
            started = list(self._in_flight.values())

        if len(started) < worker_threads:
            return False  # at least one thread is free to pick up the next message
        return all(now - start >= self._stall_after_s for start in started)

    def tick(self) -> bool:
        """One iteration. Returns whether the heartbeat was written. Never raises."""
        dead = self._dead_threads()
        if dead:
            self._withhold("thread_exited", threads=dead)
            return False

        if self._is_wedged():
            self._withhold("all_worker_threads_stalled", stall_after_s=self._stall_after_s)
            return False

        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.touch()
        except OSError as exc:  # pragma: no cover - defensive
            # Never raise: a heartbeat write failure must not take down a worker
            # that is otherwise processing correctly. A persistent failure ages
            # the file out and restarts the pod, which is the intended outcome.
            self._withhold("write_failed", error=str(exc))
            return False

        if self._withheld:
            logger.info("stt.worker.heartbeat_resumed", path=str(self.path))
            self._withheld = False
        return True

    def _withhold(self, reason: str, **fields: Any) -> None:
        """Log the transition only — a withheld tick repeats every interval."""
        if not self._withheld:
            logger.error(
                "stt.worker.heartbeat_withheld", reason=reason, path=str(self.path), **fields
            )
            self._withheld = True

    def run(self) -> None:
        """Write, THEN wait — otherwise the probe races the first interval at startup."""
        while not self._stop_event.is_set():
            self.tick()
            self._stop_event.wait(self._interval_s)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self.run, name="stt-worker-heartbeat", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop ticking and remove the file: a lingering process must not look live."""
        self._stop_event.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=self._interval_s + 5.0)
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:  # pragma: no cover - defensive
            logger.warning("stt.worker.heartbeat_cleanup_failed", error=str(exc))


class WorkerHeartbeatMiddleware(dramatiq.Middleware):
    """Starts the heartbeat inside every worker process and feeds it message events."""

    def __init__(self, settings: WorkerHeartbeatSettings | None = None) -> None:
        self._settings = settings or WorkerHeartbeatSettings()
        self.heartbeat: WorkerHeartbeat | None = None

    def after_worker_boot(self, broker: Any, worker: Any) -> None:
        self.heartbeat = WorkerHeartbeat(
            worker,
            directory=self._settings.directory,
            interval_s=self._settings.interval_s,
            stall_after_s=self._settings.stall_after_s,
        )
        self.heartbeat.start()
        logger.info(
            "stt.worker.heartbeat_started",
            path=str(self.heartbeat.path),
            interval_s=self._settings.interval_s,
            stall_after_s=self._settings.stall_after_s,
        )

    def before_worker_shutdown(self, broker: Any, worker: Any) -> None:
        if self.heartbeat is not None:
            self.heartbeat.stop()
            self.heartbeat = None

    def before_process_message(self, broker: Any, message: Any) -> None:
        if self.heartbeat is not None:
            self.heartbeat.message_started()

    def after_process_message(
        self, broker: Any, message: Any, *, result: Any = None, exception: Any = None
    ) -> None:
        if self.heartbeat is not None:
            self.heartbeat.message_finished()

    def after_skip_message(self, broker: Any, message: Any) -> None:
        if self.heartbeat is not None:
            self.heartbeat.message_finished()


broker.add_middleware(WorkerHeartbeatMiddleware())


async def initialize_services() -> None:
    """Initialize all required services for the worker.

    Order matters — infrastructure first, then ML models.
    """
    from stt.core.database.connection import initialize_database
    from stt.core.storage.minio_client import initialize_minio

    logger.info("Initializing worker services...")

    # --- Infrastructure ---
    await initialize_database()
    logger.info("Database initialized")

    await initialize_minio()
    logger.info("MinIO initialized")

    # --- VAD: Silero ONNX (lightweight, always loaded) ---
    try:
        from stt.vad.silero_service import get_vad_service

        vad_service = get_vad_service()
        await vad_service.initialize()
        logger.info("Silero VAD service initialized")
    except Exception as e:
        logger.warning(f"VAD service initialization failed (non-fatal): {e}")

    # Diarization is NOT warmed at boot either (TASK-887): the speaker-embedding model
    # to load comes from the job's ResolvedAsrSpec (`models.embedding`), declared by the
    # ASR agent, so there is nothing to warm until a job has been resolved. The batch
    # service builds the service per job, exactly like punctuation below.

    # Punctuation is NOT warmed at boot: the model to load comes from a session's
    # ResolvedAsrSpec (models.punctuation), which does not exist until an agent has
    # been resolved. `punctuation.service.ensure_initialized` loads it lazily, per
    # session, the same way the FastAPI lifespan already treats it (see
    # `stt.main.lifespan` / `TestLifespanLazyModels`).

    logger.info("All worker services initialized successfully")


async def cleanup_services() -> None:
    """Cleanup services on shutdown."""
    from stt.core.database.connection import close_database
    from stt.core.storage.minio_client import close_minio

    logger.info("Cleaning up worker services...")

    try:
        await close_database()
    except Exception as e:
        logger.warning(f"Error closing database: {e}")

    try:
        await close_minio()
    except Exception as e:
        logger.warning(f"Error closing MinIO: {e}")

    # Shutdown VAD service
    try:
        from stt.vad.silero_service import get_vad_service

        await get_vad_service().shutdown()
    except Exception as e:
        logger.warning(f"Error shutting down VAD service: {e}")

    # Shutdown punctuation service
    try:
        from stt.punctuation import service as punctuation_service

        punctuation_service.shutdown()
    except Exception as e:
        logger.warning(f"Error shutting down punctuation service: {e}")

    logger.info("Worker services cleanup complete")


def _worker_build_info() -> Any:
    """The worker's build-info, `service` renamed to `stt-worker`.

    Same baked `/app/build-info.json` as the `stt` FastAPI app (same image);
    the rename is what lets the registry distinguish the two processes.
    """
    from dataclasses import replace

    base = BuildInfoReader().get_build_info()
    return replace(base, service="stt-worker")


def _start_service_release_registration() -> dict[str, Any]:
    """Self-registration: this worker has no inbound HTTP

    surface of its own, so it registers+heartbeats independently — fire-and-
    forget, bounded-timeout, NEVER blocks or fails boot.

    The Dramatiq worker's `main` is synchronous (it blocks on
    `shutdown_event.wait`), so there is no ambient asyncio event loop alive
    for the process lifetime. This runs the registration + heartbeat loop on
    a dedicated background event-loop thread instead. `DEPLOYMENT_ENVIRONMENT`
    / `NODE_ENV` is the same repo-wide convention used elsewhere; stt has no dedicated `environment` settings field.
    """
    box: dict[str, Any] = {"loop": None, "task": None, "client": None}
    ready = threading.Event()

    def _runner() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        box["loop"] = loop

        async def _start() -> None:
            client = httpx.AsyncClient()
            box["client"] = client
            try:
                box["task"] = start_registration(
                    http_client=client,
                    gateway_url=settings.api_gateway_url,
                    service_token=settings.api_gateway_key.get_secret_value(),
                    build_info=_worker_build_info(),
                    environment=(
                        os.getenv("DEPLOYMENT_ENVIRONMENT")
                        or os.getenv("NODE_ENV")
                        or "development"
                    ),
                )
            except Exception as exc:  # noqa: BLE001 - registration must never block boot
                logger.warning(f"Service-release registration failed to start (non-fatal): {exc}")

        loop.create_task(_start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=_runner, name="service-release-registration", daemon=True)
    thread.start()
    ready.wait(timeout=2.0)
    return box


def _stop_service_release_registration(box: dict[str, Any]) -> None:
    """Cancel the heartbeat task cleanly on its own loop, then stop the loop."""
    loop = box.get("loop")
    task = box.get("task")
    client = box.get("client")
    if loop is None:
        return

    async def _stop() -> None:
        await stop_registration(task)
        if client is not None:
            await client.aclose()

    try:
        future = asyncio.run_coroutine_threadsafe(_stop(), loop)
        future.result(timeout=5.0)
    except Exception as exc:  # noqa: BLE001 - shutdown must never raise either
        logger.warning(f"Service-release registration shutdown failed (non-fatal): {exc}")
    finally:
        loop.call_soon_threadsafe(loop.stop)


def main() -> None:
    """
    Entry point for the Dramatiq worker.

    This creates and starts Dramatiq Worker threads to process messages
    from the configured queues.
    """
    import os
    import threading

    import dramatiq
    from dramatiq import Worker

    # Initialize services (database, MinIO, etc.) before starting worker
    asyncio.run(initialize_services())

    service_release_box = _start_service_release_registration()

    # The worker-thread ceiling resolves control-plane first with the env value
    # as fallback. Resolved once at worker start (Dramatiq fixes the thread pool
    # at construction, so there is no live-resize path here) and never blocks
    # startup: an unreachable gateway returns the env default.
    from stt.core.runtime_limits import resolve_worker_concurrency

    worker_threads = asyncio.run(resolve_worker_concurrency(settings.worker_threads))

    logger.info(
        "Starting STT Dramatiq workers",
        redis_url=settings.redis_url[:30] + "...",
        queues=["stt_batch", "default"],
        worker_threads=worker_threads,
    )

    # Get the configured broker
    current_broker = dramatiq.get_broker()

    # Create worker with configuration
    worker = Worker(
        broker=current_broker,
        queues={"stt_batch", "default"},
        worker_threads=worker_threads,
        worker_timeout=settings.worker_poll_timeout_ms,
    )

    # Event to signal shutdown
    shutdown_event = threading.Event()

    # Track number of interrupt signals received
    interrupt_count = 0

    # Setup signal handlers for graceful shutdown
    def handle_signal(signum: int, frame: FrameType | None) -> None:
        nonlocal interrupt_count
        interrupt_count += 1
        signame = signal.Signals(signum).name

        if interrupt_count == 1:
            logger.info(
                f"Received {signame}, initiating graceful shutdown... (press Ctrl+C again to force)"
            )
            shutdown_event.set()
        elif interrupt_count >= 2:
            logger.warning("Forcing immediate shutdown...")
            os._exit(1)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    # Start the worker
    worker.start()
    logger.info("Worker started, waiting for messages... (Press Ctrl+C to stop)")

    # Block until shutdown signal received
    shutdown_event.wait()

    # Graceful shutdown
    logger.info("Stopping worker threads...")
    worker.stop()

    # Wait for worker threads to finish (with visual feedback)
    logger.info("Waiting for worker threads to finish...")
    worker.join()
    logger.info("Worker threads stopped")

    _stop_service_release_registration(service_release_box)

    # Flushes buffered spans (and the logging chain) before the process exits —
    # idempotent and never raises, safe on the SIGTERM path even if tracing
    # was never enabled (`tracer_provider is None`).
    _worker_observability.shutdown()

    logger.info("Worker shutdown complete")


if __name__ == "__main__":
    main()
