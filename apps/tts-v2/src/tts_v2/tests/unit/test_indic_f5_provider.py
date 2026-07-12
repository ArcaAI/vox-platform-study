"""TDD tests for IndicF5Provider (TASK-494) — EXPERIMENTAL, gated OFF.

Prod/commercial enablement is NO-GO pending the owner's license review; these
tests verify the code works (mocked model) and that it stays OUT of the default
routing chain.
"""

from __future__ import annotations

import numpy as np
import pytest

from tts_v2.catalog.voices import VoiceCatalog
from tts_v2.core.config import IndicF5Config, Settings
from tts_v2.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts_v2.providers.indic_f5 import IndicF5Provider


class FakeGenerate:
    """Mimics IndicF5's model(text, ref_audio_path, ref_text) → float32 @ 24 kHz."""

    def __init__(self, seconds: float = 0.1) -> None:
        self.samples = int(24000 * seconds)
        self.calls: list[str] = []

    def __call__(self, text: str) -> np.ndarray:
        self.calls.append(text)
        return np.zeros(self.samples, dtype=np.float32)


def _req(**kw) -> SynthesisRequest:
    base = {"text": "One. Two.", "provider_voice": "ml-ref-1", "locale": "ml-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


@pytest.mark.asyncio
async def test_sentence_loop_calls_model_per_sentence():
    gen = FakeGenerate()
    provider = IndicF5Provider(IndicF5Config(), generate=gen)
    await _collect(provider, _req(text="One. Two.", fmt=AudioFormat.PCM))
    assert len(gen.calls) == 2


@pytest.mark.asyncio
async def test_pcm_is_24k_native_no_resample():
    gen = FakeGenerate(seconds=0.1)  # 2400 samples @ 24 kHz
    provider = IndicF5Provider(IndicF5Config(), generate=gen)
    chunks = await _collect(provider, _req(text="One.", fmt=AudioFormat.PCM))
    assert len(chunks) == 1
    assert len(chunks[0].data) // 2 == 2400  # 24k → 24k is a no-op


@pytest.mark.asyncio
async def test_wav_single_chunk():
    provider = IndicF5Provider(IndicF5Config(), generate=FakeGenerate())
    chunks = await _collect(provider, _req(text="One. Two.", fmt=AudioFormat.WAV))
    assert len(chunks) == 1 and chunks[0].data[:4] == b"RIFF"


@pytest.mark.asyncio
async def test_health():
    assert await IndicF5Provider(IndicF5Config(), generate=FakeGenerate()).health() is True


def test_protocol_and_gated_off_by_default():
    provider = IndicF5Provider(IndicF5Config(), generate=FakeGenerate())
    assert isinstance(provider, TTSEngine)
    assert provider.native_streaming is True
    assert IndicF5Config().enabled is False  # gated OFF (prod NO-GO)


def test_catalog_binding_present_but_not_in_default_routing():
    # Bound so it's routable when explicitly opted in, but NOT in the default
    # ml chain — enabling requires TTS_INDICF5_ENABLED=true AND editing TTS_ROUTING_ML.
    assert VoiceCatalog().get("ml-female-1").bindings["indic_f5"] == "ml-ref-1"
    assert "indic_f5" not in Settings().routing_ml
