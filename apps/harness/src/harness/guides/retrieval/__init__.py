"""Institutional-RAG hybrid retrieval package.

Components:

* :mod:`~harness.guides.retrieval.chunker` — deterministic token-window chunker
  (used by the ingest endpoint to slice an approved document into chunks).
* :mod:`~harness.guides.retrieval.sparse` — in-process fastembed ``Qdrant/bm25``
  sparse embedder (CPU, no extra service).
* :mod:`~harness.guides.retrieval.qdrant_store` — thin Qdrant wrapper over the
  named dense+sparse ``knowledge_chunks`` collection (upsert + hybrid Query API).
* :mod:`~harness.guides.retrieval.retriever` — the JIT hybrid retriever
  (dense+sparse -> RRF -> TEI rerank -> top-k), degrade-safe.
* :mod:`~harness.guides.retrieval.prompt` — StrictCitations context-block builder
  (tags each retrieved chunk so the model can cite it per claim).
"""

from __future__ import annotations

from harness.guides.retrieval.chunker import Chunk, chunk_text

__all__ = ["Chunk", "chunk_text"]
