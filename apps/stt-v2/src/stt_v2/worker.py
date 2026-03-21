"""STT Service V2 - Dramatiq Worker Entry Point.

This module configures and starts Dramatiq workers for processing
transcription jobs from the Redis message queue.

Worker architecture for 100+ concurrent users:
- Dramatiq processes: one per CPU core (CPU inference) or per GPU
- Dramatiq threads: 2–4 per process (low for CPU-bound ML work)
- ProcessPoolExecutor: optional in-process parallelism for lightweight tasks
- VAD service: Silero ONNX loaded once per worker process (single-threaded CPU)
- Qdrant client: async connection pool shared across threads
- Diarization model: pyannote loaded once per worker process (GPU if available)

Usage:
    # Via entry point (recommended):
    stt-v2-worker

    # Via dramatiq CLI (alternative):
    dramatiq stt_v2.worker

    # Via Python module:
    python -m stt_v2.worker
"""

import asyncio
import signal

import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.core.messaging.broker import configure_broker

logger = structlog.get_logger(__name__)
settings = get_settings()

# Configure the Dramatiq broker FIRST (before importing actors)
broker = configure_broker(settings.redis_url)

# Import actors to register them with the broker
# These imports MUST happen after broker configuration
from stt_v2.transcription.workers import transcribe_file  # noqa: E402, F401


async def initialize_services() -> None:
    """Initialize all required services for the worker.

    Order matters — infrastructure first, then ML models.
    """
    from stt_v2.core.database.connection import initialize_database
    from stt_v2.core.storage.minio_client import initialize_minio

    logger.info("Initializing worker services...")

    # --- Infrastructure ---
    await initialize_database()
    logger.info("Database initialized")

    await initialize_minio()
    logger.info("MinIO initialized")

    # --- VAD: Silero ONNX (lightweight, always loaded) ---
    try:
        from stt_v2.vad.silero_service import get_vad_service

        vad_service = get_vad_service()
        await vad_service.initialize()
        logger.info("Silero VAD service initialized")
    except Exception as e:
        logger.warning(f"VAD service initialization failed (non-fatal): {e}")

    # --- Qdrant: speaker embedding store ---
    try:
        from stt_v2.core.vectorstore.speaker_store import get_speaker_store

        speaker_store = get_speaker_store()
        await speaker_store.ensure_collection()
        logger.info("Qdrant speaker store initialized")
    except Exception as e:
        logger.warning(f"Qdrant speaker store initialization failed (non-fatal): {e}")

    # --- Diarization: pyannote embedding model (heavier, optional) ---
    try:
        from stt_v2.diarization.embedding_service import get_embedding_service

        embedding_service = get_embedding_service()
        await embedding_service.initialize()
        logger.info("Pyannote embedding service initialized")
    except Exception as e:
        logger.warning(f"Diarization service initialization failed (non-fatal): {e}")

    logger.info("All worker services initialized successfully")


async def cleanup_services() -> None:
    """Cleanup services on shutdown."""
    from stt_v2.core.database.connection import close_database
    from stt_v2.core.storage.minio_client import close_minio

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
        from stt_v2.vad.silero_service import get_vad_service

        await get_vad_service().shutdown()
    except Exception as e:
        logger.warning(f"Error shutting down VAD service: {e}")

    # Shutdown Qdrant client
    try:
        from stt_v2.core.vectorstore.client import get_qdrant_client

        await get_qdrant_client().close()
    except Exception as e:
        logger.warning(f"Error closing Qdrant client: {e}")

    # Shutdown diarization service
    try:
        from stt_v2.diarization.embedding_service import get_embedding_service

        await get_embedding_service().shutdown()
    except Exception as e:
        logger.warning(f"Error shutting down diarization service: {e}")

    logger.info("Worker services cleanup complete")


def main() -> None:
    """
    Entry point for the Dramatiq worker.

    This creates and starts Dramatiq Worker threads to process messages
    from the configured queues.
    """
    import os
    import threading
    import time

    import dramatiq
    from dramatiq import Worker

    # Initialize services (database, MinIO, etc.) before starting worker
    asyncio.run(initialize_services())

    logger.info(
        "Starting STT V2 Dramatiq workers",
        redis_url=settings.redis_url[:30] + "...",
        queues=["stt_batch", "default"],
        worker_threads=settings.worker_threads,
    )

    # Get the configured broker
    current_broker = dramatiq.get_broker()

    # Create worker with configuration
    worker = Worker(
        broker=current_broker,
        queues=["stt_batch", "default"],
        worker_threads=settings.worker_threads,
        worker_timeout=settings.worker_timeout_ms,
    )

    # Event to signal shutdown
    shutdown_event = threading.Event()

    # Track number of interrupt signals received
    interrupt_count = 0

    # Setup signal handlers for graceful shutdown
    def handle_signal(signum: int, frame) -> None:
        nonlocal interrupt_count
        interrupt_count += 1
        signame = signal.Signals(signum).name

        if interrupt_count == 1:
            logger.info(f"Received {signame}, initiating graceful shutdown... (press Ctrl+C again to force)")
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

    # Note: We skip async cleanup here because the event loop from initialize_services()
    # is already closed. The database connections will be cleaned up by the OS on exit.
    # For a cleaner solution, we'd need to restructure to use a single persistent event loop.
    logger.info("Worker shutdown complete")


if __name__ == "__main__":
    main()
