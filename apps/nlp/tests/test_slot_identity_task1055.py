"""TASK-1055 cluster e2e defect — an admin-loaded model serves the name-only callers too.

Live (2026-10-09): the residency agent loaded `blaze999/Medical-NER` on `cuda:1` under
the key `(model_name, model_path=derivedLocalPath)`. A clinical NER request then
arrived with `model_name` ONLY (the gateway's `resolveNerModelInjection` and the
harness `_extract_clinical_entities` send no path), so its key was `model_name`
alone, `_route` found no match, and a SECOND copy cold-loaded on `cuda:0`.

A request that names no path asks for "this model's weights", which the resident
copy is — so it is served by that copy. A request that names a DIFFERENT path never
is: different path, different weights, its own slot.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest

NAME = "blaze999/Medical-NER"
PATH = (
    "/mnt/models-bucket/hf/hub/models--blaze999--Medical-NER/snapshots/"
    "a9d5061193e969de80b24225f926cb224caac1ce/"
)
OTHER_PATH = "/mnt/models-bucket/tenant-x/fine-tuned-medical-ner/"


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
    """Two visible GPUs; the token-classifier and guard factories record `(key, device)`."""
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

    monkeypatch.setattr(deps, "_create_token_classifier", factory)
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


async def _serve(model_path: str | None) -> Any:
    import nlp.dependencies as deps

    async with deps.pinned_token_classifier(NAME, model_path) as service:
        return service


async def _admin_load_on_cuda_1(release: asyncio.Event) -> Any:
    """What the residency agent does: load `(NAME, PATH)` on the placed device."""
    import nlp.dependencies as deps

    release.set()
    return await deps._token_classifier_cache("cuda:1").get(deps._model_cache_key(NAME, PATH))


@pytest.mark.parametrize("model_path", [None, PATH])
async def test_an_admin_loaded_copy_serves_a_request_with_or_without_the_path(
    loads: list[Any], release: asyncio.Event, model_path: str | None
) -> None:
    import nlp.dependencies as deps

    placed = await _admin_load_on_cuda_1(release)

    served = await _serve(model_path)

    assert served is placed
    assert loads == [(deps._model_cache_key(NAME, PATH), "cuda:1")]  # no second copy
    assert deps._token_classifier_cache().cached_keys() == []


async def test_a_name_only_request_joins_an_admin_load_still_in_flight(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    key = deps._model_cache_key(NAME, PATH)
    on_cuda_1 = deps._token_classifier_cache("cuda:1")
    admin_load = asyncio.create_task(on_cuda_1.get(key))
    await _started(on_cuda_1, key)

    live = asyncio.create_task(_serve(None))
    await asyncio.sleep(0)
    release.set()
    served, placed = await asyncio.gather(live, admin_load)

    assert served is placed
    assert loads == [(key, "cuda:1")]


async def test_a_request_naming_a_different_path_never_gets_the_resident_copy(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    placed = await _admin_load_on_cuda_1(release)

    served = await _serve(OTHER_PATH)

    assert served is not placed
    assert served.key == deps._model_cache_key(NAME, OTHER_PATH)
    assert loads[-1] == (deps._model_cache_key(NAME, OTHER_PATH), None)


async def test_a_name_only_request_is_not_aliased_when_two_resident_paths_disagree(
    loads: list[Any], release: asyncio.Event
) -> None:
    """Two resident copies of one name with different weights: neither is "the" model."""
    import nlp.dependencies as deps

    await _admin_load_on_cuda_1(release)
    await deps._token_classifier_cache("cuda:0").get(deps._model_cache_key(NAME, OTHER_PATH))

    served = await _serve(None)

    assert served.key == NAME
    assert loads[-1] == (NAME, None)


async def test_a_resident_name_only_copy_does_not_serve_a_request_that_names_a_path(
    loads: list[Any], release: asyncio.Event
) -> None:
    """The reverse is NOT aliased: the name-only copy's weights are whatever the id resolved
    to, which this service cannot prove equal to the path the request names."""
    release.set()
    first = await _serve(None)

    served = await _serve(PATH)

    assert served is not first
    assert [key for key, _device in loads] == [NAME, f"{NAME}\x00{PATH}"]


async def test_a_different_model_name_is_never_aliased(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    placed = await _admin_load_on_cuda_1(release)

    async with deps.pinned_token_classifier("blaze999/Medical-NER-v2") as served:
        assert served is not placed


async def test_the_guard_slots_share_the_same_identity_rule(
    loads: list[Any], release: asyncio.Event
) -> None:
    import nlp.dependencies as deps

    release.set()
    guard = "fastino/gliguard-LLMGuardrails-300M"
    guard_path = "/mnt/models-bucket/hf/hub/models--fastino--gliguard/snapshots/abc/"
    placed = await deps._gliner2_guard_cache("cuda:1").get(deps._model_cache_key(guard, guard_path))

    async with deps.pinned_gliner2_guard(guard) as served:
        assert served is placed
    assert len(loads) == 1
