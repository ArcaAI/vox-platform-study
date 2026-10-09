"""TASK-1055 review R1-F6 — session traffic joins a load in flight on another GPU.

While an admin's placed load is still RUNNING on ``cuda:1``, a live session for
the same model used to start a second cold load on the default GPU (routing only
looked at loaded entries). It must join the in-flight load instead; the default
GPU is used only when no device holds the model loaded or loading.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from hope_runtime_models import Device, DeviceMemory

from stt.models.base_loader import LoadedModel

GIB = 1024**3


def _contracts_dir() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts"
        if (candidate / "model-residency-agent.fixture.json").is_file():
            return candidate
    raise AssertionError("tests/contracts not found above this test")


CONTRACTS = _contracts_dir()
RESIDENCY = json.loads((CONTRACTS / "model-residency-agent.fixture.json").read_text())


def _resolve_refs(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {"$ref"}:
            file_name, _, pointer = value["$ref"].partition("#")
            target: Any = json.loads((CONTRACTS / file_name).read_text())
            for part in filter(None, pointer.split("/")):
                target = target[part]
            return target
        return {k: _resolve_refs(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_refs(v) for v in value]
    return value


(STT_EXAMPLE,) = RESIDENCY["loadSpecExamples"]["stt"]
PRIMARY_SLUG = STT_EXAMPLE["model_ref"]
LOAD_SPEC = _resolve_refs(STT_EXAMPLE["load_spec"])


def _fake_gpu(index: int) -> Device:
    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=10 * GIB, total_bytes=16 * GIB),
        usage=lambda: 6 * GIB,
    )


@pytest.fixture
def release() -> asyncio.Event:
    """Set to let a gated load finish."""
    return asyncio.Event()


@pytest.fixture
def loader(release: asyncio.Event) -> Any:
    async def load(config: Any) -> LoadedModel:
        await release.wait()
        return LoadedModel(
            model_id=config.id,
            model_slug=config.slug,
            model=object(),
            format=config.format,
            memory_mb=1500,
            device=config.device or "cuda",
        )

    fake = MagicMock()
    fake.places_on_device_index = True
    fake.load = AsyncMock(side_effect=load)
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


def _primary_config() -> Any:
    from stt.pipeline.spec import bundle_from_resolved

    return bundle_from_resolved(LOAD_SPEC["resolved_spec"]).model_configs[PRIMARY_SLUG]


async def _started(cache: Any, slug: str) -> None:
    """Yield until ``cache`` has ``slug`` in flight (its single-flight future exists)."""
    for _ in range(100):
        if slug in cache._inflight:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"{slug} never went in flight")


async def test_a_session_joins_a_load_in_flight_on_another_gpu(
    caches: Any, loader: Any, release: asyncio.Event
) -> None:
    default = caches.get_model_cache()
    on_gpu1 = caches.get_model_cache("cuda:1")
    admin_load = asyncio.create_task(on_gpu1.get_or_load(_primary_config()))
    await _started(on_gpu1, PRIMARY_SLUG)

    session = asyncio.create_task(default.get_or_load(_primary_config()))
    await asyncio.sleep(0)
    release.set()
    served, placed = await asyncio.gather(session, admin_load)

    assert loader.load.await_count == 1  # no second cold load on the default GPU
    assert served is placed
    assert served.device == "cuda:1"
    assert default.residency_snapshot() == []


async def test_a_session_pin_during_an_in_flight_placed_load_lands_on_that_gpu(
    caches: Any, release: asyncio.Event
) -> None:
    default = caches.get_model_cache()
    on_gpu1 = caches.get_model_cache("cuda:1")
    admin_load = asyncio.create_task(on_gpu1.get_or_load(_primary_config()))
    await _started(on_gpu1, PRIMARY_SLUG)

    await default.pin(PRIMARY_SLUG)
    release.set()
    await admin_load

    (resident,) = on_gpu1.residency_snapshot()
    assert resident.in_flight == 1
    await default.unpin(PRIMARY_SLUG)
    (resident,) = on_gpu1.residency_snapshot()
    assert resident.in_flight == 0


async def test_a_session_loads_on_the_default_gpu_when_no_device_has_it(
    caches: Any, loader: Any, release: asyncio.Event
) -> None:
    default = caches.get_model_cache()
    caches.get_model_cache("cuda:1")  # exists, empty, nothing in flight
    release.set()

    served = await default.get_or_load(_primary_config())

    assert loader.load.await_count == 1
    assert served is await default.get(PRIMARY_SLUG)
    assert served.device != "cuda:1"
