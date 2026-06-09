"""Internal knowledge-ingest endpoint tests (RED-first, TASK-330 Phase 3, Lane A).

``POST /api/v1/internal/knowledge/ingest`` is the cross-lane contract Lane B's
BullMQ ingest processor calls: it chunks the approved document, dense+sparse
embeds each chunk, upserts a stable point per chunk into ``knowledge_chunks``, and
returns chunk descriptors (point ids, offsets, token counts, embedding model/dim).
The heavy clients (embeddings/sparse/qdrant) are faked so these tests assert the
contract shape, the stable/idempotent point ids, the tenant + APPROVED Qdrant
payload, the ``X-Service-Token`` guard, and the 503-on-backend-failure behaviour.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from qdrant_client import models

import harness.api.endpoints.knowledge as knowledge
from harness.core.config import Settings
from harness.main import create_app
from harness.services.embeddings_client import EmbeddingsServiceError

_DOC = (
    "Hypertension management. " * 40 + "Diabetes follow-up plan. " * 40
)  # long enough to chunk into >1 window


class _FakeEmbeddings:
    def __init__(self, *, dim: int = 4, error: Exception | None = None) -> None:
        self._dim = dim
        self._error = error
        self.calls: list[list[str]] = []

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        if self._error is not None:
            raise self._error
        return [[float(i)] * self._dim for i in range(len(texts))]


class _FakeSparse:
    def embed_documents(self, texts: list[str]) -> list[models.SparseVector]:
        return [models.SparseVector(indices=[1], values=[1.0]) for _ in texts]


class _FakeStore:
    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.items: list[Any] = []

    def upsert_chunks(self, items: list[Any]) -> int:
        if self._error is not None:
            raise self._error
        self.items.extend(items)
        return len(items)


def _settings(internal_token: str = "ingest-secret", shared_token: str = "") -> Settings:
    return Settings(
        internal_service_token=SecretStr(internal_token),
        service_token=SecretStr(shared_token),
        log_level="debug",
    )


@pytest_asyncio.fixture
async def harness_app(monkeypatch) -> AsyncGenerator[tuple, None]:
    settings = _settings()
    app = create_app(settings_override=settings)

    emb = _FakeEmbeddings()
    sparse = _FakeSparse()
    store = _FakeStore()
    monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: emb)
    monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: sparse)
    monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: store)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, emb, sparse, store, settings


def _body(**kw) -> dict:
    base = {
        "tenantId": "t-1",
        "knowledgeDocumentId": "kd-1",
        "title": "HTN protocol",
        "source": "internal://protocols/htn",
        "mimeType": "text/plain",
        "text": _DOC,
    }
    base.update(kw)
    return base


_HEADERS = {"X-Service-Token": "ingest-secret"}
_URL = "/api/v1/internal/knowledge/ingest"


class TestIngestContract:
    @pytest.mark.asyncio
    async def test_returns_chunk_descriptors_in_contract_shape(self, harness_app):
        http, _emb, _sparse, _store, settings = harness_app
        resp = await http.post(_URL, headers=_HEADERS, json=_body())
        assert resp.status_code == 200
        data = resp.json()
        assert data["chunkCount"] >= 1
        assert data["chunkCount"] == len(data["chunks"])
        d = data["chunks"][0]
        assert set(d) == {
            "chunkIndex",
            "text",
            "qdrantPointId",
            "startOffset",
            "endOffset",
            "tokenCount",
            "embeddingModel",
            "embeddingDim",
            "status",
        }
        assert d["chunkIndex"] == 0
        assert d["status"] == "APPROVED"
        assert d["embeddingModel"] == settings.retrieval.embeddings_model
        assert d["embeddingDim"] == 4  # the fake embeddings dim (actual vector length)
        assert d["text"] == _DOC[d["startOffset"] : d["endOffset"]]

    @pytest.mark.asyncio
    async def test_point_ids_are_stable_and_idempotent(self, harness_app):
        http, _emb, _sparse, _store, _settings = harness_app
        first = (await http.post(_URL, headers=_HEADERS, json=_body())).json()
        second = (await http.post(_URL, headers=_HEADERS, json=_body())).json()
        ids1 = [c["qdrantPointId"] for c in first["chunks"]]
        ids2 = [c["qdrantPointId"] for c in second["chunks"]]
        assert ids1 == ids2  # deterministic per (tenant, doc, chunkIndex)
        assert len(set(ids1)) == len(ids1)  # unique per chunk
        # Valid UUIDs.
        import uuid

        for pid in ids1:
            uuid.UUID(pid)

    @pytest.mark.asyncio
    async def test_qdrant_payload_is_tenant_and_approved_scoped(self, harness_app):
        http, _emb, _sparse, store, _settings = harness_app
        resp = await http.post(_URL, headers=_HEADERS, json=_body())
        assert resp.status_code == 200
        assert store.items, "chunks must be upserted to Qdrant"
        item = store.items[0]
        assert item.payload["tenant_id"] == "t-1"
        assert item.payload["knowledge_document_id"] == "kd-1"
        assert item.payload["status"] == "APPROVED"
        # chunk_id payload == the stable point id (the join key Lane B persists).
        assert item.payload["chunk_id"] == item.point_id
        assert item.payload["chunk_index"] == 0
        assert isinstance(item.sparse, models.SparseVector)

    @pytest.mark.asyncio
    async def test_empty_text_yields_zero_chunks(self, harness_app):
        http, _emb, _sparse, store, _settings = harness_app
        resp = await http.post(_URL, headers=_HEADERS, json=_body(text="   "))
        assert resp.status_code == 200
        assert resp.json() == {"chunkCount": 0, "chunks": []}
        assert store.items == []


class TestIngestAuth:
    @pytest.mark.asyncio
    async def test_rejects_missing_or_bad_token(self, harness_app):
        http, _emb, _sparse, store, _settings = harness_app
        missing = await http.post(_URL, json=_body())
        bad = await http.post(_URL, headers={"X-Service-Token": "nope"}, json=_body())
        assert missing.status_code == 401
        assert bad.status_code == 401
        assert store.items == []

    @pytest.mark.asyncio
    async def test_shared_service_token_is_also_accepted(self, monkeypatch):
        # internal token empty, shared token set -> the shared token is accepted.
        settings = _settings(internal_token="", shared_token="shared-secret")
        app = create_app(settings_override=settings)
        monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: _FakeEmbeddings())
        monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: _FakeSparse())
        monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: _FakeStore())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(_URL, headers={"X-Service-Token": "shared-secret"}, json=_body())
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_empty_tokens_disable_the_guard(self, monkeypatch):
        settings = _settings(internal_token="", shared_token="")
        app = create_app(settings_override=settings)
        monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: _FakeEmbeddings())
        monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: _FakeSparse())
        monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: _FakeStore())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(_URL, json=_body())
        assert resp.status_code == 200


class TestIngestDegrade:
    @pytest.mark.asyncio
    async def test_embeddings_failure_returns_503(self, monkeypatch):
        settings = _settings()
        app = create_app(settings_override=settings)
        emb = _FakeEmbeddings(error=EmbeddingsServiceError("no model loaded"))
        monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: emb)
        monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: _FakeSparse())
        store = _FakeStore()
        monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: store)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(_URL, headers=_HEADERS, json=_body())
        assert resp.status_code == 503
        assert resp.json()["detail"]["error"] == "embeddings_unavailable"
        assert store.items == []  # nothing upserted on embed failure

    @pytest.mark.asyncio
    async def test_qdrant_failure_returns_503(self, monkeypatch):
        settings = _settings()
        app = create_app(settings_override=settings)
        monkeypatch.setattr(knowledge, "_embeddings_client", lambda s: _FakeEmbeddings())
        monkeypatch.setattr(knowledge, "_sparse_embedder", lambda: _FakeSparse())
        store = _FakeStore(error=RuntimeError("qdrant down"))
        monkeypatch.setattr(knowledge, "_qdrant_store", lambda s: store)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            resp = await http.post(_URL, headers=_HEADERS, json=_body())
        assert resp.status_code == 503
        assert resp.json()["detail"]["error"] == "qdrant_unavailable"
