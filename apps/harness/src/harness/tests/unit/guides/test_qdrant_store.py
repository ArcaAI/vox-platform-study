"""Qdrant knowledge-store wrapper tests.

The wrapper owns the named dense+sparse ``knowledge_chunks`` shape and the hybrid
Query API call. The Qdrant client is mocked, so these tests assert pure wiring:
upsert builds a named-vector ``PointStruct`` per chunk; the hybrid query issues
``prefetch(dense)`` + ``prefetch(sparse)`` (each scoped to ``tenant_id`` +
``status=APPROVED``) fused by ``FusionQuery(RRF)`` and maps the scored points back
to ``RetrievedPoint`` value objects. Tenant isolation is enforced in the filter.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock

from qdrant_client import models

from harness.guides.retrieval.qdrant_store import (
    APPROVED_STATUS,
    KnowledgeQdrantStore,
    RetrievedPoint,
    UpsertItem,
)


def _store(client: MagicMock) -> KnowledgeQdrantStore:
    return KnowledgeQdrantStore("http://qdrant:6333", "knowledge_chunks", client=client)


def _match_values(flt: models.Filter) -> dict[str, object]:
    conditions = cast("list[models.FieldCondition]", flt.must or [])
    return {c.key: cast("models.MatchValue", c.match).value for c in conditions}


class TestUpsert:
    def test_builds_named_dense_and_sparse_point_structs(self):
        client = MagicMock()
        store = _store(client)
        item = UpsertItem(
            point_id="11111111-1111-1111-1111-111111111111",
            dense=[0.1, 0.2, 0.3],
            sparse=models.SparseVector(indices=[3, 7], values=[1.0, 2.0]),
            payload={
                "tenant_id": "t-1",
                "knowledge_document_id": "kd-1",
                "chunk_id": "kc-1",
                "status": APPROVED_STATUS,
                "chunk_index": 0,
                "text": "chunk text",
            },
        )

        count = store.upsert_chunks([item])
        assert count == 1

        client.upsert.assert_called_once()
        _args, kwargs = client.upsert.call_args
        assert kwargs["collection_name"] == "knowledge_chunks"
        point = kwargs["points"][0]
        assert isinstance(point, models.PointStruct)
        assert point.id == "11111111-1111-1111-1111-111111111111"
        assert point.vector["dense"] == [0.1, 0.2, 0.3]
        assert isinstance(point.vector["bm25"], models.SparseVector)
        assert point.vector["bm25"].indices == [3, 7]
        assert point.payload["chunk_id"] == "kc-1"
        assert point.payload["status"] == APPROVED_STATUS

    def test_empty_upsert_is_a_no_op(self):
        client = MagicMock()
        assert _store(client).upsert_chunks([]) == 0
        client.upsert.assert_not_called()


class TestHybridQuery:
    def _response(self):
        return SimpleNamespace(
            points=[
                SimpleNamespace(
                    id="pt-1",
                    score=0.91,
                    payload={
                        "chunk_id": "kc-1",
                        "knowledge_document_id": "kd-1",
                        "chunk_index": 2,
                        "text": "hypertension guidance",
                    },
                ),
                SimpleNamespace(
                    id="pt-2",
                    score=0.42,
                    payload={
                        "chunk_id": "kc-2",
                        "knowledge_document_id": "kd-1",
                        "chunk_index": 5,
                        "text": "diabetes guidance",
                    },
                ),
            ]
        )

    def test_issues_rrf_fusion_over_dense_and_sparse_prefetch(self):
        client = MagicMock()
        client.query_points.return_value = self._response()
        store = _store(client)

        results = store.hybrid_query(
            dense=[0.1, 0.2],
            sparse=models.SparseVector(indices=[1], values=[1.0]),
            tenant_id="t-1",
            limit=20,
        )

        _args, kwargs = client.query_points.call_args
        assert kwargs["collection_name"] == "knowledge_chunks"
        # Fusion is RRF over two prefetch branches (dense + sparse).
        assert isinstance(kwargs["query"], models.FusionQuery)
        assert kwargs["query"].fusion == models.Fusion.RRF
        prefetch = kwargs["prefetch"]
        assert len(prefetch) == 2
        usings = {p.using for p in prefetch}
        assert usings == {"dense", "bm25"}
        # Every branch is tenant + APPROVED scoped (tenant isolation + approval gate).
        for p in prefetch:
            assert _match_values(p.filter) == {"tenant_id": "t-1", "status": APPROVED_STATUS}
            assert p.limit == 20
        assert kwargs["limit"] == 20
        assert kwargs["with_payload"] is True

        # Scored points map onto RetrievedPoint value objects.
        assert [r.chunk_id for r in results] == ["kc-1", "kc-2"]
        assert results[0] == RetrievedPoint(
            qdrant_point_id="pt-1",
            chunk_id="kc-1",
            knowledge_document_id="kd-1",
            chunk_index=2,
            text="hypertension guidance",
            score=0.91,
        )

    def test_tenant_b_filter_does_not_leak_tenant_a(self):
        client = MagicMock()
        client.query_points.return_value = SimpleNamespace(points=[])
        store = _store(client)
        store.hybrid_query(
            dense=[0.1],
            sparse=models.SparseVector(indices=[1], values=[1.0]),
            tenant_id="tenant-b",
            limit=5,
        )
        _args, kwargs = client.query_points.call_args
        for p in kwargs["prefetch"]:
            assert _match_values(p.filter)["tenant_id"] == "tenant-b"
