"""TDD tests for IndicParlerProvider (TASK-488 Phase 4)."""

from __future__ import annotations

import numpy as np
import pytest

from tts_v2.core.config import IndicParlerConfig
from tts_v2.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts_v2.providers.indic_parler import IndicParlerProvider


class FakeGenerate:
    """Mimics the Parler generate(text, description) → float32 @ 44.1 kHz."""

    def __init__(self, seconds: float = 0.1) -> None:
        self.samples = int(44100 * seconds)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, text: str, description: str) -> np.ndarray:
        self.calls.append((text, description))
        return np.zeros(self.samples, dtype=np.float32)


def _req(**kw) -> SynthesisRequest:
    base = {"text": "One. Two.", "provider_voice": "Anjali", "locale": "ml-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


@pytest.mark.asyncio
async def test_sentence_loop_calls_model_per_sentence():
    gen = FakeGenerate()
    provider = IndicParlerProvider(IndicParlerConfig(), generate=gen)
    await _collect(provider, _req(text="One. Two.", fmt=AudioFormat.PCM))
    assert len(gen.calls) == 2


@pytest.mark.asyncio
async def test_resamples_44k_to_24k():
    gen = FakeGenerate(seconds=0.1)  # 4410 samples @ 44.1k → ~2400 @ 24k
    provider = IndicParlerProvider(IndicParlerConfig(), generate=gen)
    chunks = await _collect(provider, _req(text="One.", fmt=AudioFormat.PCM))
    assert len(chunks) == 1
    assert abs(len(chunks[0].data) // 2 - 2400) < 100


@pytest.mark.asyncio
async def test_uses_malayalam_speaker_in_description():
    gen = FakeGenerate()
    provider = IndicParlerProvider(IndicParlerConfig(speaker_ml="Anjali"), generate=gen)
    await _collect(provider, _req(locale="ml-IN"))
    assert "Anjali" in gen.calls[0][1]


@pytest.mark.asyncio
async def test_wav_is_single_chunk():
    gen = FakeGenerate()
    provider = IndicParlerProvider(IndicParlerConfig(), generate=gen)
    chunks = await _collect(provider, _req(text="One. Two.", fmt=AudioFormat.WAV))
    assert len(chunks) == 1
    assert chunks[0].data[:4] == b"RIFF"


def test_protocol_and_streaming_flag():
    provider = IndicParlerProvider(IndicParlerConfig(), generate=FakeGenerate())
    assert isinstance(provider, TTSEngine)
    assert provider.native_streaming is True
