"""TDD tests for SarvamProvider + catalog/routing wiring."""

from __future__ import annotations

import base64
import os

import pytest

from tts.catalog.voices import VoiceCatalog
from tts.core.config import SarvamConfig, Settings
from tts.providers.base import AudioFormat, ProviderRegistry, SynthesisRequest, TTSEngine
from tts.providers.sarvam import SarvamProvider, SarvamSynthesisError
from tts.routing.router import TTSRouter
from tts.tests.fakes import FakeEngine


class _FakeResp:
    def __init__(self, status: int, payload: dict) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp
        self.calls: list[dict] = []

    async def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return self._resp

    async def aclose(self) -> None:
        return None


def _cfg(**kw) -> SarvamConfig:
    base = {"api_key": "sarvam-key", "enabled": True}
    base.update(kw)
    return SarvamConfig(**base)


def _req(**kw) -> SynthesisRequest:
    base = {"text": "ഹലോ.", "provider_voice": "ishita", "locale": "ml-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


class TestSynthesis:
    @pytest.mark.asyncio
    async def test_pcm_request_shape_and_chunks(self):
        client = _FakeClient(_FakeResp(200, {"audios": [base64.b64encode(b"PCMDATA").decode()]}))
        provider = SarvamProvider(_cfg(), client=client)
        chunks = await _collect(provider, _req(fmt=AudioFormat.PCM))
        assert b"".join(c.data for c in chunks) == b"PCMDATA"
        body = client.calls[0]["json"]
        assert body["target_language_code"] == "ml-IN"
        assert body["speaker"] == "ishita"
        assert body["output_audio_codec"] == "linear16"
        assert body["speech_sample_rate"] == "24000"  # Sarvam wants a STRING
        assert client.calls[0]["headers"]["api-subscription-key"] == "sarvam-key"

    @pytest.mark.asyncio
    async def test_en_locale_maps_to_en_in(self):
        client = _FakeClient(_FakeResp(200, {"audios": [base64.b64encode(b"X").decode()]}))
        await _collect(SarvamProvider(_cfg(), client=client), _req(locale="en-IN"))
        assert client.calls[0]["json"]["target_language_code"] == "en-IN"

    @pytest.mark.asyncio
    async def test_wav_is_single_container(self):
        client = _FakeClient(_FakeResp(200, {"audios": [base64.b64encode(b"RIFFwav").decode()]}))
        chunks = await _collect(SarvamProvider(_cfg(), client=client), _req(fmt=AudioFormat.WAV))
        assert len(chunks) == 1 and chunks[0].data == b"RIFFwav"
        assert client.calls[0]["json"]["output_audio_codec"] == "wav"

    @pytest.mark.asyncio
    async def test_error_status_raises(self):
        provider = SarvamProvider(_cfg(), client=_FakeClient(_FakeResp(503, {})))
        with pytest.raises(SarvamSynthesisError):
            await _collect(provider, _req())

    @pytest.mark.asyncio
    async def test_missing_audio_raises(self):
        provider = SarvamProvider(_cfg(), client=_FakeClient(_FakeResp(200, {"audios": []})))
        with pytest.raises(SarvamSynthesisError):
            await _collect(provider, _req())


class TestContract:
    def test_protocol_and_streaming_flag(self):
        provider = SarvamProvider(_cfg())
        assert isinstance(provider, TTSEngine)
        assert provider.native_streaming is False

    @pytest.mark.asyncio
    async def test_health_reflects_credential(self):
        assert await SarvamProvider(_cfg(api_key="k")).health() is True
        assert await SarvamProvider(_cfg(api_key="")).health() is False


class TestCatalogAndRouting:
    def test_ml_voices_bind_sarvam(self):
        catalog = VoiceCatalog()
        assert catalog.get("ml-female-1").bindings["sarvam"] == "ishita"
        assert catalog.get("ml-male-1").bindings["sarvam"] == "shubh"

    @pytest.mark.asyncio
    async def test_router_uses_sarvam_for_ml(self):
        # sarvam is routable when the gateway injects an ml chain that includes
        # it (a BYO/PHI-enabled tenant). Routing is DB-sourced (TASK-577) — the
        # router no longer carries a code default, so the chain is injected here.
        reg = ProviderRegistry()
        sarvam = FakeEngine("sarvam", chunks=2)
        reg.register("sarvam", sarvam)  # azure / indic_parler NOT registered
        router = TTSRouter(reg, VoiceCatalog(), Settings())
        chunks = [
            c
            async for c in router.synthesize(
                voice_id="ml-female-1",
                text="ഹലോ.",
                routing_ml=["azure", "sarvam", "indic_parler"],
            )
        ]
        assert sarvam.calls == 1 and len(chunks) == 2
        assert sarvam.requests[0].provider_voice == "ishita"  # resolved catalog binding


@pytest.mark.e2e
@pytest.mark.skipif(
    os.environ.get("TTS_SARVAM_LIVE_TEST") != "1",
    reason="live Sarvam test — set TTS_SARVAM_LIVE_TEST=1 + TTS_SARVAM_API_KEY",
)
@pytest.mark.asyncio
async def test_live_sarvam_ml():
    settings = Settings()
    provider = SarvamProvider(settings.sarvam)
    assert await provider.health() is True
    req = SynthesisRequest(
        text="രോഗിക്ക് metformin 500 mg നൽകി.",
        provider_voice=settings.sarvam.voice_ml,
        locale="ml-IN",
        fmt=AudioFormat.PCM,
    )
    total = sum(len(c.data) async for c in provider.synthesize(req))
    assert total > 0
