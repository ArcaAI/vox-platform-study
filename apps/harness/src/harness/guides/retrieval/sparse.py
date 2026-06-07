"""In-process fastembed ``Qdrant/bm25`` sparse embedder (TASK-330 Phase 3).

BM25 sparse vectors are produced **in-process** on CPU (no extra service): the
ingest endpoint embeds document chunks (the passage path, :meth:`embed_documents`)
and the retriever embeds the query (the query path, :meth:`embed_query`). The
collection's sparse vector uses Qdrant's IDF ``Modifier`` so BM25 IDF scoring is
applied server-side; here we only emit per-term ``(index, value)`` pairs mapped
onto a Qdrant :class:`~qdrant_client.models.SparseVector`.

The underlying fastembed model is **injectable** (constructor ``model=``) so unit
tests stay hermetic; left ``None`` it is lazily constructed on first use (the
``fastembed`` import + model fetch happen only when retrieval is actually
exercised, keeping the base import light).
"""

from __future__ import annotations

from typing import Any

from qdrant_client import models

_DEFAULT_MODEL = "Qdrant/bm25"


class SparseBm25Embedder:
    """Wrap fastembed BM25 and yield Qdrant sparse vectors (doc + query paths)."""

    def __init__(self, model_name: str = _DEFAULT_MODEL, *, model: Any | None = None) -> None:
        self._model_name = model_name
        self._model = model

    def _ensure_model(self) -> Any:
        if self._model is None:
            from fastembed import SparseTextEmbedding

            self._model = SparseTextEmbedding(model_name=self._model_name)
        return self._model

    def embed_documents(self, texts: list[str]) -> list[models.SparseVector]:
        """Embed corpus chunks (the BM25 passage path)."""
        if not texts:
            return []
        model = self._ensure_model()
        return [self._to_sparse(emb) for emb in model.embed(list(texts))]

    def embed_query(self, text: str) -> models.SparseVector:
        """Embed a single query (the BM25 query path)."""
        model = self._ensure_model()
        emb = next(iter(model.query_embed(text)))
        return self._to_sparse(emb)

    @staticmethod
    def _to_sparse(emb: Any) -> models.SparseVector:
        # fastembed yields numpy arrays; coerce to JSON-safe native ints/floats.
        return models.SparseVector(
            indices=[int(i) for i in emb.indices],
            values=[float(v) for v in emb.values],
        )
