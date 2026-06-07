"""JIT hybrid retriever — the retrieve half of TASK-330 Phase 3 (plan §D).

Pipeline: a query built from the extracted entities is dense-embedded (LM Studio)
**and** sparse-embedded (in-process fastembed BM25); the two are fused server-side
by the Qdrant Query API (``prefetch(dense)`` + ``prefetch(sparse)`` ->
``FusionQuery(RRF)``) scoped to ``tenant_id`` + ``status=APPROVED``; the fused
candidates are reranked by the HF TEI cross-encoder and truncated to top-k.

**Degrade-safe is the load-bearing invariant**: if ANY backend (embeddings, Qdrant,
reranker) is unavailable the retriever yields an empty context with
``degraded=True`` — generation proceeds (flagged as reduced assurance), it never
raises into the durable workflow. An empty *result set* from healthy backends is
**not** a degrade (there was simply nothing relevant to cite).

The collaborators are duck-typed + injected so the retriever is unit-testable
without live LM Studio / Qdrant / TEI; the ``retrieve_context`` activity wires the
concrete clients.
"""

from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict
from qdrant_client import models

from harness.core.logging import get_logger
from harness.guides.retrieval.qdrant_store import RetrievedPoint
from harness.sensors.base import NEREntity
from harness.services.reranker_client import RerankResult

logger = get_logger(__name__)


class RetrievedChunk(BaseModel):
    """A retrieved, reranked knowledge chunk surfaced to generation + verification."""

    model_config = ConfigDict(extra="forbid")

    chunk_id: str
    text: str
    score: float = 0.0
    knowledge_document_id: str = ""
    chunk_index: int = 0


class RetrievalResult(BaseModel):
    """Retriever output: the top-k chunks + whether a backend forced a degrade."""

    model_config = ConfigDict(extra="forbid")

    chunks: list[RetrievedChunk] = []
    degraded: bool = False


def build_query(entities: list[NEREntity]) -> str:
    """Build the retrieval query from extracted entities.

    De-duplicated by normalized form (so ``"Hypertension"`` and ``"hypertension"``
    collapse) while keeping each term's first surface form, joined by spaces.
    """
    seen: set[str] = set()
    terms: list[str] = []
    for entity in entities:
        surface = entity.text.strip()
        norm = entity.normalized
        if not surface or not norm or norm in seen:
            continue
        seen.add(norm)
        terms.append(surface)
    return " ".join(terms)


class _Embeddings(Protocol):
    async def embed_one(self, text: str) -> list[float]: ...


class _Sparse(Protocol):
    def embed_query(self, text: str) -> models.SparseVector: ...


class _Store(Protocol):
    def hybrid_query(
        self, *, dense: list[float], sparse: models.SparseVector, tenant_id: str, limit: int
    ) -> list[RetrievedPoint]: ...


class _Reranker(Protocol):
    async def rerank(self, query: str, texts: list[str]) -> list[RerankResult]: ...


class HybridRetriever:
    """Dense+sparse -> RRF -> rerank -> top-k, with a fail-to-empty degrade path."""

    def __init__(
        self,
        *,
        embeddings: _Embeddings,
        sparse: _Sparse,
        store: _Store,
        reranker: _Reranker,
        top_k_retrieval: int = 20,
        top_k_rerank: int = 5,
    ) -> None:
        self._embeddings = embeddings
        self._sparse = sparse
        self._store = store
        self._reranker = reranker
        self._top_k_retrieval = top_k_retrieval
        self._top_k_rerank = top_k_rerank

    async def retrieve(self, *, query: str, tenant_id: str) -> RetrievalResult:
        """Run the hybrid pipeline; degrade to an empty context on any backend outage."""
        if not query.strip() or not tenant_id:
            return RetrievalResult()

        try:
            dense = await self._embeddings.embed_one(query)
            sparse = self._sparse.embed_query(query)
        except Exception as exc:  # noqa: BLE001 — embed outage degrades, never raises
            logger.warning("harness.retrieval.embeddings_unavailable", error=str(exc))
            return RetrievalResult(degraded=True)

        try:
            points = self._store.hybrid_query(
                dense=dense, sparse=sparse, tenant_id=tenant_id, limit=self._top_k_retrieval
            )
        except Exception as exc:  # noqa: BLE001 — Qdrant outage degrades, never raises
            logger.warning("harness.retrieval.qdrant_unavailable", error=str(exc))
            return RetrievalResult(degraded=True)

        if not points:
            return RetrievalResult()

        try:
            ranked = await self._reranker.rerank(query, [p.text for p in points])
        except Exception as exc:  # noqa: BLE001 — reranker outage degrades, never raises
            logger.warning("harness.retrieval.reranker_unavailable", error=str(exc))
            return RetrievalResult(degraded=True)

        chunks: list[RetrievedChunk] = []
        for r in ranked[: self._top_k_rerank]:
            if 0 <= r.index < len(points):
                chunks.append(self._to_chunk(points[r.index], r.score))
        return RetrievalResult(chunks=chunks)

    @staticmethod
    def _to_chunk(point: RetrievedPoint, score: float) -> RetrievedChunk:
        return RetrievedChunk(
            chunk_id=point.chunk_id,
            text=point.text,
            score=score,
            knowledge_document_id=point.knowledge_document_id,
            chunk_index=point.chunk_index,
        )
