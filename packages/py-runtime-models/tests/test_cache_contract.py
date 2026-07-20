"""TASK-529 §5 — the cache-contract conformance suite.

Every clause of the AD-4 contract (README "Contract") is one test here. The same
suite is re-instantiated per adopting service against its own wiring, so a
service that composes the shared cache proves the same guarantees.

House constraints: fake clocks only (`time_func`) — no `sleep`; NVML is always
stubbed; any randomness is seeded INSIDE the test body.
"""

from __future__ import annotations

import asyncio

import pytest

from hope_runtime_models import (
    CacheStats,
    ModelCache,
    clamp_cache_ttl_seconds,
)


class FakeClock:
    """Monotonic fake clock; `advance` is the only way time moves."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingFactory:
    """Async factory that counts calls per key and returns a distinct object."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.gate: asyncio.Event | None = None

    async def __call__(self, key: str) -> str:
        self.calls.append(key)
        if self.gate is not None:
            await self.gate.wait()
        return f"instance::{key}::{self.calls.count(key)}"

    def call_count(self, key: str) -> int:
        return self.calls.count(key)


def build_cache(
    factory: RecordingFactory,
    *,
    clock: FakeClock,
    ttl_seconds: int = 600,
    max_size: int = 2,
    **kwargs: object,
) -> ModelCache[str]:
    return ModelCache(
        factory=factory,
        ttl_seconds=ttl_seconds,
        max_size=max_size,
        time_func=clock,
        **kwargs,  # type: ignore[arg-type]
    )


# ── 1. single-flight ────────────────────────────────────────────────────────


async def test_second_request_within_ttl_no_reload() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock)

    first = await cache.get("a")
    clock.advance(10)
    second = await cache.get("a")

    assert first is second
    assert factory.call_count("a") == 1


async def test_single_flight_concurrent_gets_one_load() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    factory.gate = asyncio.Event()
    cache = build_cache(factory, clock=clock)

    waiters = [asyncio.create_task(cache.get("a")) for _ in range(5)]
    await asyncio.sleep(0)  # let them all reach the load
    factory.gate.set()
    results = await asyncio.gather(*waiters)

    assert factory.call_count("a") == 1
    assert len({id(r) for r in results}) == 1


async def test_waiter_cancellation_does_not_cancel_shared_load() -> None:
    """A cancelled waiter must not take the shared load down with it."""
    clock, factory = FakeClock(), RecordingFactory()
    factory.gate = asyncio.Event()
    cache = build_cache(factory, clock=clock)

    owner = asyncio.create_task(cache.get("a"))
    await asyncio.sleep(0)
    waiter = asyncio.create_task(cache.get("a"))
    await asyncio.sleep(0)

    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    factory.gate.set()
    assert await owner == "instance::a::1"
    assert factory.call_count("a") == 1


async def test_load_failure_is_not_cached() -> None:
    clock = FakeClock()
    attempts: list[str] = []

    async def flaky(key: str) -> str:
        attempts.append(key)
        if len(attempts) == 1:
            raise RuntimeError("boom")
        return "ok"

    cache = ModelCache(factory=flaky, ttl_seconds=600, max_size=2, time_func=clock)

    with pytest.raises(RuntimeError):
        await cache.get("a")
    assert await cache.get("a") == "ok"
    assert len(attempts) == 2


# ── 2. TTL / sweep ──────────────────────────────────────────────────────────


async def test_ttl_expiry_sweep_evicts() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    clock.advance(601)

    assert await cache.sweep() == 1
    assert cache.stats().resident_models == 0

    await cache.get("a")
    assert factory.call_count("a") == 2


async def test_sweep_keeps_entries_within_ttl() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    clock.advance(599)

    assert await cache.sweep() == 0
    assert cache.stats().resident_models == 1


async def test_min_residency_floor_blocks_sub_60s_ttl_eviction() -> None:
    """Anti-thrash (§7): never TTL-evict an entry idle < 60 s, whatever the TTL."""
    clock, factory = FakeClock(), RecordingFactory()
    # 30 is below the clamp minimum, so the clamp lifts it to 60 anyway.
    cache = build_cache(factory, clock=clock, ttl_seconds=30)

    await cache.get("a")
    clock.advance(45)
    assert await cache.sweep() == 0

    clock.advance(20)  # 65 s idle — past the 60 s floor
    assert await cache.sweep() == 1


