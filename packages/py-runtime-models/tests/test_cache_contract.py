"""The cache-contract conformance suite.

Every clause of the shared cache contract (README "Contract") is one test here.
The same suite is re-instantiated per adopting service against its own wiring,
so a service that composes the shared cache proves the same guarantees.

A second concurrency skin — `SyncModelCache` — exists for consumers
that are genuinely synchronous (the harness MiniCheck entailer). Policy is
shared; only the concurrency primitive differs. Every policy clause below is
therefore parameterized over BOTH cache classes, so the two cannot drift.

House constraints: fake clocks only (`time_func`) — no `sleep`; NVML is always
stubbed; any randomness is seeded INSIDE the test body. The one exception is the
sync single-flight clause, which needs real threads — it synchronizes on
`threading.Event`, never on timing.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import threading
from collections import Counter
from typing import Any

import pytest

from hope_runtime_models import (
    CacheStats,
    ModelCache,
    SyncModelCache,
    clamp_cache_ttl_seconds,
)

CACHE_KINDS = ("async", "sync")


class FakeClock:
    """Monotonic fake clock; `advance` is the only way time moves."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class AsyncRecordingFactory:
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


class SyncRecordingFactory:
    """Blocking factory that counts calls per key and returns a distinct object."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.gate: threading.Event | None = None
        self._mutex = threading.Lock()

    def __call__(self, key: str) -> str:
        with self._mutex:
            self.calls.append(key)
            nth = self.calls.count(key)
        if self.gate is not None:
            self.gate.wait()
        return f"instance::{key}::{nth}"

    def call_count(self, key: str) -> int:
        return self.calls.count(key)


async def _resolve(value: Any) -> Any:
    """Await `value` when the cache under test is the async one."""
    return await value if inspect.isawaitable(value) else value


class CacheUnderTest:
    """Uniform async facade over both cache classes, so one clause covers both."""

    def __init__(self, cache: Any) -> None:
        self.raw = cache

    async def get(self, key: str) -> Any:
        return await _resolve(self.raw.get(key))

    async def pin(self, key: str) -> None:
        await _resolve(self.raw.pin(key))

    async def unpin(self, key: str) -> None:
        await _resolve(self.raw.unpin(key))

    async def evict(self, key: str) -> bool:
        return await _resolve(self.raw.evict(key))

    async def sweep(self) -> int:
        return await _resolve(self.raw.sweep())

    async def clear(self) -> int:
        return await _resolve(self.raw.clear())

    def stats(self) -> CacheStats:
        return self.raw.stats()

    def cached_keys(self) -> list[str]:
        return self.raw.cached_keys()

    def configure(self, **kwargs: Any) -> None:
        self.raw.configure(**kwargs)


@pytest.fixture(params=CACHE_KINDS)
def kind(request: pytest.FixtureRequest) -> str:
    return str(request.param)


def make_factory(kind: str) -> Any:
    return AsyncRecordingFactory() if kind == "async" else SyncRecordingFactory()


def build_cache(
    kind: str,
    factory: Any,
    *,
    clock: FakeClock,
    ttl_seconds: int = 600,
    max_size: int = 2,
    **kwargs: Any,
) -> CacheUnderTest:
    cls = ModelCache if kind == "async" else SyncModelCache
    return CacheUnderTest(
        cls(
            factory=factory,
            ttl_seconds=ttl_seconds,
            max_size=max_size,
            time_func=clock,
            **kwargs,
        )
    )


# ── 1. single-flight ────────────────────────────────────────────────────────


async def test_second_request_within_ttl_no_reload(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock)

    first = await cache.get("a")
    clock.advance(10)
    second = await cache.get("a")

    assert first is second
    assert factory.call_count("a") == 1


async def test_single_flight_concurrent_gets_one_load() -> None:
    clock, factory = FakeClock(), AsyncRecordingFactory()
    factory.gate = asyncio.Event()
    cache = build_cache("async", factory, clock=clock)

    waiters = [asyncio.create_task(cache.get("a")) for _ in range(5)]
    await asyncio.sleep(0)  # let them all reach the load
    factory.gate.set()
    results = await asyncio.gather(*waiters)

    assert factory.call_count("a") == 1
    assert len({id(r) for r in results}) == 1


def test_sync_single_flight_concurrent_gets_one_load() -> None:
    """Real threads: N concurrent `get`s for one key ⇒ exactly one factory call.

    Synchronization is on `threading.Event` only — no sleeps, no timing races.
    """
    clock, factory = FakeClock(), SyncRecordingFactory()
    factory.gate = threading.Event()
    cache = SyncModelCache(factory=factory, ttl_seconds=600, max_size=2, time_func=clock)

    entered = threading.Event()
    results: list[str] = []
    results_lock = threading.Lock()

    def worker() -> None:
        entered.set()
        value = cache.get("a")
        with results_lock:
            results.append(value)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for thread in threads:
        thread.start()
    entered.wait(timeout=5)
    factory.gate.set()  # release the one owning load
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive(), "sync single-flight deadlocked"

    assert factory.call_count("a") == 1
    assert len(results) == 5
    assert len({id(r) for r in results}) == 1


async def test_waiter_cancellation_does_not_cancel_shared_load() -> None:
    """A cancelled waiter must not take the shared load down with it."""
    clock, factory = FakeClock(), AsyncRecordingFactory()
    factory.gate = asyncio.Event()
    cache = build_cache("async", factory, clock=clock)

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


async def test_load_failure_is_not_cached(kind: str) -> None:
    clock = FakeClock()
    attempts: list[str] = []

    def _flaky_body(key: str) -> str:
        attempts.append(key)
        if len(attempts) == 1:
            raise RuntimeError("boom")
        return "ok"

    async def flaky_async(key: str) -> str:
        return _flaky_body(key)

    factory = flaky_async if kind == "async" else _flaky_body
    cls = ModelCache if kind == "async" else SyncModelCache
    cache = CacheUnderTest(cls(factory=factory, ttl_seconds=600, max_size=2, time_func=clock))

    with pytest.raises(RuntimeError):
        await cache.get("a")
    assert await cache.get("a") == "ok"
    assert len(attempts) == 2


def test_sync_factory_failure_not_cached_and_propagates_to_waiters() -> None:
    """The owning sync load fails ⇒ every waiter sees it, and the next get retries."""
    clock = FakeClock()
    attempts: list[str] = []
    release = threading.Event()

    def flaky(key: str) -> str:
        attempts.append(key)
        if len(attempts) <= 1:
            release.wait(timeout=5)
            raise RuntimeError("boom")
        return "ok"

    cache = SyncModelCache(factory=flaky, ttl_seconds=600, max_size=2, time_func=clock)

    errors: list[BaseException] = []
    started = threading.Event()

    def waiter() -> None:
        started.set()
        try:
            cache.get("a")
        except BaseException as exc:  # noqa: BLE001 — the point of the test
            errors.append(exc)

    threads = [threading.Thread(target=waiter) for _ in range(3)]
    for thread in threads:
        thread.start()
    started.wait(timeout=5)
    release.set()
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()

    assert len(errors) == 3
    assert all(isinstance(e, RuntimeError) for e in errors)
    assert cache.get("a") == "ok", "failure was not cached — the retry loads"


# ── 2. TTL / sweep ──────────────────────────────────────────────────────────


async def test_ttl_expiry_sweep_evicts(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    clock.advance(601)

    assert await cache.sweep() == 1
    assert cache.stats().resident_models == 0

    await cache.get("a")
    assert factory.call_count("a") == 2


async def test_sweep_keeps_entries_within_ttl(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    clock.advance(599)

    assert await cache.sweep() == 0
    assert cache.stats().resident_models == 1


async def test_min_residency_floor_blocks_sub_60s_ttl_eviction(kind: str) -> None:
    """Anti-thrash: never TTL-evict an entry idle < 60 s, whatever the TTL."""
    clock, factory = FakeClock(), make_factory(kind)
    # 30 is below the clamp minimum, so the clamp lifts it to 60 anyway.
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=30)

    await cache.get("a")
    clock.advance(45)
    assert await cache.sweep() == 0

    clock.advance(20)  # 65 s idle — past the 60 s floor
    assert await cache.sweep() == 1


# ── 3. pinning ──────────────────────────────────────────────────────────────


async def test_pinned_survives_ttl_and_lru_pressure(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600, max_size=1)

    await cache.get("pinned")
    await cache.pin("pinned")
    clock.advance(10_000)

    assert await cache.sweep() == 0
    await cache.get("other")  # LRU pressure at max_size=1

    assert "pinned" in cache.cached_keys()
    assert await cache.evict("pinned") is False


async def test_last_unpin_restarts_idle_clock(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600)

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


async def test_pins_survive_reload(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600)

    await cache.pin("a")  # pin before the model even exists
    await cache.get("a")
    clock.advance(10_000)

    assert await cache.sweep() == 0
    assert factory.call_count("a") == 1


async def test_clear_ignores_pins(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock)

    await cache.get("a")
    await cache.pin("a")

    assert await cache.clear() == 1
    assert cache.cached_keys() == []


async def test_pin_many_and_unpin_many_skip_blanks(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600)

    await cache.get("a")
    await _resolve(cache.raw.pin_many(["a", ""]))
    clock.advance(10_000)
    assert await cache.sweep() == 0

    await _resolve(cache.raw.unpin_many(["a", ""]))
    clock.advance(601)
    assert await cache.sweep() == 1


# ── 4. VRAM ─────────────────────────────────────────────────────────────────


async def test_vram_short_evicts_idle_lru_before_load(kind: str) -> None:
    """NVML is stubbed — a probe reporting shortage evicts idle LRU first."""
    clock, factory = FakeClock(), make_factory(kind)
    free_bytes = [1_000]  # far below the estimate → shortage

    cache = build_cache(
        kind,
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


async def test_vram_probe_absent_falls_back_to_estimates(kind: str) -> None:
    """No probe (CPU-only host / CI) ⇒ the estimate budget still bounds us."""
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(
        kind,
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


async def test_vram_probe_failure_disables_probe_without_failing_load(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)

    def exploding_probe() -> int:
        raise RuntimeError("nvml gone")

    cache = build_cache(kind, factory, clock=clock, vram_probe=exploding_probe)

    assert await cache.get("a") == "instance::a::1"
    assert cache.stats().vram_probe_enabled is False


# ── 5. clamp ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(30, 60), (7200, 3600), (600, 600), (60, 60), (3600, 3600), (0, 60), (-5, 60)],
)
def test_clamp_bounds(raw: int, expected: int) -> None:
    assert clamp_cache_ttl_seconds(raw) == expected


async def test_cache_applies_clamp_to_constructor_ttl(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=7200)
    assert cache.stats().ttl_seconds == 3600


# ── 6. soft ceiling ─────────────────────────────────────────────────────────


async def test_soft_ceiling_all_pinned_exceeds_max_size_with_warning(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, max_size=1)

    await cache.get("a")
    await cache.pin("a")
    await cache.get("b")
    await cache.pin("b")

    # Deliberate: a model in use is never dropped, so the ceiling is soft.
    assert cache.stats().resident_models == 2
    assert cache.stats().all_pinned_warnings >= 1


# ── 7. hot reconfiguration ──────────────────────────────────────────────────


async def test_configure_applies_new_ttl_without_dropping_residents(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=3600)

    await cache.get("a")
    cache.configure(ttl_seconds=600)

    assert cache.stats().ttl_seconds == 600
    assert cache.cached_keys() == ["a"], "resident entries survive reconfiguration"

    clock.advance(601)
    assert await cache.sweep() == 1


async def test_configure_clamps_and_ignores_none(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600, max_size=2)

    cache.configure(ttl_seconds=7200, max_size=None)
    assert cache.stats().ttl_seconds == 3600
    assert cache.stats().max_size == 2, "None means 'keep the current value'"


async def test_configure_shrinking_max_size_enforced_on_next_access(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, max_size=3)

    await cache.get("a")
    clock.advance(1)
    await cache.get("b")
    cache.configure(max_size=1)

    assert cache.stats().resident_models == 2, "reconfigure never drops residents"
    clock.advance(1)
    await cache.get("c")
    assert cache.stats().resident_models <= 2


# ── 8. unload hook + stats ──────────────────────────────────────────────────


async def test_unload_hook_called_on_evict_and_tolerates_sync_and_async(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    unloaded: list[str] = []

    def sync_unload(key: str, _instance: str) -> None:
        unloaded.append(key)

    cache = build_cache(kind, factory, clock=clock, unload=sync_unload)
    await cache.get("a")
    await cache.evict("a")
    assert unloaded == ["a"]

    if kind == "async":
        # Only the asyncio cache can await an unload hook; the sync sibling has
        # no loop to await on, which is exactly why it is a sibling.
        async def async_unload(key: str, _instance: str) -> None:
            unloaded.append(f"async::{key}")

        cache2 = build_cache(kind, factory, clock=clock, unload=async_unload)
        await cache2.get("b")
        await cache2.evict("b")
        assert "async::b" in unloaded


async def test_unload_hook_called_when_lru_pressure_evicts(kind: str) -> None:
    """The whole point of eviction: an implicitly-evicted model IS released."""
    clock, factory = FakeClock(), make_factory(kind)
    unloaded: list[str] = []

    cache = build_cache(
        kind,
        factory,
        clock=clock,
        max_size=1,
        unload=lambda key, _instance: unloaded.append(key),
    )

    await cache.get("a")
    clock.advance(1)
    await cache.get("b")  # LRU-evicts "a"

    assert unloaded == ["a"]


async def test_unload_hook_called_when_ttl_sweep_evicts(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    unloaded: list[str] = []

    cache = build_cache(
        kind,
        factory,
        clock=clock,
        ttl_seconds=600,
        unload=lambda key, _instance: unloaded.append(key),
    )

    await cache.get("a")
    clock.advance(601)
    await cache.sweep()

    assert unloaded == ["a"]


async def test_unload_hook_called_when_lazy_ttl_eviction_happens_on_get(kind: str) -> None:
    """`get()` on an idle-expired entry evicts it — and must release it too."""
    clock, factory = FakeClock(), make_factory(kind)
    unloaded: list[str] = []

    cache = build_cache(
        kind,
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


async def test_unload_failure_never_fails_the_caller(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)

    def boom(_key: str, _instance: str) -> None:
        raise RuntimeError("unload exploded")

    cache = build_cache(kind, factory, clock=clock, unload=boom)
    await cache.get("a")

    assert await cache.evict("a") is True
    assert cache.cached_keys() == []


# ── every eviction path releases the weights, exactly once ──────────────────

#: The six ways an entry can leave either cache. TDD here caught TWO real
#: defects (lru-overflow and lazy-TTL evicted WITHOUT calling `unload`, so
#: the weights were never freed and the byte budget silently stopped meaning
#: anything). This clause generalizes those spot fixes: a future eviction path
#: cannot regress the guarantee by construction.
EVICTION_PATHS = (
    "explicit_evict",
    "ttl_lazy",
    "ttl_sweep",
    "lru_overflow",
    "vram_pressure",
    "clear",
)


@pytest.mark.parametrize("path", EVICTION_PATHS)
async def test_unload_called_exactly_once_per_eviction_path(kind: str, path: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    unloaded: list[str] = []
    extra: dict[str, Any] = {}

    if path == "lru_overflow":
        extra["max_size"] = 1
    elif path == "vram_pressure":
        extra["max_size"] = 8
        extra["vram_probe"] = lambda: 1_000
        extra["estimate_bytes"] = lambda _key: 10_000

    cache = build_cache(
        kind,
        factory,
        clock=clock,
        ttl_seconds=600,
        unload=lambda key, _instance: unloaded.append(key),
        **extra,
    )

    await cache.get("a")

    if path == "explicit_evict":
        assert await cache.evict("a") is True
    elif path == "ttl_lazy":
        clock.advance(601)
        await cache.get("a")  # expired → evict + reload
    elif path == "ttl_sweep":
        clock.advance(601)
        assert await cache.sweep() == 1
    elif path in ("lru_overflow", "vram_pressure"):
        clock.advance(1)
        await cache.get("b")
    elif path == "clear":
        assert await cache.clear() == 1

    counts = Counter(unloaded)
    assert counts["a"] == 1, f"{path}/{kind}: unload ran {counts['a']}× for the evicted key"
    assert set(counts) == {"a"}, f"{path}/{kind}: unloaded unexpected keys {set(counts)}"
    assert "a" not in cache.cached_keys() or path == "ttl_lazy"


async def test_stats_reports_hits_misses_and_eviction_reasons(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600, max_size=1)

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


async def test_stats_shape_identical_across_cache_classes() -> None:
    """One dashboard, two classes — the snapshot must be field-for-field equal."""
    snapshots: dict[str, dict[str, Any]] = {}

    for cache_kind in CACHE_KINDS:
        clock, factory = FakeClock(), make_factory(cache_kind)
        cache = build_cache(cache_kind, factory, clock=clock, ttl_seconds=600, max_size=1)
        await cache.get("a")
        await cache.get("a")
        clock.advance(1)
        await cache.get("b")
        stats = cache.stats()
        assert type(stats) is CacheStats
        snapshots[cache_kind] = dataclasses.asdict(stats)

    assert snapshots["async"] == snapshots["sync"]


async def test_metrics_sink_receives_load_and_eviction_events(kind: str) -> None:
    clock, factory = FakeClock(), make_factory(kind)
    events: list[tuple[str, str]] = []

    class Sink:
        def on_load(self, name: str, key: str) -> None:
            events.append(("load", key))

        def on_evict(self, name: str, key: str, reason: str) -> None:
            events.append((f"evict:{reason}", key))

        def on_resident(self, name: str, count: int, bytes_estimate: int) -> None:
            pass

    cache = build_cache(kind, factory, clock=clock, ttl_seconds=600, max_size=1, metrics=Sink())
    await cache.get("a")
    clock.advance(1)
    await cache.get("b")

    assert ("load", "a") in events
    assert ("evict:lru", "a") in events
