"""E2E tests for internal endpoints."""

import pytest


@pytest.mark.e2e
class TestInternalCacheEndpoints:
    """E2E tests for internal cache endpoints."""

    @pytest.mark.asyncio
    async def test_cache_stats_endpoint(self, configured_app):
        """Test /internal/cache/stats endpoint."""
        response = await configured_app.get("/internal/cache/stats")

        assert response.status_code == 200
        data = response.json()

        assert "total_models" in data
        assert "total_memory_mb" in data
        assert "max_models" in data
        assert "hits" in data
        assert "misses" in data
        assert "hit_rate" in data
        assert "models" in data
        assert "timestamp" in data

    @pytest.mark.asyncio
    async def test_cache_clear_endpoint(self, configured_app):
        """Test /internal/cache/clear endpoint."""
        response = await configured_app.post("/internal/cache/clear")

        assert response.status_code == 200
        data = response.json()

        assert data["status"] == "ok"
        assert "models_cleared" in data

    @pytest.mark.asyncio
    async def test_cache_model_not_found(self, configured_app):
        """Test /internal/cache/model/{slug} for non-cached model."""
        response = await configured_app.get("/internal/cache/model/nonexistent-model")

        assert response.status_code == 404


@pytest.mark.e2e
class TestInternalPipelineEndpoints:
    """E2E tests for internal pipeline endpoints."""

    @pytest.mark.asyncio
    async def test_pipelines_loaded_endpoint(self, configured_app):
        """Test /internal/pipelines/loaded endpoint."""
        response = await configured_app.get("/internal/pipelines/loaded")

        assert response.status_code == 200
        data = response.json()

        assert "total_pipelines" in data
        assert "ready_pipelines" in data
        assert "pipelines" in data
        assert "timestamp" in data


@pytest.mark.e2e
class TestInternalSessionEndpoints:
    """E2E tests for internal session endpoints."""

    @pytest.mark.asyncio
    async def test_sessions_endpoint(self, configured_app):
        """Test /internal/sessions endpoint."""
        response = await configured_app.get("/internal/sessions")

        assert response.status_code == 200
        data = response.json()

        assert "active_sessions" in data
        assert "sessions" in data
        assert "timestamp" in data

    @pytest.mark.asyncio
    async def test_sessions_cleanup_endpoint(self, configured_app):
        """Test /internal/sessions/cleanup endpoint.

        When streaming is not initialized (no session manager), the endpoint
        returns status='not_initialized' with sessions_cleaned=0.
        """
        response = await configured_app.post("/internal/sessions/cleanup?max_age_seconds=3600")

        assert response.status_code == 200
        data = response.json()

        assert data["status"] in ("ok", "not_initialized")
        assert "sessions_cleaned" in data
        assert data["max_age_seconds"] == 3600
