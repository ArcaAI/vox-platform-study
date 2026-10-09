"""TASK-1055 E6 — an unload hands the device's memory back BEFORE the unload is closed.

Order per evicted entry on a GPU device: the service's ``unload`` hook → the cache drops
its own references → ``release_accelerator_memory(device.id)`` → ``Device.end_unload``.
So the next load's measurement starts from a clean baseline. A CPU device (or a cache
without residency) never calls the release. torch is never imported: the release is
replaced by a recorder.
"""

from __future__ import annotations

import asyncio
import gc
import weakref
from typing import Any

import pytest

from hope_runtime_models import (
    CacheResidency,
    Device,
    DeviceMemory,
    ModelCache,
    SyncModelCache,
)
from hope_runtime_models import cache as cache_module
from hope_runtime_models.residency_agent import CacheBinding, ResidencyAgent

GIB = 1024**3
KINDS = ["async", "sync"]


class Weights:
    """A stand-in model whose lifetime the test can observe through a weakref."""

    def __init__(self, key: str) -> None:
        self.key = key


class Recorder:
    def __init__(self, device: Device | None = None, refs: list[Any] | None = None) -> None:
        self.calls: list[str | None] = []
        self.unloads_open_at_call: list[int] = []
        self.alive_at_call: list[bool] = []
        self._device = device
        self._refs = refs if refs is not None else []

    def __call__(self, device_id: str | None = None) -> None:
        gc.collect()
        self.calls.append(device_id)
        if self._device is not None:
            self.unloads_open_at_call.append(self._device._active_unloads)
        self.alive_at_call.append(any(ref() is not None for ref in self._refs))


def gpu(device_id: str = "cuda:1") -> Device:
    memory = DeviceMemory(free_bytes=8 * GIB, total_bytes=16 * GIB)
    return Device(id=device_id, kind="gpu", memory=lambda: memory, usage=lambda: 0)


def cpu() -> Device:
    memory = DeviceMemory(free_bytes=8 * GIB, total_bytes=16 * GIB)
    return Device(id="cpu", kind="cpu", memory=lambda: memory, usage=lambda: 0)


def build(
    kind: str,
    device: Device | None,
    *,
    events: list[str],
    refs: list[Any],
    unload_raises: bool = False,
    with_hook: bool = True,
) -> Any:
    def make(key: str) -> Weights:
        instance = Weights(key)
        refs.append(weakref.ref(instance))
        return instance

    def unload(key: str, _instance: Weights) -> None:
        events.append(f"hook:{key}")
        if unload_raises:
            raise RuntimeError("shutdown blew up")

    common: dict[str, Any] = {
        "ttl_seconds": 900,
        "max_size": 4,
        "unload": unload if with_hook else None,
        "residency": None if device is None else CacheResidency(service="nlp", device=device),
        "name": "nlp_test",
    }
    if kind == "async":

        async def afactory(key: str) -> Weights:
            return make(key)

        return ModelCache(factory=afactory, **common)
    return SyncModelCache(factory=make, **common)


async def call(value: Any) -> Any:
    return await value if asyncio.iscoroutine(value) else value


@pytest.mark.parametrize("kind", KINDS)
async def test_unload_releases_the_gpu_after_the_hook_and_before_end_unload(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    device = gpu("cuda:1")
    events: list[str] = []
    refs: list[Any] = []
    recorder = Recorder(device, refs)

    def release(device_id: str | None = None) -> None:
        events.append(f"release:{device_id}")
        recorder(device_id)

    monkeypatch.setattr(cache_module, "release_accelerator_memory", release)
    cache = build(kind, device, events=events, refs=refs)
    await call(cache.get("gliguard"))

    assert await call(cache.unload("gliguard")) is True
    assert events == ["hook:gliguard", "release:cuda:1"]
    assert recorder.unloads_open_at_call == [1]  # end_unload has not run yet
    assert device._active_unloads == 0  # ...and does run after it


@pytest.mark.parametrize("kind", KINDS)
async def test_the_cache_holds_no_reference_to_the_weights_when_it_releases(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    device = gpu("cuda:0")
    refs: list[Any] = []
    recorder = Recorder(device, refs)
    monkeypatch.setattr(cache_module, "release_accelerator_memory", recorder)
    cache = build(kind, device, events=[], refs=refs, with_hook=False)
    await call(cache.get("ner"))

    await call(cache.unload("ner"))
    assert recorder.calls == ["cuda:0"]
    assert recorder.alive_at_call == [False]


async def test_an_agent_unload_holds_no_reference_to_the_weights_when_the_cache_releases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    device = gpu("cuda:0")
    refs: list[Any] = []
    recorder = Recorder(device, refs)
    monkeypatch.setattr(cache_module, "release_accelerator_memory", recorder)
    cache = build("async", device, events=[], refs=refs, with_hook=False)
    await cache.get("ner")
    agent = ResidencyAgent(
        service="nlp", instance="t", bindings=lambda: [CacheBinding(cache=cache)]
    )

    result = await agent.unload("ner", force=False, reason="admin")
    assert result["outcome"] == "unloaded"
    assert recorder.alive_at_call == [False]


@pytest.mark.parametrize("kind", KINDS)
async def test_every_eviction_path_releases_once_per_entry(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder = Recorder()
    monkeypatch.setattr(cache_module, "release_accelerator_memory", recorder)
    cache = build(kind, gpu("cuda:1"), events=[], refs=[])
    for key in ("a", "b", "c"):
        await call(cache.get(key))

    assert await call(cache.evict("a")) is True
    assert await call(cache.clear()) == 2
    assert recorder.calls == ["cuda:1", "cuda:1", "cuda:1"]


@pytest.mark.parametrize("kind", KINDS)
async def test_a_failing_hook_still_releases_and_closes_the_unload(
    kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    device = gpu("cuda:1")
    recorder = Recorder(device)
    monkeypatch.setattr(cache_module, "release_accelerator_memory", recorder)
    cache = build(kind, device, events=[], refs=[], unload_raises=True)
    await call(cache.get("m"))

    assert await call(cache.unload("m")) is True
    assert recorder.calls == ["cuda:1"]
    assert device._active_unloads == 0
    assert [m.key for m in cache.residency_snapshot()] == []


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("device", [cpu(), None], ids=["cpu", "no-residency"])
async def test_cpu_and_unwired_caches_never_call_the_release(
    kind: str, device: Device | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder = Recorder()
    monkeypatch.setattr(cache_module, "release_accelerator_memory", recorder)
    events: list[str] = []
    cache = build(kind, device, events=events, refs=[])
    await call(cache.get("m"))

    assert await call(cache.unload("m")) is True
    assert events == ["hook:m"]
    assert recorder.calls == []
