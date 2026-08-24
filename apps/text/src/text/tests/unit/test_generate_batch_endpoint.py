"""``POST /generate/batch`` — async submission for the ``BATCH_GENERATION``
worker-pool task type (TASK-725 §7 residual close-out).

Before this endpoint existed, `worker.py::_handle_batch_generation` had a
fully working dispatch path (fixed 2026-08-20) with nothing in this repo that
could ever enqueue a `BATCH_GENERATION` task — this closes that gap.

Mirrors `test_embeddings_endpoint.py`'s `TestBatchEmbeddings` shape (hermetic:
registry/queue/task-manager are stubs, no live engines; 202 + envelope
assertions; `ShutdownError` → 503), plus the mandatory-tenant-header contract
`test_generate_mandatory_tenant_header.py` already locks for the synchronous
`/generate` endpoint, since batch generation drives the SAME billable
`LLMProvider.generate()` call.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.models.worker_task import WorkerTaskType


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "the answer",
            "",
            {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    registry.list_providers.return_value = ["lm-studio"]
    return registry


@pytest.fixture
def mock_worker_pool_queue():
    queue = AsyncMock()
    queue.submit = AsyncMock(return_value="222-0")
    return queue


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "batch-gen-task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    return tm


@pytest.fixture
def app(mock_registry, mock_worker_pool_queue, mock_task_manager):
    from text.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.worker_pool_queue = mock_worker_pool_queue
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


_BODY = {"prompt": "summarize this note", "provider": "lm-studio", "model": "gemma-4"}


class TestBatchGenerationSubmission:
    @pytest.mark.asyncio
    async def test_submits_envelope_and_returns_202(self, client, mock_worker_pool_queue):
        resp = await client.post("/api/v1/generate/batch", json=_BODY)

        assert resp.status_code == 202
        data = resp.json()
        assert data["task_id"] == "batch-gen-task-1"
        assert data["status"] == "queued"

        mock_worker_pool_queue.submit.assert_awaited_once()
        envelope = mock_worker_pool_queue.submit.call_args.args[0]
        assert envelope.task_type == WorkerTaskType.BATCH_GENERATION
        assert envelope.task_id == "batch-gen-task-1"
        assert envelope.payload["prompt"] == "summarize this note"
        assert envelope.payload["provider"] == "lm-studio"
        assert envelope.payload["model"] == "gemma-4"

    @pytest.mark.asyncio
    async def test_forwards_tenant_and_idempotency_headers(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/generate/batch",
            json=_BODY,
            headers={"X-Tenant-Id": "tenant-9", "Idempotency-Key": "idem-9"},
        )
        assert resp.status_code == 202
        envelope = mock_worker_pool_queue.submit.call_args.args[0]
        assert envelope.tenant_id == "tenant-9"
        assert envelope.idempotency_key == "idem-9"

    @pytest.mark.asyncio
    async def test_declared_tenantless_marker_is_accepted(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/generate/batch",
            json=_BODY,
            headers={"X-Tenant-Id": "tenantless:control-plane"},
        )
        assert resp.status_code == 202
        envelope = mock_worker_pool_queue.submit.call_args.args[0]
        assert envelope.tenant_id == "tenantless:control-plane"

    @pytest.mark.asyncio
    async def test_draining_control_plane_rejects_submission(self, client, mock_worker_pool_queue):
        from text.core.exceptions import ShutdownError

        mock_worker_pool_queue.submit.side_effect = ShutdownError()
        resp = await client.post("/api/v1/generate/batch", json=_BODY)
        assert resp.status_code == 503


# Opt OUT of conftest's default-tenant injection: these tests must be able to
# send NO header at all, which is the state the mandatory contract refuses.
@pytest.mark.no_default_tenant_header
class TestBatchGenerationRejections:
    @pytest.mark.asyncio
    async def test_missing_tenant_header_is_428(self, client, mock_worker_pool_queue):
        resp = await client.post("/api/v1/generate/batch", json=_BODY)

        assert resp.status_code == 428
        # Fail CLOSED: nothing is queued (and nothing billed) for a request with
        # no attributable tenant.
        mock_worker_pool_queue.submit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_blank_tenant_header_is_428(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/generate/batch", json=_BODY, headers={"X-Tenant-Id": "   "}
        )
        assert resp.status_code == 428
        mock_worker_pool_queue.submit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_missing_prompt_is_422(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/generate/batch",
            json={"provider": "lm-studio"},
            headers={"X-Tenant-Id": "50000000-0000-0000-0000-000000000000"},
        )
        assert resp.status_code == 422
        mock_worker_pool_queue.submit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_blank_prompt_is_422(self, client, mock_worker_pool_queue):
        resp = await client.post(
            "/api/v1/generate/batch",
            json={"prompt": "   ", "provider": "lm-studio"},
            headers={"X-Tenant-Id": "50000000-0000-0000-0000-000000000000"},
        )
        assert resp.status_code == 422
        mock_worker_pool_queue.submit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unknown_provider_is_404(self, client, mock_registry, mock_worker_pool_queue):
        from text.providers.base import ProviderNotFoundError

        mock_registry.get.side_effect = ProviderNotFoundError("not registered")
        resp = await client.post(
            "/api/v1/generate/batch",
            json={"prompt": "hello", "provider": "ghost"},
            headers={"X-Tenant-Id": "50000000-0000-0000-0000-000000000000"},
        )
        assert resp.status_code == 404
        mock_worker_pool_queue.submit.assert_not_awaited()


class TestBatchGenerationDispatchRoundTrip:
    """Proves the payload this endpoint builds is exactly what
    ``worker.py::_handle_batch_generation`` (fixed 2026-08-20) expects —
    submission → queued → dispatched, without a live Redis/worker process.
    """

    @pytest.mark.asyncio
    async def test_submitted_envelope_dispatches_through_the_real_worker_handler(
        self, client, mock_worker_pool_queue, mock_provider
    ):
        from text.providers.base import ProviderRegistry
        from text.worker import _handle_batch_generation

        resp = await client.post("/api/v1/generate/batch", json=_BODY)
        assert resp.status_code == 202

        envelope = mock_worker_pool_queue.submit.call_args.args[0]

        real_registry = ProviderRegistry()
        real_registry.register("lm-studio", mock_provider)

        await _handle_batch_generation(envelope, provider_registry=real_registry)

        mock_provider.generate.assert_awaited_once()
        (dispatched_request,) = mock_provider.generate.await_args.args
        assert dispatched_request.prompt == "summarize this note"
        assert dispatched_request.model == "gemma-4"