# ── 3. pinning ──────────────────────────────────────────────────────────────


async def test_pinned_survives_ttl_and_lru_pressure() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600, max_size=1)

    await cache.get("pinned")
    await cache.pin("pinned")
    clock.advance(10_000)

    assert await cache.sweep() == 0
    await cache.get("other")  # LRU pressure at max_size=1

    assert "pinned" in cache.cached_keys()
    assert await cache.evict("pinned") is False


async def test_last_unpin_restarts_idle_clock() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    await cache.pin("a")
    await cache.pin("a")
    clock.advance(10_000)

    await cache.unpin("a")
    assert await cache.sweep() == 0, "still pinned once"

    await cache.unpin("a")
    assert await cache.sweep() == 0, "last unpin restarts the idle clock"

    clock.advance(601)
    assert await cache.sweep() == 1


async def test_pins_survive_reload() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600)

    await cache.pin("a")  # pin before the model even exists
    await cache.get("a")
    clock.advance(10_000)

    assert await cache.sweep() == 0
    assert factory.call_count("a") == 1


async def test_clear_ignores_pins() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock)

    await cache.get("a")
    await cache.pin("a")

    assert await cache.clear() == 1
    assert cache.cached_keys() == []


# ── 4. VRAM ─────────────────────────────────────────────────────────────────


async def test_vram_short_evicts_idle_lru_before_load() -> None:
    """NVML is stubbed — a probe reporting shortage evicts idle LRU first."""
    clock, factory = FakeClock(), RecordingFactory()
    free_bytes = [1_000]  # far below the estimate → shortage

    cache = build_cache(
        factory,
        clock=clock,
        max_size=8,
        vram_probe=lambda: free_bytes[0],
        estimate_bytes=lambda _key: 10_000,
    )

    await cache.get("old")
    clock.advance(1)
    await cache.get("new")  # triggers the pre-load VRAM check

    reasons = [e.reason for e in cache.stats().evictions_by_reason]
    assert "vram" in reasons
    assert "old" not in cache.cached_keys()


async def test_vram_probe_absent_falls_back_to_estimates() -> None:
    """No probe (CPU-only host / CI) ⇒ the estimate budget still bounds us."""
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(
        factory,
        clock=clock,
        max_size=8,
        max_bytes_estimate=15_000,
        estimate_bytes=lambda _key: 10_000,
    )

    await cache.get("a")
    clock.advance(1)
    await cache.get("b")  # 20_000 > 15_000 budget → evict "a"

    assert "a" not in cache.cached_keys()
    assert "b" in cache.cached_keys()


async def test_vram_probe_failure_disables_probe_without_failing_load() -> None:
    clock, factory = FakeClock(), RecordingFactory()

    def exploding_probe() -> int:
        raise RuntimeError("nvml gone")

    cache = build_cache(factory, clock=clock, vram_probe=exploding_probe)

    assert await cache.get("a") == "instance::a::1"
    assert cache.stats().vram_probe_enabled is False


# ── 5. clamp ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(30, 60), (7200, 3600), (600, 600), (60, 60), (3600, 3600), (0, 60), (-5, 60)],
)
def test_clamp_bounds(raw: int, expected: int) -> None:
    assert clamp_cache_ttl_seconds(raw) == expected


async def test_cache_applies_clamp_to_constructor_ttl() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=7200)
    assert cache.stats().ttl_seconds == 3600


# ── 6. soft ceiling ─────────────────────────────────────────────────────────


async def test_soft_ceiling_all_pinned_exceeds_max_size_with_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, max_size=1)

    await cache.get("a")
    await cache.pin("a")
    await cache.get("b")
    await cache.pin("b")

    # Deliberate: a model in use is never dropped, so the ceiling is soft.
    assert cache.stats().resident_models == 2
    assert cache.stats().all_pinned_warnings >= 1


# ── 7. hot reconfiguration ──────────────────────────────────────────────────


async def test_configure_applies_new_ttl_without_dropping_residents() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=3600)

    await cache.get("a")
    cache.configure(ttl_seconds=600)

    assert cache.stats().ttl_seconds == 600
    assert cache.cached_keys() == ["a"], "resident entries survive reconfiguration"

    clock.advance(601)
    assert await cache.sweep() == 1


