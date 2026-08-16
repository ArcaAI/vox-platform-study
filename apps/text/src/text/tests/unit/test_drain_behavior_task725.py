"""Drain behavior on shutdown (TASK-725 Task 6).

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

from text.core.exceptions import ShutdownError
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.services.shutdown_manager import ShutdownManager
from text.services.worker_pool_queue import WorkerPoolQueue


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xadd = AsyncMock(return_value="1-0")
    return r


class TestSigtermMidDrain:
    @pytest.mark.asyncio
    async def test_in_flight_sync_task_completes_while_new_async_submission_is_rejected(
        self, mock_redis
    ):
        shutdown_manager = ShutdownManager()
        queue = WorkerPoolQueue(redis=mock_redis, shutdown_manager=shutdown_manager)

        # A generation already in flight when SIGTERM lands.
        shutdown_manager.register_task("in-flight-task-1")
        assert shutdown_manager.active_count == 1

        # SIGTERM: begin draining.
        shutdown_manager.initiate_shutdown()
        assert shutdown_manager.is_shutting_down is True

        # New async work is rejected — never queued into a draining pod.
        with pytest.raises(ShutdownError):
            await queue.submit(
                WorkerTaskEnvelope(task_type=WorkerTaskType.EMBEDDING, payload={"texts": ["x"]})
            )
        mock_redis.xadd.assert_not_awaited()

        # The in-flight task is UNAFFECTED by the new-submission rejection —
        # it finishes normally.
        shutdown_manager.complete_task("in-flight-task-1")
        assert shutdown_manager.active_count == 0

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
