"""EnginePool: one engine per runtime key, single-flight, admitted by GiB, pins, kinds.

TASK-1021 C-4: a pool (``vllm.pools[VLLM_POOL]``) declares which KINDS it accepts, which
slugs it PINS, its VRAM budget in GiB and a residency count. An engine is admitted while
``Σ resident vramGiB + new ≤ budget`` and ``count ≤ maxResidentEngines``; otherwise the
least-recently-used IDLE, UNPINNED engine is evicted — never a busy or a pinned one.
"""

from __future__ import annotations

import asyncio

import pytest

from hope_vllm.core.serving_spec_client import ModelNotServable
from hope_vllm.engine.base import EngineBuildRefused
from hope_vllm.engine.pool import (
    SYSTEM_TENANT_ID,
    EngineCapacityError,
    EngineLoadError,
    EnginePool,
    PoolConfig,
    RuntimeKeySpecMismatchError,
)
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.tests.conftest import serving_spec_payload
from hope_vllm.tests.fakes import FakeEngineFactory


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def make_spec(**overrides: object) -> ResolvedServingSpec:
    return ResolvedServingSpec.model_validate(serving_spec_payload(**overrides))


def config(
    *,
    budget: float = 100.0,
    max_resident: int = 4,
    kinds: tuple[str, ...] = ("asr",),
    pins: tuple[str, ...] = (),
    inflight_factor: int = 2,
) -> PoolConfig:
    return PoolConfig(
        accepted_kinds=frozenset(kinds),
        pins=pins,
        vram_budget_gib=budget,
        max_resident=max_resident,
        inflight_factor=inflight_factor,
    )


def make_pool(factory: FakeEngineFactory, clock: Clock | None = None, **cfg: object) -> EnginePool:
    fixed = config(**cfg)  # type: ignore[arg-type]
    return EnginePool(factory, pool_config=lambda: fixed, clock=clock or Clock())


def loaded(pool: EnginePool) -> list[str]:
    return sorted(e["runtime_key"] for e in pool.snapshot()["loaded"])


# ── lazy, single-flight, fail-closed (kept from the spike) ───────────────────


async def test_builds_lazily_and_reuses_the_engine_for_the_same_runtime_key() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory)
    assert factory.builds == []

    async with pool.lease(make_spec()) as first:
        pass
    async with pool.lease(make_spec()) as second:
        pass

    assert factory.builds == ["model-0001:v1"]
    assert first is second


async def test_concurrent_first_requests_share_one_load() -> None:
    factory = FakeEngineFactory(build_delay_s=0.05)
    pool = make_pool(factory)

    async def use() -> object:
        async with pool.lease(make_spec()) as engine:
            return engine

    engines = await asyncio.gather(*(use() for _ in range(10)))

    assert factory.builds == ["model-0001:v1"]
    assert len({id(e) for e in engines}) == 1


async def test_snapshot_reports_loading_then_loaded_engines_and_the_budget() -> None:
    factory = FakeEngineFactory(build_delay_s=0.05)
    pool = make_pool(factory, budget=6.0, max_resident=2)

    task = asyncio.create_task(pool.warm(make_spec(vramGiB=2.5)))
    await asyncio.sleep(0.01)
    assert pool.snapshot()["loading"] == ["model-0001:v1"]
    assert pool.snapshot()["loaded"] == []

    await task
    snap = pool.snapshot()
    assert snap["loading"] == []
    (engine,) = snap["loaded"]
    assert engine["runtime_key"] == "model-0001:v1"
    assert engine["slug"] == "arcaai-whisper-large-ml-en-vllm"
    assert engine["kind"] == "asr"
    assert engine["vram_gib"] == 2.5
    assert engine["pinned"] is False
    assert snap["max_resident"] == 2
    assert snap["vram_budget_gib"] == 6.0
    assert snap["resident_gib"] == 2.5
    assert snap["accepted_kinds"] == ["asr"]


async def test_same_runtime_key_with_a_different_spec_is_refused() -> None:
    pool = make_pool(FakeEngineFactory())
    await pool.warm(make_spec())

    with pytest.raises(RuntimeKeySpecMismatchError):
        async with pool.lease(make_spec(localPath="/elsewhere")):
            pass


async def test_a_failed_load_is_reported_and_not_cached() -> None:
    factory = FakeEngineFactory(fail_with=RuntimeError("CUDA out of memory"))
    pool = make_pool(factory)

    with pytest.raises(EngineLoadError):
        await pool.warm(make_spec())
    assert pool.snapshot()["loaded"] == [] and pool.snapshot()["loading"] == []

    factory.fail_with = None
    await pool.warm(make_spec())
    assert factory.builds == ["model-0001:v1", "model-0001:v1"]


