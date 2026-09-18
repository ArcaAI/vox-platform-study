"""Unit tests for Health API routes.

These tests cover health check endpoints and internal admin endpoints.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.health.api.routes import (
    ComponentHealth,
    HealthStatus,
    _check_database,
    _check_minio,
    _component_to_dict,
    cleanup_sessions,
    get_streaming_sessions,
    health_check,
    liveness_check,
    readiness_check,
)

# =============================================================================
# Health Status and Component Tests
# =============================================================================


class TestHealthStatus:
    """Tests for HealthStatus enum."""

    def test_health_status_values(self):
        """Test all health status values exist."""
        assert HealthStatus.HEALTHY.value == "healthy"
        assert HealthStatus.DEGRADED.value == "degraded"
        assert HealthStatus.UNHEALTHY.value == "unhealthy"


class TestComponentHealth:
    """Tests for ComponentHealth dataclass."""

    def test_component_health_creation(self):
        """Test basic component health creation."""
        health = ComponentHealth(
            name="database",
            status=HealthStatus.HEALTHY,
            latency_ms=5.5,
        )

        assert health.name == "database"
        assert health.status == HealthStatus.HEALTHY
        assert health.latency_ms == 5.5
        assert health.message is None

    def test_component_health_with_message(self):
        """Test component health with error message."""
        health = ComponentHealth(
            name="redis",
            status=HealthStatus.UNHEALTHY,
            latency_ms=1000.0,
            message="Connection refused",
        )

        assert health.status == HealthStatus.UNHEALTHY
        assert health.message == "Connection refused"


class TestComponentToDict:
    """Tests for _component_to_dict helper."""

    def test_converts_healthy_component(self):
        """Test conversion of healthy component."""
        health = ComponentHealth(
            name="database",
            status=HealthStatus.HEALTHY,
            latency_ms=5.567,
        )

        result = _component_to_dict(health)

        assert result["status"] == "healthy"
        assert result["duration_ms"] == 5.57  # Rounded to 2 decimals
        assert "message" not in result  # omitted when None

    def test_converts_unhealthy_component_with_message(self):
        """Test conversion of unhealthy component with message."""
        health = ComponentHealth(
            name="minio",
            status=HealthStatus.UNHEALTHY,
            latency_ms=123.456,
            message="Bucket not found",
        )

        result = _component_to_dict(health)

        assert result["status"] == "unhealthy"
        assert result["duration_ms"] == 123.46
        assert result["message"] == "Bucket not found"


# =============================================================================
# Health Check Endpoint Tests
# =============================================================================


class TestHealthCheckEndpoint:
    """Tests for basic health check endpoint."""

    @pytest.mark.asyncio
    async def test_health_check_returns_status(self):
        """Test health check returns overall status with checks."""
        with (
            patch("stt.health.api.routes._check_database") as mock_db,
            patch("stt.health.api.routes._check_minio") as mock_minio,
            patch("stt.health.api.routes._check_redis") as mock_redis,
            patch("stt.health.api.routes._check_streaming") as mock_streaming,
            patch("stt.health.api.routes.settings") as mock_settings,
            # TASK-990 F6: the reported version is the BUILD's, not
            # `settings.app_version` — see `_service_version`'s docstring. Patch
            # the (lru_cached) reader rather than the settings field, so this
            # test cannot go green again by accident if the literal creeps back.
            patch("stt.health.api.routes._service_version", return_value="0.0.0-test.deadbeef"),
        ):

            mock_settings.app_name = "stt"
            mock_settings.app_version = "1.0.0"

            mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
            mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
            mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)
            mock_streaming.return_value = {"status": "degraded", "duration_ms": 0}

            result = await health_check()

            assert result["status"] == "healthy"
            assert result["service"] == "stt"
            assert result["version"] == "0.0.0-test.deadbeef"
            assert result["version"] != mock_settings.app_version
            assert "timestamp" in result
            assert "checks" in result


class TestLivenessCheckEndpoint:
    """Tests for liveness probe endpoint."""

    @pytest.mark.asyncio
    async def test_liveness_check_returns_healthy(self):
        """Test liveness check returns healthy."""
        result = await liveness_check()

        assert result["status"] == "healthy"


# =============================================================================
# Component Health Check Tests
# =============================================================================


class TestDatabaseHealthCheck:
    """Tests for database health check."""

    @pytest.mark.asyncio
    async def test_database_healthy(self):
        """Test database check when healthy."""
        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=None)
        mock_session.execute = AsyncMock()

        with patch("stt.health.api.routes.get_db_session", return_value=mock_session):
            result = await _check_database()

            assert result.status == HealthStatus.HEALTHY
            assert result.name == "database"
            assert result.latency_ms >= 0

    @pytest.mark.asyncio
    async def test_database_unhealthy(self):
        """Test database check when unhealthy."""
        mock_session = AsyncMock()
        mock_session.__aenter__ = AsyncMock(side_effect=Exception("Connection failed"))
        mock_session.__aexit__ = AsyncMock(return_value=None)

        with patch("stt.health.api.routes.get_db_session", return_value=mock_session):
            result = await _check_database()

            assert result.status == HealthStatus.UNHEALTHY
            assert "Connection failed" in result.message


class TestMinioHealthCheck:
    """Tests for MinIO health check."""

    @pytest.mark.asyncio
    async def test_minio_healthy(self):
        """Test MinIO check when healthy."""
        mock_client = MagicMock()
        mock_client.health_check.return_value = True

        with patch("stt.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

            assert result.status == HealthStatus.HEALTHY
            assert result.name == "minio"

    @pytest.mark.asyncio
    async def test_minio_unhealthy_returns_false(self):
        """Test MinIO check when health_check returns False."""
        mock_client = MagicMock()
        mock_client.health_check.return_value = False

        with patch("stt.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

            assert result.status == HealthStatus.UNHEALTHY

    @pytest.mark.asyncio
    async def test_minio_unhealthy_exception(self):
        """Test MinIO check when exception occurs."""
        with patch("stt.health.api.routes.get_minio_client", side_effect=Exception("MinIO error")):
            result = await _check_minio()

            assert result.status == HealthStatus.UNHEALTHY
            assert "MinIO error" in result.message


# Note: Redis health check tests are skipped as they require
# patching dynamic imports inside the _check_redis function.
# The function imports get_broker at runtime which is difficult to mock in unit tests.
# These tests should be covered in integration tests with actual Redis.


class TestReadinessCheck:
    """Tests for readiness check endpoint."""

    @pytest.mark.asyncio
    async def test_readiness_all_healthy(self):
        """Test readiness when all components healthy returns simple healthy dict."""
        with (
            patch("stt.health.api.routes._check_database") as mock_db,
            patch("stt.health.api.routes._check_minio") as mock_minio,
            patch("stt.health.api.routes._check_redis") as mock_redis,
        ):

            mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
            mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
            mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

            result = await readiness_check()

            assert result["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_readiness_one_unhealthy(self):
        """Test readiness when one component is unhealthy returns JSONResponse."""
        from fastapi.responses import JSONResponse

        with (
            patch("stt.health.api.routes._check_database") as mock_db,
            patch("stt.health.api.routes._check_minio") as mock_minio,
            patch("stt.health.api.routes._check_redis") as mock_redis,
        ):

            mock_db.return_value = ComponentHealth(
                "database", HealthStatus.UNHEALTHY, 5.0, "DB error"
            )
            mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
            mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

            result = await readiness_check()

            assert isinstance(result, JSONResponse)
            assert result.status_code == 503

    @pytest.mark.asyncio
    async def test_readiness_all_healthy_no_degraded_check(self):
        """Test readiness returns healthy when no components are unhealthy."""
        with (
            patch("stt.health.api.routes._check_database") as mock_db,
            patch("stt.health.api.routes._check_minio") as mock_minio,
            patch("stt.health.api.routes._check_redis") as mock_redis,
        ):

            mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
            mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
            mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

            result = await readiness_check()

            assert result == {"status": "healthy"}


class TestInternalStreamingEndpoints:
    """Tests for internal streaming admin endpoints."""

    @pytest.mark.asyncio
    async def test_get_streaming_sessions_returns_not_initialized(self):
        """Should return not_initialized when runtime manager is missing."""
        with patch("stt.streaming._runtime.get_session_manager", return_value=None):
            result = await get_streaming_sessions()

            assert result["status"] == "not_initialized"
            assert result["active_sessions"] == 0
            assert result["sessions"] == []

    @pytest.mark.asyncio
    async def test_get_streaming_sessions_returns_running_sessions(self):
        """Should return active sessions from SessionManager."""
        mock_mgr = MagicMock()
        mock_mgr.list_sessions.return_value = [
            {"session_id": "s-1", "status": "active"},
        ]

        with patch("stt.streaming._runtime.get_session_manager", return_value=mock_mgr):
            result = await get_streaming_sessions()

            assert result["status"] == "running"
            assert result["active_sessions"] == 1
            assert result["sessions"][0]["session_id"] == "s-1"
            assert result["sessions"][0]["source"] == "streaming"

    @pytest.mark.asyncio
    async def test_cleanup_sessions_returns_not_initialized(self):
        """Should return not_initialized when runtime manager is missing."""
        with patch("stt.streaming._runtime.get_session_manager", return_value=None):
            result = await cleanup_sessions(max_age_seconds=180)

            assert result["status"] == "not_initialized"
            assert result["sessions_cleaned"] == 0
            assert result["max_age_seconds"] == 180

    @pytest.mark.asyncio
    async def test_cleanup_sessions_uses_session_manager_reaper(self):
        """Should call SessionManager.reap_expired_sessions with provided age."""
        mock_mgr = MagicMock()
        mock_mgr.reap_expired_sessions = AsyncMock(return_value=3)

        with patch("stt.streaming._runtime.get_session_manager", return_value=mock_mgr):
            result = await cleanup_sessions(max_age_seconds=120)

            mock_mgr.reap_expired_sessions.assert_awaited_once_with(120)
            assert result["status"] == "ok"
            assert result["sessions_cleaned"] == 3
            assert result["max_age_seconds"] == 120
