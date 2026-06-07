"""TASK-338 Phase 4b — the /generate endpoint invokes the external guardrail.

Verifies the guardrail is called per generate, the consultation X-Tenant-Id is
forwarded, blocked content is rejected (fail-closed verdict), and allowed content
(incl. fail-open verdict) proceeds. The guardrail client is mocked — no network.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=("ok", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    )
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


def _make_app(registry, task_manager, guardrail_client):
    from smr_v2.main import create_app

    app = create_app()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.guardrail_client = guardrail_client
    return app


@pytest_asyncio.fixture
async def _client_factory(mock_registry, mock_task_manager):
    clients = []

    async def _build(guardrail_client):
        app = _make_app(mock_registry, mock_task_manager, guardrail_client)
        transport = ASGITransport(app=app)
        c = AsyncClient(transport=transport, base_url="http://test")
        clients.append(c)
        return c

    yield _build
    for c in clients:
        await c.aclose()


@pytest.mark.asyncio
async def test_blocked_content_rejected_with_422(_client_factory, mock_provider):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": False, "reason": "external_guardrail_unavailable"}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "hello"})

    assert resp.status_code == 422
    assert "guardrail" in resp.json()["detail"].lower()
    mock_provider.generate.assert_not_called()  # rejected before provider work


@pytest.mark.asyncio
async def test_allowed_content_proceeds(_client_factory, mock_provider):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"allowed": True})
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "patient note"})

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


@pytest.mark.asyncio
async def test_fail_open_verdict_proceeds(_client_factory, mock_provider):
    # When guardrail is unreachable + fail_open, the client returns allowed=True.
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(
        return_value={"allowed": True, "reason": "external_guardrail_failed_open"}
    )
    client = await _client_factory(guardrail)

    resp = await client.post("/api/v1/generate", json={"prompt": "patient note"})

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()


@pytest.mark.asyncio
async def test_tenant_id_header_propagated_to_guardrail(_client_factory):
    guardrail = AsyncMock()
    guardrail.validate = AsyncMock(return_value={"allowed": True})
    client = await _client_factory(guardrail)

    await client.post(
        "/api/v1/generate",
        json={"prompt": "patient note", "system_prompt": "be careful"},
        headers={"X-Tenant-Id": "tenant-42"},
    )

    guardrail.validate.assert_awaited_once()
    kwargs = guardrail.validate.await_args.kwargs
    assert kwargs["tenant_id"] == "tenant-42"
    assert kwargs["prompt"] == "patient note"
    assert kwargs["system_prompt"] == "be careful"


@pytest.mark.asyncio
async def test_no_guardrail_client_skips_validation(_client_factory, mock_provider):
    client = await _client_factory(None)  # guardrail unwired

    resp = await client.post("/api/v1/generate", json={"prompt": "hello"})

    assert resp.status_code == 200
    mock_provider.generate.assert_called_once()