async def test_a_named_build_refusal_keeps_its_code() -> None:
    factory = FakeEngineFactory(fail_with=EngineBuildRefused("MODEL_NOT_PUBLISHED", "absent"))
    pool = make_pool(factory)
    with pytest.raises(EngineLoadError) as caught:
        await pool.warm(make_spec())
    assert caught.value.code == "MODEL_NOT_PUBLISHED"


async def test_inflight_count_tracks_leases() -> None:
    pool = make_pool(FakeEngineFactory())
    async with pool.lease(make_spec()):
        assert pool.snapshot()["loaded"][0]["inflight"] == 1
        assert pool.inflight(make_spec().runtime_key) == 1
    assert pool.snapshot()["loaded"][0]["inflight"] == 0
    assert pool.inflight(make_spec().runtime_key) == 0


async def test_close_shuts_down_every_resident_engine() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory)
    await pool.warm(make_spec(runtimeKey="a"))
    await pool.warm(make_spec(runtimeKey="b"))

    await pool.close()

    assert factory.engines["a"].shut_down and factory.engines["b"].shut_down
    assert pool.snapshot()["loaded"] == []


async def test_the_control_plane_is_pulled_before_every_build_and_only_then() -> None:
    calls: list[str] = []
    factory = FakeEngineFactory()

    async def before_build() -> None:
        calls.append(f"refresh-before-build-{len(factory.builds)}")

    fixed = config()
    pool = EnginePool(factory, pool_config=lambda: fixed, before_build=before_build)
    await pool.warm(make_spec(runtimeKey="a"))
    async with pool.lease(make_spec(runtimeKey="a")):
        pass
    await pool.warm(make_spec(runtimeKey="b"))
    assert calls == ["refresh-before-build-0", "refresh-before-build-1"]


# ── GiB admission ───────────────────────────────────────────────────────────


async def test_two_3_gib_engines_fit_6_gib_and_a_third_evicts_the_lru_idle_one() -> None:
    factory, clock = FakeEngineFactory(), Clock()
    pool = make_pool(factory, clock, budget=6.0, max_resident=4)

    await pool.warm(make_spec(runtimeKey="a", vramGiB=3))
    clock.now += 1
    await pool.warm(make_spec(runtimeKey="b", vramGiB=3))
    clock.now += 1
    async with pool.lease(make_spec(runtimeKey="a", vramGiB=3)):  # a is now the MRU
        pass
    clock.now += 1
    assert loaded(pool) == ["a", "b"]

    await pool.warm(make_spec(runtimeKey="c", vramGiB=3))

    assert loaded(pool) == ["a", "c"]
    assert factory.engines["b"].shut_down is True
    assert factory.engines["a"].shut_down is False
    assert pool.snapshot()["resident_gib"] == 6.0


async def test_eviction_frees_as_many_lru_engines_as_the_new_one_needs() -> None:
    factory, clock = FakeEngineFactory(), Clock()
    pool = make_pool(factory, clock, budget=6.0)
    for key in ("a", "b", "c"):
        await pool.warm(make_spec(runtimeKey=key, vramGiB=2))
        clock.now += 1

    await pool.warm(make_spec(runtimeKey="d", vramGiB=3.5))

    # 6 − 3.5 = 2.5 GiB may stay: only the most recent 2 GiB engine survives.
    assert loaded(pool) == ["c", "d"]


async def test_nothing_is_evicted_when_eviction_could_not_make_room_anyway() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, budget=6.0)
    await pool.warm(make_spec(runtimeKey="idle", vramGiB=2))
    async with pool.lease(make_spec(runtimeKey="busy", vramGiB=3)):
        with pytest.raises(EngineCapacityError):
            await pool.warm(make_spec(runtimeKey="big", vramGiB=5))
    assert factory.engines["idle"].shut_down is False
    assert loaded(pool) == ["busy", "idle"]


async def test_a_busy_engine_is_never_evicted_capacity_error_instead() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, budget=6.0)

    async with pool.lease(make_spec(runtimeKey="a", vramGiB=4)):
        with pytest.raises(EngineCapacityError):
            async with pool.lease(make_spec(runtimeKey="b", vramGiB=4)):
                pass

    assert factory.engines["a"].shut_down is False
    assert "b" not in factory.builds


async def test_the_count_bound_still_applies_under_the_gib_budget() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, budget=100.0, max_resident=1)
    await pool.warm(make_spec(runtimeKey="a", vramGiB=1))
    await pool.warm(make_spec(runtimeKey="b", vramGiB=1))
    assert loaded(pool) == ["b"]
    assert factory.engines["a"].shut_down is True


