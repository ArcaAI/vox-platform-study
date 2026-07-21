"""TDD tests for health endpoints."""

from __future__ import annotations

import pytest

from tts_v2.tests.fakes import FakeEngine


class TestHealth:
    @pytest.mark.asyncio
    async def test_health_ok(self, async_client):
        resp = await async_client.get("/api/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["service"] == "tts-v2"
        assert body["version"] == "0.1.0"

    @pytest.mark.asyncio
    async def test_liveness(self, async_client):
        resp = await async_client.get("/api/v1/health/live")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_readiness_503_without_providers(self, async_client):
        # Phase 2: readiness gates on the provider registry.
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_readiness_200_with_healthy_provider(self, app, async_client):
        app.state.provider_registry.register("azure", FakeEngine("azure"))
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_metrics_exposed(self, async_client):
        resp = await async_client.get("/metrics")
        assert resp.status_code == 200
