"""Qdrant wrapper for the institutional ``knowledge_chunks`` collection.

Owns the named-vector shape (dense ``"dense"`` + sparse ``"bm25"``) and the two
operations the loop needs:

* :meth:`KnowledgeQdrantStore.upsert_chunks` — write one named dense+sparse point
  per chunk (used by the ingest endpoint).
* :meth:`KnowledgeQdrantStore.hybrid_query` — the Qdrant Query API hybrid:
  ``prefetch(dense)`` + ``prefetch(sparse)`` (each scoped to ``tenant_id`` +
  ``status=APPROVED``) fused by ``FusionQuery(RRF)``, mapped back to
  :class:`RetrievedPoint` value objects.

The ``tenant_id`` + ``status=APPROVED`` filter on **both** prefetch branches is
the load-bearing tenant-isolation + approval gate: only a tenant's own APPROVED
chunks are ever retrievable. The :class:`~qdrant_client.QdrantClient` is
injectable so unit tests run without a live Qdrant.

NOTE: the installed qdrant-client ``FusionQuery`` exposes only ``fusion`` (no
explicit RRF ``k``); fusion uses Qdrant's server-side RRF. The configured
``rrf_k`` is carried in :class:`~harness.core.config.RetrievalConfig` for
forward-compat but is not passed to this API version.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

from pydantic import BaseModel, ConfigDict

# `qdrant_client` is the optional `rag` extra: imported here only
# for type annotations (deferred by `from __future__ import annotations`), and
# lazily inside the methods below that actually construct/use it, so importing
# this module never requires the extra to be installed.
if TYPE_CHECKING:
    from qdrant_client import QdrantClient, models

# Named vectors + payload keys — MUST match infrastructure/docker/scripts/init-qdrant-collections.py.
DENSE_VECTOR_NAME = "dense"
SPARSE_VECTOR_NAME = "bm25"
APPROVED_STATUS = "APPROVED"


@dataclass
class UpsertItem:
    """One chunk to upsert: a stable point id + named dense/sparse vectors + payload."""

    point_id: str
    dense: list[float]
    sparse: models.SparseVector
    payload: dict[str, Any]


class RetrievedPoint(BaseModel):
    """A scored hybrid-retrieval hit (payload-projected, no Qdrant types leak out)."""

    model_config = ConfigDict(extra="forbid")

    qdrant_point_id: str
    chunk_id: str
    knowledge_document_id: str = ""
    chunk_index: int = 0
    text: str = ""
    score: float = 0.0


class KnowledgeQdrantStore:
    """Thin Qdrant wrapper over the named dense+sparse ``knowledge_chunks`` collection."""

    def __init__(
        self,
        url: str,
        collection: str,
        *,
        dense_name: str = DENSE_VECTOR_NAME,
        sparse_name: str = SPARSE_VECTOR_NAME,
        client: QdrantClient | None = None,
        timeout: float = 10.0,
        api_key: str | None = None,
    ) -> None:
        self._collection = collection
        self._dense_name = dense_name
        self._sparse_name = sparse_name
        if client is not None:
            self._client = client
        else:
            from qdrant_client import QdrantClient

            # api_key=None is the unauthenticated path qdrant-client already
            # expects, so this is safe to pass unconditionally.
            self._client = QdrantClient(
                url=url, timeout=cast(int, timeout), api_key=api_key
            )

    def upsert_chunks(self, items: list[UpsertItem]) -> int:
        """Upsert one named dense+sparse point per chunk; returns the count."""
        if not items:
            return 0
        from qdrant_client import models

        points = [
            models.PointStruct(
                id=item.point_id,
                vector={self._dense_name: item.dense, self._sparse_name: item.sparse},
                payload=item.payload,
            )
            for item in items
        ]
        self._client.upsert(collection_name=self._collection, points=points)
        return len(points)

    def hybrid_query(
        self,
        *,
        dense: list[float],
        sparse: models.SparseVector,
        tenant_id: str,
        limit: int,
        with_payload: bool = True,
    ) -> list[RetrievedPoint]:
        """Run the dense+sparse RRF hybrid, tenant + APPROVED scoped, return hits."""
        from qdrant_client import models

        flt = self._tenant_approved_filter(tenant_id)
        response = self._client.query_points(
            collection_name=self._collection,
            prefetch=[
                models.Prefetch(query=dense, using=self._dense_name, filter=flt, limit=limit),
                models.Prefetch(query=sparse, using=self._sparse_name, filter=flt, limit=limit),
            ],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            limit=limit,
            with_payload=with_payload,
        )
        return [self._to_retrieved(pt) for pt in getattr(response, "points", [])]

    @staticmethod
    def _tenant_approved_filter(tenant_id: str) -> models.Filter:
        from qdrant_client import models

        return models.Filter(
            must=[
                models.FieldCondition(key="tenant_id", match=models.MatchValue(value=tenant_id)),
                models.FieldCondition(key="status", match=models.MatchValue(value=APPROVED_STATUS)),
            ]
        )

    @staticmethod
    def _to_retrieved(point: Any) -> RetrievedPoint:
        payload = getattr(point, "payload", None) or {}
        return RetrievedPoint(
            qdrant_point_id=str(getattr(point, "id", "")),
            chunk_id=str(payload.get("chunk_id") or ""),
            knowledge_document_id=str(payload.get("knowledge_document_id") or ""),
            chunk_index=int(payload.get("chunk_index") or 0),
            text=str(payload.get("text") or ""),
            score=float(getattr(point, "score", 0.0) or 0.0),
        )
