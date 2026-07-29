"""TDD tests for the WS-duplex streaming endpoint.

Uses Starlette's WebSocket test client against the real app with a fake engine
registered — exercises the init→ready handshake, per-sentence binary frames,
done, up-front error surfacing, and the service-token gate.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tts.core.config import Settings
from tts.main import create_app
from tts.tests.fakes import FakeEngine


def _app(*, service_token: str = "", providers: dict | None = None):
    app = create_app(settings_override=Settings(service_token=service_token))
    if providers is None:
        providers = {"azure": FakeEngine("azure", chunks=1)}
    for name, engine in providers.items():
        app.state.provider_registry.register(name, engine)
    return app


def test_init_ready_then_binary_frames_then_done():
    app = _app(providers={"azure": FakeEngine("azure", native_streaming=False, chunks=1)})
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/audio/stream") as ws:
            # routing chain is gateway-injected on the init frame (TASK-577).
            ws.send_json(
                {
                    "type": "init",
                    "voice": "en-female-1",
                    "format": "pcm",
                    "routing_en": ["azure", "kokoro"],
                }
            )
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            assert ready["sample_rate"] == 24000 and ready["channels"] == 1
            ws.send_json({"type": "text", "text": "One. "})
            ws.send_json({"type": "text", "text": "Two. "})
            ws.send_json({"type": "end"})
            frame1 = ws.receive_bytes()
            frame2 = ws.receive_bytes()
            done = ws.receive_json()
            assert frame1 == b"AUDIO" and frame2 == b"AUDIO"
            assert done == {"type": "done"}


def test_unknown_voice_errors_before_audio():
    app = _app()
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/audio/stream") as ws:
            ws.send_json({"type": "init", "voice": "nope-voice", "format": "pcm"})
            msg = ws.receive_json()
            assert msg["type"] == "error" and msg["code"] == "invalid_voice"


def test_no_provider_errors_up_front():
    app = _app(providers={})  # nothing registered → no candidate
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/audio/stream") as ws:
            ws.send_json({"type": "init", "voice": "en-female-1", "format": "pcm"})
            msg = ws.receive_json()
            assert msg["type"] == "error" and msg["code"] == "provider_unavailable"


def test_first_message_must_be_init():
    app = _app()
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/audio/stream") as ws:
            ws.send_json({"type": "text", "text": "hi "})
            msg = ws.receive_json()
            assert msg["type"] == "error" and msg["code"] == "invalid_input"


def test_non_pcm_format_rejected():
    app = _app()
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/audio/stream") as ws:
            ws.send_json({"type": "init", "voice": "en-female-1", "format": "mp3"})
            msg = ws.receive_json()
            assert msg["type"] == "error" and msg["code"] == "invalid_input"


def test_missing_service_token_closes_4401():
    app = _app(service_token="s3cret")
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/api/v1/audio/stream") as ws:
                ws.receive_json()  # server closes before accept
        assert exc.value.code == 4401


def test_valid_service_token_accepted():
    app = _app(
        service_token="s3cret",
        providers={"azure": FakeEngine("azure", native_streaming=False, chunks=1)},
    )
    with TestClient(app) as client:
        with client.websocket_connect(
            "/api/v1/audio/stream", headers={"x-service-token": "s3cret"}
        ) as ws:
            ws.send_json(
                {
                    "type": "init",
                    "voice": "en-female-1",
                    "format": "pcm",
                    "routing_en": ["azure", "kokoro"],
                }
            )
            assert ws.receive_json()["type"] == "ready"
