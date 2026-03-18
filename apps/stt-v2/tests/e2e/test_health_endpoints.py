"""E2E tests for health endpoints."""

import pytest


@pytest.mark.e2e
class TestHealthEndpointsE2E:
    """E2E tests for health check endpoints."""

    @pytest.mark.asyncio
    async def test_health_endpoint(self, configured_app):
        """Test /api/v1/health endpoint returns correctly."""
        response = await configured_app.get("/api/v1/health")

        assert response.status_code == 200
        data = response.json()

        assert data["status"] == "ok"
        assert data["service"] == "stt-v2"
        assert "version" in data
        assert "timestamp" in data

    @pytest.mark.asyncio
    async def test_liveness_endpoint(self, configured_app):
        """Test /api/v1/live endpoint returns OK."""
        response = await configured_app.get("/api/v1/live")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

    @pytest.mark.asyncio
    async def test_readiness_endpoint(self, configured_app):
        """Test /api/v1/ready endpoint returns component status."""
        response = await configured_app.get("/api/v1/ready")

        assert response.status_code == 200
        data = response.json()

        assert "status" in data
        assert "components" in data
        assert "uptime_seconds" in data
        assert len(data["components"]) >= 3  # database, minio, redis

    @pytest.mark.asyncio
    async def test_metrics_endpoint(self, configured_app):
        """Test /metrics endpoint returns Prometheus metrics."""
        response = await configured_app.get("/metrics")

        assert response.status_code == 200
        # Prometheus metrics are in text format
        assert "http_requests" in response.text or "python_" in response.text