async def test_a_loading_engine_counts_against_the_budget() -> None:
    factory = FakeEngineFactory(build_delay_s=0.05)
    pool = make_pool(factory, budget=6.0)
    first = asyncio.create_task(pool.warm(make_spec(runtimeKey="a", vramGiB=4)))
    await asyncio.sleep(0.01)
    with pytest.raises(EngineCapacityError):  # a is loading, not idle — not evictable
        await pool.warm(make_spec(runtimeKey="b", vramGiB=4))
    await first


async def test_a_spec_bigger_than_the_whole_budget_is_refused_by_name() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, budget=6.0)
    await pool.warm(make_spec(runtimeKey="small", vramGiB=1))

    with pytest.raises(EngineBuildRefused) as caught:
        await pool.warm(make_spec(runtimeKey="huge", vramGiB=7))

    assert caught.value.code == "VRAM_BUDGET_EXCEEDED"
    assert factory.builds == ["small"]
    assert factory.engines["small"].shut_down is False  # nothing evicted for a hopeless ask


async def test_the_pool_config_is_read_at_every_admission() -> None:
    """`vllm.pools` is a control-plane knob: a change applies without a restart."""
    current = {"value": config(budget=3.0)}
    factory = FakeEngineFactory()
    pool = EnginePool(factory, pool_config=lambda: current["value"])
    await pool.warm(make_spec(runtimeKey="a", vramGiB=3))

    current["value"] = config(budget=6.0)  # the platform admin raised it
    await pool.warm(make_spec(runtimeKey="b", vramGiB=3))
    assert loaded(pool) == ["a", "b"]

    current["value"] = config(budget=3.0)
    await pool.warm(make_spec(runtimeKey="c", vramGiB=3))
    assert loaded(pool) == ["c"]


# ── kinds ───────────────────────────────────────────────────────────────────


async def test_a_kind_the_pool_does_not_accept_is_refused_before_any_load() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, kinds=("asr",))
    with pytest.raises(ModelNotServable) as caught:
        async with pool.lease(make_spec(kind="llm")):
            pass
    assert caught.value.reason == "KIND_NOT_ACCEPTED"
    assert factory.builds == []


async def test_a_resident_engine_of_a_kind_no_longer_accepted_is_refused_too() -> None:
    current = {"value": config(kinds=("asr", "llm"))}
    pool = EnginePool(FakeEngineFactory(), pool_config=lambda: current["value"])
    await pool.warm(make_spec(kind="llm"))
    current["value"] = config(kinds=("asr",))
    with pytest.raises(ModelNotServable):
        async with pool.lease(make_spec(kind="llm")):
            pass


# ── pins ────────────────────────────────────────────────────────────────────


async def test_warm_pins_loads_every_pin_resolved_against_the_system_tenant() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory, budget=6.0, pins=("pin-a", "pin-b"))
    asked: list[str] = []

    async def resolve(slug: str) -> ResolvedServingSpec:
        asked.append(slug)
        return make_spec(slug=slug, runtimeKey=f"{slug}:v1", vramGiB=2)

    await pool.warm_pins(resolve)

    assert asked == ["pin-a", "pin-b"]
    assert factory.builds == ["pin-a:v1", "pin-b:v1"]
    assert all(e["pinned"] for e in pool.snapshot()["loaded"])
    assert SYSTEM_TENANT_ID == "00000000-0000-0000-0000-000000000000"


async def test_a_pinned_engine_is_never_evicted() -> None:
    factory, clock = FakeEngineFactory(), Clock()
    pool = make_pool(factory, clock, budget=6.0, pins=("pinned",))

    async def resolve(slug: str) -> ResolvedServingSpec:
        return make_spec(slug=slug, runtimeKey="pinned:v1", vramGiB=3)

    await pool.warm_pins(resolve)
    clock.now += 1
    await pool.warm(make_spec(runtimeKey="a", vramGiB=3))
    clock.now += 1
    # The pin is the LEAST recently used — but pinned, so `a` goes.
    await pool.warm(make_spec(runtimeKey="b", vramGiB=3))
    assert loaded(pool) == ["b", "pinned:v1"]
    assert factory.engines["pinned:v1"].shut_down is False

    # Only the pin is left to evict and it may not be: capacity, not eviction.
    async with pool.lease(make_spec(runtimeKey="b", vramGiB=3)):
        with pytest.raises(EngineCapacityError):
            await pool.warm(make_spec(runtimeKey="c", vramGiB=3))
    assert factory.engines["pinned:v1"].shut_down is False


async def test_no_pins_is_a_no_op() -> None:
    factory = FakeEngineFactory()
    pool = make_pool(factory)

    async def resolve(slug: str) -> ResolvedServingSpec:  # pragma: no cover - never called
        raise AssertionError(slug)

    await pool.warm_pins(resolve)
    assert factory.builds == []
