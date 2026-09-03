"""Drain behavior on shutdown.

A SIGTERM mid-drain must reject NEW async task submissions while an
already-in-flight one completes normally. `ShutdownManager` already tracked
in-flight SYNC generation tasks (`api/endpoints/generate.py`'s
`register_task`/`complete_task`); this ticket extends the SAME
`is_shutting_down` flag to gate the new async `WorkerPoolQueue.submit()` call
site — see `services/worker_pool_queue.py`. RED for the async-queue half;
the sync-drain half already existed and is asserted here as a regression
guard for the combined scenario.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from text.services.shutdown_manager import ShutdownManager


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xadd = AsyncMock(return_value="1-0")
    return r


class TestSigtermMidDrain:
    # the async-submission-rejected half went with the worker-pool
    # plane it exercised. `wait_for_shutdown` is the drain `main.py` actually awaits
    # on every shutdown, so it survives and still earns its place.
    @pytest.mark.asyncio
    async def test_wait_for_shutdown_resolves_once_in_flight_task_completes(self):
        """The drain the lifespan shutdown handler (`main.py`) awaits: it does
        NOT time out once the sole in-flight task completes."""
        import asyncio

        shutdown_manager = ShutdownManager()
        shutdown_manager.register_task("in-flight-task-1")

        async def _complete_shortly() -> None:
            await asyncio.sleep(0.01)
            shutdown_manager.complete_task("in-flight-task-1")

        asyncio.get_event_loop().create_task(_complete_shortly())
        timed_out = await shutdown_manager.wait_for_shutdown(timeout=2.0)

        assert timed_out is False
