"""Live hybrid-retrieval verification (one-off driver).

Mirrors ``harness.temporal.activities._hybrid_retriever`` (the real wiring) and
exercises the retrieve half of the loop against the LIVE stack (LM Studio bge-m3
+ Qdrant ``knowledge_chunks`` + TEI ``hope-reranker``) for the two seeded tenants:

  Tenant A (Global)  -> hypertension protocol chunk ``ad1bd3fc...``
  Tenant B (ArcaAI)  -> diabetic-foot protocol chunk ``6997cd95...``

Checks (paste-as-evidence):
  1. Tenant-A retrieval surfaces the hypertension chunk (degraded=False).
  2. Cross-tenant isolation: the SAME hypertension query under Tenant B never
     returns Tenant A's chunk (0 leaks).
  3. Graceful degrade: reranker down  -> degraded=True, empty context.
  4. Graceful degrade: embeddings down -> degraded=True, empty context.

Run:
  PYTHONPATH=apps/harness/src conda run -n arcaenv \
    python apps/harness/scripts/task_330_phase3_retrieval_check.py
"""

from __future__ import annotations

import asyncio

from harness.core.config import get_settings
from harness.guides.retrieval.qdrant_store import KnowledgeQdrantStore
from harness.guides.retrieval.retriever import HybridRetriever
from harness.guides.retrieval.sparse import SparseBm25Embedder
from harness.services.embeddings_client import EmbeddingsClient
from harness.services.reranker_client import RerankerClient
from harness.temporal.activities import _hybrid_retriever

TENANT_A = "50000000-0000-0000-0000-000000000000"
TENANT_B = "50000000-0000-0000-0000-000000000001"
CHUNK_A = "ad1bd3fc-bb10-52d5-b3c5-adb8c5360ae5"  # hypertension (Tenant A)
CHUNK_B = "6997cd95-3ac8-59ab-97e8-5be8dcfaeacb"  # diabetic foot (Tenant B)

QUERY = (
    "first-line antihypertensive agents and blood pressure target for an adult "
    "with stage 2 hypertension and follow-up cadence"
)


def _dump(tag: str, result) -> None:
    print(f"\n[{tag}] degraded={result.degraded} n_chunks={len(result.chunks)}")
    for c in result.chunks:
        print(f"    chunk_id={c.chunk_id} score={round(c.score, 4)} doc={c.knowledge_document_id}")
        print(f"        text={c.text[:90]!r}")


async def main() -> None:
    settings = get_settings()
    rc = settings.retrieval
    print("=== RetrievalConfig (live) ===")
    print(f"  qdrant={rc.qdrant_url} collection={rc.collection}")
    print(f"  embeddings={rc.embeddings_base_url} model={rc.embeddings_model} dim={rc.embeddings_dim}")
    print(f"  reranker={rc.reranker_base_url} top_k_retrieval={rc.top_k_retrieval} top_k_rerank={rc.top_k_rerank}")

    retriever = _hybrid_retriever(settings)

    # 1) Tenant-A positive retrieval.
    ra = await retriever.retrieve(query=QUERY, tenant_id=TENANT_A)
    _dump("A: tenant-A hypertension query", ra)
    a_ok = (not ra.degraded) and any(c.chunk_id == CHUNK_A for c in ra.chunks)
    print(f"  => TENANT-A RETRIEVAL: {'PASS' if a_ok else 'FAIL'} (expected chunk {CHUNK_A})")

    # 2) Cross-tenant isolation: same query, Tenant B scope.
    rb = await retriever.retrieve(query=QUERY, tenant_id=TENANT_B)
    _dump("B: tenant-B same hypertension query (isolation)", rb)
    leaks = [c.chunk_id for c in rb.chunks if c.chunk_id == CHUNK_A]
    foreign = [c.chunk_id for c in rb.chunks if c.knowledge_document_id and c.chunk_id == CHUNK_A]
    iso_ok = len(leaks) == 0
    print(f"  => CROSS-TENANT ISOLATION: {'PASS' if iso_ok else 'FAIL'} (tenant-A leaks into B: {leaks or 0})")

    # 3) Degrade: reranker down (unroutable port).
    degr_rerank = HybridRetriever(
        embeddings=EmbeddingsClient(
            rc.embeddings_base_url, model=rc.embeddings_model, timeout=rc.embeddings_timeout_s
        ),
        sparse=SparseBm25Embedder(),
        store=KnowledgeQdrantStore(rc.qdrant_url, rc.collection, timeout=rc.qdrant_timeout_s),
        reranker=RerankerClient("http://localhost:9", timeout=3.0),
        top_k_retrieval=rc.top_k_retrieval,
        top_k_rerank=rc.top_k_rerank,
    )
    rd = await degr_rerank.retrieve(query=QUERY, tenant_id=TENANT_A)
    _dump("DEGRADE: reranker down", rd)
    d1_ok = rd.degraded and not rd.chunks
    print(f"  => GRACEFUL DEGRADE (reranker down): {'PASS' if d1_ok else 'FAIL'}")

    # 4) Degrade: embeddings down (unroutable port).
    degr_embed = HybridRetriever(
        embeddings=EmbeddingsClient("http://localhost:9/v1", model=rc.embeddings_model, timeout=3.0),
        sparse=SparseBm25Embedder(),
        store=KnowledgeQdrantStore(rc.qdrant_url, rc.collection, timeout=rc.qdrant_timeout_s),
        reranker=RerankerClient(rc.reranker_base_url, timeout=rc.reranker_timeout_s),
        top_k_retrieval=rc.top_k_retrieval,
        top_k_rerank=rc.top_k_rerank,
    )
    re_ = await degr_embed.retrieve(query=QUERY, tenant_id=TENANT_A)
    _dump("DEGRADE: embeddings down", re_)
    d2_ok = re_.degraded and not re_.chunks
    print(f"  => GRACEFUL DEGRADE (embeddings down): {'PASS' if d2_ok else 'FAIL'}")

    print("\n===== SUMMARY =====")
    print(f"  tenant-A retrieval     : {'PASS' if a_ok else 'FAIL'}")
    print(f"  cross-tenant isolation : {'PASS' if iso_ok else 'FAIL'}")
    print(f"  degrade (reranker)     : {'PASS' if d1_ok else 'FAIL'}")
    print(f"  degrade (embeddings)   : {'PASS' if d2_ok else 'FAIL'}")


if __name__ == "__main__":
    asyncio.run(main())
