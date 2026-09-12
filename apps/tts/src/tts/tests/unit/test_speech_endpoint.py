"""TDD tests for the OpenAI-compatible speech endpoint."""

from __future__ import annotations

import base64

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import tts.routing.router as router_mod
from tts.core.config import Settings
from tts.main import create_app
from tts.tests.fakes import FakeEngine, candidate, spec_json, voice_binding

# The gateway-resolved TEXT_TO_SPEECH agent every request now carries (TASK-879). It replaced the
# `routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings` fold: the engine chain, the
# model, the voices and the connection that serves each engine are all properties of the agent,
# and they arrive resolved. `en-IN` is the binding's locale, which is what the Prometheus labels
# below are keyed on.
_EN = voice_binding("en-female-1", locale="en-IN")


def _spec(engine: str = "azure", **kwargs) -> dict:
    return spec_json(candidate(engine, voices=[_EN], voice=_EN.id, **kwargs))


def _app(providers: dict | None = None):
    # Explicit empty service_token (dev-mode bypass) — otherwise pydantic-settings
    # picks up a real TTS_SERVICE_TOKEN from the host/.env.dev environment and
    # every unauthenticated test client call 401s (pre-existing env-coupling,
    # unrelated to; test_stream_ws.py's `_app` already does this).
    app = create_app(settings_override=Settings(debug=True, internal_access_token=""))
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
                "resolved_spec": _spec(),
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
                "resolved_spec": _spec(),
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
                "resolved_spec": _spec(),
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
                "resolved_spec": _spec(),
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
            "/api/v1/audio/speech", json={"input": "", "voice": "en-female-1", "resolved_spec": _spec()}
        )
        assert r.status_code == 422

    @pytest.mark.asyncio
    async def test_a_request_with_no_resolved_spec_is_refused(self, client_with_azure):
        """FAIL CLOSED. This service reads no selection of its own, so a request with no spec
        could only be served on a guessed vendor — which is the whole failure mode the agent-first
        speech path exists to remove."""
        r = await client_with_azure.post(
            "/api/v1/audio/speech", json={"input": "Hi.", "voice": "en-female-1"}
        )
        assert r.status_code == 422

    @pytest.mark.asyncio
    async def test_unknown_voice_404(self, client_with_azure):
        r = await client_with_azure.post(
            "/api/v1/audio/speech", json={"input": "Hi.", "voice": "nope-1", "resolved_spec": _spec()}
        )
        assert r.status_code == 404

    @pytest.mark.asyncio
    async def test_oversize_input_413(self):
        app = _app({"azure": FakeEngine("azure")})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                "/api/v1/audio/speech",
                json={"input": "x" * 5000, "voice": "en-female-1", "resolved_spec": _spec()},
            )
        assert r.status_code == 413


class TestUnavailable:
    @pytest.mark.asyncio
    async def test_no_provider_returns_503(self):
        app = _app()  # no providers registered
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post("/api/v1/audio/speech", json={"input": "Hi.", "voice": "en-female-1", "resolved_spec": _spec()})
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
                "resolved_spec": _spec(),
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
            json={"input": text, "voice": "en-female-1", "resolved_spec": _spec()},
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
                json={"input": "x" * 5000, "voice": "en-female-1", "resolved_spec": _spec()},
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
                "resolved_spec": _spec(),
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
                "resolved_spec": _spec(),
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
            json={"input": "Hi.", "voice": "en-female-1", "resolved_spec": _spec()},
        )

        after_chars = REGISTRY.get_sample_value("tts_characters_total", labels)
        after_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels)
        assert after_chars == before_chars + 3
        assert after_secs == pytest.approx(before_secs + 14 / 48000)


class TestComputeMetadataHeaders:
    """TASK-959 — compute/device/byte metadata beside the existing usage headers.

    ``X-Tts-Synthesis-Ms``/``X-Tts-Response-Bytes``/``X-Tts-Byte-Source`` are only knowable once
    the whole utterance has been produced, so they ride the BATCH response only.
    ``X-Tts-Device`` is known off the first chunk (like ``X-Tts-Provider``/``X-Tts-Connection-Id``)
    and rides every response mode; it is absent for a cloud engine with no device of ours.
    ``X-Tts-Ttfa-Ms`` is this lane's documented substitute on the two paths that stream the body
    before the total synthesis time is known.
    """

    @pytest.mark.asyncio
    async def test_batch_local_provider_carries_all_four_headers(self, monkeypatch):
        # Bypass the real spec-built KokoroProvider (which would try to load actual model
        # weights) and serve the registered FakeEngine instead — the same seam
        # `test_router.py`'s `registered_engines_serve` fixture uses.
        monkeypatch.setattr(router_mod, "_build_spec_engine", lambda *_a, **_k: None)
        # `device` carries a dead validation alias (control-plane-owned field, see
        # `moved_alias`) — `model_copy(update=...)` is the sanctioned way past it,
        # the same seam `router.py` itself uses for the other per-request fields.
        settings_override = Settings(debug=True, internal_access_token="")
        settings_override.kokoro = settings_override.kokoro.model_copy(update={"device": "cuda"})
        app = create_app(settings_override=settings_override)
        app.state.provider_registry.register(
            "kokoro", FakeEngine("kokoro", chunks=2, payload=b"PCMDATA")
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(
                "/api/v1/audio/speech",
                json={
                    "input": "Hello.",
                    "voice": "en-female-1",
                    "response_format": "pcm",
                    "resolved_spec": _spec(engine="kokoro"),
                },
            )
        assert r.status_code == 200
        assert r.headers["x-tts-provider"] == "kokoro"
        assert r.headers["x-tts-device"] == "cuda"
        assert int(r.headers["x-tts-synthesis-ms"]) >= 0
        assert r.headers["x-tts-response-bytes"] == str(len(b"PCMDATA" * 2))
        assert r.headers["x-tts-byte-source"] == "wire"

    @pytest.mark.asyncio
    async def test_batch_azure_omits_device_but_carries_synthesis_ms_and_app_byte_source(
        self, client_with_azure
    ):
        # Azure Speech is a cloud engine that names no device of ours — the header must be
        # ABSENT, never an empty string or a guessed value.
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hello.",
                "voice": "en-female-1",
                "response_format": "pcm",
                "resolved_spec": _spec(),
            },
        )
        assert r.status_code == 200
        assert r.headers["x-tts-provider"] == "azure"
        assert "x-tts-device" not in r.headers
        assert int(r.headers["x-tts-synthesis-ms"]) >= 0
        assert r.headers["x-tts-response-bytes"] == str(len(b"PCMDATA" * 2))
        assert r.headers["x-tts-byte-source"] == "app"

    @pytest.mark.asyncio
    async def test_streaming_response_carries_ttfa_ms_and_omits_batch_only_headers(
        self, client_with_azure
    ):
        # Headers commit before the body streams, so the total synthesis time and the total
        # byte count are not knowable yet — only time-to-first-audio is.
        r = await client_with_azure.post(
            "/api/v1/audio/speech",
            json={
                "input": "Hi.",
                "voice": "en-female-1",
                "stream_format": "audio",
                "resolved_spec": _spec(),
            },
        )
        assert r.status_code == 200
        assert int(r.headers["x-tts-ttfa-ms"]) >= 0
        assert "x-tts-synthesis-ms" not in r.headers
        assert "x-tts-response-bytes" not in r.headers
        assert "x-tts-byte-source" not in r.headers
