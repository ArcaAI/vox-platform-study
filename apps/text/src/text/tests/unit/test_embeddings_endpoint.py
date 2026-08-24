"""Embeddings endpoints — sync `/embeddings` and async `/embeddings/batch`
(TASK-725 Task 4). Hermetic: registry/queue/task-manager are stubs, no live
engines. RED: written before `api/endpoints/embeddings.py` existed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.worker_task import WorkerTaskType


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
def mock_worker_pool_queue():
    queue = AsyncMock()
    queue.submit = AsyncMock(return_value="111-0")
    return queue


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "embed-task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    return tm


@pytest.fixture
def app(mock_embedding_registry, mock_worker_pool_queue, mock_task_manager):
    from text.main import create_app

    application = create_app()
    application.state.settings = Settings(port=5099)
    application.state.embedding_registry = mock_embedding_registry
    application.state.worker_pool_queue = mock_worker_pool_queue
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


class TestBatchEmbeddings:
    @pytest.mark.asyncio
    async def test_submits_envelope_and_returns_202(self, client, mock_worker_pool_queue):
        resp = await client.post("/api/v1/embeddings/batch", json={"texts": ["a", "b", "c"]})

        assert resp.status_code == 202
        data = resp.json()
        assert data["task_id"] == "embed-task-1"
        assert data["status"] == "queued"

        mock_worker_pool_queue.submit.assert_awaited_once()
        envelope = mock_worker_pool_queue.submit.call_args.args[0]
        assert envelope.task_type == WorkerTaskType.EMBEDDING
        assert envelope.task_id == "embed-task-1"
        assert envelope.payload["texts"] == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_forwards_tenant_and_idempotency_headers(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/embeddings/batch",
            json={"texts": ["a"]},
            headers={"X-Tenant-Id": "tenant-9", "Idempotency-Key": "idem-9"},
        )
        assert resp.status_code == 202
        envelope = mock_worker_pool_queue.submit.call_args.args[0]
        assert envelope.tenant_id == "tenant-9"
        assert envelope.idempotency_key == "idem-9"

    @pytest.mark.asyncio
    async def test_draining_control_plane_rejects_submission(self, client, mock_worker_pool_queue):
        from text.core.exceptions import ShutdownError

        mock_worker_pool_queue.submit.side_effect = ShutdownError()
        resp = await client.post("/api/v1/embeddings/batch", json={"texts": ["a"]})
        assert resp.status_code == 503
