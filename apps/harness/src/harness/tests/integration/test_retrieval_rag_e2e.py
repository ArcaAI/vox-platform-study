"""Deterministic RAG e2e (verification).

These tests exercise the institutional-RAG retrieve path end-to-end against a
**real Qdrant engine** (the ``qdrant-client`` in-memory local mode) and the
**real in-process fastembed BM25** sparse embedder — the two pieces that don't
need a live service. Only the dense embedder (LM Studio ``/v1/embeddings``,
BAAI/bge-m3) and the cross-encoder reranker (TEI ``hope-reranker``) are stubbed,
because they require GPU-loaded models that are a documented prerequisite handoff.
That is exactly the "use mocked/seeded Qdrant"
deterministic subset the plan calls for when the embedding/reranker models can't
be loaded.

What this proves WITHOUT any live model:
  * **ingest -> retrieve -> cite**: the real ``/api/v1/internal/knowledge/ingest``
    endpoint chunks + (sparse-)embeds + upserts into the real Qdrant engine, and
    the real :class:`HybridRetriever` then retrieves the just-ingested chunk and
    the StrictCitations block carries its id (a generated note citing that id is
    strict-parsed, a hallucinated id is dropped).
  * **cross-tenant isolation**: the ``tenant_id`` filter is enforced by the real
    Qdrant engine (not just constructed) — tenant B never sees tenant A's chunks.
  * **APPROVED gate**: a non-APPROVED chunk for the SAME tenant is unretrievable.
  * **degrade-safe**: a backend outage yields an empty context flagged
    ``degraded=True`` (the reduced-assurance signal) and never raises.

The live ingest->embed->retrieve->rerank->cite path with the real BAAI/bge-m3
1024-dim embeddings + TEI reranker is gated behind ``HARNESS_RAG_E2E_LIVE`` and
skipped here (the models are the open prerequisite).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from qdrant_client import QdrantClient, models

import harness.api.endpoints.knowledge as knowledge
from harness.core.config import Settings
from harness.guides.retrieval.prompt import build_strict_citations_block, extract_cited_ids
from harness.guides.retrieval.qdrant_store import (
    APPROVED_STATUS,
    DENSE_VECTOR_NAME,
    SPARSE_VECTOR_NAME,
    KnowledgeQdrantStore,
    UpsertItem,
)
from harness.guides.retrieval.retriever import HybridRetriever
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.services.reranker_client import RerankResult

# Small dense dim for the hermetic collection (the real collection is 1024;
# dimension only needs to be self-consistent inside this in-memory engine).
_DIM = 8
_COLLECTION = "knowledge_chunks"
_NS = uuid.uuid5(uuid.NAMESPACE_URL, "hope:harness:test:knowledge")


def _pid(tenant: str, doc: str, idx: int) -> str:
    return str(uuid.uuid5(_NS, f"{tenant}:{doc}:{idx}"))


class _StubDense:
    """Constant dense embedder (no LM Studio). Covers both the ingest (``embed``)
    and the retriever (``embed_one``) shapes. Dense scores tie, so BM25 sparse
    provides the lexical ranking — fine for isolation/approval assertions."""

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * _DIM for _ in texts]

    async def embed_one(self, text: str) -> list[float]:
        return [0.1] * _DIM


class _IdentityReranker:
    """Identity reranker (no TEI): preserves the fused order, score by position."""

    async def rerank(self, query: str, texts: list[str]) -> list[RerankResult]:
        return [RerankResult(index=i, score=1.0 - 0.01 * i) for i in range(len(texts))]


@pytest.fixture(scope="module")
def sparse_embedder() -> SparseBm25Embedder:
    """The REAL in-process fastembed BM25 embedder (module-scoped: load once)."""
    return SparseBm25Embedder()


@pytest.fixture
def qdrant_client() -> Iterator[QdrantClient]:
    """A real in-memory Qdrant engine with the named dense+sparse collection."""
    client = QdrantClient(":memory:")
    client.create_collection(
        _COLLECTION,
        vectors_config={
            DENSE_VECTOR_NAME: models.VectorParams(size=_DIM, distance=models.Distance.COSINE)
        },
        sparse_vectors_config={
            SPARSE_VECTOR_NAME: models.SparseVectorParams(modifier=models.Modifier.IDF)
        },
    )
    yield client
    client.close()


@pytest.fixture
def store(qdrant_client: QdrantClient) -> KnowledgeQdrantStore:
    return KnowledgeQdrantStore("http://in-memory", _COLLECTION, client=qdrant_client)


def _retriever(store: KnowledgeQdrantStore, sparse: SparseBm25Embedder) -> HybridRetriever:
    return HybridRetriever(
        embeddings=_StubDense(),
        sparse=sparse,
        store=store,
        reranker=_IdentityReranker(),
        top_k_retrieval=20,
        top_k_rerank=5,
    )


def _seed(
    store: KnowledgeQdrantStore,
    sparse: SparseBm25Embedder,
    tenant: str,
    doc: str,
    texts: list[str],
    *,
    status: str = APPROVED_STATUS,
    start: int = 0,
) -> list[str]:
    """Upsert chunks for one tenant/doc with real BM25 sparse vectors; return ids."""
    svecs = sparse.embed_documents(texts)
    items: list[UpsertItem] = []
    ids: list[str] = []
    for i, (text, sv) in enumerate(zip(texts, svecs, strict=True), start=start):
        pid = _pid(tenant, doc, i)
        ids.append(pid)
        items.append(
            UpsertItem(
                point_id=pid,
                dense=[0.1] * _DIM,
                sparse=sv,
                payload={
                    "tenant_id": tenant,
                    "knowledge_document_id": doc,
                    "chunk_id": pid,
                    "status": status,
                    "chunk_index": i,
                    "text": text,
                },
            )
        )
    store.upsert_chunks(items)
    return ids


# ---------------------------------------------------------------------------
# ingest endpoint -> retrieve -> cite (real Qdrant engine + real BM25)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def ingest_http(monkeypatch, store, sparse_embedder):
    """The REAL ingest FastAPI app, wired to the in-memory store + real BM25 +
    the stub dense embedder (guard disabled via empty tokens)."""
    settings = Settings(internal_service_token="", service_token="", log_level="debug")
    from harness.main import create_app

    fastapi_app = create_app(settings_override=settings)
    monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: _StubDense())
    monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: sparse_embedder)
    monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: store)
    transport = ASGITransport(app=fastapi_app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


class TestIngestRetrieveCite:
    @pytest.mark.asyncio
    async def test_ingested_doc_is_retrievable_and_citable(
        self, ingest_http, store, sparse_embedder
    ):
        text = (
            "Sepsis bundle: administer broad-spectrum antibiotics within one hour. "
            "Order serum lactate and obtain blood cultures before antibiotics."
        )
        resp = await ingest_http.post(
            "/api/v1/internal/knowledge/ingest",
            json={
                "tenantId": "tenant-A",
                "knowledgeDocumentId": "doc-sepsis",
                "title": "Sepsis Protocol",
                "source": "protocols/sepsis.md",
                "mimeType": "text/markdown",
                "text": text,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["chunkCount"] >= 1
        ingested_ids = {c["qdrantPointId"] for c in body["chunks"]}

        # Retrieve with the REAL retriever against the SAME in-memory Qdrant.
        retriever = _retriever(store, sparse_embedder)
        result = await retriever.retrieve(query="sepsis lactate antibiotics", tenant_id="tenant-A")
        assert result.degraded is False
        assert result.chunks, "the just-ingested chunk must be retrievable"
        retrieved_ids = {c.chunk_id for c in result.chunks}
        assert retrieved_ids & ingested_ids, "retrieved ids must match the ingested chunk ids"

        # The StrictCitations block carries the retrieved chunk id...
        block = build_strict_citations_block(result.chunks)
        cited_id = result.chunks[0].chunk_id
        assert f"id={cited_id}" in block
        assert "[[kb:" in block

        # ...and a generated note citing that id is strict-parsed, while a
        # hallucinated id is dropped (so citationsMap never gets a fake id).
        allowed = {c.chunk_id for c in result.chunks}
        note = (
            f"Plan: start antibiotics within one hour [[kb:{cited_id}]]. "
            f"Draw lactate [[kb:{uuid.uuid4()}]]."  # hallucinated id
        )
        kept = extract_cited_ids(note, allowed)
        assert kept == [cited_id], "only retrieved (allowed) ids survive strict citation parsing"


# ---------------------------------------------------------------------------
# cross-tenant isolation + APPROVED gate (filter enforced by the real engine)
# ---------------------------------------------------------------------------


class TestCrossTenantIsolation:
    @pytest.mark.asyncio
    async def test_tenant_b_cannot_retrieve_tenant_a_chunks(self, store, sparse_embedder):
        a_ids = _seed(
            store,
            sparse_embedder,
            "tenant-A",
            "doc-a",
            [
                "Sepsis bundle antibiotics within one hour.",
                "Order serum lactate and blood cultures.",
            ],
        )
        b_ids = _seed(
            store,
            sparse_embedder,
            "tenant-B",
            "doc-b",
            ["Tenant B oncology chemotherapy protocol."],
        )
        retriever = _retriever(store, sparse_embedder)

        # The SAME clinical query, run for each tenant. Tenant B shares no terms,
        # but even a term-overlapping query must never cross the tenant boundary.
        res_a = await retriever.retrieve(query="sepsis lactate antibiotics", tenant_id="tenant-A")
        res_b = await retriever.retrieve(query="sepsis lactate antibiotics", tenant_id="tenant-B")

        a_hits = {c.chunk_id for c in res_a.chunks}
        b_hits = {c.chunk_id for c in res_b.chunks}
        assert a_hits and a_hits <= set(a_ids), "tenant A sees only its own chunks"
        assert b_hits <= set(b_ids), "tenant B sees ONLY its own chunks (no tenant-A leak)"
        assert not (b_hits & set(a_ids)), "tenant-A chunks must never appear for tenant B"

    @pytest.mark.asyncio
    async def test_non_approved_chunks_are_not_retrievable(self, store, sparse_embedder):
        approved = _seed(
            store,
            sparse_embedder,
            "tenant-A",
            "doc-a",
            ["Approved hypertension management guidance."],
        )
        draft = _seed(
            store,
            sparse_embedder,
            "tenant-A",
            "doc-a",
            ["Draft hypertension management guidance pending review."],
            status="DRAFT",
            start=50,
        )
        retriever = _retriever(store, sparse_embedder)
        result = await retriever.retrieve(
            query="hypertension management guidance", tenant_id="tenant-A"
        )
        hits = {c.chunk_id for c in result.chunks}
        assert hits == set(approved), "only APPROVED chunks are retrievable"
        assert not (hits & set(draft)), "a DRAFT chunk must never be retrievable"


# ---------------------------------------------------------------------------
# degrade-safe (reduced-assurance signal, never raises)
# ---------------------------------------------------------------------------


class TestDegradeSafe:
    @pytest.mark.asyncio
    async def test_qdrant_outage_degrades_to_empty_flagged(self, sparse_embedder):
        # A store pointed at a dead Qdrant address; the retriever must not raise.
        dead = KnowledgeQdrantStore("http://127.0.0.1:6/none", _COLLECTION, timeout=1.0)
        retriever = HybridRetriever(
            embeddings=_StubDense(),
            sparse=sparse_embedder,
            store=dead,
            reranker=_IdentityReranker(),
        )
        result = await retriever.retrieve(query="sepsis", tenant_id="tenant-A")
        assert result.chunks == []
        assert result.degraded is True
        # The empty, degraded context yields an empty StrictCitations block, so
        # generation proceeds ungrounded + flagged (reduced assurance).
        assert build_strict_citations_block(result.chunks) == ""