async def test_configure_clamps_and_ignores_none() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600, max_size=2)

    cache.configure(ttl_seconds=7200, max_size=None)
    assert cache.stats().ttl_seconds == 3600
    assert cache.stats().max_size == 2, "None means 'keep the current value'"


async def test_configure_shrinking_max_size_enforced_on_next_access() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, max_size=3)

    await cache.get("a")
    clock.advance(1)
    await cache.get("b")
    cache.configure(max_size=1)

    assert cache.stats().resident_models == 2, "reconfigure never drops residents"
    clock.advance(1)
    await cache.get("c")
    assert cache.stats().resident_models <= 2


# ── 8. unload hook + stats ──────────────────────────────────────────────────


async def test_unload_hook_called_on_evict_and_tolerates_sync_and_async() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    unloaded: list[str] = []

    def sync_unload(key: str, _instance: str) -> None:
        unloaded.append(key)

    cache = build_cache(factory, clock=clock, unload=sync_unload)
    await cache.get("a")
    await cache.evict("a")
    assert unloaded == ["a"]

    async def async_unload(key: str, _instance: str) -> None:
        unloaded.append(f"async::{key}")

    cache2 = build_cache(factory, clock=clock, unload=async_unload)
    await cache2.get("b")
    await cache2.evict("b")
    assert "async::b" in unloaded


async def test_unload_hook_called_when_lru_pressure_evicts() -> None:
    """The whole point of eviction: an implicitly-evicted model IS released."""
    clock, factory = FakeClock(), RecordingFactory()
    unloaded: list[str] = []

    cache = build_cache(
        factory,
        clock=clock,
        max_size=1,
        unload=lambda key, _instance: unloaded.append(key),
    )

    await cache.get("a")
    clock.advance(1)
    await cache.get("b")  # LRU-evicts "a"

    assert unloaded == ["a"]


async def test_unload_hook_called_when_ttl_sweep_evicts() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    unloaded: list[str] = []

    cache = build_cache(
        factory,
        clock=clock,
        ttl_seconds=600,
        unload=lambda key, _instance: unloaded.append(key),
    )

    await cache.get("a")
    clock.advance(601)
    await cache.sweep()

    assert unloaded == ["a"]


async def test_unload_hook_called_when_lazy_ttl_eviction_happens_on_get() -> None:
    """`get()` on an idle-expired entry evicts it — and must release it too."""
    clock, factory = FakeClock(), RecordingFactory()
    unloaded: list[str] = []

    cache = build_cache(
        factory,
        clock=clock,
        ttl_seconds=600,
        unload=lambda key, _instance: unloaded.append(key),
    )

    await cache.get("a")
    clock.advance(601)
    await cache.get("a")  # expired → evict + reload

    assert unloaded == ["a"]
    assert factory.call_count("a") == 2


async def test_unload_failure_never_fails_the_caller() -> None:
    clock, factory = FakeClock(), RecordingFactory()

    def boom(_key: str, _instance: str) -> None:
        raise RuntimeError("unload exploded")

    cache = build_cache(factory, clock=clock, unload=boom)
    await cache.get("a")

    assert await cache.evict("a") is True
    assert cache.cached_keys() == []


async def test_stats_reports_hits_misses_and_eviction_reasons() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    cache = build_cache(factory, clock=clock, ttl_seconds=600, max_size=1)

    await cache.get("a")  # miss
    await cache.get("a")  # hit
    clock.advance(1)
    await cache.get("b")  # miss + LRU eviction of "a"

    stats = cache.stats()
    assert isinstance(stats, CacheStats)
    assert stats.hits == 1
    assert stats.misses == 2
    assert stats.loads == 2
    assert {e.reason for e in stats.evictions_by_reason} == {"lru"}


async def test_metrics_sink_receives_load_and_eviction_events() -> None:
    clock, factory = FakeClock(), RecordingFactory()
    events: list[tuple[str, str]] = []

    class Sink:
        def on_load(self, name: str, key: str) -> None:
            events.append(("load", key))

        def on_evict(self, name: str, key: str, reason: str) -> None:
            events.append((f"evict:{reason}", key))

        def on_resident(self, name: str, count: int, bytes_estimate: int) -> None:
            pass

    cache = build_cache(factory, clock=clock, ttl_seconds=600, max_size=1, metrics=Sink())
    await cache.get("a")
    clock.advance(1)
    await cache.get("b")

    assert ("load", "a") in events
    assert ("evict:lru", "a") in events
