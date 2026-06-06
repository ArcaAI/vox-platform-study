"""Tests for the harness health/liveness/readiness endpoints.

RED-first: these are written before the implementation. The harness follows
the HOPE standardized health contract (status: healthy/degraded/unhealthy;
endpoints: /health, /health/live, /health/ready).
"""

from __future__ import annotations

import pytest


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_200_and_service_metadata(self, async_client):
        """GET /api/v1/health returns 200 with service identity + timestamp."""
        resp = await async_client.get("/api/v1/health")
        assert resp.status_code == 200

        data = resp.json()
        assert data["status"] == "healthy"
        assert data["service"] == "harness"
        assert data["version"]  # non-empty
        assert "timestamp" in data
        assert "uptime_seconds" in data

    @pytest.mark.asyncio
    async def test_health_surfaces_temporal_configuration(self, async_client):
        """/health echoes the configured Temporal substrate (no dialing)."""
        resp = await async_client.get("/api/v1/health")
        data = resp.json()

        temporal = data["checks"]["temporal"]
        assert temporal["address"]
        assert temporal["namespace"]
        assert temporal["task_queue"]


class TestLivenessEndpoint:
    @pytest.mark.asyncio
    async def test_liveness_always_returns_200(self, async_client):
        """/health/live returns 200 independent of external dependencies."""
        resp = await async_client.get("/api/v1/health/live")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}
