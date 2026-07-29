"""TDD tests for KokoroProvider."""

from __future__ import annotations

import numpy as np
import pytest

from tts.core.config import KokoroConfig
from tts.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts.providers.kokoro import KokoroProvider


class FakePipeline:
    """Mimics kokoro.KPipeline: callable yielding (graphemes, phonemes, audio)."""

    def __init__(self, segments: int = 2, samples: int = 2400) -> None:
        self.segments = segments
        self.samples = samples
        self.voice: str | None = None
        self.calls = 0

    def __call__(self, text, voice=None):
        self.calls += 1
        self.voice = voice
        for _ in range(self.segments):
            yield ("gs", "ps", np.zeros(self.samples, dtype=np.float32))


def _req(**kw) -> SynthesisRequest:
    base = {"text": "Hello there.", "provider_voice": "af_heart", "locale": "en-IN"}
    base.update(kw)
    return SynthesisRequest(**base)


async def _collect(provider, req):
    return [c async for c in provider.synthesize(req)]


@pytest.mark.asyncio
async def test_streams_pcm_chunk_per_segment():
    provider = KokoroProvider(
        KokoroConfig(voice="af_heart"), pipeline=FakePipeline(segments=3, samples=2400)
    )
    chunks = await _collect(provider, _req(fmt=AudioFormat.PCM))
    assert len(chunks) == 3
    assert all(len(c.data) == 4800 for c in chunks)  # 2400 samples × 2 bytes, 24k→24k


@pytest.mark.asyncio
async def test_wav_is_single_chunk_with_riff_header():
    provider = KokoroProvider(KokoroConfig(), pipeline=FakePipeline(segments=2))
    chunks = await _collect(provider, _req(fmt=AudioFormat.WAV))
    assert len(chunks) == 1
    assert chunks[0].data[:4] == b"RIFF"
    assert chunks[0].is_final is True


@pytest.mark.asyncio
async def test_passes_requested_voice_to_pipeline():
    pipeline = FakePipeline()
    provider = KokoroProvider(KokoroConfig(voice="af_default"), pipeline=pipeline)
    await _collect(provider, _req(provider_voice="af_heart"))
    assert pipeline.voice == "af_heart"


def test_protocol_and_streaming_flag():
    provider = KokoroProvider(KokoroConfig(), pipeline=FakePipeline())
    assert isinstance(provider, TTSEngine)
    assert provider.native_streaming is True
