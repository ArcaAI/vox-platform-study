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

        assert data["status"] in ("healthy", "degraded", "unhealthy")
        assert data["service"] == "stt"
        assert "version" in data
        assert "timestamp" in data
        assert "uptime_seconds" in data
        assert "checks" in data

    @pytest.mark.asyncio
    async def test_liveness_endpoint(self, configured_app):
        """Test /api/v1/live endpoint returns healthy."""
        response = await configured_app.get("/api/v1/live")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_readiness_endpoint(self, configured_app):
        """Test /api/v1/ready endpoint returns status.

        The readiness endpoint returns 200 {"status": "healthy"} when all
        dependencies are reachable, or 503 {"status": "unhealthy", ...}
        when any critical dependency is down.  In testcontainer mode,
        MinIO and Redis may not be initialized, so 503 is acceptable.
        """
        response = await configured_app.get("/api/v1/ready")

        data = response.json()
        assert "status" in data
        if response.status_code == 200:
            assert data["status"] == "healthy"
        else:
            assert response.status_code == 503
            assert data["status"] == "unhealthy"

    @pytest.mark.asyncio
    async def test_metrics_endpoint(self, configured_app):
        """Test /metrics endpoint returns Prometheus metrics."""
        response = await configured_app.get("/metrics")

        assert response.status_code == 200
        assert "http_requests" in response.text or "python_" in response.text
