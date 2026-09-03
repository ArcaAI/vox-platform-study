"""GET /providers admin introspection additions — per-provider
pool health + in-flight-request count layered onto the existing probe
contract. Hermetic. RED: written before providers.py exposed these fields.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.provider import ProviderInfo


def _info(name: str) -> ProviderInfo:
    return ProviderInfo(name=name, display_name=name, status="available", default_model="m")


@pytest.fixture
def settings() -> Settings:
    return Settings(port=5099)


@pytest_asyncio.fixture
async def client(settings):
    from text.main import create_app
    from text.providers.base import ProviderRegistry

    app = create_app()
    app.state.settings = settings
    app.state.provider_registry = ProviderRegistry()

    healthy = AsyncMock()
    healthy.get_info = AsyncMock(return_value=_info("healthy"))
    app.state.provider_registry.register("healthy", healthy)

    unchecked = AsyncMock()
    unchecked.get_info = AsyncMock(return_value=_info("unchecked"))
    app.state.provider_registry.register("unchecked", unchecked)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.app_ref = app  # type: ignore[attr-defined]
        yield c


class TestPoolHealthOnProvidersListing:
    @pytest.mark.asyncio
    async def test_unchecked_provider_reports_null_pool_health(self, client):
        resp = await client.get("/api/v1/providers")
        by_name = {p["name"]: p for p in resp.json()}
        assert by_name["unchecked"]["pool_health"] is None
        assert by_name["unchecked"]["pool_health_checked_at"] is None

    @pytest.mark.asyncio
    async def test_checked_healthy_provider_reports_true(self, client):
        client.app_ref.state.pool_health_tracker.record("healthy", True)
        resp = await client.get("/api/v1/providers")
        by_name = {p["name"]: p for p in resp.json()}
        assert by_name["healthy"]["pool_health"] is True
        assert by_name["healthy"]["pool_health_checked_at"] is not None

    @pytest.mark.asyncio
    async def test_in_flight_requests_defaults_to_zero(self, client):
        resp = await client.get("/api/v1/providers")
        assert all(p["in_flight_requests"] == 0 for p in resp.json())
