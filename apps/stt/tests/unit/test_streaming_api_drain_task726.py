"""Unit tests for the streaming draining HTTP surface (TASK-726 Task 3).

Mirrors the fixture shape of test_streaming_api.py's TestCreateSession /
capacity-rejection tests, scoped to a new file so it never collides with
sibling work in that shared test module.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.core.exceptions import SessionManagerDrainingError
from stt.streaming._runtime import clear_runtime, set_session_manager
from stt.streaming.api.routes import router


@pytest.fixture(autouse=True)
def _clean_runtime():
    clear_runtime()
    yield
    clear_runtime()


@pytest.fixture
def mock_session_manager():
    mgr = AsyncMock()
    mgr._guard = MagicMock()
    mgr._guard.max_streams = 10
    mgr._guard.active_count = 2
    mgr._guard.available_slots = 8
    mgr.capacity_guard = mgr._guard
    mgr.get_switch_controller = MagicMock(return_value=None)
    return mgr


@pytest.fixture
def app_with_streaming(mock_session_manager):
    set_session_manager(mock_session_manager)
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client(app_with_streaming):
    return TestClient(app_with_streaming)


@pytest.fixture
def app_no_streaming():
    clear_runtime()
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client_no_streaming(app_no_streaming):
    return TestClient(app_no_streaming)


class TestCreateSessionRejectedWhileDraining:
    def test_returns_503_draining_distinct_from_at_capacity(self, client, mock_session_manager):
        mock_session_manager.create_session = AsyncMock(
            side_effect=SessionManagerDrainingError("worker draining")
        )

        resp = client.post(
            "/internal/streaming/sessions",
            json={"session_id": "sess-drain-1", "tenant_id": "t-001", "pipeline_id": "pipe-001"},
        )

        assert resp.status_code == 503
        assert "Retry-After" in resp.headers
        assert resp.json()["detail"] == "Draining"


class TestBeginDrainEndpoint:
    def test_marks_manager_draining_and_reports_state(self, client, mock_session_manager):
        mock_session_manager.begin_drain = MagicMock()
        mock_session_manager.worker_id = "worker-1"
        mock_session_manager.active_session_count = 3

        resp = client.post("/internal/streaming/drain")

        assert resp.status_code == 200
        mock_session_manager.begin_drain.assert_called_once()
        body = resp.json()
        assert body["status"] == "draining"
        assert body["worker_id"] == "worker-1"
        assert body["active_sessions"] == 3

    def test_not_initialized_returns_503(self, client_no_streaming):
        resp = client_no_streaming.post("/internal/streaming/drain")
        assert resp.status_code == 503
