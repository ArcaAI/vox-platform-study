"""TASK-1055 wave 3 — stt residency accepts ``{"model": <one ResolvedAsrSpec model>}``.

Pinned by ``tests/contracts/model-residency-task1055.fixture.json`` →
``wave3.sttModelOnly`` (its two ``loadSpecExamples`` are the bodies used here). The
model is keyed by slug in the same per-device cache a session uses, so a session
afterwards reuses the weights. Fakes only — no model is ever loaded.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from hope_runtime_models import Device, DeviceMemory
from hope_runtime_models.residency_agent import DeviceUnavailable, InvalidLoadSpec

from stt.models.base_loader import LoadedModel

GIB = 1024**3


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-task1055.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text())
    raise AssertionError("contract fixture not found above this test")


EXAMPLES = _fixture()["wave3"]["sttModelOnly"]["loadSpecExamples"]
ASR_EXAMPLE, VAD_EXAMPLE = EXAMPLES[0], EXAMPLES[1]


def _fake_gpu(index: int) -> Device:
    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=10 * GIB, total_bytes=16 * GIB),
        usage=lambda: 6 * GIB,
    )


@pytest.fixture
def loader() -> Any:
    fake = MagicMock()
    fake.places_on_device_index = True
    fake.load = AsyncMock(
        side_effect=lambda config: LoadedModel(
            model_id=config.id,
            model_slug=config.slug,
            model=object(),
            format=config.format,
            memory_mb=100,
            device=config.device or "cuda",
        )
    )
    fake.unload = AsyncMock()
    return fake


@pytest.fixture
def caches(monkeypatch: pytest.MonkeyPatch, loader: Any) -> Any:
    import stt.models.cache as cache_module
    import stt.residency.wiring as wiring
    from stt.models.cache import ModelCache

    devices = [_fake_gpu(0), _fake_gpu(1)]
    monkeypatch.setattr(wiring, "stt_devices", lambda: devices)
    monkeypatch.setattr(wiring, "stt_device", lambda: devices[0])
    monkeypatch.setattr(ModelCache, "loader_for", lambda self, _config: loader)
    monkeypatch.setattr(ModelCache, "_get_loader", lambda self, _format: loader)
    monkeypatch.setattr(cache_module, "_device_caches", {})
    monkeypatch.setattr(cache_module, "_cache", ModelCache())
    return cache_module


async def test_asr_model_only_loads_keyed_by_slug_on_the_device(caches: Any, loader: Any) -> None:
    from stt.residency.agent import _plan

    plan = await _plan(
        ASR_EXAMPLE["model_ref"], ASR_EXAMPLE["load_spec"], device=ASR_EXAMPLE["device"]
    )

    assert plan is not None
    assert plan.key == ASR_EXAMPLE["model_ref"]
    assert plan.cache is caches.get_model_cache("cuda:0")
    await plan.load()
    (config,) = loader.load.await_args.args
    assert config.slug == ASR_EXAMPLE["model_ref"]
    assert config.local_path == ASR_EXAMPLE["load_spec"]["model"]["localPath"]


async def test_vad_model_only_loads_without_a_device(caches: Any, loader: Any) -> None:
    from stt.residency.agent import _plan

    plan = await _plan(VAD_EXAMPLE["model_ref"], VAD_EXAMPLE["load_spec"])

    assert plan is not None and plan.key == "silero-vad"
    assert plan.cache is caches.get_model_cache()
    await plan.load()
    assert loader.load.await_count == 1


async def test_a_later_get_or_load_with_an_equal_config_is_a_hit(caches: Any, loader: Any) -> None:
    from stt.pipeline.spec import AsrSpecModel, to_ai_model_config
    from stt.residency.agent import _plan

    plan = await _plan(VAD_EXAMPLE["model_ref"], VAD_EXAMPLE["load_spec"])
    assert plan is not None
    await plan.load()

    config = to_ai_model_config(AsrSpecModel.model_validate(VAD_EXAMPLE["load_spec"]["model"]))
    await plan.cache.get_or_load(config)

    assert loader.load.await_count == 1


async def test_a_slug_that_is_not_the_model_ref_is_refused(caches: Any) -> None:
    from stt.residency.agent import _plan

    with pytest.raises(InvalidLoadSpec, match="silero-vad"):
        await _plan("some-other-model", VAD_EXAMPLE["load_spec"])


async def test_an_unknown_key_in_the_model_object_is_refused(caches: Any) -> None:
    from stt.residency.agent import _plan

    model = {**VAD_EXAMPLE["load_spec"]["model"], "bogus": 1}
    with pytest.raises(InvalidLoadSpec):
        await _plan("silero-vad", {"model": model})


async def test_any_other_shape_names_both_accepted_shapes(caches: Any) -> None:
    from stt.residency.agent import _plan

    with pytest.raises(InvalidLoadSpec) as caught:
        await _plan("silero-vad", {"engine": "x"})
    assert "resolved_spec" in str(caught.value) and "model" in str(caught.value)

    with pytest.raises(InvalidLoadSpec):
        await _plan("silero-vad", {"model": VAD_EXAMPLE["load_spec"]["model"], "resolved_spec": {}})


async def test_device_is_honoured_and_an_unknown_one_refused(caches: Any, loader: Any) -> None:
    from stt.residency.agent import _plan

    plan = await _plan("silero-vad", VAD_EXAMPLE["load_spec"], device="cuda:1")
    assert plan is not None and plan.cache is caches.get_model_cache("cuda:1")
    await plan.load()
    (config,) = loader.load.await_args.args
    assert config.device == "cuda:1"

    with pytest.raises(DeviceUnavailable, match="cuda:7"):
        await _plan("silero-vad", VAD_EXAMPLE["load_spec"], device="cuda:7")
