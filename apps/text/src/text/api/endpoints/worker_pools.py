"""Worker-pool admin introspection endpoint (TASK-725 Tasks 3 & 6).

Per-`task_type` queue depth + draining status — the async-pool counterpart to
`GET /providers` (which covers the nine sync `LLMProvider`s + `tei-embed`, per
provider). Kept as its own endpoint rather than folded into `/providers`
because the two are shaped differently (per-`task_type` pool vs. per-provider
row) and `/providers` response shape (`list[ProviderInfo]`) is a real external
contract the gateway discovery merge already keys on (`providers.py`'s own
docstring) — changing its shape is out of scope.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from text.core.dependencies import get_shutdown_manager, get_worker_pool_queue
from text.core.metrics import WORKER_POOL_QUEUE_DEPTH
from text.models.worker_pool_status import WorkerPoolStatus
from text.models.worker_task import WorkerTaskType
from text.services.shutdown_manager import ShutdownManager
from text.services.worker_pool_queue import WorkerPoolQueue

router = APIRouter(tags=["worker-pools"])


@router.get("/worker-pools", response_model=list[WorkerPoolStatus])
async def list_worker_pools(
    worker_pool_queue: WorkerPoolQueue = Depends(get_worker_pool_queue),
    shutdown_manager: ShutdownManager | None = Depends(get_shutdown_manager),
) -> list[WorkerPoolStatus]:
    draining = bool(shutdown_manager and shutdown_manager.is_shutting_down)

    async def _status(task_type: WorkerTaskType) -> WorkerPoolStatus:
        depth = await worker_pool_queue.depth(task_type)
        WORKER_POOL_QUEUE_DEPTH.labels(task_type=task_type.value).set(depth)
        return WorkerPoolStatus(task_type=task_type.value, queue_depth=depth, draining=draining)

    return list(await asyncio.gather(*(_status(t) for t in WorkerTaskType)))
