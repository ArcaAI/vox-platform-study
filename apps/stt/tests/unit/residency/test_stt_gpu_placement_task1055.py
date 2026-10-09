"""TASK-1055 lane S — stt places a model on the GPU the platform admin chose.

The residency agent receives ``device`` = ``cuda:<i>`` (the i-th GPU this process
sees) or ``None`` (default placement). Pinned by
``tests/contracts/model-residency-task1055.fixture.json`` (``deviceIds``, ``python``):

* one model cache PER DEVICE, lazily created, same retention as the default one;
  a plan's cache is bound to the requested device;
* the report lists every GPU the process sees (CPU only when there is none);
* the same model on two devices is two entries, never a false ``already_loaded``;
* session traffic keeps the default-device cache, unless the model is resident
  ONLY on another device — then it is served (and pinned) where it is.

CI has no GPU: devices are fakes with scripted memory readings.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from hope_runtime_models import Device, DeviceMemory
from hope_runtime_models.residency_agent import DeviceUnavailable
from httpx import ASGITransport, AsyncClient

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat

GIB = 1024**3


def _contracts_dir() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts"
        if (candidate / "model-residency-task1055.fixture.json").is_file():
            return candidate
    raise AssertionError("tests/contracts not found above this test")


CONTRACTS = _contracts_dir()
TASK1055 = json.loads((CONTRACTS / "model-residency-task1055.fixture.json").read_text())
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


def _fake_gpu(index: int, *, free: int = 10 * GIB) -> Device:
    return Device(
        id=f"cuda:{index}",
        kind="gpu",
        memory=lambda: DeviceMemory(free_bytes=free, total_bytes=16 * GIB),
        usage=lambda: 16 * GIB - free,
    )


@pytest.fixture
def two_gpus(monkeypatch: pytest.MonkeyPatch) -> list[Device]:
    """The process sees two GPUs (CUDA_VISIBLE_DEVICES=0,1 + PCI_BUS_ID on the cluster)."""
    import stt.residency.wiring as wiring

    devices = [_fake_gpu(0), _fake_gpu(1, free=14 * GIB)]
    monkeypatch.setattr(wiring, "stt_devices", lambda: devices)
    monkeypatch.setattr(wiring, "stt_device", lambda: devices[0])
    return devices


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
            memory_mb=1500,
            device=config.device or "cuda",
        )
    )
    fake.unload = AsyncMock()
    return fake


@pytest.fixture
def caches(monkeypatch: pytest.MonkeyPatch, two_gpus: list[Device], loader: Any) -> Any:
    """A fresh default cache + an empty per-device registry; every cache uses `loader`."""
    import stt.models.cache as cache_module
    from stt.models.cache import ModelCache

    monkeypatch.setattr(ModelCache, "loader_for", lambda self, _config: loader)
    monkeypatch.setattr(ModelCache, "_get_loader", lambda self, _format: loader)
    monkeypatch.setattr(cache_module, "_device_caches", {})
    fresh = ModelCache()
    monkeypatch.setattr(cache_module, "_cache", fresh)
    return cache_module


@pytest.fixture
def client(caches: Any) -> AsyncClient:
    from fastapi import FastAPI

    from stt.residency.agent import residency_router

    app = FastAPI()
    app.include_router(residency_router())
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://stt")


def _primary_config() -> Any:
    from stt.pipeline.spec import bundle_from_resolved

    return bundle_from_resolved(LOAD_SPEC["resolved_spec"]).model_configs[PRIMARY_SLUG]


# ── wiring: every GPU the process sees ──────────────────────────────────────


def test_stt_devices_lists_every_visible_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    import stt.residency.wiring as wiring

    gpus = [_fake_gpu(0), _fake_gpu(1)]
    monkeypatch.setattr(wiring, "gpu_devices", lambda: gpus)
    wiring.stt_devices.cache_clear()
    wiring.stt_device.cache_clear()
    try:
        assert [d.id for d in wiring.stt_devices()] == ["cuda:0", "cuda:1"]
        assert wiring.stt_device() is gpus[0]
        assert wiring.stt_device_by_id("cuda:1") is gpus[1]
        assert wiring.stt_device_by_id("cuda:7") is None
    finally:
        wiring.stt_devices.cache_clear()
        wiring.stt_device.cache_clear()


def test_stt_devices_falls_back_to_the_host_cpu_without_a_gpu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import stt.residency.wiring as wiring

    monkeypatch.setattr(wiring, "gpu_devices", lambda: [])
    wiring.stt_devices.cache_clear()
    wiring.stt_device.cache_clear()
    try:
        (only,) = wiring.stt_devices()
        assert only.id == "cpu" and only.kind == "cpu"
        assert wiring.stt_device() is only
    finally:
        wiring.stt_devices.cache_clear()
        wiring.stt_device.cache_clear()


async def test_the_report_lists_every_gpu_even_with_nothing_loaded(client: AsyncClient) -> None:
    async with client:
        report = (await client.get("/internal/residency")).json()

    assert [d["id"] for d in report["devices"]] == ["cuda:0", "cuda:1"]
    assert all(d["kind"] == "gpu" for d in report["devices"])
    assert report["models"] == []


# ── the planner ─────────────────────────────────────────────────────────────


async def test_no_device_plans_on_the_default_cache_unchanged(caches: Any) -> None:
    from stt.residency.agent import _plan

    plan = await _plan(PRIMARY_SLUG, LOAD_SPEC)

    assert plan is not None
    assert plan.cache is caches.get_model_cache()
    assert plan.cache.residency.device.id == "cuda:0"
    await plan.load()
    (config,) = plan.cache.loader_for(None).load.await_args.args
    assert config.device is None  # today's behaviour: the loader's own default placement


async def test_a_chosen_gpu_plans_on_a_cache_bound_to_that_gpu(caches: Any, loader: Any) -> None:
    from stt.residency.agent import _plan

    plan = await _plan(PRIMARY_SLUG, LOAD_SPEC, device="cuda:1")

    assert plan is not None
    assert plan.cache.residency.device.id == "cuda:1"
    assert plan.cache is not caches.get_model_cache()
    assert plan.cache is caches.get_model_cache("cuda:1")
    await plan.load()
    (config,) = loader.load.await_args.args
    assert config.device == "cuda:1"


async def test_an_unknown_device_is_device_unavailable(caches: Any) -> None:
    from stt.residency.agent import _plan

    with pytest.raises(DeviceUnavailable, match="cuda:7"):
        await _plan(PRIMARY_SLUG, LOAD_SPEC, device="cuda:7")


async def test_an_unknown_device_without_a_spec_is_still_device_unavailable(caches: Any) -> None:
    from stt.residency.agent import _plan

    with pytest.raises(DeviceUnavailable):
        await _plan(PRIMARY_SLUG, {}, device="cuda:7")


async def test_a_loader_that_cannot_choose_a_gpu_is_refused_for_another_gpu(
    caches: Any, loader: Any
) -> None:
    from stt.residency.agent import _plan

    loader.places_on_device_index = False

    with pytest.raises(DeviceUnavailable, match="cuda:1"):
        await _plan(PRIMARY_SLUG, LOAD_SPEC, device="cuda:1")
    # …but the default GPU is where it already runs, so naming it is fine.
    assert (await _plan(PRIMARY_SLUG, LOAD_SPEC, device="cuda:0")) is not None


async def test_load_route_places_on_the_chosen_gpu(client: AsyncClient, loader: Any) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
        report = (await client.get("/internal/residency")).json()

    assert response.status_code == 200, response.text
    assert response.json()["outcome"] == "loaded"
    assert response.json()["model"]["device"] == "cuda:1"
    (model,) = report["models"]
    assert model["device"] == "cuda:1"


async def test_load_route_refuses_an_unknown_gpu(client: AsyncClient) -> None:
    async with client:
        response = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:2"},
        )

    assert response.status_code == 400
    body = response.json()["error"]
    assert body["code"] == TASK1055["python"]["errors"]["DEVICE_UNAVAILABLE"]["error"]["code"]
    assert body["device"] == "cuda:2"


# ── a model on two devices is two entries ───────────────────────────────────


async def test_the_same_model_on_two_gpus_is_two_entries(client: AsyncClient, loader: Any) -> None:
    async with client:
        first = await client.post(
            "/internal/residency/load", json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC}
        )
        second = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
        again = await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
        report = (await client.get("/internal/residency")).json()

    assert first.json()["outcome"] == "loaded"
    assert second.json()["outcome"] == "loaded"  # never a false already_loaded
    assert again.json()["outcome"] == "already_loaded"
    assert loader.load.await_count == 2
    assert sorted(m["device"] for m in report["models"]) == ["cuda:0", "cuda:1"]
    assert len({m["cache"] for m in report["models"]}) == 2


async def test_an_unload_with_a_device_drops_only_that_copy(
    client: AsyncClient, loader: Any
) -> None:
    async with client:
        await client.post(
            "/internal/residency/load", json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC}
        )
        await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
        unloaded = await client.post(
            "/internal/residency/unload", json={"model_ref": PRIMARY_SLUG, "device": "cuda:1"}
        )
        report = (await client.get("/internal/residency")).json()

    assert unloaded.json()["outcome"] == "unloaded"
    (left,) = report["models"]
    assert left["device"] == "cuda:0"
    loader.unload.assert_awaited_once()


# ── one cache per device ────────────────────────────────────────────────────


def test_a_device_cache_is_created_once_with_the_default_retention(caches: Any) -> None:
    default = caches.get_model_cache()
    default.apply_retention({"ttl_seconds": 900, "max_models": 3, "max_memory_mb": 7000})

    device_cache = caches.get_model_cache("cuda:1")

    assert caches.get_model_cache("cuda:1") is device_cache
    assert caches.get_model_cache("cuda:0") is default
    assert device_cache.residency.device.id == "cuda:1"
    assert device_cache.residency.metrics is default.residency.metrics
    assert device_cache.residency.service == "stt"
    assert (
        device_cache._ttl_seconds,
        device_cache._max_size,
        device_cache._max_bytes_estimate,
    ) == (
        900,
        3,
        7000,
    )
    assert device_cache.name != default.name


def test_retention_applied_to_the_default_cache_reaches_every_device_cache(caches: Any) -> None:
    device_cache = caches.get_model_cache("cuda:1")

    caches.get_model_cache().apply_retention({"ttl_seconds": 1200, "max_models": 2})

    assert device_cache._ttl_seconds == 1200
    assert device_cache._max_size == 2


def test_an_unknown_device_cache_is_refused(caches: Any) -> None:
    with pytest.raises(DeviceUnavailable):
        caches.get_model_cache("cuda:9")


# ── session traffic routes to where the model is resident ───────────────────


async def test_a_session_uses_the_gpu_the_model_is_resident_on(
    caches: Any, loader: Any, client: AsyncClient
) -> None:
    async with client:
        await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
    default = caches.get_model_cache()
    on_gpu1 = caches.get_model_cache("cuda:1")

    served = await default.get_or_load(_primary_config())
    await default.pin_many([PRIMARY_SLUG])

    assert loader.load.await_count == 1  # no second copy on the default GPU
    assert served is await on_gpu1.get(PRIMARY_SLUG)
    assert await default.get(PRIMARY_SLUG) is served
    (resident,) = on_gpu1.residency_snapshot()
    assert resident.in_flight == 1  # the session's pin protects the copy it uses
    assert default.residency_snapshot() == []

    await default.unpin_many([PRIMARY_SLUG])
    (resident,) = on_gpu1.residency_snapshot()
    assert resident.in_flight == 0


async def test_a_session_prefers_the_default_gpu_when_resident_on_both(
    caches: Any, loader: Any, client: AsyncClient
) -> None:
    async with client:
        await client.post(
            "/internal/residency/load", json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC}
        )
        await client.post(
            "/internal/residency/load",
            json={"model_ref": PRIMARY_SLUG, "load_spec": LOAD_SPEC, "device": "cuda:1"},
        )
    default = caches.get_model_cache()

    served = await default.get_or_load(_primary_config())
    await default.pin(PRIMARY_SLUG)

    assert served is await default.get(PRIMARY_SLUG)
    assert served.device != "cuda:1"
    (on_default,) = default.residency_snapshot()
    (on_gpu1,) = caches.get_model_cache("cuda:1").residency_snapshot()
    assert on_default.in_flight == 1 and on_gpu1.in_flight == 0


async def test_a_session_loads_on_the_default_gpu_when_nothing_is_resident(
    caches: Any, loader: Any
) -> None:
    default = caches.get_model_cache()
    caches.get_model_cache("cuda:1")  # exists, but empty

    served = await default.get_or_load(_primary_config())

    assert loader.load.await_count == 1
    assert served is await default.get(PRIMARY_SLUG)


async def test_a_device_cache_stamps_its_gpu_on_every_load_it_runs(
    caches: Any, loader: Any
) -> None:
    """Even a config with no device opinion loads ON the cache's GPU."""
    await caches.get_model_cache("cuda:1").get_or_load(_primary_config())

    (config,) = loader.load.await_args.args
    assert config.device == "cuda:1"


