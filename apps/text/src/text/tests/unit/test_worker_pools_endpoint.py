"""GET /worker-pools admin introspection (TASK-725 Tasks 3 & 6). Hermetic.
RED: written before `api/endpoints/worker_pools.py` existed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings


@pytest.fixture
def mock_worker_pool_queue():
    queue = AsyncMock()
    queue.depth = AsyncMock(side_effect=lambda task_type: {"embedding": 3}.get(
        task_type.value if hasattr(task_type, "value") else task_type, 0
    ))
    return queue


@pytest.fixture
def app(mock_worker_pool_queue):
    from text.main import create_app
    from text.services.shutdown_manager import ShutdownManager

    application = create_app()
    application.state.settings = Settings(port=5099)
    application.state.worker_pool_queue = mock_worker_pool_queue
    application.state.shutdown_manager = ShutdownManager()
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.app_ref = app  # type: ignore[attr-defined]
        yield c


class TestWorkerPoolsListing:
    @pytest.mark.asyncio
    async def test_lists_both_task_types_with_depth(self, client):
        resp = await client.get("/api/v1/worker-pools")
        assert resp.status_code == 200
        by_type = {row["task_type"]: row for row in resp.json()}
        assert set(by_type) == {"embedding", "batch_generation"}
        assert by_type["embedding"]["queue_depth"] == 3

    @pytest.mark.asyncio
    async def test_not_draining_by_default(self, client):
        resp = await client.get("/api/v1/worker-pools")
        assert all(row["draining"] is False for row in resp.json())

    @pytest.mark.asyncio
    async def test_reports_draining_during_shutdown(self, client, app):
        app.state.shutdown_manager.initiate_shutdown()
        resp = await client.get("/api/v1/worker-pools")
        assert all(row["draining"] is True for row in resp.json())
