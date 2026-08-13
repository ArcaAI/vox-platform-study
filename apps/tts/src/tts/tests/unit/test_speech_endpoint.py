"""TDD tests for the OpenAI-compatible speech endpoint."""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts.core.config import Settings
from tts.main import create_app
from tts.tests.fakes import FakeEngine


def _app(providers: dict | None = None):
    # Explicit empty service_token (dev-mode bypass) — otherwise pydantic-settings
    # picks up a real TTS_SERVICE_TOKEN from the host/.env.dev environment and
    # every unauthenticated test client call 401s (pre-existing env-coupling,
    # unrelated to; test_stream_ws.py's `_app` already does this).
    app = create_app(settings_override=Settings(debug=True, service_token=""))
    for name, engine in (providers or {}).items():
        app.state.provider_registry.register(name, engine)
    return app


@pytest_asyncio.fixture
async def client_with_azure():
    app = _app({"azure": FakeEngine("azure", chunks=2, payload=b"PCMDATA")})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


class TestBatch:
    @pytest.mark.asyncio
    async def test_batch_pcm(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hello.",
                "voice": "en-female-1",
                "response_format": "pcm",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/pcm")
        assert r.content == b"PCMDATA" * 2

    @pytest.mark.asyncio
    async def test_batch_mp3_content_type(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "response_format": "mp3",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")


class TestStreaming:
    @pytest.mark.asyncio
    async def test_stream_audio_chunks(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "stream_format": "audio",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        assert r.content == b"PCMDATA" * 2
        assert r.headers.get("x-accel-buffering") == "no"

    @pytest.mark.asyncio
    async def test_stream_sse_events(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "stream_format": "sse",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        body = r.text
        assert "speech.audio.delta" in body
        assert "speech.audio.done" in body
        assert base64.b64encode(b"PCMDATA").decode() in body


class TestValidation:
    @pytest.mark.asyncio
    async def test_empty_input_422(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech", json={"input": "", "voice": "en-female-1"}
        )
        assert r.status_code == 422

    @pytest.mark.asyncio
    async def test_unknown_voice_404(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech", json={"input": "Hi.", "voice": "nope-1"}
        )
        assert r.status_code == 404

    @pytest.mark.asyncio
    async def test_oversize_input_413(self):
        app = _app({"azure": FakeEngine("azure")})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                "/api/v1/audio/speech",
                json={"input": "x" * 5000, "voice": "en-female-1"},
            )
        assert r.status_code == 413


class TestUnavailable:
    @pytest.mark.asyncio
    async def test_no_provider_returns_503(self):
        app = _app()  # no providers registered
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post("/api/v1/audio/speech", json={"input": "Hi.", "voice": "en-female-1"})
        assert r.status_code == 503


class TestVoices:
    @pytest.mark.asyncio
    async def test_list_voices(self, client_with_azure):
        r = await client_with_azure.get("/api/v1/voices")
        assert r.status_code == 200
        ids = [v["id"] for v in r.json()["voices"]]
        assert "en-female-1" in ids and "ml-female-1" in ids


class TestUsageMetering:
    """Accepted-input character count + synthesized
    audio-seconds, surfaced in the response so the gateway can emit
    CHARACTER + AUDIO_SECOND ledger rows without re-deriving TTS internals."""

    @pytest.mark.asyncio
    async def test_batch_response_carries_usage_headers(self, client_with_azure):
        # "PCMDATA" (7 bytes) x2 chunks = 14 bytes @ 24000 Hz s16le mono.
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hello.",
                "voice": "en-female-1",
                "response_format": "pcm",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        assert r.headers["x-tts-characters"] == "6"
        assert r.headers["x-tts-sample-rate"] == "24000"
        assert r.headers["x-tts-audio-format"] == "pcm"
        assert r.headers["x-tts-provider"] == "azure"
        assert float(r.headers["x-tts-audio-seconds"]) == pytest.approx(14 / 48000)

    @pytest.mark.asyncio
    async def test_batch_character_count_is_code_points_not_utf16_units(self, client_with_azure):
        # Malayalam text + an astral-plane emoji: code-point counting only,
        # no CJK/Indic double counting and no UTF-16 surrogate-pair inflation.
        text = "നമസ്കാരം \U0001f600"
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={"input": text, "voice": "en-female-1", "routing_en": ["azure", "kokoro"]},
        )
        assert r.status_code == 200
        assert r.headers["x-tts-characters"] == str(len(text))

    @pytest.mark.asyncio
    async def test_413_rejected_request_emits_nothing(self):
        # No work was done — no usage headers, and the ledger-feeding
        # Prometheus counters must not move.
        from prometheus_client import REGISTRY

        from tts.core import metrics as m

        labels = {"provider": "azure", "locale": "en-IN", "status": "ok"}
        before = REGISTRY.get_sample_value("tts_characters_total", labels) or 0.0

        app = _app({"azure": FakeEngine("azure")})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                "/api/v1/audio/speech",
                json={"input": "x" * 5000, "voice": "en-female-1"},
            )
        assert r.status_code == 413
        assert "x-tts-characters" not in r.headers
        assert (REGISTRY.get_sample_value("tts_characters_total", labels) or 0.0) == before
        del m  # imported for the REGISTRY metric name only

    @pytest.mark.asyncio
    async def test_raw_audio_stream_has_no_final_audio_seconds_header(self, client_with_azure):
        # Duration isn't known until the stream completes — headers are sent
        # before the first byte, so it CANNOT be an up-front header here. The
        # gateway derives it from the sample-rate/format headers + byte count
        # it observes while proxying (same RTF byte math).
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "stream_format": "audio",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        assert r.headers["x-tts-characters"] == "3"
        assert r.headers["x-tts-sample-rate"] == "24000"
        assert r.headers["x-tts-audio-format"] == "pcm"
        assert r.headers["x-tts-provider"] == "azure"
        assert "x-tts-audio-seconds" not in r.headers

    @pytest.mark.asyncio
    async def test_sse_stream_emits_final_usage_event(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "stream_format": "sse",
                "routing_en": ["azure", "kokoro"],
            },
        )
        assert r.status_code == 200
        body = r.text
        assert "speech.usage" in body
        assert '"characters": 3' in body or '"characters":3' in body

    @pytest.mark.asyncio
    async def test_batch_records_prometheus_usage_counters(self, client_with_azure):
        from prometheus_client import REGISTRY

        labels = {"provider": "azure", "locale": "en-IN", "status": "ok"}
        before_chars = REGISTRY.get_sample_value("tts_characters_total", labels) or 0.0
        before_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels) or 0.0

        await client_with_azure.post(
            "/api/v1/audio/speech",
            json={"input": "Hi.", "voice": "en-female-1", "routing_en": ["azure", "kokoro"]},
        )

        after_chars = REGISTRY.get_sample_value("tts_characters_total", labels)
        after_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels)
        assert after_chars == before_chars + 3
        assert after_secs == pytest.approx(before_secs + 14 / 48000)
