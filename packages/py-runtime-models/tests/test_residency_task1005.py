"""TASK-1005 — the model-residency agent: operator verbs, measured footprint, admission.

The contract under test is `tests/contracts/model-residency-agent.fixture.json`
(repo root), PINNED before the lanes branched. Its `python` block is what every
Python service's `/internal/residency/*` routes must emit, byte-for-byte in key
set, so the gateway controller can map one shape.

House constraints (as in `test_cache_contract.py`): fake clocks for idle time,
NVML is always stubbed (a fake `pynvml` module), no GPU. Admission waits use real
but tiny (milliseconds) budgets because they are bounded by wall time by design.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from hope_runtime_models import (
    EVICTION_REASONS,
    AdmissionPolicy,
    AdmissionRejected,
    CacheResidency,
    Device,
    DeviceMemory,
    ModelCache,
    ModelInFlightError,
    SyncModelCache,
    gpu_device,
    reset_nvml_detection,
)
from hope_runtime_models.residency_agent import (
    CacheBinding,
    LoadPlan,
    ModelIdentity,
    ResidencyAgent,
)
from hope_runtime_models.residency_api import build_residency_router

GIB = 1024**3


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-agent.fixture.json"
        if candidate.exists():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise FileNotFoundError("model-residency-agent.fixture.json not found above this test")


FIXTURE = _fixture()
PY = FIXTURE["python"]
ENUMS = FIXTURE["enums"]


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeDeviceMemory:
    """A device whose free memory the test factories move by hand."""

    def __init__(self, total: int = 16 * GIB, free: int = 12 * GIB) -> None:
        self.total = total
        self.free = free

    def read(self) -> DeviceMemory:
        return DeviceMemory(free_bytes=self.free, total_bytes=self.total)


def fake_gpu(memory: FakeDeviceMemory, device_id: str = "cuda:0") -> Device:
    return Device(
        id=device_id,
        kind="gpu",
        memory=memory.read,
        usage=lambda: memory.total - memory.free,
    )


class RecordingResidencyMetrics:
    def __init__(self) -> None:
        self.states: list[tuple[str, str, str, str | None]] = []
        self.bytes: list[tuple[str, str, str, int | None]] = []
        self.load_seconds: list[tuple[str, str, float]] = []
        self.evictions: list[tuple[str, str]] = []

    def on_state(self, service: str, model: str, device: str, state: str | None) -> None:
        self.states.append((service, model, device, state))

    def on_bytes(self, service: str, model: str, device: str, measured: int | None) -> None:
        self.bytes.append((service, model, device, measured))

    def on_load_seconds(self, service: str, model: str, seconds: float) -> None:
        self.load_seconds.append((service, model, seconds))

    def on_eviction(self, service: str, reason: str) -> None:
        self.evictions.append((service, reason))


class LegacySink:
    def __init__(self) -> None:
        self.evictions: list[str] = []

    def on_load(self, name: str, key: str) -> None: ...

    def on_evict(self, name: str, key: str, reason: str) -> None:
        self.evictions.append(reason)

    def on_resident(self, name: str, count: int, bytes_estimate: int) -> None: ...


def make_cache(
    *,
    memory: FakeDeviceMemory | None = None,
    footprints: dict[str, int] | None = None,
    clock: FakeClock | None = None,
    max_size: int = 4,
    ttl_seconds: int = 600,
    admission: AdmissionPolicy | None = None,
    metrics: RecordingResidencyMetrics | None = None,
    legacy: LegacySink | None = None,
    gate: asyncio.Event | None = None,
    device: Device | None = None,
) -> ModelCache[str]:
    memory = memory or FakeDeviceMemory()
    footprints = footprints or {}

    async def factory(key: str) -> str:
        if gate is not None:
            await gate.wait()
        memory.free -= footprints.get(key, 0)
        return f"instance::{key}"

    async def unload(key: str, _instance: str) -> None:
        memory.free += footprints.get(key, 0)

    residency = CacheResidency(
        service="stt",
        device=device or fake_gpu(memory),
        metrics=metrics,
        admission=admission or AdmissionPolicy(),
    )
    return ModelCache(
        factory=factory,
        unload=unload,
        ttl_seconds=ttl_seconds,
        max_size=max_size,
        time_func=clock or FakeClock(),
        metrics=legacy,
        residency=residency,
        name="asr",
    )


def make_agent(
    caches: list[ModelCache[str]],
    *,
    planner: Any = None,
    wall: float = 1_790_000_000.0,
) -> ResidencyAgent:
    async def default_planner(model_ref: str, load_spec: dict[str, Any]) -> LoadPlan | None:
        cache = caches[0]
        return LoadPlan(cache=cache, key=model_ref, load=lambda: cache.get(model_ref))

    return ResidencyAgent(
        service="stt",
        instance="hope-stt-test",
        bindings=lambda: [CacheBinding(cache=cache) for cache in caches],
        planner=planner or default_planner,
        wall_clock=lambda: wall,
    )


def make_client(agent: ResidencyAgent) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(build_residency_router(agent))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://svc")


# ── 1. unload refuses while in flight (plan §8.3, first failing test) ───────


async def test_unload_refuses_while_in_flight_unless_forced() -> None:
    cache = make_cache()
    await cache.get("whisper")
    await cache.pin("whisper")

    with pytest.raises(ModelInFlightError) as refused:
        await cache.unload("whisper")
    assert refused.value.in_flight == 1
    assert cache.cached_keys() == ["whisper"]

    assert await cache.unload("whisper", force=True) is True
    assert cache.cached_keys() == []


async def test_unload_route_answers_409_in_flight_with_the_fixture_error_shape() -> None:
    cache = make_cache()
    await cache.get("arcaai-whisper-ml-en-ggml")
    await cache.pin("arcaai-whisper-ml-en-ggml")

    async with make_client(make_agent([cache])) as client:
        response = await client.post("/internal/residency/unload", json=PY["unloadRequest"])

    assert response.status_code == 409
    body = response.json()
    assert set(body) == set(PY["error"])
    assert set(body["error"]) == set(PY["error"]["error"])
    assert body["error"]["code"] == "IN_FLIGHT"
    assert body["error"]["in_flight"] == 1
    assert cache.cached_keys() == ["arcaai-whisper-ml-en-ggml"]


async def test_unload_route_unloads_an_idle_model_and_reports_not_loaded_after() -> None:
    cache = make_cache()
    await cache.get("arcaai-whisper-ml-en-ggml")

    async with make_client(make_agent([cache])) as client:
        first = await client.post("/internal/residency/unload", json=PY["unloadRequest"])
        second = await client.post("/internal/residency/unload", json=PY["unloadRequest"])

    assert first.status_code == 200
    assert set(first.json()) == set(PY["unloadResponse"])
    assert first.json() == {"outcome": "unloaded", "model_ref": "arcaai-whisper-ml-en-ggml"}
    assert second.json()["outcome"] == "not_loaded"


# ── 2. measured bytes = the (fake) NVML free-memory delta ───────────────────


class _FakeNvml(types.ModuleType):
    """Just enough of `pynvml` for `make_vram_info_probe`."""

    def __init__(self, total: int, free: int) -> None:
        super().__init__("pynvml")
        self.total = total
        self.free = free

    def nvmlInit(self) -> None:  # noqa: N802 — the real API's spelling
        return None

    def nvmlDeviceGetHandleByIndex(self, index: int) -> int:  # noqa: N802
        return index

    def nvmlDeviceGetMemoryInfo(self, _handle: int) -> Any:  # noqa: N802
        return types.SimpleNamespace(total=self.total, free=self.free, used=self.total - self.free)


@pytest.fixture
def fake_nvml(monkeypatch: pytest.MonkeyPatch) -> _FakeNvml:
    nvml = _FakeNvml(total=17_175_674_880, free=12_817_793_024)
    monkeypatch.setitem(sys.modules, "pynvml", nvml)
    reset_nvml_detection()
    yield nvml
    reset_nvml_detection()


async def test_measured_bytes_equal_the_nvml_free_memory_delta(fake_nvml: _FakeNvml) -> None:
    device = gpu_device(0)
    assert device is not None and device.kind == "gpu" and device.id == "cuda:0"
    footprint = 1_623_195_648

    async def factory(key: str) -> str:
        fake_nvml.free -= footprint
        return f"instance::{key}"

    cache: ModelCache[str] = ModelCache(
        factory=factory,
        ttl_seconds=900,
        max_size=2,
        time_func=FakeClock(),
        residency=CacheResidency(service="stt", device=device),
        name="asr",
    )
    await cache.get("arcaai-whisper-ml-en-ggml")

    report = make_agent([cache]).report()
    (model,) = report["models"]
    assert model["bytes"] == footprint
    assert model["bytes_source"] == "measured"
    assert model["device"] == "cuda:0"
    (gpu,) = report["devices"]
    # TASK-1055 added index/name/uuid/process_bytes (pinned in test_device_report_task1055.py).
    assert {key: gpu[key] for key in ("id", "kind", "total_bytes", "free_bytes")} == {
        "id": "cuda:0",
        "kind": "gpu",
        "total_bytes": 17_175_674_880,
        "free_bytes": 12_817_793_024 - footprint,
    }


async def test_overlapping_loads_on_one_device_are_never_measured() -> None:
    """Two loads in flight at once: a delta cannot be split, so neither is `measured`.

    TASK-1055 reports the polluted delta as `estimated` (it was `unknown` / None before).
    """
    memory = FakeDeviceMemory()
    gate = asyncio.Event()
    cache = make_cache(memory=memory, footprints={"a": GIB, "b": 2 * GIB}, gate=gate)

    loads = [asyncio.create_task(cache.get("a")), asyncio.create_task(cache.get("b"))]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*loads)

    models = {m["model_ref"]: m for m in make_agent([cache]).report()["models"]}
    assert models["a"]["bytes_source"] == "estimated"
    assert models["b"]["bytes_source"] == "estimated"


async def test_a_load_that_frees_nothing_or_grows_free_memory_is_unknown_not_zero() -> None:
    cache = make_cache(footprints={})  # the factory moves no memory at all
    await cache.get("cloud-asr")

    (model,) = make_agent([cache]).report()["models"]
    assert model["bytes"] is None
    assert model["bytes_source"] == "unknown"


# ── 3. the report matches the pinned fixture key set exactly ────────────────


async def test_get_report_matches_the_fixture_key_set_exactly() -> None:
    clock = FakeClock()
    cache = make_cache(clock=clock, footprints={"arcaai-whisper-ml-en-ggml": GIB})
    await cache.get("arcaai-whisper-ml-en-ggml")
    await cache.pin("arcaai-whisper-ml-en-ggml")

    async with make_client(make_agent([cache])) as client:
        response = await client.get("/internal/residency")

    assert response.status_code == 200
    report = response.json()
    expected = PY["report"]
    assert set(report) == set(expected)
    assert report["service"] == "stt"
    assert report["instance"] == "hope-stt-test"
    assert report["reported_at"].endswith("Z")
    (device,) = report["devices"]
    # TASK-1055 v2 fixture: + index / name / uuid / process_bytes.
    assert set(device) == set(expected["devices"][0]) | {"index", "name", "uuid", "process_bytes"}
    assert device["kind"] in ENUMS["deviceKind"]
    (model,) = report["models"]
    assert set(model) == set(expected["models"][0])
    assert model["state"] in ENUMS["state"]
    assert model["bytes_source"] in ENUMS["bytesSource"]
    assert model["cache"] == "asr"
    assert model["in_flight"] == 1
    assert model["pinned"] is True
    assert model["admin_pinned"] is False
    assert model["ttl_seconds"] == 600
    assert model["loaded_at"].endswith("Z") and model["last_used_at"].endswith("Z")
    assert isinstance(model["load_seconds"], float)


async def test_load_route_loads_then_answers_already_loaded_with_fixture_shapes() -> None:
    cache = make_cache()
    request = {**PY["loadRequest"], "pin": False}

    async with make_client(make_agent([cache])) as client:
        first = await client.post("/internal/residency/load", json=request)
        second = await client.post("/internal/residency/load", json=request)

    assert first.status_code == 200, first.text
    assert set(first.json()) == set(PY["loadResponse"])
    assert first.json()["outcome"] == "loaded"
    assert set(first.json()["model"]) == set(PY["report"]["models"][0])
    assert second.json()["outcome"] == "already_loaded"
    assert cache.cached_keys() == ["arcaai-whisper-ml-en-ggml"]


async def test_load_with_pin_sets_the_operator_pin_and_ttl() -> None:
    cache = make_cache()
    request = {**PY["loadRequest"], "pin": True, "ttl_seconds": 1800}

    async with make_client(make_agent([cache])) as client:
        response = await client.post("/internal/residency/load", json=request)

    model = response.json()["model"]
    assert model["admin_pinned"] is True
    assert model["pinned"] is True
    assert model["in_flight"] == 0
    assert model["ttl_seconds"] == 1800


async def test_policy_route_sets_admin_pin_and_ttl_with_the_fixture_shape() -> None:
    cache = make_cache()
    await cache.get("arcaai-whisper-ml-en-ggml")

    async with make_client(make_agent([cache])) as client:
        response = await client.put(
            "/internal/residency/models/arcaai-whisper-ml-en-ggml/policy",
            json=PY["policyRequest"],
        )
        missing = await client.put(
            "/internal/residency/models/never-loaded/policy", json=PY["policyRequest"]
        )

    assert response.status_code == 200, response.text
    assert set(response.json()) == set(PY["policyResponse"])
    model = response.json()["model"]
    assert model["admin_pinned"] is True and model["ttl_seconds"] == 1800
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "MODEL_UNKNOWN"


async def test_load_of_an_unknown_model_with_no_usable_spec_is_404_model_unknown() -> None:
    cache = make_cache()

    async def planner(_ref: str, _spec: dict[str, Any]) -> LoadPlan | None:
        return None

    async with make_client(make_agent([cache], planner=planner)) as client:
        response = await client.post("/internal/residency/load", json=PY["loadRequest"])

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MODEL_UNKNOWN"


async def test_a_failing_load_is_load_failed_and_is_not_cached() -> None:
    async def factory(key: str) -> str:
        raise RuntimeError("weights missing")

    cache: ModelCache[str] = ModelCache(
        factory=factory,
        ttl_seconds=600,
        max_size=2,
        residency=CacheResidency(service="stt", device=fake_gpu(FakeDeviceMemory())),
    )

    async with make_client(make_agent([cache])) as client:
        response = await client.post("/internal/residency/load", json=PY["loadRequest"])

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "LOAD_FAILED"
    assert cache.cached_keys() == []


async def test_concurrent_loads_of_one_model_share_a_single_flight() -> None:
    gate = asyncio.Event()
    calls: list[str] = []
    memory = FakeDeviceMemory()

    async def factory(key: str) -> str:
        calls.append(key)
        await gate.wait()
        return f"instance::{key}"

    cache: ModelCache[str] = ModelCache(
        factory=factory,
        ttl_seconds=600,
        max_size=2,
        residency=CacheResidency(service="stt", device=fake_gpu(memory)),
    )
    agent = make_agent([cache])

    first = asyncio.create_task(agent.load("m", {}, pin=False, ttl_seconds=None))
    second = asyncio.create_task(agent.load("m", {}, pin=False, ttl_seconds=None))
    await asyncio.sleep(0.01)
    gate.set()
    outcomes = await asyncio.gather(first, second)

    assert calls == ["m"]
    assert {o["model"]["model_ref"] for o in outcomes} == {"m"}


async def test_a_different_model_while_the_device_is_loading_is_409_load_in_progress() -> None:
    gate = asyncio.Event()

    async def factory(key: str) -> str:
        await gate.wait()
        return f"instance::{key}"

    cache: ModelCache[str] = ModelCache(
        factory=factory,
        ttl_seconds=600,
        max_size=4,
        residency=CacheResidency(service="stt", device=fake_gpu(FakeDeviceMemory())),
    )
    agent = make_agent([cache])

    busy = asyncio.create_task(agent.load("first", {}, pin=False, ttl_seconds=None))
    await asyncio.sleep(0.01)
    async with make_client(agent) as client:
        response = await client.post(
            "/internal/residency/load", json={**PY["loadRequest"], "model_ref": "second"}
        )
    gate.set()
    await busy

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "LOAD_IN_PROGRESS"
    assert cache.cached_keys() == ["first"]


# ── 4. operator pin survives idle TTL and LRU ───────────────────────────────


@pytest.mark.parametrize("kind", ["async", "sync"])
async def test_admin_pin_survives_ttl_expiry_and_lru_pressure(kind: str) -> None:
    clock = FakeClock()
    memory = FakeDeviceMemory()
    residency = CacheResidency(service="stt", device=fake_gpu(memory))

    if kind == "async":

        async def afactory(key: str) -> str:
            return f"instance::{key}"

        cache: Any = ModelCache(
            factory=afactory, ttl_seconds=60, max_size=1, time_func=clock, residency=residency
        )
    else:
        cache = SyncModelCache(
            factory=lambda key: f"instance::{key}",
            ttl_seconds=60,
            max_size=1,
            time_func=clock,
            residency=residency,
        )

    async def call(value: Any) -> Any:
        return await value if asyncio.iscoroutine(value) else value

    await call(cache.get("pinned"))
    await call(cache.set_policy("pinned", admin_pinned=True))

    clock.advance(3600)
    assert await call(cache.sweep()) == 0
    await call(cache.get("other"))  # max_size=1 → LRU pressure on "pinned"
    assert "pinned" in cache.cached_keys()
    assert await call(cache.evict("pinned")) is False

    await call(cache.set_policy("pinned", admin_pinned=False))
    clock.advance(3600)
    assert await call(cache.sweep()) >= 1
    assert "pinned" not in cache.cached_keys()


async def test_admin_pin_is_not_in_flight() -> None:
    cache = make_cache()
    await cache.get("m")
    await cache.set_policy("m", admin_pinned=True)

    (model,) = make_agent([cache]).report()["models"]
    assert model["in_flight"] == 0
    assert model["admin_pinned"] is True and model["pinned"] is True
    # An operator pin is not a request in flight: unload goes through without force.
    assert await cache.unload("m") is True


async def test_per_model_ttl_override_expires_before_the_cache_default() -> None:
    clock = FakeClock()
    cache = make_cache(clock=clock, ttl_seconds=3600)
    await cache.get("short")
    await cache.get("long")
    await cache.set_policy("short", ttl_seconds=120)

    clock.advance(600)
    assert await cache.sweep() == 1
    assert cache.cached_keys() == ["long"]

    await cache.set_policy("long", ttl_seconds=None)  # back to the cache default
    models = make_agent([cache]).report()["models"]
    assert models[0]["ttl_seconds"] == 3600


# ── 5. admission: off by default; rejects after max_wait_ms when on ─────────


async def test_admission_is_disabled_by_default() -> None:
    assert AdmissionPolicy().enabled is False
    memory = FakeDeviceMemory(total=16 * GIB, free=0)  # a full card
    cache = make_cache(memory=memory)

    assert await cache.get("m") == "instance::m"  # no admission gate in the way


async def test_admission_rejects_after_max_wait_when_nothing_is_evictable() -> None:
    memory = FakeDeviceMemory(total=16 * GIB, free=1 * GIB)  # 6 % free < 15 % headroom
    policy = AdmissionPolicy(enabled=True, headroom_percent=15, max_wait_ms=30, poll_interval_ms=5)
    cache = make_cache(memory=memory, admission=policy)
    cache.residency.admission = AdmissionPolicy()  # load "busy" with admission off
    await cache.get("busy")
    await cache.pin("busy")
    cache.residency.admission = policy

    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(AdmissionRejected) as rejected:
        await cache.get("incoming")
    waited = loop.time() - started

    assert waited >= 0.03
    assert rejected.value.retry_after_seconds >= 1
    assert rejected.value.device_id == "cuda:0"
    assert "incoming" not in cache.cached_keys()
    assert cache.cached_keys() == ["busy"]


async def test_admission_evicts_an_idle_model_for_room_as_pressure() -> None:
    memory = FakeDeviceMemory(total=16 * GIB, free=4 * GIB)
    metrics, legacy = RecordingResidencyMetrics(), LegacySink()
    cache = make_cache(
        memory=memory,
        footprints={"idle": 2 * GIB, "incoming": GIB},
        metrics=metrics,
        legacy=legacy,
        admission=AdmissionPolicy(enabled=True, headroom_percent=15, max_wait_ms=30),
    )
    await cache.get("idle")  # 2 GiB free left: 12.5 % < 15 % → no room for "incoming"

    assert await cache.get("incoming") == "instance::incoming"
    assert cache.cached_keys() == ["incoming"]
    assert ("stt", "pressure") in metrics.evictions
    assert legacy.evictions == ["vram"]  # the legacy label set is untouched


async def test_admission_rejection_is_503_insufficient_memory_with_retry_after() -> None:
    memory = FakeDeviceMemory(total=16 * GIB, free=GIB)
    cache = make_cache(
        memory=memory,
        admission=AdmissionPolicy(enabled=True, max_wait_ms=10, poll_interval_ms=5),
    )

    async with make_client(make_agent([cache])) as client:
        response = await client.post("/internal/residency/load", json=PY["loadRequest"])

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "INSUFFICIENT_MEMORY"
    assert int(response.headers["retry-after"]) >= 1


# ── 6. metrics ──────────────────────────────────────────────────────────────


async def test_residency_metrics_follow_load_and_eviction_with_their_reasons() -> None:
    clock = FakeClock()
    memory = FakeDeviceMemory()
    metrics, legacy = RecordingResidencyMetrics(), LegacySink()
    cache = make_cache(
        clock=clock, memory=memory, footprints={"m": GIB}, metrics=metrics, legacy=legacy
    )

    await cache.get("m")
    assert ("stt", "m", "cuda:0", "loading") in metrics.states
    assert metrics.states[-1] == ("stt", "m", "cuda:0", "loaded")
    assert metrics.bytes[-1] == ("stt", "m", "cuda:0", GIB)
    assert [(s, m) for s, m, _ in metrics.load_seconds] == [("stt", "m")]

    await cache.unload("m")
    assert metrics.evictions == [("stt", "admin")]
    assert metrics.states[-1] == ("stt", "m", "cuda:0", None)
    assert legacy.evictions == ["lru"]
    assert set(legacy.evictions) <= set(EVICTION_REASONS)

    await cache.get("m")
    clock.advance(3600)
    await cache.sweep()
    assert metrics.evictions[-1] == ("stt", "ttl")

    await cache.get("m")
    await cache.unload("m", reason="policy")
    assert metrics.evictions[-1] == ("stt", "policy")


def test_prometheus_residency_metrics_use_the_planned_names_and_labels() -> None:
    import prometheus_client

    from hope_runtime_models import (
        MODEL_LOAD_SECONDS,
        RESIDENCY_EVICTIONS_TOTAL,
        RESIDENT,
        RESIDENT_BYTES,
        PrometheusResidencyMetrics,
    )

    registry = prometheus_client.CollectorRegistry()
    sink = PrometheusResidencyMetrics.create(prometheus_client, registry=registry)
    sink.on_state("stt", "m", "cuda:0", "loaded")
    sink.on_bytes("stt", "m", "cuda:0", 42)
    sink.on_load_seconds("stt", "m", 1.5)
    sink.on_eviction("stt", "pressure")

    assert (RESIDENT, RESIDENT_BYTES, MODEL_LOAD_SECONDS, RESIDENCY_EVICTIONS_TOTAL) == (
        "model_resident",
        "model_resident_bytes",
        "model_load_seconds",
        "model_evictions_total",
    )
    value = registry.get_sample_value
    labels = {"service": "stt", "model": "m", "device": "cuda:0"}
    assert value("model_resident", {**labels, "state": "loaded"}) == 1
    assert value("model_resident", {**labels, "state": "loading"}) == 0
    assert value("model_resident_bytes", labels) == 42
    assert value("model_load_seconds_count", {"service": "stt", "model": "m"}) == 1
    assert value("model_evictions_total", {"service": "stt", "reason": "pressure"}) == 1


def test_model_identity_describes_a_key_by_default() -> None:
    assert CacheBinding(cache=make_cache()).describe("k", None) == ModelIdentity(
        model_ref="k", ai_model_id=None
    )


def test_a_declared_device_is_reported_before_any_cache_exists() -> None:
    memory = FakeDeviceMemory(total=64 * GIB, free=32 * GIB)
    agent = ResidencyAgent(
        service="nlp",
        instance="hope-nlp-test",
        bindings=lambda: [],
        devices=lambda: [Device(id="cpu", kind="cpu", memory=memory.read)],
    )

    report = agent.report()
    assert report["models"] == []
    assert report["devices"] == [
        {
            "id": "cpu",
            "kind": "cpu",
            "total_bytes": 64 * GIB,
            "free_bytes": 32 * GIB,
            "index": None,
            "name": None,
            "uuid": None,
            "process_bytes": None,
        }
    ]
