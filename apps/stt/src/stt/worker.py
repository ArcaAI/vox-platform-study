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
from types import FrameType
from typing import Any

import httpx
from hope_env import BuildInfoReader
from hope_env.service_registration import start_registration, stop_registration
from hope_obs import configure_worker_observability

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
