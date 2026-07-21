"""Unit tests for health/api/routes.py.

Covers:
- ``/api/v1/health`` — liveness probe
- ``/api/v1/live`` — liveness probe (simple)
- ``/api/v1/ready`` — readiness check including streaming component
- ``_check_streaming()`` — streaming health helper
- ``_check_database()`` — database health check
- ``_check_minio()`` — MinIO health check
- ``_check_redis()`` — Redis health check

Uses FastAPI TestClient with mocked dependencies to avoid requiring
real database, MinIO, or Redis connections.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def health_app():
    """Create a FastAPI app with the health router."""
    from stt_v2.health.api.routes import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    return app


@pytest.fixture
def client(health_app):
    return TestClient(health_app)


# ---------------------------------------------------------------------------
# /health (Liveness)
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    """Tests for GET /api/v1/health."""

    def test_returns_status(self, client):
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] in ("healthy", "unhealthy", "degraded")
        assert "service" in data
        assert "version" in data
        assert "timestamp" in data


# ---------------------------------------------------------------------------
# /live (Liveness)
# ---------------------------------------------------------------------------


class TestLiveEndpoint:
    """Tests for GET /api/v1/live."""

    def test_returns_healthy(self, client):
        resp = client.get("/api/v1/live")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}


# ---------------------------------------------------------------------------
# /ready (Readiness)
# ---------------------------------------------------------------------------


class TestReadinessEndpoint:
    """Tests for GET /api/v1/ready."""

    def test_healthy_when_all_deps_ok(self, client):
        from stt_v2.health.api.routes import ComponentHealth, HealthStatus

        mock_db_session = AsyncMock()
        mock_db_session.__aenter__ = AsyncMock(return_value=AsyncMock())
        mock_db_session.__aexit__ = AsyncMock(return_value=False)
        mock_db_session_ctx = MagicMock(return_value=mock_db_session)

        mock_minio = MagicMock()
        mock_minio.health_check.return_value = True

        redis_ok = ComponentHealth(
            name="redis",
            status=HealthStatus.HEALTHY,
            latency_ms=0.1,
        )

        with (
            patch("stt_v2.health.api.routes.get_db_session", mock_db_session_ctx),
            patch("stt_v2.health.api.routes.get_minio_client", return_value=mock_minio),
            patch(
                "stt_v2.health.api.routes._check_redis",
                new_callable=AsyncMock,
                return_value=redis_ok,
            ),
        ):
            resp = client.get("/api/v1/ready")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"

    def test_unhealthy_when_db_down(self, client):
        with (
            patch("stt_v2.health.api.routes.get_db_session", side_effect=RuntimeError("DB down")),
            patch(
                "stt_v2.health.api.routes.get_minio_client",
                return_value=MagicMock(health_check=MagicMock(return_value=True)),
            ),
        ):
            resp = client.get("/api/v1/ready")

        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "unhealthy"

    def test_streaming_not_checked_in_readiness(self, client):
        """Readiness only checks db, minio, redis — not streaming."""
        from stt_v2.health.api.routes import ComponentHealth, HealthStatus

        mock_db_session = AsyncMock()
        mock_db_session.__aenter__ = AsyncMock(return_value=AsyncMock())
        mock_db_session.__aexit__ = AsyncMock(return_value=False)

        redis_ok = ComponentHealth(
            name="redis",
            status=HealthStatus.HEALTHY,
            latency_ms=0.1,
        )

        with (
            patch(
                "stt_v2.health.api.routes.get_db_session", MagicMock(return_value=mock_db_session)
            ),
            patch(
                "stt_v2.health.api.routes.get_minio_client",
                return_value=MagicMock(health_check=MagicMock(return_value=True)),
            ),
            patch(
                "stt_v2.health.api.routes._check_redis",
                new_callable=AsyncMock,
                return_value=redis_ok,
            ),
        ):
            resp = client.get("/api/v1/ready")

        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"


# ---------------------------------------------------------------------------
# _check_streaming (Unit)
# ---------------------------------------------------------------------------


class TestCheckStreamingUnit:
    """Direct unit tests for _check_streaming()."""

    def test_manager_none_returns_degraded(self):
        from stt_v2.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: None),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        assert result["duration_ms"] == 0

    def test_manager_available_returns_healthy(self):
        from stt_v2.health.api.routes import _check_streaming

        mgr = MagicMock()

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: mgr),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "healthy"
        assert result["duration_ms"] == 0

    def test_import_error_returns_degraded(self):
        from stt_v2.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(
                    get_session_manager=MagicMock(side_effect=ImportError("no streaming"))
                ),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        assert "no streaming" in (result.get("message") or "")

    def test_runtime_error_returns_degraded(self):
        from stt_v2.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(
                    get_session_manager=MagicMock(side_effect=RuntimeError("crash"))
                ),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"


# ---------------------------------------------------------------------------
# _check_database (Unit)
# ---------------------------------------------------------------------------


class TestCheckDatabase:
    """Tests for _check_database()."""

    @pytest.mark.asyncio
    async def test_healthy_database(self):
        from stt_v2.health.api.routes import _check_database

        mock_session = AsyncMock()
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)

        with patch("stt_v2.health.api.routes.get_db_session", return_value=mock_ctx):
            result = await _check_database()

        assert result.name == "database"
        assert result.status.value == "healthy"
        assert result.latency_ms >= 0

    @pytest.mark.asyncio
    async def test_unhealthy_database(self):
        from stt_v2.health.api.routes import _check_database

        with patch(
            "stt_v2.health.api.routes.get_db_session", side_effect=RuntimeError("conn refused")
        ):
            result = await _check_database()

        assert result.name == "database"
        assert result.status.value == "unhealthy"
        assert "conn refused" in (result.message or "")


# ---------------------------------------------------------------------------
# _check_minio (Unit)
# ---------------------------------------------------------------------------


class TestCheckMinio:
    """Tests for _check_minio()."""

    @pytest.mark.asyncio
    async def test_healthy_minio(self):
        from stt_v2.health.api.routes import _check_minio

        mock_client = MagicMock()
        mock_client.health_check.return_value = True

        with patch("stt_v2.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

        assert result.name == "minio"
        assert result.status.value == "healthy"

    @pytest.mark.asyncio
    async def test_unhealthy_minio(self):
        from stt_v2.health.api.routes import _check_minio

        mock_client = MagicMock()
        mock_client.health_check.return_value = False

        with patch("stt_v2.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

        assert result.name == "minio"
        assert result.status.value == "unhealthy"

    @pytest.mark.asyncio
    async def test_minio_exception(self):
        from stt_v2.health.api.routes import _check_minio

        with patch(
            "stt_v2.health.api.routes.get_minio_client", side_effect=RuntimeError("no minio")
        ):
            result = await _check_minio()

        assert result.status.value == "unhealthy"
        assert "no minio" in (result.message or "")


# ---------------------------------------------------------------------------
# _check_redis (Unit)
# ---------------------------------------------------------------------------


class TestCheckRedis:
    """Tests for _check_redis()."""

    @pytest.mark.asyncio
    async def test_healthy_redis(self):
        from stt_v2.health.api.routes import _check_redis

        mock_client = AsyncMock()
        mock_client.ping = AsyncMock(return_value=True)

        with patch("stt_v2.streaming._runtime.get_redis_client", return_value=mock_client):
            result = await _check_redis()

        assert result.name == "redis"
        assert result.status.value == "healthy"

    @pytest.mark.asyncio
    async def test_unhealthy_redis(self):
        from stt_v2.health.api.routes import _check_redis

        with patch(
            "stt_v2.streaming._runtime.get_redis_client",
            side_effect=RuntimeError("redis down"),
        ):
            result = await _check_redis()

        assert result.name == "redis"
        assert result.status.value == "unhealthy"


# ---------------------------------------------------------------------------
# ComponentHealth dataclass
# ---------------------------------------------------------------------------


class TestComponentHealth:
    """Tests for ComponentHealth dataclass."""

    def test_component_to_dict(self):
        from stt_v2.health.api.routes import ComponentHealth, HealthStatus, _component_to_dict

        comp = ComponentHealth(
            name="test",
            status=HealthStatus.HEALTHY,
            latency_ms=12.345,
            message=None,
        )
        d = _component_to_dict(comp)
        assert d["status"] == "healthy"
        assert d["duration_ms"] == 12.35
        assert "message" not in d  # omitted when None

    def test_component_to_dict_with_message(self):
        from stt_v2.health.api.routes import ComponentHealth, HealthStatus, _component_to_dict

        comp = ComponentHealth(
            name="db",
            status=HealthStatus.UNHEALTHY,
            latency_ms=500.1,
            message="Connection refused",
        )
        d = _component_to_dict(comp)
        assert d["status"] == "unhealthy"
        assert d["message"] == "Connection refused"
