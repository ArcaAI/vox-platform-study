"""Retrieval eval for the institutional-RAG hybrid retriever.

Closes the Phase-3 retrieval-eval exit-gate item ("% claims with a valid citation;
basic recall sanity") with a deterministic, offline run. It ingests a small
synthetic clinical corpus into a **real Qdrant engine** (the ``qdrant-client``
in-memory local mode) using the **real in-process fastembed BM25** sparse
embedder, then runs the **real** :class:`~harness.guides.retrieval.retriever.HybridRetriever`
for each query and scores:

* **recall@k** / **hit@k** — does the retriever surface the gold-relevant chunk(s)?
* **MRR** — mean reciprocal rank of the first relevant chunk.
* **citation-validity** — for each query, the top retrieved chunk is cited with the
  StrictCitations ``[[kb:<id>]]`` marker; "% with a valid citation" is the share of
  queries whose top citation points at a genuinely-relevant chunk (and survives the
  strict, hallucination-dropping parser).
* **cross-tenant leaks** — a same-named chunk owned by a *different* tenant must
  never be retrieved (must be 0).

Only the dense embedder (LM Studio ``/v1/embeddings`` BAAI/bge-m3) and the
cross-encoder reranker (TEI ``hope-reranker``) are stubbed — those GPU-loaded
models are a documented prerequisite handoff. So the
recall reported here is the **BM25 + RRF + tenant/APPROVED-filter** lexical
channel; the real dense + rerank channels lift it further once the models load.

**Open data prerequisite (handoff).** This runs the SYNTHETIC wiring fixture
(``retrieval_synthetic_v0.json``). The release-grade retrieval eval needs the
clinician-curated institutional golden set (N≈132 query→chunk relevance pairs),
owned + versioned by a clinical SME — drop it in via ``--golden-set`` (same shape)
with no code change.

Run it::

    conda run -n arcaenv python -m harness.eval.retrieval_eval \\
      --golden-set apps/harness/src/harness/eval/golden/fixtures/retrieval_synthetic_v0.json \\
      --output retrieval-eval.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, cast

from pydantic import BaseModel, ConfigDict
from qdrant_client import QdrantClient, models

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

_DIM = 8  # hermetic in-memory dense dim (real collection is 1024)
_COLLECTION = "knowledge_chunks"
_NS = uuid.uuid5(uuid.NAMESPACE_URL, "hope:harness:eval:retrieval")

_DEFAULT_FIXTURE = Path(__file__).parent / "golden" / "fixtures" / "retrieval_synthetic_v0.json"


def chunk_point_id(tenant_id: str, doc_id: str, chunk_index: int) -> str:
    """Deterministic point id per (tenant, doc, chunk) — mirrors the ingest endpoint."""
    return str(uuid.uuid5(_NS, f"{tenant_id}:{doc_id}:{chunk_index}"))


class _StubDense:
    """Constant dense embedder (no LM Studio): dense scores tie, BM25 ranks."""

    async def embed_one(self, text: str) -> list[float]:
        return [0.1] * _DIM


class _IdentityReranker:
    """Identity reranker (no TEI): preserve the RRF-fused order."""

    async def rerank(self, query: str, texts: list[str]) -> list[RerankResult]:
        return [RerankResult(index=i, score=1.0 - 0.001 * i) for i in range(len(texts))]


class QueryResult(BaseModel):
    """Per-query retrieval scoring."""

    model_config = ConfigDict(extra="forbid")

    query: str
    tenant_id: str
    n_relevant: int
    retrieved_ids: list[str]
    relevant_retrieved: int
    recall_at_k: float
    hit_at_k: bool
    reciprocal_rank: float
    top_citation_valid: bool
    cross_tenant_leak: int


def _make_store() -> tuple[KnowledgeQdrantStore, SparseBm25Embedder]:
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
    return (
        KnowledgeQdrantStore("http://in-memory", _COLLECTION, client=client),
        SparseBm25Embedder(),
    )


def index_corpus(
    corpus: list[dict[str, Any]], store: KnowledgeQdrantStore, sparse: SparseBm25Embedder
) -> None:
    """Upsert the synthetic corpus (real BM25 sparse + stub dense) into Qdrant."""
    texts = [c["text"] for c in corpus]
    svecs = sparse.embed_documents(texts)
    items: list[UpsertItem] = []
    for c, sv in zip(corpus, svecs, strict=True):
        pid = chunk_point_id(c["tenant_id"], c["doc_id"], c["chunk_index"])
        items.append(
            UpsertItem(
                point_id=pid,
                dense=[0.1] * _DIM,
                sparse=sv,
                payload={
                    "tenant_id": c["tenant_id"],
                    "knowledge_document_id": c["doc_id"],
                    "chunk_id": pid,
                    "status": APPROVED_STATUS,
                    "chunk_index": c["chunk_index"],
                    "text": c["text"],
                },
            )
        )
    store.upsert_chunks(items)


async def score_query(
    query: dict[str, Any],
    retriever: HybridRetriever,
    corpus_by_id: dict[str, dict[str, Any]],
) -> QueryResult:
    """Run one query and compute recall / MRR / citation-validity / leak."""
    tenant_id = query["tenant_id"]
    relevant_ids = {chunk_point_id(tenant_id, doc_id, idx) for doc_id, idx in query["relevant"]}
    result = await retriever.retrieve(query=query["query"], tenant_id=tenant_id)
    retrieved_ids = [c.chunk_id for c in result.chunks]

    relevant_retrieved = sum(1 for cid in retrieved_ids if cid in relevant_ids)
    recall = relevant_retrieved / len(relevant_ids) if relevant_ids else 0.0
    rr = 0.0
    for rank, cid in enumerate(retrieved_ids, start=1):
        if cid in relevant_ids:
            rr = 1.0 / rank
            break

    # Citation validity: cite the top retrieved chunk with the StrictCitations
    # marker; it is "valid" iff the strict parser keeps it AND it is gold-relevant.
    top_citation_valid = False
    if result.chunks:
        top_id = result.chunks[0].chunk_id
        allowed = set(retrieved_ids)
        note = f"Recommendation per protocol [[kb:{top_id}]]."
        kept = extract_cited_ids(note, allowed)
        top_citation_valid = bool(kept) and kept[0] in relevant_ids
        # Sanity: the StrictCitations block must actually list the cited id.
        block = build_strict_citations_block(result.chunks)
        assert f"id={top_id}" in block

    leaks = sum(
        1
        for cid in retrieved_ids
        if corpus_by_id.get(cid, {}).get("tenant_id", tenant_id) != tenant_id
    )

    return QueryResult(
        query=query["query"],
        tenant_id=tenant_id,
        n_relevant=len(relevant_ids),
        retrieved_ids=retrieved_ids,
        relevant_retrieved=relevant_retrieved,
        recall_at_k=round(recall, 6),
        hit_at_k=relevant_retrieved > 0,
        reciprocal_rank=round(rr, 6),
        top_citation_valid=top_citation_valid,
        cross_tenant_leak=leaks,
    )


def aggregate(results: list[QueryResult]) -> dict[str, Any]:
    n = len(results)
    if not n:
        return {"n_queries": 0}
    return {
        "n_queries": n,
        "recall_at_k_mean": round(sum(r.recall_at_k for r in results) / n, 6),
        "hit_at_k_rate": round(sum(1 for r in results if r.hit_at_k) / n, 6),
        "mrr": round(sum(r.reciprocal_rank for r in results) / n, 6),
        "citation_validity_rate": round(sum(1 for r in results if r.top_citation_valid) / n, 6),
        "cross_tenant_leaks": sum(r.cross_tenant_leak for r in results),
    }


async def run_eval(fixture: dict[str, Any], *, top_k_rerank: int = 5) -> dict[str, Any]:
    """Index the corpus, score every query, return ``{aggregate, queries, ...}``."""
    corpus = fixture["corpus"]
    store, sparse = _make_store()
    index_corpus(corpus, store, sparse)
    corpus_by_id = {
        chunk_point_id(c["tenant_id"], c["doc_id"], c["chunk_index"]): c for c in corpus
    }
    retriever = HybridRetriever(
        embeddings=_StubDense(),
        sparse=sparse,
        store=store,
        reranker=_IdentityReranker(),
        top_k_retrieval=20,
        top_k_rerank=top_k_rerank,
    )

    results: list[QueryResult] = []
    for query in fixture["queries"]:
        res = await score_query(query, retriever, corpus_by_id)
        results.append(res)
        print(
            f"  - '{res.query}' recall@{top_k_rerank}={res.recall_at_k:.3f} "
            f"rr={res.reciprocal_rank:.3f} citation_valid={res.top_citation_valid} "
            f"leak={res.cross_tenant_leak}",
            flush=True,
        )

    return {
        "golden_set_version": fixture.get("version", "unknown"),
        "channels": {
            "dense": "stubbed (BAAI/bge-m3 prerequisite)",
            "sparse": "live fastembed BM25",
            "rerank": "stubbed (TEI prerequisite)",
            "qdrant": "in-memory engine",
        },
        "top_k_rerank": top_k_rerank,
        "aggregate": aggregate(results),
        "queries": [r.model_dump() for r in results],
    }


def load_fixture(path: str | Path) -> dict[str, Any]:
    return cast("dict[str, Any]", json.loads(Path(path).read_text(encoding="utf-8")))


def _run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden-set", default=str(_DEFAULT_FIXTURE))
    parser.add_argument("--output", default="")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args(argv)

    fixture = load_fixture(args.golden_set)
    print(
        f"[retrieval-eval] golden_set='{fixture.get('version')}' "
        f"corpus={len(fixture['corpus'])} queries={len(fixture['queries'])} top_k={args.top_k}",
        flush=True,
    )
    report = asyncio.run(run_eval(fixture, top_k_rerank=args.top_k))

    print("\n[retrieval-eval] aggregate:")
    print(json.dumps(report["aggregate"], indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\n[retrieval-eval] wrote report -> {args.output}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(_run())
