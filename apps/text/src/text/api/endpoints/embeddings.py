"""Text-embedding endpoints (TASK-725 Task 4) — net new; `text` had no
embedding capability before this ticket (§2.7).

`POST /embeddings` — synchronous, immediate round trip (mirrors `/generate`'s
shape for the small-batch, low-latency case).

`POST /embeddings/batch` — async submission onto `WorkerPoolQueue`, processed
out-of-process by Task 7's worker entry point; returns 202 with a `task_id`
pollable via the existing `GET /tasks/{task_id}` (no duplicate status route).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from text.core.dependencies import (
    get_embedding_registry,
)
from text.models.embedding import (
    EmbeddingRequest,
    EmbeddingResponse,
)
from text.providers.embedding import EmbeddingProviderNotFoundError, EmbeddingProviderRegistry

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
