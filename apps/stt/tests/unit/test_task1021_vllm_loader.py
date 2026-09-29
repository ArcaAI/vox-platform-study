"""TASK-1021 L3.1 — the `vllm` loader and the `stt`-side pseudo-format.

The `vllm` service (`apps/vllm`, contract C-3) serves Whisper over the OpenAI
transcription schema. `stt` holds no weights for it: the loader turns the
gateway-injected ``provider_overrides["vllm"]`` entry (contract C-5 — the SYSTEM
``AiProviderConnection(stt, vllm)`` row, or a tenant sibling under ``vllm:<slug>``)
into a :class:`VllmAsrConfig`, and fails CLOSED by name when the entry is absent.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.exceptions import ModelLoadError
from stt.models.base_loader import CredentialPosture, LoadedModel
from stt.models.cache import ModelCache
from stt.models.vllm_loader import VllmAsrConfig, VllmLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)

SLUG = "arcaai-whisper-large-ml-en-vllm"
BASE_URL = "http://hope-vllm-asr:8867/v1"


@pytest.fixture
def cache() -> ModelCache:
    instance = ModelCache.__new__(ModelCache)  # no __init__: skip cache/metrics setup
    ModelCache._install_loaders(instance)
    return instance


def _config(*, connection_key: str | None = None) -> AiModelConfig:
    return AiModelConfig(
        id=f"agent-model:{SLUG}",
        tenant_id="00000000-0000-0000-0000-000000000000",
        slug=SLUG,
        name=SLUG,
        description=None,
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.HUGGINGFACE,
        source_uri="hf:arcaai/whisper-large-ml-en",
        source_revision=None,
        format=AiModelFormat.SAFETENSOR,
        memory_size_mb=None,
        compute_type="float16",
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path="/mnt/models-bucket/hf",
        downloaded_at=None,
        file_size_mb=None,
        checksum=None,
        tags=[],
        library_name="vllm",
        connection_key=connection_key,
    )


def _entry(**extra: Any) -> dict[str, Any]:
    return {
        "base_url": BASE_URL,
        "max_concurrent": 8,
        "connection_id": "conn-1",
        "connection_slug": "vllm",
        "funding": "platform",
        **extra,
    }


# ---------------------------------------------------------------------------
# selection
# ---------------------------------------------------------------------------


def test_the_pseudo_format_is_the_contract_value() -> None:
    assert AiModelFormat.VLLM.value == "vllm"


def test_library_vllm_selects_the_vllm_loader(cache: ModelCache) -> None:
    assert isinstance(cache.loader_for(_config()), VllmLoader)


def test_the_format_map_holds_the_same_instance(cache: ModelCache) -> None:
    """`_unload_model` releases by `LoadedModel.format`, which is `VLLM`."""
    assert cache._get_loader(AiModelFormat.VLLM) is cache._library_loaders["vllm"]


def test_the_loader_is_self_hosted_with_no_override_key() -> None:
    assert VllmLoader.credential_posture == CredentialPosture.SELF_HOSTED
    assert VllmLoader.override_key is None


# ---------------------------------------------------------------------------
# the override entry → VllmAsrConfig
# ---------------------------------------------------------------------------


async def test_the_override_maps_to_a_vllm_asr_config() -> None:
    loaded = await VllmLoader().load(_config(), provider_overrides={"vllm": _entry()})

    assert loaded.format == AiModelFormat.VLLM
    assert loaded.model_slug == SLUG
    assert loaded.memory_mb == 0
    assert loaded.model == VllmAsrConfig(
        base_url=BASE_URL, model_slug=SLUG, max_concurrent=8, timeout_s=30.0
    )


async def test_timeout_and_unbounded_concurrency_come_from_the_entry() -> None:
    entry = _entry(timeout_s=12.5)
    entry.pop("max_concurrent")
    loaded = await VllmLoader().load(_config(), provider_overrides={"vllm": entry})

    assert loaded.model.max_concurrent is None
    assert loaded.model.timeout_s == 12.5


async def test_a_sibling_connection_is_read_under_its_declared_key() -> None:
    """TASK-958 — a declared connection key is the ONLY key read."""
    overrides = {
        "vllm": _entry(base_url="http://default/v1"),
        "vllm:asr-b": _entry(base_url="http://sibling/v1"),
    }
    loaded = await VllmLoader().load(
        _config(connection_key="vllm:asr-b"), provider_overrides=overrides
    )
    assert loaded.model.base_url == "http://sibling/v1"


@pytest.mark.parametrize(
    "overrides",
    [None, {}, {"openai": {"api_key": "k", "base_url": "http://x"}}, {"vllm": {"funding": "x"}}],
    ids=["none", "empty", "other-provider", "no-base-url"],
)
async def test_a_missing_entry_fails_closed_by_name(overrides: dict[str, Any] | None) -> None:
    with pytest.raises(ModelLoadError, match="vllm connection not configured"):
        await VllmLoader().load(_config(), provider_overrides=overrides)


# ---------------------------------------------------------------------------
# the streaming load reaches the loader WITH the overrides (cache bypass)
# ---------------------------------------------------------------------------


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


def _vllm_spec() -> dict[str, Any]:
    spec = copy.deepcopy(_fixture()["vllmServingFacts"]["expected"])
    spec["models"]["asr"]["slug"] = SLUG
    spec["models"]["asr"]["libraryName"] = "vllm"
    spec["models"]["asr"]["provider"] = "vllm"
    return spec


async def test_the_streaming_load_bypasses_the_cache_and_hands_the_loader_the_overrides() -> None:
    from stt.streaming.session_manager import _CLOUD_ASR_OVERRIDE_FORMATS, SessionManager

    assert AiModelFormat.VLLM in _CLOUD_ASR_OVERRIDE_FORMATS

    mgr = MagicMock(spec=SessionManager)
    for name in (
        "_session_specs",
        "_session_language_modes",
        "_session_asr_formats",
        "_session_connections",
        "_session_pinned_models",
    ):
        setattr(mgr, name, {})
    mgr._pending_want_word_timestamps = False
    mgr._warm_and_pin_pipeline_models = AsyncMock(return_value=[])
    mgr._load_cloud_asr_uncached = lambda **kw: SessionManager._load_cloud_asr_uncached(mgr, **kw)
    captured: dict[str, Any] = {}

    def _spy(asr_model: Any, inference_config: Any, initial_prompt: str | None = None) -> Any:
        captured["model"] = asr_model
        return AsyncMock()

    mgr._make_asr_callable = _spy
    bundle = SessionManager._register_resolved_spec(mgr, "s1", _vllm_spec())
    config = await SessionManager._load_pipeline_config(mgr, bundle.runtime_key, session_id="s1")

    real = ModelCache.__new__(ModelCache)
    ModelCache._install_loaders(real)
    cache = MagicMock()
    cache.loader_for = real.loader_for
    cache._get_loader = real._get_loader
    cache.get_or_load_from_ref = AsyncMock(side_effect=AssertionError("cache path taken"))
    cache.pin = AsyncMock()
    with patch("stt.models.get_model_cache", return_value=cache):
        await SessionManager._load_asr_pipeline(
            mgr, config, "s1", tenant_id="t-1", provider_overrides={"vllm": _entry()}
        )

    loaded: LoadedModel = captured["model"]
    assert loaded.format == AiModelFormat.VLLM
    assert loaded.model.base_url == BASE_URL
    assert mgr._session_asr_formats["s1"] == AiModelFormat.VLLM