# ── measurement: parameter bytes for torch formats ──────────────────────────


class _Tensor:
    def __init__(self, numel: int, size: int) -> None:
        self._numel, self._size = numel, size

    def numel(self) -> int:
        return self._numel

    def element_size(self) -> int:
        return self._size


class _Module:
    def __init__(self) -> None:
        self._params = [_Tensor(1000, 2), _Tensor(24, 4)]
        self._buffers = [_Tensor(10, 4)]

    def parameters(self) -> list[_Tensor]:
        return self._params

    def buffers(self) -> list[_Tensor]:
        return self._buffers


def _loaded(fmt: AiModelFormat, model: Any) -> LoadedModel:
    return LoadedModel(model_id="m", model_slug="s", model=model, format=fmt)


@pytest.mark.parametrize(
    "fmt", [AiModelFormat.SAFETENSOR, AiModelFormat.PYTORCH, AiModelFormat.NEMO]
)
def test_torch_formats_are_measured_by_parameter_and_buffer_bytes(
    caches: Any, fmt: AiModelFormat
) -> None:
    measure = caches.get_model_cache()._measure

    assert measure(_loaded(fmt, _Module())) == 1000 * 2 + 24 * 4 + 10 * 4


@pytest.mark.parametrize(
    "fmt",
    [AiModelFormat.FASTER_WHISPER, AiModelFormat.WHISPER_CPP, AiModelFormat.ONNX],
)
def test_non_torch_formats_keep_the_device_delta(caches: Any, fmt: AiModelFormat) -> None:
    measure = caches.get_model_cache()._measure

    # Even an object that happens to expose `.parameters()` is not sized for them.
    assert measure(_loaded(fmt, _Module())) is None


def test_a_device_cache_measures_the_same_way(caches: Any) -> None:
    measure = caches.get_model_cache("cuda:1")._measure

    assert measure(_loaded(AiModelFormat.PYTORCH, _Module())) == 2136
