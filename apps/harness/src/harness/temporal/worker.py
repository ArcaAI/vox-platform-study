"""Temporal worker entrypoint.

Run with the configured conda env:

    conda run -n arcaenv python -m harness.temporal.worker

The worker polls the configured task queue and hosts the harness workflows and
activities. It requires a reachable Temporal server (see ``infrastructure/docker``
for the dev stack, started via ``--profile temporal``).
"""

from __future__ import annotations

import asyncio
import functools
import signal
from datetime import timedelta

from temporalio.worker import Worker

from harness.core.config import get_settings
from harness.core.logging import get_logger, setup_logging
from harness.temporal.activities import DOCUMENT_ACTIVITIES, ping_activity
from harness.temporal.client import get_temporal_client
from harness.temporal.workflows import HarnessDocWorkflow, HarnessPingWorkflow

logger = get_logger(__name__)

_SHUTDOWN_SIGNALS = (signal.SIGINT, signal.SIGTERM)


async def run_worker() -> None:
    """Connect to Temporal and run the harness worker until interrupted.

    Shutdown is graceful: SIGINT (Ctrl+C) and SIGTERM (``docker stop`` /
    Kubernetes) set an interrupt event that stops the worker via its async
    context manager. Temporal then drains in-flight activities for up to
    ``graceful_shutdown_timeout_s`` before cancelling them, so a worker being
    rolled is not killed mid-activity.
    """
    settings = get_settings()
    setup_logging(settings.log_level)

    logger.info(
        "harness.worker.connecting",
        address=settings.temporal.address,
        namespace=settings.temporal.namespace,
        task_queue=settings.temporal.task_queue,
    )
    client = await get_temporal_client(settings)

    interrupt_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in _SHUTDOWN_SIGNALS:
        try:
            loop.add_signal_handler(
                sig, functools.partial(_request_shutdown, sig, interrupt_event)
            )
        except NotImplementedError:
            # add_signal_handler is unavailable on some platforms (e.g. Windows);
            # fall back to the KeyboardInterrupt path handled in main().
            pass

    worker = Worker(
        client,
        task_queue=settings.temporal.task_queue,
        workflows=[HarnessPingWorkflow, HarnessDocWorkflow],
        activities=[ping_activity, *DOCUMENT_ACTIVITIES],
        graceful_shutdown_timeout=timedelta(
            seconds=settings.temporal.graceful_shutdown_timeout_s
        ),
    )

    logger.info(
        "harness.worker.started",
        task_queue=settings.temporal.task_queue,
        graceful_shutdown_timeout_s=settings.temporal.graceful_shutdown_timeout_s,
    )
    async with worker:
        await interrupt_event.wait()
    logger.info("harness.worker.stopped")


def _request_shutdown(sig: signal.Signals, interrupt_event: asyncio.Event) -> None:
    """Signal handler: log once and trigger graceful worker shutdown."""
    if not interrupt_event.is_set():
        logger.info("harness.worker.shutdown_requested", signal=sig.name)
    interrupt_event.set()


def main() -> None:
    """Console-script / module entrypoint."""
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        # Reached only when signal handlers could not be installed (e.g. running
        # off the main thread, or an unsupported platform). Exit cleanly instead
        # of dumping a traceback.
        logger.info("harness.worker.interrupted")


if __name__ == "__main__":
    main()
