"""Unit tests for the language-mode streaming API wiring (TASK-587)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import LanguageModeUnsupportedError
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
    guard = MagicMock()
    guard.max_streams = 10
    guard.active_count = 1
    mgr.capacity_guard = guard
    # get_switch_controller (TASK-613) is a SYNCHRONOUS method on the real
    # SessionManager; explicitly set as a plain MagicMock so routes.py's
    # synchronous call site gets None back instead of an unawaited coroutine.
    mgr.get_switch_controller = MagicMock(return_value=None)
    return mgr


@pytest.fixture
def client(mock_session_manager):
    set_session_manager(mock_session_manager)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _create_body(**overrides) -> dict:
    body = {
        "session_id": "sess-587",
        "tenant_id": "tenant-1",
        "pipeline_id": "pipeline-1",
    }
    body.update(overrides)
    return body


def test_get_language_modes_returns_catalog(client: TestClient) -> None:
    resp = client.get("/internal/streaming/language-modes")
    assert resp.status_code == 200
    modes = resp.json()["modes"]
    ids = [m["id"] for m in modes]
    assert ids == ["en", "ml", "ml-en", "vi", "vi-en", "auto"]
    ml_en = next(m for m in modes if m["id"] == "ml-en")
    assert AiModelFormat.SARVAM.value in ml_en["supportedEngines"]
    assert AiModelFormat.NEMO.value not in ml_en["supportedEngines"]


def test_create_forwards_language_mode(client: TestClient, mock_session_manager) -> None:
    session = MagicMock()
    session.session_id = "sess-587"
    session.pipeline_id = "pipeline-1"
    mock_session_manager.create_session.return_value = session

    resp = client.post("/internal/streaming/sessions", json=_create_body(language_mode="ml-en"))

    assert resp.status_code == 201
    kwargs = mock_session_manager.create_session.await_args.kwargs
    assert kwargs["language_mode"] == "ml-en"


def test_create_maps_unsupported_mode_to_422(client: TestClient, mock_session_manager) -> None:
    mock_session_manager.create_session.side_effect = LanguageModeUnsupportedError(
        "ml", AiModelFormat.NEMO
    )

    resp = client.post("/internal/streaming/sessions", json=_create_body(language_mode="ml"))

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["languageMode"] == "ml"
    assert detail["engine"] == AiModelFormat.NEMO.value
    assert "en" in detail["supportedModes"]
    assert "ml" not in detail["supportedModes"]
