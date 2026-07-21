"""JIT hybrid retriever tests.

The retriever is the retrieve half of the pipeline: build a query from the extracted
entities -> dense (LM Studio) + sparse (fastembed) embed -> Qdrant hybrid RRF
(tenant + APPROVED scoped) -> TEI rerank -> top-k. Every backend is faked so these
tests assert the wiring, the top-k truncation/reorder, and — the load-bearing
invariant — that ANY backend failure DEGRADES to an empty context (``degraded=True``)
and never raises into the durable loop.
"""

from __future__ import annotations

import pytest
from qdrant_client import models

from harness.guides.retrieval.qdrant_store import RetrievedPoint
from harness.guides.retrieval.retriever import HybridRetriever, build_query
from harness.sensors.base import NEREntity
from harness.services.reranker_client import RerankResult


class _Emb:
    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    async def embed_one(self, text: str) -> list[float]:
        if self._error:
            raise self._error
        return [0.1, 0.2, 0.3]


class _Sparse:
    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    def embed_query(self, text: str) -> models.SparseVector:
        if self._error:
            raise self._error
        return models.SparseVector(indices=[1], values=[1.0])


class _Store:
    def __init__(self, points, *, error: Exception | None = None) -> None:
        self._points = points
        self._error = error
        self.calls: list[dict] = []

    def hybrid_query(self, **kwargs) -> list[RetrievedPoint]:
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return list(self._points)


class _Reranker:
    def __init__(self, results, *, error: Exception | None = None) -> None:
        self._results = results
        self._error = error
        self.calls: list[tuple] = []

    async def rerank(self, query: str, texts: list[str]) -> list[RerankResult]:
        self.calls.append((query, list(texts)))
        if self._error:
            raise self._error
        return list(self._results)


def _points() -> list[RetrievedPoint]:
    return [
        RetrievedPoint(
            qdrant_point_id=f"pt-{i}",
            chunk_id=f"kc-{i}",
            knowledge_document_id="kd-1",
            chunk_index=i,
            text=f"chunk {i}",
            score=0.5,
        )
        for i in range(3)
    ]


def _retriever(
    emb, sparse, store, reranker, *, top_k_retrieval=20, top_k_rerank=2
) -> HybridRetriever:
    return HybridRetriever(
        embeddings=emb,
        sparse=sparse,
        store=store,
        reranker=reranker,
        top_k_retrieval=top_k_retrieval,
        top_k_rerank=top_k_rerank,
    )


class TestBuildQuery:
    def test_joins_deduped_entity_surface_forms(self):
        entities = [
            NEREntity(text="hypertension"),
            NEREntity(text="Hypertension"),  # dup (normalized)
            NEREntity(text="metformin"),
        ]
        assert build_query(entities) == "hypertension metformin"

    def test_empty_entities_yields_empty_query(self):
        assert build_query([]) == ""


class TestRetrieveHappyPath:
    @pytest.mark.asyncio
    async def test_hybrid_then_rerank_then_topk(self):
        store = _Store(_points())
        # Rerank says chunk 2 is best, then 0 (chunk 1 drops out of top-2).
        reranker = _Reranker(
            [
                RerankResult(index=2, score=0.99),
                RerankResult(index=0, score=0.80),
                RerankResult(index=1, score=0.10),
            ]
        )
        retriever = _retriever(
            _Emb(), _Sparse(), store, reranker, top_k_retrieval=20, top_k_rerank=2
        )

        result = await retriever.retrieve(query="chest pain", tenant_id="t-1")

        assert result.degraded is False
        assert [c.chunk_id for c in result.chunks] == ["kc-2", "kc-0"]
        assert result.chunks[0].score == 0.99
        # Qdrant scoped to the tenant with the configured retrieval depth.
        assert store.calls[0]["tenant_id"] == "t-1"
        assert store.calls[0]["limit"] == 20
        # Reranker scored the fused candidate texts.
        assert reranker.calls[0][1] == ["chunk 0", "chunk 1", "chunk 2"]

    @pytest.mark.asyncio
    async def test_no_hits_is_empty_not_degraded(self):
        reranker = _Reranker([])
        retriever = _retriever(_Emb(), _Sparse(), _Store([]), reranker)
        result = await retriever.retrieve(query="q", tenant_id="t-1")
        assert result.chunks == []
        assert result.degraded is False
        assert reranker.calls == []  # nothing to rerank

    @pytest.mark.asyncio
    async def test_blank_query_or_tenant_short_circuits(self):
        store = _Store(_points())
        retriever = _retriever(_Emb(), _Sparse(), store, _Reranker([]))
        assert (await retriever.retrieve(query="   ", tenant_id="t-1")).chunks == []
        assert (await retriever.retrieve(query="q", tenant_id="")).chunks == []
        assert store.calls == []  # never touched a backend


class TestRetrieveDegradeSafe:
    @pytest.mark.asyncio
    async def test_embeddings_down_degrades_to_empty(self):
        retriever = _retriever(
            _Emb(error=RuntimeError("lmstudio down")), _Sparse(), _Store(_points()), _Reranker([])
        )
        result = await retriever.retrieve(query="q", tenant_id="t-1")
        assert result.chunks == []
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_qdrant_down_degrades_to_empty(self):
        retriever = _retriever(
            _Emb(), _Sparse(), _Store([], error=RuntimeError("qdrant down")), _Reranker([])
        )
        result = await retriever.retrieve(query="q", tenant_id="t-1")
        assert result.chunks == []
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_reranker_down_degrades_to_empty(self):
        retriever = _retriever(
            _Emb(), _Sparse(), _Store(_points()), _Reranker([], error=RuntimeError("tei down"))
        )
        result = await retriever.retrieve(query="q", tenant_id="t-1")
        assert result.chunks == []
        assert result.degraded is True
