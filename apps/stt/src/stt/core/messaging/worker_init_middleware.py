"""Dramatiq middleware to initialize/cleanup services per worker process.

When the ``dramatiq`` CLI spawns worker processes with ``--processes N``,
each child process only imports the worker module -- it never calls
``worker.main()``.  This middleware bridges that gap by running
``initialize_services()`` inside each forked process (via
``after_process_boot``) and ``cleanup_services()`` on shutdown.

``after_process_boot`` is only emitted by the dramatiq CLI's fork
mechanism, so it never fires when using the ``stt-worker`` entry
point (which calls ``main()`` directly).  No guard flag needed.
"""

from typing import Any

import structlog
from dramatiq.middleware import Middleware

from stt.core.worker_loop import run_on_worker_loop, shutdown_worker_loop

logger = structlog.get_logger(__name__)


class WorkerInitMiddleware(Middleware):
    """Initialize required services when a worker process boots.

    BUG-016: boot and cleanup run on the SHARED worker loop, not on throwaway
    `asyncio.run()` loops. The services built here (VAD, embedding, punctuation,
    model cache) hold asyncio state, and jobs reach them from the worker loop —
    building them on a loop that is closed before the first job runs is the same
    cross-loop defect as the per-message loops, one layer earlier.
    """

    def after_process_boot(self, broker: Any) -> None:
        """Called immediately after a child process is forked by the dramatiq CLI."""
        logger.info("WorkerInitMiddleware: initializing services for worker process")
        from stt.worker import initialize_services

        run_on_worker_loop(initialize_services())
        logger.info("WorkerInitMiddleware: services initialized")

    def before_worker_shutdown(self, broker: Any, worker: Any) -> None:
        """Called before the worker process shuts down."""
        logger.info("WorkerInitMiddleware: cleaning up services")
        from stt.worker import cleanup_services

        try:
            run_on_worker_loop(cleanup_services())
            logger.info("WorkerInitMiddleware: cleanup complete")
        finally:
            # Stop the loop AFTER cleanup has run on it — cleanup needs the loop
            # its services were built on, and nothing may outlive the worker.
            shutdown_worker_loop()
