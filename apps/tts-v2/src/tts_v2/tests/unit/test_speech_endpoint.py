"""TDD tests for the OpenAI-compatible speech endpoint (TASK-488 Phase 2)."""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts_v2.core.config import Settings
from tts_v2.main import create_app
from tts_v2.tests.fakes import FakeEngine


def _app(providers: dict | None = None):
    app = create_app(settings_override=Settings(debug=True))
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
            json={"input": "Hello.", "voice": "en-female-1", "response_format": "pcm"},
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/pcm")
        assert r.content == b"PCMDATA" * 2

    @pytest.mark.asyncio
    async def test_batch_mp3_content_type(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={"input": "Hi.", "voice": "en-female-1", "response_format": "mp3"},
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/mpeg")


class TestStreaming:
    @pytest.mark.asyncio
    async def test_stream_audio_chunks(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={"input": "Hi.", "voice": "en-female-1", "stream_format": "audio"},
        )
        assert r.status_code == 200
        assert r.content == b"PCMDATA" * 2
        assert r.headers.get("x-accel-buffering") == "no"

    @pytest.mark.asyncio
    async def test_stream_sse_events(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={"input": "Hi.", "voice": "en-female-1", "stream_format": "sse"},
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
            r = await c.post(
                "/api/v1/audio/speech", json={"input": "Hi.", "voice": "en-female-1"}
            )
        assert r.status_code == 503


class TestVoices:
    @pytest.mark.asyncio
    async def test_list_voices(self, client_with_azure):
        r = await client_with_azure.get("/api/v1/voices")
        assert r.status_code == 200
        ids = [v["id"] for v in r.json()["voices"]]
        assert "en-female-1" in ids and "ml-female-1" in ids
