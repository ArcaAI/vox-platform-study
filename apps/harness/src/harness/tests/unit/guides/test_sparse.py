"""fastembed BM25 sparse-embedder tests.

The sparse embedder wraps fastembed's in-process ``Qdrant/bm25`` model and maps
its ``SparseEmbedding`` (indices/values) onto a Qdrant
:class:`~qdrant_client.models.SparseVector`. The fastembed model is injectable so
the unit tests stay hermetic (no model download); a single real smoke test
exercises the live model and skips when it is unavailable offline.
"""

from __future__ import annotations

import pytest
from qdrant_client import models

from harness.guides.retrieval.sparse import SparseBm25Embedder


class _FakeEmbedding:
    def __init__(self, indices, values):
        self.indices = indices
        self.values = values


class _FakeModel:
    """Stand-in fastembed model recording which path (doc vs query) was used."""

    def __init__(self):
        self.embed_calls: list[list[str]] = []
        self.query_calls: list[str] = []

    def embed(self, texts):
        self.embed_calls.append(list(texts))
        for _ in texts:
            yield _FakeEmbedding([10, 20], [1.5, 2.5])

    def query_embed(self, text):
        self.query_calls.append(text)
        yield _FakeEmbedding([10], [1.0])


class TestSparseEmbedder:
    def test_embed_documents_maps_to_qdrant_sparse_vectors(self):
        fake = _FakeModel()
        emb = SparseBm25Embedder(model=fake)
        vectors = emb.embed_documents(["doc one", "doc two"])

        assert len(vectors) == 2
        assert all(isinstance(v, models.SparseVector) for v in vectors)
        assert vectors[0].indices == [10, 20]
        assert vectors[0].values == [1.5, 2.5]
        assert fake.embed_calls == [["doc one", "doc two"]]
        assert fake.query_calls == []  # documents use the passage path

    def test_embed_query_uses_query_path(self):
        fake = _FakeModel()
        emb = SparseBm25Embedder(model=fake)
        vec = emb.embed_query("hypertension")

        assert isinstance(vec, models.SparseVector)
        assert vec.indices == [10]
        assert vec.values == [1.0]
        assert fake.query_calls == ["hypertension"]
        assert fake.embed_calls == []  # queries use the query path

    def test_indices_and_values_are_native_python_types(self):
        # Even when fastembed yields numpy arrays, the Qdrant payload must be JSON-safe.
        np = pytest.importorskip("numpy")
        fake_emb = _FakeEmbedding(np.array([3, 4], dtype=np.int64), np.array([0.7, 0.8]))

        class _Np:
            def embed(self, texts):
                for _ in texts:
                    yield fake_emb

        vec = SparseBm25Embedder(model=_Np()).embed_documents(["x"])[0]
        assert vec.indices == [3, 4]
        assert all(isinstance(i, int) for i in vec.indices)
        assert all(isinstance(v, float) for v in vec.values)

    def test_empty_documents_short_circuits(self):
        fake = _FakeModel()
        assert SparseBm25Embedder(model=fake).embed_documents([]) == []
        assert fake.embed_calls == []


class TestRealBm25Smoke:
    def test_real_bm25_produces_nonempty_sparse_vector(self):
        try:
            emb = SparseBm25Embedder()
            vec = emb.embed_query("patient has hypertension and diabetes")
        except Exception as exc:  # noqa: BLE001 — offline / model unavailable
            pytest.skip(f"fastembed Qdrant/bm25 unavailable: {exc}")
        assert isinstance(vec, models.SparseVector)
        assert len(vec.indices) == len(vec.values) >= 1
