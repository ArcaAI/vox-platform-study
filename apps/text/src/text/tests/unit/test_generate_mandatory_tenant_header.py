"""TASK-737 — ``X-Tenant-Id`` is MANDATORY on ``POST /api/v1/generate``.

This is the busiest tenant-scoped internal surface in the platform. ``/generate``
resolves the tenant's BYOK provider/credential from this header, and TASK-735
derives ``funding``/``cost_basis`` from whichever tier supplied that credential —
so a dropped header mis-CONFIGURES and mis-BILLS the call in one move, with
nothing thrown and nothing logged.

The earlier TASK-737 pass could only log an ERROR here, because roughly seven
``apps/api`` callers still omitted the header and refusing them would have taken
down exactly the clinical traffic the ticket protects. Those callers are fixed
now, so this surface enforces:

*   absent / blank  → **428 Precondition Required** (mirrors the gateway's
    ``RequiresIfMatch`` convention: a mandatory request precondition is missing;
    the same status the two ``apps/nlp`` classify routes already return).
*   ``tenantless:<reason>`` → accepted, routes to the platform path, logged at
    debug. Declared tenant-less work is legitimate; an ABSENT header is not, and
    keeping those two distinguishable is the whole point of the contract.
*   a real tenant id → accepted, as before.

RED-first: written against the log-only ``_classify_inbound_tenant`` — every
``428`` assertion below returns ``200`` until the endpoint raises.
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
        return_value=(
            "Generated summary",
            "",
            {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )
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
    task_state.task_id = "task-737"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


@pytest.fixture
def app(mock_registry, mock_task_manager):
    from text.main import create_app

    application = create_app()
    application.state.provider_registry = mock_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


_BODY = {"prompt": "hello", "model": "test-model"}


# Opt OUT of conftest's default-tenant injection for the whole class: these tests
# must be able to send NO header at all, which is the state the contract refuses.
@pytest.mark.no_default_tenant_header
class TestGenerateRequiresTenantHeader:
    @pytest.mark.asyncio
    async def test_absent_header_is_428(self, client, mock_provider):
        response = await client.post("/api/v1/generate", json=_BODY)

        assert response.status_code == 428
        # Fail CLOSED: the provider is never invoked, so nothing is billed against
        # the wrong tenant's resolved credential.
        assert mock_provider.generate.await_count == 0

    @pytest.mark.asyncio
    async def test_blank_header_is_428(self, client):
        response = await client.post("/api/v1/generate", json=_BODY, headers={"X-Tenant-Id": "   "})
        assert response.status_code == 428

    @pytest.mark.asyncio
    async def test_428_detail_names_the_contract(self, client):
        response = await client.post("/api/v1/generate", json=_BODY)
        detail = str(response.json().get("detail", "")).lower()
        # The message must tell the CALLER what to do — including the declared
        # tenant-less escape hatch, so a legitimately tenant-less caller is not
        # left guessing.
        assert "x-tenant-id" in detail
        assert "tenantless:" in detail

    @pytest.mark.asyncio
    async def test_declared_tenantless_marker_is_accepted(self, client, mock_provider):
        response = await client.post(
            "/api/v1/generate", json=_BODY, headers={"X-Tenant-Id": "tenantless:control-plane"}
        )

        assert response.status_code == 200
        assert mock_provider.generate.await_count == 1

    @pytest.mark.asyncio
    async def test_real_tenant_id_is_accepted(self, client, mock_provider):
        response = await client.post(
            "/api/v1/generate",
            json=_BODY,
            headers={"X-Tenant-Id": "50000000-0000-0000-0000-000000000000"},
        )

        assert response.status_code == 200
        assert mock_provider.generate.await_count == 1
