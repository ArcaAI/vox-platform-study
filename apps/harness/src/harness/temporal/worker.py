"""Temporal worker entrypoint.

Run with the configured conda env:

    conda run -n arcaenv python -m harness.temporal.worker

The worker polls the configured task queue and hosts the harness workflows and
activities. It requires a reachable Temporal server (see ``infrastructure/docker``
for the dev stack, started via ``--profile temporal``).
"""

from __future__ import annotations

import asyncio

from temporalio.worker import Worker

from harness.core.config import get_settings
from harness.core.logging import get_logger, setup_logging
from harness.temporal.activities import DOCUMENT_ACTIVITIES, ping_activity
from harness.temporal.client import get_temporal_client
from harness.temporal.workflows import HarnessDocWorkflow, HarnessPingWorkflow

logger = get_logger(__name__)


async def run_worker() -> None:
    """Connect to Temporal and run the harness worker until cancelled."""
    settings = get_settings()
    setup_logging(settings.log_level)

    logger.info(
        "harness.worker.connecting",
        address=settings.temporal.address,
        namespace=settings.temporal.namespace,
        task_queue=settings.temporal.task_queue,
    )
    client = await get_temporal_client(settings)

    worker = Worker(
        client,
        task_queue=settings.temporal.task_queue,
        workflows=[HarnessPingWorkflow, HarnessDocWorkflow],
        activities=[ping_activity, *DOCUMENT_ACTIVITIES],
    )

    logger.info("harness.worker.started", task_queue=settings.temporal.task_queue)
    await worker.run()


def main() -> None:
    """Console-script / module entrypoint."""
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
