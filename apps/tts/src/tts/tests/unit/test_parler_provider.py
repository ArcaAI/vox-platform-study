"""TDD tests for IndicParlerProvider."""

from __future__ import annotations

import numpy as np
import pytest

from tts.core.config import IndicParlerConfig, Settings
from tts.providers.base import AudioFormat, SynthesisRequest, TTSEngine
from tts.providers.indic_parler import (
    IndicParlerProvider,
    _resolve_desc_source,
    _resolve_model_source,
    _resolve_s3_overrides,
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
async def test_uses_the_requested_speaker_in_the_description():
    """The description conditions on the CATALOG binding, not a config copy.

    This provider used to pick between its own `speaker_ml` / `speaker_en`
    settings and ignore `req.provider_voice` entirely — so the catalog binding
    the router had already resolved for it was silently discarded. Two
    representations of one fact, with the wrong one winning ( lane C).
    """
    gen = FakeGenerate()
    provider = IndicParlerProvider(IndicParlerConfig(), generate=gen)
    await _collect(provider, _req(locale="ml-IN", provider_voice="Anjali"))
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


# --- Internal-mirror load-branch resolution ---


def test_model_source_comes_from_the_registry_row_not_a_hardcoded_default():
    """No mirror on the row → the hub id the AGENT's model names, no local_files_only.

    The hub id used to be a `pydantic-settings` default (`ai4bharat/indic-parler-tts`), which is a
    model SELECTION wearing a config costume. TASK-879 emptied the field and made the registry row
    the only supplier: `from_spec` fills it from `AiModel.sourceUri`.
    """
    assert IndicParlerConfig().hf_model == "", "the hub id must not be a hardcoded default"

    from tts.providers.indic_parler import IndicParlerProvider
    from tts.tests.fakes import candidate

    built = IndicParlerProvider.from_spec(
        Settings(),
        candidate("indic_parler", slug="indic-parler-tts", source_uri="ai4bharat/indic-parler-tts"),
        {},
    )
    source, kwargs = _resolve_model_source(built._config)
    assert source == "ai4bharat/indic-parler-tts"
    assert kwargs == {}


def test_the_mirror_and_the_description_tokenizer_come_from_the_row_too():
    """`localPath` and `_metadata.artifacts.descEncoderPath`, the two deployment paths.

    Parler bakes `google/flan-t5-large` as a Hub id in its own config, so an otherwise-offline
    deployment still reaches out for that ONE tokenizer unless the mirror is named. It is an
    artifact of the model, so it rides on the model row.
    """
    from tts.providers.indic_parler import IndicParlerProvider, _resolve_desc_source
    from tts.tests.fakes import candidate

    built = IndicParlerProvider.from_spec(
        Settings(),
        candidate(
            "indic_parler",
            slug="indic-parler-tts",
            source_uri="ai4bharat/indic-parler-tts",
            local_path="/mnt/models/indic-parler-tts",
            artifacts={"descEncoderPath": "/mnt/models/flan-t5-large"},
        ),
        {},
    )
    assert _resolve_model_source(built._config) == ("/mnt/models/indic-parler-tts", {"local_files_only": True})
    assert _resolve_desc_source(built._config, "google/flan-t5-large") == (
        "/mnt/models/flan-t5-large",
        {"local_files_only": True},
    )


def test_model_source_uses_mirror_offline_when_path_set():
    """Mirror path set (prod) → load from it, offline (never touch gated hub)."""
    cfg = IndicParlerConfig().model_copy(update={"model_path": "/models/indic-parler-tts/abc123"})
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
    cfg = IndicParlerConfig().model_copy(update={"desc_encoder_path": "/models/flan-t5-large"})
    source, kwargs = _resolve_desc_source(cfg, "google/flan-t5-large")
    assert source == "/models/flan-t5-large"
    assert kwargs == {"local_files_only": True}


# `s3://` local-mirror override resolution


@pytest.mark.asyncio
async def test_resolve_s3_overrides_passes_through_a_config_with_no_s3_value():
    """No `s3://` value anywhere → the SAME config object, unchanged."""
    cfg = IndicParlerConfig().model_copy(update={"model_path": "/models/indic-parler-tts/abc123"})
    resolved_cfg = await _resolve_s3_overrides(cfg)
    assert resolved_cfg is cfg


@pytest.mark.asyncio
async def test_resolve_s3_overrides_resolves_model_path(monkeypatch):
    seen: dict = {}

    async def _fake_resolve(value: str, *, slug: str) -> str:
        seen["value"], seen["slug"] = value, slug
        return "/cache/s3/resolved-model"

    monkeypatch.setattr("tts.models.source_resolver.resolve_local_override", _fake_resolve)

    cfg = IndicParlerConfig().model_copy(update={"model_path": "s3://models/indic-parler"})
    resolved_cfg = await _resolve_s3_overrides(cfg)

    assert seen == {"value": "s3://models/indic-parler", "slug": "indic_parler-model"}
    assert resolved_cfg.model_path == "/cache/s3/resolved-model"
    # `_resolve_model_source` then treats it exactly like any staged mirror.
    source, kwargs = _resolve_model_source(resolved_cfg)
    assert source == "/cache/s3/resolved-model"
    assert kwargs == {"local_files_only": True}


@pytest.mark.asyncio
async def test_resolve_s3_overrides_resolves_desc_encoder_path(monkeypatch):
    async def _fake_resolve(value: str, *, slug: str) -> str:
        return f"/cache/s3/{slug}"

    monkeypatch.setattr("tts.models.source_resolver.resolve_local_override", _fake_resolve)

    cfg = IndicParlerConfig().model_copy(update={"desc_encoder_path": "s3://models/flan-t5-large"})
    resolved_cfg = await _resolve_s3_overrides(cfg)

    assert resolved_cfg.desc_encoder_path == "/cache/s3/indic_parler-desc"
    # `model_path` had no `s3://` value, so it is untouched.
    assert resolved_cfg.model_path == cfg.model_path


@pytest.mark.asyncio
async def test_load_generate_resolves_s3_before_building(monkeypatch):
    """The provider's real load path calls the resolver before `_load_model`."""
    calls: list[str] = []

    async def _fake_resolve(value: str, *, slug: str) -> str:
        calls.append(value)
        return "/cache/s3/resolved-model"

    monkeypatch.setattr("tts.models.source_resolver.resolve_local_override", _fake_resolve)

    seen_config: list[IndicParlerConfig] = []

    cfg = IndicParlerConfig().model_copy(update={"model_path": "s3://models/indic-parler"})
    provider = IndicParlerProvider(cfg)

    def _fake_load_model(config: IndicParlerConfig) -> object:
        seen_config.append(config)
        return lambda text, description: None

    provider._load_model = _fake_load_model  # type: ignore[method-assign]

    await provider._load_generate("indic_parler")

    assert calls == ["s3://models/indic-parler"]
    assert seen_config[0].model_path == "/cache/s3/resolved-model"
