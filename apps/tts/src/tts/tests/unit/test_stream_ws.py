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
            # routing chain is gateway-injected on the init frame.
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


class TestUsageMetering:
    """The WS-duplex session accumulates accepted characters
    (every pushed "text" frame) and synthesized audio bytes, and surfaces both
    in a final ``{"type":"usage",...}`` frame at teardown — success OR abort —
    so the gateway (which fronts this socket, never the browser directly) can
    emit CHARACTER + AUDIO_SECOND ledger rows. The gateway strips this frame
    from the client relay (out of this file's scope); tested here at the TTS
    boundary directly.
    """

    def test_usage_frame_after_done_on_clean_completion(self) -> None:
        # "AUDIO" (5 bytes) x2 sentences = 10 bytes @ 24000 Hz s16le mono.
        app = _app(providers={"azure": FakeEngine("azure", native_streaming=False, chunks=1)})
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/audio/stream") as ws:
                ws.send_json(
                    {
                        "type": "init",
                        "voice": "en-female-1",
                        "format": "pcm",
                        "routing_en": ["azure", "kokoro"],
                    }
                )
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "text", "text": "One. "})
                ws.send_json({"type": "text", "text": "Two. "})
                ws.send_json({"type": "end"})
                assert ws.receive_bytes() == b"AUDIO"
                assert ws.receive_bytes() == b"AUDIO"
                done = ws.receive_json()
                usage = ws.receive_json()

        assert done == {"type": "done"}
        assert usage["type"] == "usage"
        assert usage["characters"] == len("One. Two. ")
        assert usage["audioSeconds"] == pytest.approx(10 / 48000)
        assert usage["interrupted"] is False
        assert usage["provider"] == "azure"

    def test_usage_frame_reports_partial_progress_on_mid_stream_failure(self) -> None:
        # One sentence emits one chunk, THEN fails — no failover candidate
        # (audio already flowing), so the session tears down via the error
        # path. The usage frame must still report what actually happened:
        # partial bytes, interrupted=True — never silently drop it.
        engine = FakeEngine("azure", native_streaming=False, chunks=2, fail_after_chunks=1)
        app = _app(providers={"azure": engine})
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/audio/stream") as ws:
                ws.send_json(
                    {"type": "init", "voice": "en-female-1", "format": "pcm", "routing_en": ["azure"]}
                )
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "text", "text": "Hi. "})
                ws.send_json({"type": "end"})
                assert ws.receive_bytes() == b"AUDIO"
                err = ws.receive_json()
                usage = ws.receive_json()

        assert err["type"] == "error"
        assert usage["type"] == "usage"
        assert usage["characters"] == len("Hi. ")
        assert usage["audioSeconds"] == pytest.approx(5 / 48000)
        assert usage["interrupted"] is True
        assert usage["provider"] == "azure"

    def test_usage_frame_sent_on_no_provider_before_any_audio(self) -> None:
        # Failure before the FIRST byte of the FIRST sentence — zero audio
        # ever flowed, so provider is unresolved (None), not fabricated.
        engine = FakeEngine("azure", native_streaming=False, fail_before_emit=True)
        app = _app(providers={"azure": engine})
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/audio/stream") as ws:
                ws.send_json(
                    {"type": "init", "voice": "en-female-1", "format": "pcm", "routing_en": ["azure"]}
                )
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "text", "text": "Hi. "})
                ws.send_json({"type": "end"})
                err = ws.receive_json()
                usage = ws.receive_json()

        assert err["type"] == "error"
        assert usage["type"] == "usage"
        assert usage["audioSeconds"] is None
        assert usage["interrupted"] is True
        assert usage["provider"] is None

    def test_prometheus_counters_recorded_on_clean_completion(self) -> None:
        from prometheus_client import REGISTRY

        labels = {"provider": "azure", "locale": "en-IN", "status": "ok"}
        before_chars = REGISTRY.get_sample_value("tts_characters_total", labels) or 0.0
        before_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels) or 0.0

        app = _app(providers={"azure": FakeEngine("azure", native_streaming=False, chunks=1)})
        with TestClient(app) as client:
            with client.websocket_connect("/api/v1/audio/stream") as ws:
                ws.send_json(
                    {"type": "init", "voice": "en-female-1", "format": "pcm", "routing_en": ["azure"]}
                )
                assert ws.receive_json()["type"] == "ready"
                ws.send_json({"type": "text", "text": "Hi. "})
                ws.send_json({"type": "end"})
                ws.receive_bytes()
                ws.receive_json()  # done
                ws.receive_json()  # usage

        after_chars = REGISTRY.get_sample_value("tts_characters_total", labels)
        after_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels)
        assert after_chars == before_chars + len("Hi. ")
        assert after_secs == pytest.approx(before_secs + 5 / 48000)
