"""WorkerTaskEnvelope model (TASK-725 Task 1/4). RED: written before the model
existed."""

from __future__ import annotations

from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType


class TestWorkerTaskEnvelope:
    def test_defaults_generate_a_task_id(self):
        env = WorkerTaskEnvelope(task_type=WorkerTaskType.EMBEDDING)
        assert env.task_id
        other = WorkerTaskEnvelope(task_type=WorkerTaskType.EMBEDDING)
        assert env.task_id != other.task_id

    def test_task_type_is_scoped_to_async_types_only(self):
        assert set(WorkerTaskType) == {
            WorkerTaskType.EMBEDDING,
            WorkerTaskType.BATCH_GENERATION,
        }

    def test_default_max_retries_is_three(self):
        env = WorkerTaskEnvelope(task_type=WorkerTaskType.BATCH_GENERATION)
        assert env.max_retries == 3

    def test_round_trips_through_json(self):
        env = WorkerTaskEnvelope(
            task_type=WorkerTaskType.EMBEDDING,
            tenant_id="tenant-1",
            request_id="req-1",
            idempotency_key="idem-1",
            payload={"texts": ["a", "b"]},
        )
        restored = WorkerTaskEnvelope.model_validate_json(env.model_dump_json())
        assert restored == env
