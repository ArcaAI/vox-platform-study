"""Harness *guides* — retrieval/grounding helpers for the durable loop (TASK-330).

Phase-3 adds :mod:`harness.guides.retrieval`: a self-hosted hybrid JIT retriever
(LM Studio dense + fastembed BM25 sparse -> Qdrant RRF fusion -> TEI rerank) that
grounds generation in a tenant-owned institutional knowledge corpus. Everything
here is flag-gated (``HARNESS_RETRIEVAL_ENABLED``) and degrade-safe.
"""
