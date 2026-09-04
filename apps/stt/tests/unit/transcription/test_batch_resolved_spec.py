"""TASK-861 — the batch worker assembles its models from ``resolved_spec`` (no DB read)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.pipeline.dto import PipelineConfig
from stt.pipeline.spec import ResolvedAsrSpec, bundle_from_resolved, pipeline_config_from_bundle
from stt.transcription.batch_service import BatchTranscriptionService


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture()["platformDefault"]["expected"]


def _boom(*_a: Any, **_k: Any) -> Any:
    raise AssertionError("apps/stt read the database on the agent path")


def test_bundle_carries_primary_and_fallback_chains_and_every_model_config() -> None:
    bundle = bundle_from_resolved(SPEC)
    assert isinstance(bundle.spec, ResolvedAsrSpec)
    assert set(bundle.pipeline_specs) == {
        SPEC["runtimeKey"],
        SPEC["fallback"]["spec"]["runtimeKey"],
    }
    assert set(bundle.model_configs) == {
        "arcaai-whisper-large-ml-en-gguf",
        "faster-whisper-large-v3-turbo-int8",
        "silero-vad",
        "ecapa-tdnn-voxceleb",
    }
    assert bundle.pipeline_specs[SPEC["runtimeKey"]].inference.initial_prompt_text == (
        "Clinical consultation. Medical terminology."
    )


def test_pipeline_config_from_bundle_is_keyed_on_the_runtime_key() -> None:
    bundle = bundle_from_resolved(SPEC)
    primary = pipeline_config_from_bundle(bundle, SPEC["runtimeKey"])
    fallback = pipeline_config_from_bundle(bundle, SPEC["fallback"]["spec"]["runtimeKey"])
    assert isinstance(primary, PipelineConfig)
    assert primary.id == SPEC["runtimeKey"]
    assert primary.slug == "platform-transcription"
    assert primary.tenant_id == SPEC["agent"]["tenantId"]
    assert fallback.spec.models.asr.slug == "faster-whisper-large-v3-turbo-int8"
    # Independent copies: mutating one job's language never leaks into another.
    primary.spec.inference.language = "vi"
    assert pipeline_config_from_bundle(bundle, SPEC["runtimeKey"]).spec.inference.language == "ml"
    with pytest.raises(KeyError):
        pipeline_config_from_bundle(bundle, "unknown-key")


@pytest.mark.asyncio
async def test_load_models_uses_the_pre_resolved_configs_and_never_the_model_reader() -> None:
    bundle = bundle_from_resolved(SPEC)
    pipeline = pipeline_config_from_bundle(bundle, SPEC["runtimeKey"])
    loaded: list[str] = []

    async def _get_or_load(cfg: Any) -> Any:
        loaded.append(cfg.slug)
        return MagicMock(model_slug=cfg.slug, format=cfg.format)

    cache = MagicMock()
    cache.get_or_load = AsyncMock(side_effect=_get_or_load)
    cache.get_or_load_inline = AsyncMock(side_effect=_boom)

    service = BatchTranscriptionService()
    with (
        patch("stt.transcription.batch_service.get_model_cache", return_value=cache),
        patch("stt.transcription.batch_service.get_model_reader", _boom),
    ):
        models = await service._load_models(pipeline, model_configs=bundle.model_configs)

    assert models["asr"].model_slug == "arcaai-whisper-large-ml-en-gguf"
    assert models["vad"].model_slug == "silero-vad"
    assert models["denoise"] is None
    assert loaded == ["arcaai-whisper-large-ml-en-gguf", "silero-vad"]
