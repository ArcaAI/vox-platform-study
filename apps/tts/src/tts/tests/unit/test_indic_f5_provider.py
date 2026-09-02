"""TDD tests for IndicF5Provider — EXPERIMENTAL, gated OFF.

Prod/commercial enablement is NO-GO pending the owner's license review; these
tests verify the code works (mocked model) and that it stays OUT of the default
routing chain.
"""

from __future__ import annotations

import numpy as np
import pytest

from tts.catalog.voices import VoiceCatalog
from tts.core.config import IndicF5Config, Settings
from tts.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts.providers.indic_f5 import IndicF5Provider, _resolve_s3_override


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
    # Bound so it's routable when explicitly opted in, but NOT in the built-in
    # Day-1 default: the SYSTEM TenantTtsConfig default routes ml to
    # `indic_parler`, and enabling indic_f5 requires TTS_INDICF5_ENABLED=true AND
    # a tenant admin adding it to the DB-sourced routing chain.
    assert VoiceCatalog().get("ml-female-1").bindings["indic_f5"] == "ml-ref-1"
    # Config carries no vendor routing default at all (fail-closed).
    assert not hasattr(Settings(), "routing_ml")


# --- `s3://` local-mirror override resolution (TASK-855 L6) ---


@pytest.mark.asyncio
async def test_resolve_s3_override_passes_through_a_config_with_no_s3_value():
    """No `s3://` value → the SAME config object, unchanged."""
    cfg = IndicF5Config().model_copy(update={"model_path": "/models/indic-f5"})
    resolved_cfg = await _resolve_s3_override(cfg)
    assert resolved_cfg is cfg


@pytest.mark.asyncio
async def test_resolve_s3_override_resolves_model_path(monkeypatch):
    seen: dict = {}

    async def _fake_resolve(value: str, *, slug: str) -> str:
        seen["value"], seen["slug"] = value, slug
        return "/cache/s3/resolved-f5"

    monkeypatch.setattr("tts.models.source_resolver.resolve_local_override", _fake_resolve)

    cfg = IndicF5Config().model_copy(update={"model_path": "s3://models/indic-f5"})
    resolved_cfg = await _resolve_s3_override(cfg)

    assert seen == {"value": "s3://models/indic-f5", "slug": "indic_f5-model"}
    assert resolved_cfg.model_path == "/cache/s3/resolved-f5"


@pytest.mark.asyncio
async def test_load_generate_resolves_s3_before_building(monkeypatch):
    """The provider's real load path calls the resolver before `_load_model`."""
    calls: list[str] = []

    async def _fake_resolve(value: str, *, slug: str) -> str:
        calls.append(value)
        return "/cache/s3/resolved-f5"

    monkeypatch.setattr("tts.models.source_resolver.resolve_local_override", _fake_resolve)

    seen_config: list[IndicF5Config] = []

    cfg = IndicF5Config().model_copy(update={"model_path": "s3://models/indic-f5"})
    provider = IndicF5Provider(cfg)

    def _fake_load_model(config: IndicF5Config) -> object:
        seen_config.append(config)
        return lambda text: None

    provider._load_model = _fake_load_model  # type: ignore[method-assign]

    await provider._load_generate("indic_f5")

    assert calls == ["s3://models/indic-f5"]
    assert seen_config[0].model_path == "/cache/s3/resolved-f5"
