"""WorkerPoolConsumer — the claim/process/ack loop worker.py runs per task_type
(TASK-725 Tasks 6 & 7). Hermetic: queue/task_manager are stubs. RED: written
before `text/worker.py` existed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from text.models.task import TaskState, TaskStatus
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType


@pytest.fixture
def mock_queue():
    q = AsyncMock()
    q.ack = AsyncMock()
    return q


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.get_task = AsyncMock(return_value=None)
    tm.update_task = AsyncMock()
    return tm


@pytest.fixture
def envelope():
    return WorkerTaskEnvelope(
        task_id="task-1", task_type=WorkerTaskType.EMBEDDING, payload={"texts": ["hi"]}
    )


class TestProcessSuccessAndFailure:
    @pytest.mark.asyncio
    async def test_success_marks_completed_and_acks(self, mock_queue, mock_task_manager, envelope):
        from text.worker import WorkerPoolConsumer

        handler = AsyncMock()
        consumer = WorkerPoolConsumer(
            WorkerTaskType.EMBEDDING, mock_queue, mock_task_manager, handler
        )

        await consumer._process("111-0", envelope)

        handler.assert_awaited_once_with(envelope)
        mock_task_manager.update_task.assert_any_call("task-1", status=TaskStatus.RUNNING)
        mock_task_manager.update_task.assert_any_call("task-1", status=TaskStatus.COMPLETED)
        mock_queue.ack.assert_awaited_once_with(WorkerTaskType.EMBEDDING, "111-0")

    @pytest.mark.asyncio
    async def test_handler_failure_marks_failed_but_still_acks(
        self, mock_queue, mock_task_manager, envelope
    ):
        """One bad task must not kill the consumer loop, and must not leave
        the message stuck unacked forever."""
        from text.worker import WorkerPoolConsumer

        async def _boom(_env):
            raise RuntimeError("engine down")

        consumer = WorkerPoolConsumer(
            WorkerTaskType.EMBEDDING, mock_queue, mock_task_manager, _boom
        )

        await consumer._process("111-0", envelope)

        failed_call = [
            c
            for c in mock_task_manager.update_task.await_args_list
            if c.kwargs.get("status") == TaskStatus.FAILED
        ]
        assert len(failed_call) == 1
        assert "engine down" in failed_call[0].kwargs["error"]
        mock_queue.ack.assert_awaited_once_with(WorkerTaskType.EMBEDDING, "111-0")


class TestDuplicateDelivery:
    @pytest.mark.asyncio
    async def test_already_completed_task_is_skipped_not_rerun(
        self, mock_queue, mock_task_manager, envelope
    ):
        """At-least-once redelivery of an already-terminal task must not
        re-bill/re-run the underlying (paid) work."""
        from text.worker import WorkerPoolConsumer

        mock_task_manager.get_task = AsyncMock(
            return_value=TaskState(
                task_id="task-1", status=TaskStatus.COMPLETED, provider="tei-embed", model="m"
            )
        )
        handler = AsyncMock()
        consumer = WorkerPoolConsumer(
            WorkerTaskType.EMBEDDING, mock_queue, mock_task_manager, handler
        )

        await consumer._process("111-0", envelope)

        handler.assert_not_awaited()
        mock_queue.ack.assert_awaited_once_with(WorkerTaskType.EMBEDDING, "111-0")


class TestDrain:
    @pytest.mark.asyncio
    async def test_request_drain_stops_the_claim_loop(self, mock_queue, mock_task_manager):
        """Task 6, worker-side half: stop claiming NEW work once draining;
        the loop exits instead of blocking on the next claim forever."""
        from text.worker import WorkerPoolConsumer

        mock_queue.claim = AsyncMock(return_value=[])
        consumer = WorkerPoolConsumer(
            WorkerTaskType.EMBEDDING, mock_queue, mock_task_manager, AsyncMock()
        )
        consumer.request_drain()

        await consumer.run()

        mock_queue.claim.assert_not_awaited()
