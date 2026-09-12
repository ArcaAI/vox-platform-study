"""Embeddings endpoint — sync `/embeddings`.

removed `/embeddings/batch` with the worker-pool plane it dispatched
onto; the sync route is what remains.

ORIGINAL: sync `/embeddings` and async `/embeddings/batch`
Hermetic: registry/queue/task-manager are stubs, no live
engines. RED: written before `api/endpoints/embeddings.py` existed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings


@pytest.fixture
def mock_embedding_provider():
    provider = AsyncMock()
    provider.embed = AsyncMock(return_value=[[0.1, 0.2, 0.3]])
    return provider


@pytest.fixture
def mock_embedding_registry(mock_embedding_provider):
    registry = MagicMock()
    registry.get.return_value = mock_embedding_provider
    registry.list_providers.return_value = ["tei-embed"]
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "embed-task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    return tm


@pytest.fixture
def app(mock_embedding_registry, mock_task_manager):
    from text.main import create_app

    application = create_app()
    application.state.settings = Settings(port=5099)
    application.state.embedding_registry = mock_embedding_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.app_ref = app  # type: ignore[attr-defined]
        yield c


class TestSyncEmbeddings:
    @pytest.mark.asyncio
    async def test_round_trips_vectors(self, client, mock_embedding_provider):
        resp = await client.post("/api/v1/embeddings", json={"texts": ["hello"]})

        assert resp.status_code == 200
        data = resp.json()
        assert data["embeddings"] == [[0.1, 0.2, 0.3]]
        assert data["provider"] == "tei-embed"
        assert data["dim"] == 3
        mock_embedding_provider.embed.assert_awaited_once_with(["hello"])

    @pytest.mark.asyncio
    async def test_unknown_provider_returns_404(self, client, mock_embedding_registry):
        from text.providers.embedding import EmbeddingProviderNotFoundError

        mock_embedding_registry.get.side_effect = EmbeddingProviderNotFoundError("nope")
        resp = await client.post(
            "/api/v1/embeddings", json={"texts": ["hello"], "provider": "does-not-exist"}
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_blank_texts_list_rejected(self, client):
        resp = await client.post("/api/v1/embeddings", json={"texts": []})
        assert resp.status_code == 422
