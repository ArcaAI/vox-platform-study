"""WorkerPoolQueue — cross-process/cross-pod async task dispatch (TASK-725).

Redis Streams + a consumer group per ``task_type``, mirroring
``services/task_manager.TaskManager``'s existing Redis-Streams usage rather than
introducing a new broker (design.md D7 — contract-over-broker). Key prefix
``text:workerpool:{task_type}`` — the SAME ``text:`` prefix TaskManager/idempotency-
cache keys already use (metric/key names are not yet ``text:`` post-TASK-707;
see design-notes.md §(c)).

Deliberately NOT named ``ProviderQueue`` and NOT built on it — see
``services/provider_queue.py`` (an in-process ``asyncio.PriorityQueue`` for
same-pod backpressure on the SYNC ``/generate`` path). This class is the
cross-process dispatch mechanism to a SEPARATE worker consumer process
(Task 7's entry point); the two never share state.
"""

from __future__ import annotations

from typing import Any, cast

import structlog

from text.core.exceptions import ShutdownError
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.services.shutdown_manager import ShutdownManager

logger = structlog.get_logger(__name__)

_STREAM_KEY_PREFIX = "text:workerpool:"
_GROUP_SUFFIX = ":workers"


def _stream_key(task_type: WorkerTaskType | str) -> str:
    return f"{_STREAM_KEY_PREFIX}{task_type}"


def _group_name(task_type: WorkerTaskType | str) -> str:
    return f"{_stream_key(task_type)}{_GROUP_SUFFIX}"


class WorkerPoolQueue:
    """Submit/claim/ack async worker tasks via Redis Streams consumer groups."""

    def __init__(
        self,
        redis: Any,
        *,
        shutdown_manager: ShutdownManager | None = None,
        stream_max_len: int = 100_000,
    ) -> None:
        self._redis = redis
        self._shutdown_manager = shutdown_manager
        self._stream_max_len = stream_max_len

    async def submit(self, envelope: WorkerTaskEnvelope) -> str:
        """Enqueue ``envelope`` onto its ``task_type`` stream. Returns the Redis
        stream message id.

        Fails closed with ``ShutdownError`` (503, reused from the sync
        ``/generate`` path — not a new exception type) while the control plane
        is draining (TASK-725 Task 6): "stop accepting new async tasks" is
        enforced HERE, at the single submission call site, rather than at every
        caller.
        """
        if self._shutdown_manager is not None and self._shutdown_manager.is_shutting_down:
            raise ShutdownError(
                "Service is shutting down — not accepting new async worker-pool tasks."
            )
        msg_id = await self._redis.xadd(
            _stream_key(envelope.task_type),
            {"envelope": envelope.model_dump_json()},
            maxlen=self._stream_max_len,
        )
        if isinstance(msg_id, bytes):
            msg_id = msg_id.decode()
        return cast(str, msg_id)

    async def depth(self, task_type: WorkerTaskType | str) -> int:
        """Current pending queue depth for ``task_type`` — the KEDA-facing signal
        (`core/metrics.WORKER_POOL_QUEUE_DEPTH`)."""
        return cast(int, await self._redis.xlen(_stream_key(task_type)))

    async def claim(
        self,
        task_type: WorkerTaskType | str,
        *,
        consumer: str,
        count: int = 1,
        block_ms: int = 5000,
    ) -> list[tuple[str, WorkerTaskEnvelope]]:
        """Claim up to ``count`` pending tasks for ``consumer`` via XREADGROUP.

        Ensures the consumer group exists (creating it, tolerating the
        "already exists" race — any OTHER group-create failure, e.g. a
        connection error, re-raises rather than being swallowed alongside it).
        """
        group = _group_name(task_type)
        stream = _stream_key(task_type)
        try:
            await self._redis.xgroup_create(stream, group, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

        result = await self._redis.xreadgroup(
            groupname=group,
            consumername=consumer,
            streams={stream: ">"},
            count=count,
            block=block_ms,
        )
        if not result:
            return []

        claimed: list[tuple[str, WorkerTaskEnvelope]] = []
        for _stream_name, entries in result:
            for msg_id, fields in entries:
                raw = fields.get(b"envelope") or fields.get("envelope")
                if raw is None:
                    logger.warning(
                        "worker_pool_queue.claim_missing_envelope",
                        task_type=str(task_type),
                        msg_id=msg_id,
                    )
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode()
                if isinstance(msg_id, bytes):
                    msg_id = msg_id.decode()
                claimed.append((msg_id, WorkerTaskEnvelope.model_validate_json(raw)))
        return claimed

    async def ack(self, task_type: WorkerTaskType | str, msg_id: str) -> None:
        """Acknowledge a claimed task so it leaves the consumer group's pending
        entries list (redelivery no longer applies to it)."""
        await self._redis.xack(_stream_key(task_type), _group_name(task_type), msg_id)
