"""WorkerPoolQueue — cross-process async task dispatch (TASK-725 Tasks 1/5/6).

Hermetic: Redis is mocked (no live Redis). Deliberately named/tested SEPARATELY
from `services/provider_queue.ProviderQueue` (an in-process `asyncio.PriorityQueue`
for same-pod backpressure) — see design-notes.md §(d) pitfall. RED: written
before `services/worker_pool_queue.py` existed.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from text.core.exceptions import ShutdownError
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.services.shutdown_manager import ShutdownManager


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xadd = AsyncMock(return_value="1234567890-0")
    r.xlen = AsyncMock(return_value=0)
    r.xgroup_create = AsyncMock()
    r.xreadgroup = AsyncMock(return_value=[])
    r.xack = AsyncMock(return_value=1)
    return r


@pytest.fixture
def envelope():
    return WorkerTaskEnvelope(
        task_type=WorkerTaskType.EMBEDDING,
        payload={"texts": ["hello"], "provider": "tei-embed"},
    )


class TestSubmit:
    @pytest.mark.asyncio
    async def test_submit_xadds_to_the_task_type_stream(self, mock_redis, envelope):
        from text.services.worker_pool_queue import WorkerPoolQueue

        queue = WorkerPoolQueue(redis=mock_redis)
        msg_id = await queue.submit(envelope)

        assert msg_id == "1234567890-0"
        mock_redis.xadd.assert_awaited_once()
        stream_key = mock_redis.xadd.call_args.args[0]
        assert stream_key == "text:workerpool:embedding"

    @pytest.mark.asyncio
    async def test_submit_serializes_the_full_envelope(self, mock_redis, envelope):
        from text.services.worker_pool_queue import WorkerPoolQueue

        queue = WorkerPoolQueue(redis=mock_redis)
        await queue.submit(envelope)

        fields = mock_redis.xadd.call_args.args[1]
        body = json.loads(fields["envelope"])
        assert body["task_id"] == envelope.task_id
        assert body["payload"]["texts"] == ["hello"]

    @pytest.mark.asyncio
    async def test_submit_rejects_new_work_while_draining(self, mock_redis, envelope):
        """Task 6: stop accepting new async tasks once the control plane is
        shutting down — reuses ShutdownError (503), same as /generate's
        existing check, rather than inventing a parallel exception type."""
        from text.services.worker_pool_queue import WorkerPoolQueue

        shutdown_manager = ShutdownManager()
        shutdown_manager.initiate_shutdown()
        queue = WorkerPoolQueue(redis=mock_redis, shutdown_manager=shutdown_manager)

        with pytest.raises(ShutdownError):
            await queue.submit(envelope)
        mock_redis.xadd.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_submit_allowed_when_shutdown_manager_not_draining(self, mock_redis, envelope):
        from text.services.worker_pool_queue import WorkerPoolQueue

        shutdown_manager = ShutdownManager()
        queue = WorkerPoolQueue(redis=mock_redis, shutdown_manager=shutdown_manager)

        await queue.submit(envelope)
        mock_redis.xadd.assert_awaited_once()


class TestDepth:
    @pytest.mark.asyncio
    async def test_depth_reads_xlen_of_the_task_type_stream(self, mock_redis):
        from text.services.worker_pool_queue import WorkerPoolQueue

        mock_redis.xlen.return_value = 7
        queue = WorkerPoolQueue(redis=mock_redis)

        depth = await queue.depth(WorkerTaskType.EMBEDDING)

        assert depth == 7
        mock_redis.xlen.assert_awaited_once_with("text:workerpool:embedding")


class TestClaimAndAck:
    @pytest.mark.asyncio
    async def test_claim_ensures_consumer_group_then_reads(self, mock_redis, envelope):
        from text.services.worker_pool_queue import WorkerPoolQueue

        raw = envelope.model_dump_json()
        mock_redis.xreadgroup.return_value = [
            ("text:workerpool:embedding", [("111-0", {"envelope": raw})])
        ]
        queue = WorkerPoolQueue(redis=mock_redis)

        claimed = await queue.claim(WorkerTaskType.EMBEDDING, consumer="worker-1", count=1)

        assert len(claimed) == 1
        msg_id, claimed_envelope = claimed[0]
        assert msg_id == "111-0"
        assert claimed_envelope.task_id == envelope.task_id
        mock_redis.xgroup_create.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_claim_tolerates_group_already_existing(self, mock_redis):
        from text.services.worker_pool_queue import WorkerPoolQueue

        mock_redis.xgroup_create.side_effect = Exception("BUSYGROUP Consumer Group name already exists")
        queue = WorkerPoolQueue(redis=mock_redis)

        claimed = await queue.claim(WorkerTaskType.EMBEDDING, consumer="worker-1", count=1)

        assert claimed == []

    @pytest.mark.asyncio
    async def test_claim_reraises_unexpected_group_create_error(self, mock_redis):
        from text.services.worker_pool_queue import WorkerPoolQueue

        mock_redis.xgroup_create.side_effect = Exception("connection refused")
        queue = WorkerPoolQueue(redis=mock_redis)

        with pytest.raises(Exception, match="connection refused"):
            await queue.claim(WorkerTaskType.EMBEDDING, consumer="worker-1", count=1)

    @pytest.mark.asyncio
    async def test_ack_xacks_the_task_type_stream(self, mock_redis):
        from text.services.worker_pool_queue import WorkerPoolQueue

        queue = WorkerPoolQueue(redis=mock_redis)
        await queue.ack(WorkerTaskType.EMBEDDING, "111-0")

        mock_redis.xack.assert_awaited_once_with(
            "text:workerpool:embedding", "text:workerpool:embedding:workers", "111-0"
        )
