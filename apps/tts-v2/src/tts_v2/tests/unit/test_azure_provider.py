"""TDD tests for AzureSpeechProvider (TASK-488 Phase 3).

The Azure SDK is fully faked (injected) so these run hermetically without the
native ``azure-cognitiveservices-speech`` wheel. A live test at the bottom is
gated behind ``TTS_AZURE_LIVE_TEST=1`` and marked ``e2e`` (deselected by default).
"""

from __future__ import annotations

import os

import pytest

from tts_v2.core.config import AzureSpeechConfig
from tts_v2.providers.azure_speech import AzureSpeechProvider, AzureSynthesisError
from tts_v2.providers.base import AudioFormat, SynthesisRequest, TTSEngine

# ── Fake Azure Speech SDK ───────────────────────────────────────────────────


class _FakeFuture:
    def __init__(self, result):
        self._result = result

    def get(self):
        return self._result


class _FakeResult:
    def __init__(self, reason, chunks=None, cancel=None):
        self.reason = reason
        self.chunks = list(chunks or [])
        self.cancellation_details = cancel


class _FakeConfig:
    def __init__(self, subscription=None, region=None):
        self.subscription = subscription
        self.region = region
        self.speech_synthesis_voice_name = None
        self.output_format = None

    def set_speech_synthesis_output_format(self, fmt):
        self.output_format = fmt


class _FakeAudioDataStream:
    def __init__(self, result):
        self._chunks = list(result.chunks)

    def read_data(self, buffer):
        if not self._chunks:
            return 0
        chunk = self._chunks.pop(0)
        buffer[: len(chunk)] = chunk
        return len(chunk)


def make_fake_sdk(result):
    class _OutputFormats:
        Raw24Khz16BitMonoPcm = "raw-24k-pcm"
        Riff24Khz16BitMonoPcm = "riff-24k-pcm"
        Audio24Khz48KBitRateMonoMp3 = "mp3-24k-48k"

    class _ResultReason:
        SynthesizingAudioStarted = "started"
        Canceled = "canceled"

    class SDK:
        SpeechConfig = _FakeConfig
        AudioDataStream = _FakeAudioDataStream
        SpeechSynthesisOutputFormat = _OutputFormats
        ResultReason = _ResultReason
        synths: list = []
        state = {"connection_opened": False}

    class _Synth:
        def __init__(self, speech_config=None, audio_config=None):
            self.cfg = speech_config
            self.text = None
            self.ssml = None
            SDK.synths.append(self)

        def start_speaking_text_async(self, text):
            self.text = text
            return _FakeFuture(result)

        def start_speaking_ssml_async(self, ssml):
            self.ssml = ssml
            return _FakeFuture(result)

    class _Connection:
        @staticmethod
        def from_speech_synthesizer(synth):
            return _Connection()

        def open(self, for_connection):
            SDK.state["connection_opened"] = True

    SDK.SpeechSynthesizer = _Synth
    SDK.Connection = _Connection
    return SDK


def _config(key: str = "secret-key", region: str = "eastus") -> AzureSpeechConfig:
    return AzureSpeechConfig(api_key=key, region=region, enabled=True)


