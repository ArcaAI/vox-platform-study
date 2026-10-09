"""TASK-1055 — honest footprints: the ``measure`` hook, ``bytes_source``, the measurement guard.

Contract: ``tests/contracts/model-residency-task1055.fixture.json`` (``python.$reportNotes``):
``measured`` = parameter+buffer bytes (the ``measure`` hook) or a CLEAN, serialised per-device
delta; ``estimated`` = a polluted (overlapping) delta; ``unknown`` = nothing to report.

No GPU, no torch: devices are fakes whose free memory the factories move by hand.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest

from hope_runtime_models import (
    AdmissionPolicy,
    AdmissionRejected,
    CacheResidency,
    Device,
    DeviceMemory,
    ModelCache,
    SyncModelCache,
)
from hope_runtime_models.residency_agent import CacheBinding, ResidencyAgent

GIB = 1024**3


def _fixture() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "model-residency-task1055.fixture.json"
        if candidate.exists():
            loaded: dict[str, Any] = json.loads(candidate.read_text())
            return loaded
    raise FileNotFoundError("model-residency-task1055.fixture.json not found above this test")


BYTES_SOURCES = {"measured", "estimated", "unknown"}


class FakeMemory:
    def __init__(self, total: int = 16 * GIB, free: int = 12 * GIB) -> None:
        self.total = total
        self.free = free

    def read(self) -> DeviceMemory:
        return DeviceMemory(free_bytes=self.free, total_bytes=self.total)


def fake_gpu(memory: FakeMemory, device_id: str = "cuda:0") -> Device:
    return Device(
        id=device_id, kind="gpu", memory=memory.read, usage=lambda: memory.total - memory.free
    )


def build(
    kind: str,
    *,
    memory: FakeMemory,
    footprints: dict[str, int],
    measure: Any = None,
    admission: AdmissionPolicy | None = None,
    gate: asyncio.Event | None = None,
) -> Any:
    def unload(key: str, _instance: Any) -> None:
        memory.free += footprints.get(key, 0)

    residency = CacheResidency(
        service="nlp", device=fake_gpu(memory), admission=admission or AdmissionPolicy()
    )
    common: dict[str, Any] = {
        "ttl_seconds": 900,
        "max_size": 4,
        "unload": unload,
        "residency": residency,
        "measure": measure,
        "name": "nlp_test",
    }
    if kind == "async":

        async def afactory(key: str) -> str:
            if gate is not None:
                await gate.wait()
            memory.free -= footprints.get(key, 0)
            return f"instance::{key}"

        return ModelCache(factory=afactory, **common)

    def factory(key: str) -> str:
        memory.free -= footprints.get(key, 0)
        return f"instance::{key}"

    return SyncModelCache(factory=factory, **common)


async def call(value: Any) -> Any:
    return await value if asyncio.iscoroutine(value) else value


def snapshot(cache: Any, key: str) -> Any:
    (model,) = [m for m in cache.residency_snapshot() if m.key == key]
    return model


KINDS = ["async", "sync"]


# ── 1. the measure hook and the device delta ────────────────────────────────


@pytest.mark.parametrize("kind", KINDS)
async def test_measure_hook_wins_over_the_device_delta(kind: str) -> None:
    memory = FakeMemory()
    cache = build(kind, memory=memory, footprints={"m": 3 * GIB}, measure=lambda _i: 993_001_472)
    await call(cache.get("m"))

    model = snapshot(cache, "m")
    assert model.measured_bytes == 993_001_472
    assert model.bytes_source == "measured"


@pytest.mark.parametrize("kind", KINDS)
async def test_measure_hook_none_falls_back_to_a_clean_delta_which_is_measured(kind: str) -> None:
    memory = FakeMemory()
    cache = build(kind, memory=memory, footprints={"m": GIB}, measure=lambda _i: None)
    await call(cache.get("m"))

    model = snapshot(cache, "m")
    assert model.measured_bytes == GIB
    assert model.bytes_source == "measured"


@pytest.mark.parametrize("kind", KINDS)
async def test_measure_hook_that_raises_never_fails_the_load(kind: str) -> None:
    def broken(_instance: Any) -> int:
        raise RuntimeError("not a torch module")

    cache = build(kind, memory=FakeMemory(), footprints={"m": GIB}, measure=broken)
    assert await call(cache.get("m")) == "instance::m"

    model = snapshot(cache, "m")
    assert (model.measured_bytes, model.bytes_source) == (GIB, "measured")


@pytest.mark.parametrize("kind", KINDS)
async def test_no_delta_and_no_hook_is_unknown(kind: str) -> None:
    cache = build(kind, memory=FakeMemory(), footprints={})
    await call(cache.get("cloud"))

    model = snapshot(cache, "cloud")
    assert (model.measured_bytes, model.bytes_source) == (None, "unknown")


async def test_an_overlapping_delta_is_reported_as_estimated_not_dropped() -> None:
    memory = FakeMemory()
    gate = asyncio.Event()
    cache = build("async", memory=memory, footprints={"a": GIB, "b": 2 * GIB}, gate=gate)

    loads = [asyncio.create_task(cache.get("a")), asyncio.create_task(cache.get("b"))]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*loads)

    for key in ("a", "b"):
        model = snapshot(cache, key)
        assert model.bytes_source == "estimated"
        assert model.measured_bytes is not None and model.measured_bytes > 0


async def test_an_overlapping_load_still_takes_the_hook_value_as_measured() -> None:
    memory = FakeMemory()
    gate = asyncio.Event()
    cache = build(
        "async",
        memory=memory,
        footprints={"a": GIB, "b": 2 * GIB},
        gate=gate,
        measure=lambda instance: 111 if instance.endswith("a") else 222,
    )
    loads = [asyncio.create_task(cache.get("a")), asyncio.create_task(cache.get("b"))]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*loads)

    assert (snapshot(cache, "a").measured_bytes, snapshot(cache, "a").bytes_source) == (
        111,
        "measured",
    )
    assert (snapshot(cache, "b").measured_bytes, snapshot(cache, "b").bytes_source) == (
        222,
        "measured",
    )


async def test_report_bytes_source_carries_the_cache_source_and_stays_in_the_enum() -> None:
    memory = FakeMemory()
    gate = asyncio.Event()
    cache = build("async", memory=memory, footprints={"a": GIB, "b": 2 * GIB}, gate=gate)
    loads = [asyncio.create_task(cache.get("a")), asyncio.create_task(cache.get("b"))]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*loads)
    await cache.get("solo-unknown")  # moves no memory

    agent = ResidencyAgent(
        service="nlp", instance="t", bindings=lambda: [CacheBinding(cache=cache)]
    )
    models = {m["model_ref"]: m for m in agent.report()["models"]}
    assert models["a"]["bytes_source"] == "estimated"
    assert models["a"]["bytes"] == snapshot(cache, "a").measured_bytes
    assert models["solo-unknown"]["bytes_source"] == "unknown"
    assert models["solo-unknown"]["bytes"] is None
    assert {m["bytes_source"] for m in models.values()} <= BYTES_SOURCES
    fixture_model = _fixture()["python"]["report"]["models"][0]
    assert fixture_model["bytes_source"] in BYTES_SOURCES


async def test_an_estimated_delta_never_becomes_the_admission_footprint() -> None:
    memory = FakeMemory(total=16 * GIB, free=12 * GIB)
    gate = asyncio.Event()
    cache = build("async", memory=memory, footprints={"a": GIB, "b": 2 * GIB}, gate=gate)
    loads = [asyncio.create_task(cache.get("a")), asyncio.create_task(cache.get("b"))]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*loads)
    await cache.unload("b")
    await cache.unload("a")

    # 2.5 GiB free of 16: headroom 15 % = 2.4 GiB. Unknown footprint counts as 0 → admitted;
    # had the polluted 3 GiB delta of "b" been stored it would be refused.
    memory.free = int(2.5 * GIB)
    cache.residency.admission = AdmissionPolicy(enabled=True, max_wait_ms=10, poll_interval_ms=5)
    assert await cache.get("b") == "instance::b"


# ── 2. the measurement guard ────────────────────────────────────────────────


@pytest.mark.parametrize("kind", KINDS)
async def test_a_reading_below_half_the_trusted_footprint_is_distrusted_and_not_stored(
    kind: str, caplog: pytest.LogCaptureFixture
) -> None:
    readings = iter([4 * GIB, GIB])
    memory = FakeMemory(total=16 * GIB, free=12 * GIB)
    cache = build(kind, memory=memory, footprints={}, measure=lambda _i: next(readings))
    await call(cache.get("granite"))
    await call(cache.unload("granite"))

    with caplog.at_level(logging.WARNING, logger="hope_runtime_models.cache"):
        await call(cache.get("granite"))

    model = snapshot(cache, "granite")
    assert model.measured_bytes == GIB
    assert model.bytes_source == "estimated"
    distrusted = [r for r in caplog.records if "measurement_distrusted" in r.getMessage()]
    assert [r.levelno for r in distrusted] == [logging.WARNING]

    # Admission still sizes the model at the trusted 4 GiB: 6 GiB free − 4 < 2.4 headroom.
    await call(cache.unload("granite"))
    memory.free = 6 * GIB
    cache.residency.admission = AdmissionPolicy(enabled=True, max_wait_ms=10, poll_interval_ms=5)
    with pytest.raises(AdmissionRejected) as rejected:
        await call(cache.get("granite"))
    assert rejected.value.needed_bytes == 4 * GIB


@pytest.mark.parametrize("kind", KINDS)
async def test_a_reading_at_or_above_half_replaces_the_footprint(kind: str) -> None:
    readings = iter([4 * GIB, 2 * GIB, 2 * GIB])
    memory = FakeMemory(total=16 * GIB, free=12 * GIB)
    cache = build(kind, memory=memory, footprints={}, measure=lambda _i: next(readings))
    await call(cache.get("m"))
    await call(cache.unload("m"))
    await call(cache.get("m"))

    model = snapshot(cache, "m")
    assert (model.measured_bytes, model.bytes_source) == (2 * GIB, "measured")

    await call(cache.unload("m"))
    memory.free = int(4.5 * GIB)  # 4.5 − 2 ≥ 2.4 headroom: admitted at the new 2 GiB footprint
    cache.residency.admission = AdmissionPolicy(enabled=True, max_wait_ms=10, poll_interval_ms=5)
    assert await call(cache.get("m")) == "instance::m"
