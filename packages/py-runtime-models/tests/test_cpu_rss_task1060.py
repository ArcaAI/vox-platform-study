"""TASK-1060 lane P — a cpu load reports the process-RSS delta (D-5, D-6).

cpu order: clean delta (measured) > measure hook (measured) > dirty delta (estimated) > unknown.
GPU order is unchanged: hook first, then the delta.
"""

from __future__ import annotations

from typing import Any

from hope_runtime_models import CacheResidency, Device, DeviceMemory, SyncModelCache
from hope_runtime_models.devices import process_rss_bytes

GIB = 1024**3
HOOK_BYTES = 993_001_472
DELTA = 2 * GIB


class Pool:
    def __init__(self) -> None:
        self.used = 4 * GIB

    def memory(self) -> DeviceMemory:
        return DeviceMemory(free_bytes=16 * GIB - self.used, total_bytes=16 * GIB)


def build(kind: str, pool: Pool, *, measure: Any, overlap: bool = False) -> SyncModelCache[str]:
    device = Device(
        id="cpu" if kind == "cpu" else "cuda:0",
        kind=kind,
        memory=pool.memory,
        usage=lambda: pool.used,
    )

    def factory(key: str) -> str:
        if overlap:
            # another load starts on the same device while this one is in flight
            device.begin_load("other")
        pool.used += DELTA
        return f"instance::{key}"

    return SyncModelCache(
        factory=factory,
        ttl_seconds=900,
        max_size=4,
        unload=lambda _k, _i: None,
        residency=CacheResidency(service="nlp", device=device),
        measure=measure,
        name="rss_test",
    )


def only(cache: Any) -> Any:
    (model,) = cache.residency_snapshot()
    return model


def test_cpu_clean_delta_beats_the_hook() -> None:
    cache = build("cpu", Pool(), measure=lambda _i: HOOK_BYTES)
    cache.get("m")
    model = only(cache)
    assert (model.measured_bytes, model.bytes_source) == (DELTA, "measured")


def test_cpu_dirty_delta_falls_back_to_the_hook() -> None:
    cache = build("cpu", Pool(), measure=lambda _i: HOOK_BYTES, overlap=True)
    cache.get("m")
    model = only(cache)
    assert (model.measured_bytes, model.bytes_source) == (HOOK_BYTES, "measured")


def test_cpu_dirty_delta_without_hook_is_estimated() -> None:
    cache = build("cpu", Pool(), measure=None, overlap=True)
    cache.get("m")
    model = only(cache)
    assert (model.measured_bytes, model.bytes_source) == (DELTA, "estimated")


def test_gpu_order_is_unchanged_hook_first() -> None:
    cache = build("gpu", Pool(), measure=lambda _i: HOOK_BYTES)
    cache.get("m")
    model = only(cache)
    assert (model.measured_bytes, model.bytes_source) == (HOOK_BYTES, "measured")


def test_process_rss_bytes_is_positive_with_psutil() -> None:
    value = process_rss_bytes()
    assert isinstance(value, int) and value > 0
