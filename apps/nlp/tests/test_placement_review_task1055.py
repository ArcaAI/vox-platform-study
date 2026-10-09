"""TASK-1055 review R1-F6 — request traffic joins a load in flight on another GPU.

`_route` used to look only at LOADED entries: while an admin's placed load was
still running on `cuda:1`, a live request for the same model started a second cold
load on the default device. It must join the in-flight load; the default cache is
used only when no device holds the model loaded or loading.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest

GUARD = "fastino/gliguard-LLMGuardrails-300M"


def _fake_gpu(index: int) -> Any:
    from hope_runtime_models import Device
    from hope_runtime_models.vram import DeviceMemory

    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=8 << 30, total_bytes=16 << 30),
        usage=lambda: 8 << 30,
    )


class _Loaded:
    def __init__(self, key: str, device: str | None) -> None:
        self.key, self.placement = key, device

    async def shutdown(self) -> None:
        pass


@pytest.fixture
def release() -> asyncio.Event:
    """Set to let a gated load finish."""
    return asyncio.Event()


@pytest.fixture
def loads(monkeypatch: pytest.MonkeyPatch, release: asyncio.Event) -> Iterator[list[Any]]:
    """Two visible GPUs; the GLiNER2 guard factory records `(key, device)` and waits."""
    import nlp.core.device as device_module
    import nlp.dependencies as deps
    import nlp.residency as residency

    monkeypatch.setattr(residency, "gpu_devices", lambda *a, **k: [_fake_gpu(0), _fake_gpu(1)])
    monkeypatch.setattr(device_module.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(device_module.torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(deps, "release_accelerator_memory", lambda device_id=None: None)
    calls: list[Any] = []

    async def factory(key: str, device: str | None = None) -> _Loaded:
        calls.append((key, device))
        await release.wait()
        return _Loaded(key, device)

    monkeypatch.setattr(deps, "_create_gliner2_guard", factory)
    residency.nlp_device.cache_clear()
    deps.reset_model_caches()
    yield calls
    deps.reset_model_caches()
    residency.nlp_device.cache_clear()


async def _started(cache: Any, key: str) -> None:
    for _ in range(100):
        if key in cache._inflight:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"{key} never went in flight")


async def test_a_request_joins_a_load_in_flight_on_another_gpu(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    on_cuda_1 = deps._gliner2_guard_cache("cuda:1")
    admin_load = asyncio.create_task(on_cuda_1.get(GUARD))
    await _started(on_cuda_1, GUARD)

    assert deps._route("nlp_gliner2_guard", GUARD) is on_cuda_1

    async def request() -> Any:
        async with deps.pinned_gliner2_guard(GUARD) as service:
            return service

    live = asyncio.create_task(request())
    await asyncio.sleep(0)
    release.set()
    served, placed = await asyncio.gather(live, admin_load)

    assert loads == [(GUARD, "cuda:1")]  # no second cold load on the default device
    assert served is placed
    assert deps._gliner2_guard_cache().cached_keys() == []


async def test_a_request_prefers_a_loaded_copy_over_an_in_flight_one(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    release.set()
    on_cuda_0 = deps._gliner2_guard_cache("cuda:0")
    await on_cuda_0.get(GUARD)
    release.clear()
    on_cuda_1 = deps._gliner2_guard_cache("cuda:1")
    pending = asyncio.create_task(on_cuda_1.get(GUARD))
    await _started(on_cuda_1, GUARD)

    assert deps._route("nlp_gliner2_guard", GUARD) is on_cuda_0

    release.set()
    await pending


async def test_a_request_loads_on_the_default_cache_when_no_device_has_it(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    deps._gliner2_guard_cache("cuda:1")  # exists, empty, nothing in flight
    release.set()

    assert deps._route("nlp_gliner2_guard", GUARD) is deps._gliner2_guard_cache()
    async with deps.pinned_gliner2_guard(GUARD) as cold:
        assert cold.placement is None
