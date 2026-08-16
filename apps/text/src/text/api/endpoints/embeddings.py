"""Text-embedding endpoints (TASK-725 Task 4) — net new; `text` had no
embedding capability before this ticket (§2.7).

`POST /embeddings` — synchronous, immediate round trip (mirrors `/generate`'s
shape for the small-batch, low-latency case).

`POST /embeddings/batch` — async submission onto `WorkerPoolQueue`, processed
out-of-process by Task 7's worker entry point; returns 202 with a `task_id`
pollable via the existing `GET /tasks/{task_id}` (no duplicate status route).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException

from text.core.dependencies import (
    get_embedding_registry,
    get_task_manager,
    get_worker_pool_queue,
)
from text.core.metrics import WORKER_POOL_TASKS_TOTAL
from text.models.embedding import (
    EmbeddingBatchAcceptedResponse,
    EmbeddingBatchRequest,
    EmbeddingRequest,
    EmbeddingResponse,
)
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.providers.embedding import EmbeddingProviderNotFoundError, EmbeddingProviderRegistry
from text.services.task_manager import TaskManager
from text.services.worker_pool_queue import WorkerPoolQueue

router = APIRouter(tags=["embeddings"])


@router.post("/embeddings", response_model=EmbeddingResponse)
async def create_embeddings(
    request_body: EmbeddingRequest,
    registry: EmbeddingProviderRegistry = Depends(get_embedding_registry),
) -> EmbeddingResponse:
    try:
        provider = registry.get(request_body.provider)
    except EmbeddingProviderNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Embedding provider '{request_body.provider}' not found",
        ) from None

    vectors = await provider.embed(request_body.texts)
    return EmbeddingResponse(
        embeddings=vectors,
        provider=request_body.provider,
        model=request_body.model or "",
        dim=len(vectors[0]) if vectors else 0,
    )


@router.post(
    "/embeddings/batch",
    status_code=202,
    response_model=EmbeddingBatchAcceptedResponse,
)
async def submit_batch_embedding(
    request_body: EmbeddingBatchRequest,
    worker_pool_queue: WorkerPoolQueue = Depends(get_worker_pool_queue),
    task_manager: TaskManager = Depends(get_task_manager),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> EmbeddingBatchAcceptedResponse:
    # Task STATE is TaskManager's job (unchanged, extended not replaced);
    # `provider`/`model` are informational labels here, same as every other
    # TaskManager caller.
    task = await task_manager.create_task(
        provider=request_body.provider, model="embedding-batch"
    )
    envelope = WorkerTaskEnvelope(
        task_id=task.task_id,
        task_type=WorkerTaskType.EMBEDDING,
        tenant_id=x_tenant_id,
        idempotency_key=idempotency_key,
        payload={"texts": request_body.texts, "provider": request_body.provider},
    )
    # ShutdownError (503) propagates unwrapped to the shared SmrError handler
    # when the control plane is draining — see WorkerPoolQueue.submit
    # (TASK-725 Task 6).
    await worker_pool_queue.submit(envelope)
    WORKER_POOL_TASKS_TOTAL.labels(task_type="embedding", status="submitted").inc()
    return EmbeddingBatchAcceptedResponse(task_id=task.task_id, status="queued")