def _req(**kw) -> SynthesisRequest:
    base = {"text": "Hello.", "provider_voice": "en-IN-NeerjaNeural", "locale": "en-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


# ── Tests ───────────────────────────────────────────────────────────────────


class TestSynthesis:
    @pytest.mark.asyncio
    async def test_emits_chunks(self):
        sdk = make_fake_sdk(_FakeResult("started", chunks=[b"aa", b"bb", b"cc"]))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        chunks = await _collect(provider, _req())
        assert [c.data for c in chunks] == [b"aa", b"bb", b"cc"]

    @pytest.mark.asyncio
    async def test_voice_and_format_mapping_pcm(self):
        sdk = make_fake_sdk(_FakeResult("started", chunks=[b"x"]))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        await _collect(provider, _req(provider_voice="ml-IN-SobhanaNeural", fmt=AudioFormat.PCM))
        cfg = sdk.synths[-1].cfg
        assert cfg.speech_synthesis_voice_name == "ml-IN-SobhanaNeural"
        assert cfg.output_format == "raw-24k-pcm"

    @pytest.mark.asyncio
    async def test_format_mapping_wav_and_mp3(self):
        for fmt, expected in [
            (AudioFormat.WAV, "riff-24k-pcm"),
            (AudioFormat.MP3, "mp3-24k-48k"),
        ]:
            sdk = make_fake_sdk(_FakeResult("started", chunks=[b"x"]))
            provider = AzureSpeechProvider(_config(), sdk=sdk)
            await _collect(provider, _req(fmt=fmt))
            assert sdk.synths[-1].cfg.output_format == expected

    @pytest.mark.asyncio
    async def test_speed_uses_ssml(self):
        sdk = make_fake_sdk(_FakeResult("started", chunks=[b"x"]))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        await _collect(provider, _req(speed=1.2))
        synth = sdk.synths[-1]
        assert synth.text is None
        assert synth.ssml is not None and "prosody" in synth.ssml and "+20%" in synth.ssml

    @pytest.mark.asyncio
    async def test_default_speed_uses_plain_text(self):
        sdk = make_fake_sdk(_FakeResult("started", chunks=[b"x"]))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        await _collect(provider, _req(speed=1.0))
        assert sdk.synths[-1].text == "Hello."
        assert sdk.synths[-1].ssml is None

    @pytest.mark.asyncio
    async def test_canceled_result_raises(self):
        sdk = make_fake_sdk(_FakeResult("canceled", cancel="auth failed"))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        with pytest.raises(AzureSynthesisError):
            await _collect(provider, _req())


class TestEndToEndThroughApp:
    """Full path: POST /audio/speech → router → AzureSpeechProvider (fake SDK)."""

    @pytest.mark.asyncio
    async def test_speech_endpoint_streams_azure_audio(self):
        from httpx import ASGITransport, AsyncClient

        from tts_v2.core.config import Settings
        from tts_v2.main import create_app

        app = create_app(settings_override=Settings(debug=True))
        sdk = make_fake_sdk(_FakeResult("started", chunks=[b"AA", b"BB"]))
        app.state.provider_registry.register("azure", AzureSpeechProvider(_config(), sdk=sdk))

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v1/audio/speech", json={"input": "Hi.", "voice": "en-female-1"}
            )
        assert resp.status_code == 200
        assert resp.content == b"AABB"
        # Azure received the catalog-resolved en-IN voice binding.
        assert sdk.synths[-1].cfg.speech_synthesis_voice_name == "en-IN-NeerjaNeural"


class TestProviderContract:
    def test_satisfies_engine_protocol(self):
        provider = AzureSpeechProvider(_config(), sdk=make_fake_sdk(_FakeResult("started")))
        assert isinstance(provider, TTSEngine)
        assert provider.native_streaming is True

    @pytest.mark.asyncio
    async def test_health_reflects_credential(self):
        sdk = make_fake_sdk(_FakeResult("started"))
        assert await AzureSpeechProvider(_config(key="k"), sdk=sdk).health() is True
        assert await AzureSpeechProvider(_config(key=""), sdk=sdk).health() is False

    @pytest.mark.asyncio
    async def test_prewarm_opens_connection(self):
        sdk = make_fake_sdk(_FakeResult("started"))
        provider = AzureSpeechProvider(_config(), sdk=sdk)
        await provider.prewarm()
        assert sdk.state["connection_opened"] is True


@pytest.mark.e2e
@pytest.mark.skipif(
    os.environ.get("TTS_AZURE_LIVE_TEST") != "1",
    reason="live Azure test — set TTS_AZURE_LIVE_TEST=1 and AZURE_SPEECH_KEY",
)
@pytest.mark.asyncio
async def test_live_azure_en_and_ml():
    """Real synthesis against Azure (en + ml). Requires a real credential."""
    from tts_v2.core.config import Settings

    settings = Settings()
    provider = AzureSpeechProvider(settings.azure)
    assert await provider.health() is True
    for voice, locale in [("en-IN-NeerjaNeural", "en-IN"), ("ml-IN-SobhanaNeural", "ml-IN")]:
        req = SynthesisRequest(
            text="Hello." if locale == "en-IN" else "ഹലോ.",
            provider_voice=voice,
            locale=locale,
            fmt=AudioFormat.PCM,
        )
        total = sum(len(c.data) async for c in provider.synthesize(req))
        assert total > 0
