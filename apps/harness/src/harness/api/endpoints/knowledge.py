"""Internal institutional-knowledge ingest endpoint (TASK-330 Phase 3, Lane A).

``POST /api/v1/internal/knowledge/ingest`` is the cross-lane contract Lane B's
BullMQ ``IngestKnowledgeDocument`` processor calls after a ``KnowledgeDocument`` is
APPROVED. Chunking, dense (LM Studio) + sparse (fastembed BM25) embedding, and the
Qdrant upsert into the dedicated ``knowledge_chunks`` collection all happen **inside
this endpoint**; it returns one descriptor per chunk so Lane B can persist
``KnowledgeChunk`` rows keyed by ``qdrantPointId``.

Auth: the ``X-Service-Token`` header must match the dedicated
``HARNESS_INTERNAL_SERVICE_TOKEN`` **or** the shared ``HARNESS_SERVICE_TOKEN``
(extends the existing internal-endpoint mechanism); empty (both) disables the
guard for local dev. On an embeddings / sparse / Qdrant failure the endpoint
returns HTTP 503 with a structured error body so Lane B can fail + retry the job
(nothing is half-written: the upsert is the last step).

Point id = a stable ``uuid5`` per ``(tenant, document, chunkIndex)`` so re-ingesting
the same document is idempotent. The Qdrant payload ``chunk_id`` is set equal to the
point id (the stable join key Lane B persists as ``KnowledgeChunk.qdrantPointId``).
"""

from __future__ import annotations

import secrets
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from harness.core.config import Settings
from harness.core.logging import get_logger
from harness.guides.retrieval.chunker import chunk_text
from harness.guides.retrieval.qdrant_store import (
    APPROVED_STATUS,
    KnowledgeQdrantStore,
    UpsertItem,
)
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.services.embeddings_client import EmbeddingsClient, EmbeddingsServiceError

logger = get_logger(__name__)

router = APIRouter(tags=["internal"])

# Stable namespace for deterministic per-chunk point ids (idempotent re-ingest).
_POINT_NS = uuid.uuid5(uuid.NAMESPACE_URL, "hope:harness:knowledge_chunks")


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def require_internal_service_token(
    request: Request,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> None:
    """Accept the dedicated ingest token OR the shared service token (constant-time).

    Empty configured tokens (both) disable the guard for local dev. Extends the
    existing ``require_service_token`` mechanism rather than replacing it, so the
    same internal surface keeps working while Lane B can present the contract's
    ``HARNESS_INTERNAL_SERVICE_TOKEN``.
    """
    settings = _settings(request)
    accepted = [
        tok
        for tok in (
            settings.internal_service_token.get_secret_value(),
            settings.service_token.get_secret_value(),
        )
        if tok
    ]
    if not accepted:
        return
    if not x_service_token or not any(
        secrets.compare_digest(x_service_token, tok) for tok in accepted
    ):
        raise HTTPException(status_code=401, detail="invalid or missing service token")


def _embeddings_client(settings: Settings) -> EmbeddingsClient:
    rc = settings.retrieval
    return EmbeddingsClient(
        rc.embeddings_base_url, model=rc.embeddings_model, timeout=rc.embeddings_timeout_s
    )


def _sparse_embedder() -> SparseBm25Embedder:
    return SparseBm25Embedder()


def _qdrant_store(settings: Settings) -> KnowledgeQdrantStore:
    rc = settings.retrieval
    return KnowledgeQdrantStore(rc.qdrant_url, rc.collection, timeout=rc.qdrant_timeout_s)


def _point_id(tenant_id: str, document_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(_POINT_NS, f"{tenant_id}:{document_id}:{chunk_index}"))


class IngestRequest(BaseModel):
    """Body for ``knowledge/ingest`` (camelCase at the Lane B boundary)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tenant_id: str = Field(alias="tenantId")
    knowledge_document_id: str = Field(alias="knowledgeDocumentId")
    title: str = ""
    source: str = ""
    mime_type: str = Field(default="text/plain", alias="mimeType")
    text: str = ""


@router.post(
    "/knowledge/ingest",
    dependencies=[Depends(require_internal_service_token)],
)
async def ingest_knowledge(body: IngestRequest, request: Request) -> dict[str, Any]:
    """Chunk -> dense+sparse embed -> upsert -> return chunk descriptors."""
    settings = _settings(request)

    chunks = chunk_text(body.text)
    if not chunks:
        return {"chunkCount": 0, "chunks": []}

    texts = [c.text for c in chunks]

    try:
        dense_vectors = await _embeddings_client(settings).embed(texts)
    except EmbeddingsServiceError as exc:
        logger.warning(
            "harness.knowledge.ingest.embeddings_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "embeddings_unavailable", "detail": str(exc)},
        ) from exc

    try:
        sparse_vectors = _sparse_embedder().embed_documents(texts)
    except Exception as exc:  # noqa: BLE001 — any sparse failure degrades the job
        logger.warning(
            "harness.knowledge.ingest.sparse_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "sparse_embeddings_unavailable", "detail": str(exc)},
        ) from exc

    items: list[UpsertItem] = []
    descriptors: list[dict[str, Any]] = []
    for i, chunk in enumerate(chunks):
        point_id = _point_id(body.tenant_id, body.knowledge_document_id, chunk.chunk_index)
        items.append(
            UpsertItem(
                point_id=point_id,
                dense=dense_vectors[i],
                sparse=sparse_vectors[i],
                payload={
                    "tenant_id": body.tenant_id,
                    "knowledge_document_id": body.knowledge_document_id,
                    "chunk_id": point_id,
                    "status": APPROVED_STATUS,
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                },
            )
        )
        descriptors.append(
            {
                "chunkIndex": chunk.chunk_index,
                "text": chunk.text,
                "qdrantPointId": point_id,
                "startOffset": chunk.start_offset,
                "endOffset": chunk.end_offset,
                "tokenCount": chunk.token_count,
                "embeddingModel": settings.retrieval.embeddings_model,
                "embeddingDim": len(dense_vectors[i]),
                "status": APPROVED_STATUS,
            }
        )

    try:
        _qdrant_store(settings).upsert_chunks(items)
    except Exception as exc:  # noqa: BLE001 — Qdrant outage degrades the job (retryable)
        logger.warning(
            "harness.knowledge.ingest.qdrant_unavailable",
            knowledge_document_id=body.knowledge_document_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail={"error": "qdrant_unavailable", "detail": str(exc)},
        ) from exc

    logger.info(
        "harness.knowledge.ingest.completed",
        knowledge_document_id=body.knowledge_document_id,
        tenant_id=body.tenant_id,
        chunk_count=len(descriptors),
    )
    return {"chunkCount": len(descriptors), "chunks": descriptors}
