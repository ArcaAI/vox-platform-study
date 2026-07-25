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

import asyncio
from typing import Any

import structlog
from dramatiq.middleware import Middleware

logger = structlog.get_logger(__name__)


class WorkerInitMiddleware(Middleware):
    """Initialize required services when a worker process boots."""

    def after_process_boot(self, broker: Any) -> None:
        """Called immediately after a child process is forked by the dramatiq CLI."""
        logger.info("WorkerInitMiddleware: initializing services for worker process")
        from stt.worker import initialize_services

        asyncio.run(initialize_services())
        logger.info("WorkerInitMiddleware: services initialized")

    def before_worker_shutdown(self, broker: Any, worker: Any) -> None:
        """Called before the worker process shuts down."""
        logger.info("WorkerInitMiddleware: cleaning up services")
        from stt.worker import cleanup_services

        asyncio.run(cleanup_services())
        logger.info("WorkerInitMiddleware: cleanup complete")
