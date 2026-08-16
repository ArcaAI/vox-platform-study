"""Async worker-pool task envelope (TASK-725 Phase A/B).

Scoped strictly to genuinely asynchronous, OUT-OF-PROCESS work (batch
generation + the new embedding task type) — distinct from the existing
synchronous `/generate` and resumable-SSE (`stream.py`/`tasks.py`) request
paths, which this ticket does not touch. See
`docs/implementation/TASK-725-Worker-Pool-Text/design-notes.md` §(d).

Task STATE (pending/running/completed/failed) stays `TaskManager`'s job
(`services/task_manager.py`) — this envelope carries only what a worker needs
to CLAIM and EXECUTE the task; it is the message body on the
`services/worker_pool_queue.WorkerPoolQueue` Redis Stream, not a second
task-state store.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class WorkerTaskType(StrEnum):
    """The two async task types this ticket adds. NOT the sync/SSE paths."""

    EMBEDDING = "embedding"
    BATCH_GENERATION = "batch_generation"


class WorkerTaskEnvelope(BaseModel):
    """One unit of async work dispatched to a worker pool.

    Modeled on the Dramatiq actor kwarg shape in
    `apps/stt/src/stt/transcription/workers/transcribe_file.py:31-51` — the
    only out-of-process worker task envelope actually running in this
    monorepo today.
    """

    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_type: WorkerTaskType
    tenant_id: str | None = None
    request_id: str | None = None
    priority: int = 0
    # Mirrors `/generate`'s existing `Idempotency-Key` header convention. A
    # worker-crash re-delivery (Redis Streams consumer groups are
    # at-least-once) must not re-bill/re-run — handlers MUST check this
    # before doing paid work.
    idempotency_key: str | None = None
    max_retries: int = 3
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
