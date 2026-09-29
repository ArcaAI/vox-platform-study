"""EnginePool: one lazily built engine per runtime key, single-flight, bounded residency."""

from __future__ import annotations

import asyncio

import pytest

from hope_vllm.engine.pool import (
    EngineCapacityError,
    EngineLoadError,
    EnginePool,
    RuntimeKeySpecMismatchError,
)
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.conftest import serving_spec_payload
from hope_vllm.tests.fakes import FakeEngineFactory


def make_spec(**overrides: object) -> ResolvedServingSpec:
    return ResolvedServingSpec.model_validate(serving_spec_payload(**overrides))


async def test_builds_lazily_and_reuses_the_engine_for_the_same_runtime_key() -> None:
    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=1)
    assert factory.builds == []

    async with pool.lease(make_spec()) as first:
        pass
    async with pool.lease(make_spec()) as second:
        pass

    assert factory.builds == ["model-0001:v1"]
    assert first is second


async def test_concurrent_first_requests_share_one_load() -> None:
    factory = FakeEngineFactory(build_delay_s=0.05)
    pool = EnginePool(factory, max_resident=1)

    async def use() -> object:
        async with pool.lease(make_spec()) as engine:
            return engine

    engines = await asyncio.gather(*(use() for _ in range(10)))

    assert factory.builds == ["model-0001:v1"]
    assert len({id(e) for e in engines}) == 1


async def test_snapshot_reports_loading_then_loaded_engines() -> None:
    factory = FakeEngineFactory(build_delay_s=0.05)
    pool = EnginePool(factory, max_resident=1)

    task = asyncio.create_task(pool.warm(make_spec()))
    await asyncio.sleep(0.01)
    assert pool.snapshot()["loading"] == ["model-0001:v1"]
    assert pool.snapshot()["loaded"] == []

    await task
    snap = pool.snapshot()
    assert snap["loading"] == []
    assert [e["runtime_key"] for e in snap["loaded"]] == ["model-0001:v1"]
    assert snap["max_resident"] == 1


async def test_same_runtime_key_with_a_different_spec_is_refused() -> None:
    pool = EnginePool(FakeEngineFactory(), max_resident=2)
    await pool.warm(make_spec())

    with pytest.raises(RuntimeKeySpecMismatchError):
        async with pool.lease(make_spec(localPath="/elsewhere")):
            pass


async def test_idle_least_recently_used_engine_is_evicted_at_the_bound() -> None:
    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=1)
    await pool.warm(make_spec(runtimeKey="a"))
    engine_a = factory.engines["a"]

    async with pool.lease(make_spec(runtimeKey="b")):
        pass

    assert engine_a.shut_down is True
    assert [e["runtime_key"] for e in pool.snapshot()["loaded"]] == ["b"]


async def test_a_busy_engine_is_never_evicted_capacity_error_instead() -> None:
    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=1)

    async with pool.lease(make_spec(runtimeKey="a")):
        with pytest.raises(EngineCapacityError):
            async with pool.lease(make_spec(runtimeKey="b")):
                pass

    assert factory.engines["a"].shut_down is False


async def test_a_failed_load_is_reported_and_not_cached() -> None:
    factory = FakeEngineFactory(fail_with=RuntimeError("CUDA out of memory"))
    pool = EnginePool(factory, max_resident=1)

    with pytest.raises(EngineLoadError):
        await pool.warm(make_spec())
    assert pool.snapshot()["loaded"] == [] and pool.snapshot()["loading"] == []

    factory.fail_with = None
    await pool.warm(make_spec())
    assert factory.builds == ["model-0001:v1", "model-0001:v1"]


async def test_inflight_count_tracks_leases() -> None:
    pool = EnginePool(FakeEngineFactory(), max_resident=1)
    async with pool.lease(make_spec()):
        assert pool.snapshot()["loaded"][0]["inflight"] == 1
    assert pool.snapshot()["loaded"][0]["inflight"] == 0


async def test_close_shuts_down_every_resident_engine() -> None:
    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=2)
    await pool.warm(make_spec(runtimeKey="a"))
    await pool.warm(make_spec(runtimeKey="b"))

    await pool.close()

    assert factory.engines["a"].shut_down and factory.engines["b"].shut_down
    assert pool.snapshot()["loaded"] == []


# ── OD-6: residency bound read per eviction check; control plane pulled before a build ──


async def test_the_residency_bound_is_read_at_every_eviction_check() -> None:
    """`asrVllm.engine.maxResidentEngines` applies on the next eviction check, no restart."""
    bound = {"value": 1}
    factory = FakeEngineFactory()
    pool = EnginePool(factory, max_resident=lambda: bound["value"])
    await pool.warm(make_spec(runtimeKey="a"))

    bound["value"] = 2  # the platform admin raised it
    await pool.warm(make_spec(runtimeKey="b"))
    assert factory.engines["a"].shut_down is False
    assert pool.snapshot()["max_resident"] == 2

    bound["value"] = 1
    await pool.warm(make_spec(runtimeKey="c"))
    assert sorted(e["runtime_key"] for e in pool.snapshot()["loaded"]) == ["b", "c"]


async def test_the_control_plane_is_pulled_before_every_build_and_only_then() -> None:
    calls: list[str] = []
    factory = FakeEngineFactory()

    async def before_build() -> None:
        calls.append(f"refresh-before-build-{len(factory.builds)}")

    pool = EnginePool(factory, max_resident=2, before_build=before_build)
    await pool.warm(make_spec(runtimeKey="a"))
    async with pool.lease(make_spec(runtimeKey="a")):
        pass
    await pool.warm(make_spec(runtimeKey="b"))
    assert calls == ["refresh-before-build-0", "refresh-before-build-1"]
