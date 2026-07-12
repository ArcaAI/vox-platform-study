"""TDD tests for IndicParlerProvider (TASK-488 Phase 4)."""

from __future__ import annotations

import numpy as np
import pytest

from tts_v2.core.config import IndicParlerConfig
from tts_v2.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts_v2.providers.indic_parler import (
    IndicParlerProvider,
    _resolve_desc_source,
    _resolve_model_source,
)


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


# --- TASK-495: internal-mirror load-branch resolution ---


def test_model_source_defaults_to_gated_hub():
    """No mirror configured (dev) → gated hub id, no local_files_only."""
    source, kwargs = _resolve_model_source(IndicParlerConfig())
    assert source == "ai4bharat/indic-parler-tts"
    assert kwargs == {}


def test_model_source_uses_mirror_offline_when_path_set():
    """Mirror path set (prod) → load from it, offline (never touch gated hub)."""
    cfg = IndicParlerConfig(model_path="/models/indic-parler-tts/abc123")
    source, kwargs = _resolve_model_source(cfg)
    assert source == "/models/indic-parler-tts/abc123"
    assert kwargs == {"local_files_only": True}


def test_desc_source_defaults_to_baked_hub_id():
    """No desc mirror → the baked flan-t5 hub id fetched at load."""
    source, kwargs = _resolve_desc_source(IndicParlerConfig(), "google/flan-t5-large")
    assert source == "google/flan-t5-large"
    assert kwargs == {}


def test_desc_source_uses_mirror_offline_when_path_set():
    """Desc mirror set → mirrored tokenizer, offline (baked id ignored)."""
    cfg = IndicParlerConfig(desc_encoder_path="/models/flan-t5-large")
    source, kwargs = _resolve_desc_source(cfg, "google/flan-t5-large")
    assert source == "/models/flan-t5-large"
    assert kwargs == {"local_files_only": True}
