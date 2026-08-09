"""TDD tests for health endpoints."""

from __future__ import annotations

import pytest

from tts.tests.fakes import FakeEngine


class TestHealth:
    @pytest.mark.asyncio
    async def test_health_ok(self, async_client):
        resp = await async_client.get("/api/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert body["service"] == "tts"
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
    async def test_readiness_200_with_keyless_byok_provider(self, app, async_client):
        """TASK-642: a registered cloud provider awaiting a per-request BYOK key is
        serviceable — the gateway injects the credential per request — so it must
        not hold the whole service out of the k8s Service endpoints."""
        app.state.provider_registry.register(
            "azure", FakeEngine("azure", healthy=False, configured=False)
        )
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 200
        body = resp.json()
        # Degraded, not plain healthy: nothing can be served without a BYOK key.
        assert body["status"] == "degraded"
        assert body["awaiting_credentials"] == ["azure"]

    @pytest.mark.asyncio
    async def test_readiness_prefers_healthy_over_degraded(self, app, async_client):
        app.state.provider_registry.register(
            "azure", FakeEngine("azure", healthy=False, configured=False)
        )
        app.state.provider_registry.register("kokoro", FakeEngine("kokoro"))
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_readiness_503_with_configured_but_unhealthy_provider(self, app, async_client):
        """A provider that HAS its credential and still reports unhealthy is broken,
        not BYOK-pending — it must not alone produce a 200."""
        app.state.provider_registry.register(
            "kokoro", FakeEngine("kokoro", healthy=False, configured=True)
        )
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_readiness_503_when_keyless_provider_health_raises(self, app, async_client):
        """Keylessness excuses a False health(); it does not excuse a raising one."""

        class ExplodingEngine(FakeEngine):
            async def health(self) -> bool:
                raise RuntimeError("provider probe blew up")

        app.state.provider_registry.register(
            "azure", ExplodingEngine("azure", healthy=False, configured=False)
        )
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_metrics_exposed(self, async_client):
        resp = await async_client.get("/metrics")
        assert resp.status_code == 200
