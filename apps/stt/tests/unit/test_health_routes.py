"""Unit tests for health/api/routes.py.

Covers:
- ``/api/v1/health`` — liveness probe
- ``/api/v1/live`` — liveness probe (simple)
- ``/api/v1/ready`` — readiness check including streaming component
- ``_check_streaming()`` — streaming health helper
- ``_check_minio()`` — MinIO health check
- ``_check_redis()`` — Redis health check

Uses FastAPI TestClient with mocked dependencies to avoid requiring
real MinIO or Redis connections. TASK-1006 — the service has no database, so there is
no database check.
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
    from stt.health.api.routes import router

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
        # TASK-1006 — no database connection, so no database component.
        assert "database" not in data["checks"]


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
        from stt.health.api.routes import ComponentHealth, HealthStatus

        mock_minio = MagicMock()
        mock_minio.health_check.return_value = True

        redis_ok = ComponentHealth(
            name="redis",
            status=HealthStatus.HEALTHY,
            latency_ms=0.1,
        )

        with (
            patch("stt.health.api.routes.get_minio_client", return_value=mock_minio),
            patch(
                "stt.health.api.routes._check_redis",
                new_callable=AsyncMock,
                return_value=redis_ok,
            ),
        ):
            resp = client.get("/api/v1/ready")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"

    def test_unhealthy_when_minio_down(self, client):
        with patch(
            "stt.health.api.routes.get_minio_client",
            return_value=MagicMock(health_check=MagicMock(return_value=False)),
        ):
            resp = client.get("/api/v1/ready")

        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "unhealthy"

    def test_streaming_not_checked_in_readiness(self, client):
        """Readiness only checks minio and redis — not streaming."""
        from stt.health.api.routes import ComponentHealth, HealthStatus

        redis_ok = ComponentHealth(
            name="redis",
            status=HealthStatus.HEALTHY,
            latency_ms=0.1,
        )

        with (
            patch(
                "stt.health.api.routes.get_minio_client",
                return_value=MagicMock(health_check=MagicMock(return_value=True)),
            ),
            patch(
                "stt.health.api.routes._check_redis",
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
        from stt.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt.streaming._runtime": MagicMock(get_session_manager=lambda: None),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        assert result["duration_ms"] == 0

    def test_manager_available_returns_healthy(self):
        from stt.health.api.routes import _check_streaming

        mgr = MagicMock()

        with patch.dict(
            "sys.modules",
            {
                "stt.streaming._runtime": MagicMock(get_session_manager=lambda: mgr),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "healthy"
        assert result["duration_ms"] == 0

    def test_import_error_returns_degraded(self):
        from stt.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt.streaming._runtime": MagicMock(
                    get_session_manager=MagicMock(side_effect=ImportError("no streaming"))
                ),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        assert "no streaming" in (result.get("message") or "")

    def test_runtime_error_returns_degraded(self):
        from stt.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt.streaming._runtime": MagicMock(
                    get_session_manager=MagicMock(side_effect=RuntimeError("crash"))
                ),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"


# ---------------------------------------------------------------------------
# _check_minio (Unit)
# ---------------------------------------------------------------------------


class TestCheckMinio:
    """Tests for _check_minio()."""

    @pytest.mark.asyncio
    async def test_healthy_minio(self):
        from stt.health.api.routes import _check_minio

        mock_client = MagicMock()
        mock_client.health_check.return_value = True

        with patch("stt.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

        assert result.name == "minio"
        assert result.status.value == "healthy"

    @pytest.mark.asyncio
    async def test_unhealthy_minio(self):
        from stt.health.api.routes import _check_minio

        mock_client = MagicMock()
        mock_client.health_check.return_value = False

        with patch("stt.health.api.routes.get_minio_client", return_value=mock_client):
            result = await _check_minio()

        assert result.name == "minio"
        assert result.status.value == "unhealthy"

    @pytest.mark.asyncio
    async def test_minio_exception(self):
        from stt.health.api.routes import _check_minio

        with patch("stt.health.api.routes.get_minio_client", side_effect=RuntimeError("no minio")):
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
        from stt.health.api.routes import _check_redis

        mock_client = AsyncMock()
        mock_client.ping = AsyncMock(return_value=True)

        with patch("stt.streaming._runtime.get_redis_client", return_value=mock_client):
            result = await _check_redis()

        assert result.name == "redis"
        assert result.status.value == "healthy"

    @pytest.mark.asyncio
    async def test_unhealthy_redis(self):
        from stt.health.api.routes import _check_redis

        with patch(
            "stt.streaming._runtime.get_redis_client",
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
        from stt.health.api.routes import ComponentHealth, HealthStatus, _component_to_dict

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
        from stt.health.api.routes import ComponentHealth, HealthStatus, _component_to_dict

        comp = ComponentHealth(
            name="db",
            status=HealthStatus.UNHEALTHY,
            latency_ms=500.1,
            message="Connection refused",
        )
        d = _component_to_dict(comp)
        assert d["status"] == "unhealthy"
        assert d["message"] == "Connection refused"


class TestDenoiseEngineStatusTask1030:
    """TASK-1030 (OD-2) — each denoise engine's status is VISIBLE in the health body,
    and an unavailable engine never makes the service unhealthy or not-ready: a
    session that selected it transcribes without denoise."""

    def _deps_ok(self):
        from stt.health.api.routes import ComponentHealth, HealthStatus

        redis_ok = ComponentHealth(name="redis", status=HealthStatus.HEALTHY, latency_ms=0.1)
        return (
            patch(
                "stt.health.api.routes.get_minio_client",
                return_value=MagicMock(health_check=MagicMock(return_value=True)),
            ),
            patch(
                "stt.health.api.routes._check_redis", new_callable=AsyncMock, return_value=redis_ok
            ),
        )

    def test_health_body_reports_each_engine_without_changing_the_status(self, client):
        status = {
            "rnnoise": {"status": "ok", "detail": ""},
            "deepfilternet3": {
                "status": "unavailable",
                "detail": "package `df.enhance` not importable",
            },
        }
        minio, redis = self._deps_ok()
        with (
            minio,
            redis,
            patch("stt.health.api.routes.denoise_engine_status", return_value=status),
        ):
            resp = client.get("/api/v1/health")

        data = resp.json()
        assert data["checks"]["denoise"] == status
        assert data["status"] == "healthy"

    def test_an_unavailable_engine_keeps_the_pod_ready(self, client):
        status = {
            "rnnoise": {"status": "unavailable", "detail": "x"},
            "deepfilternet3": {"status": "unavailable", "detail": "y"},
        }
        minio, redis = self._deps_ok()
        with (
            minio,
            redis,
            patch("stt.health.api.routes.denoise_engine_status", return_value=status),
        ):
            resp = client.get("/api/v1/health/ready")

        assert resp.status_code == 200
