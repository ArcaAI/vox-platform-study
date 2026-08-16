"""Readiness probe reflects SessionManager draining state (TASK-726 Task 3).

This is the ACTUAL "stop routing new sessions here" mechanism: k8s removes a
pod from its Service Endpoints once /health/ready starts failing, which is
how a draining stt instance stops receiving new
`POST /internal/streaming/sessions` calls WITHOUT any gateway-side change —
see docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md §(a).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi.responses import JSONResponse

from stt.health.api.routes import ComponentHealth, HealthStatus, readiness_check


@pytest.mark.asyncio
async def test_readiness_returns_503_when_session_manager_draining():
    mock_mgr = MagicMock()
    mock_mgr.is_draining = True

    with (
        patch("stt.health.api.routes._check_database") as mock_db,
        patch("stt.health.api.routes._check_minio") as mock_minio,
        patch("stt.health.api.routes._check_redis") as mock_redis,
        patch("stt.streaming._runtime.get_session_manager", return_value=mock_mgr),
    ):
        mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
        mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
        mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

        result = await readiness_check()

        assert isinstance(result, JSONResponse)
        assert result.status_code == 503


@pytest.mark.asyncio
async def test_readiness_stays_healthy_when_session_manager_not_draining():
    mock_mgr = MagicMock()
    mock_mgr.is_draining = False

    with (
        patch("stt.health.api.routes._check_database") as mock_db,
        patch("stt.health.api.routes._check_minio") as mock_minio,
        patch("stt.health.api.routes._check_redis") as mock_redis,
        patch("stt.streaming._runtime.get_session_manager", return_value=mock_mgr),
    ):
        mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
        mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
        mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

        result = await readiness_check()

        assert result == {"status": "healthy"}


@pytest.mark.asyncio
async def test_readiness_healthy_when_streaming_not_initialized():
    """No SessionManager at all (batch-only mode) must not affect readiness."""
    with (
        patch("stt.health.api.routes._check_database") as mock_db,
        patch("stt.health.api.routes._check_minio") as mock_minio,
        patch("stt.health.api.routes._check_redis") as mock_redis,
        patch("stt.streaming._runtime.get_session_manager", return_value=None),
    ):
        mock_db.return_value = ComponentHealth("database", HealthStatus.HEALTHY, 5.0)
        mock_minio.return_value = ComponentHealth("minio", HealthStatus.HEALTHY, 3.0)
        mock_redis.return_value = ComponentHealth("redis", HealthStatus.HEALTHY, 2.0)

        result = await readiness_check()

        assert result == {"status": "healthy"}
