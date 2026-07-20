"""TASK-529 AD-4 — the one model-lifecycle cache shared by every HOPE service.

Converges the three structurally identical caches that existed before this
ticket (stt-v2 `models/cache.py`, guardrail `services/model_cache.py`, nlp
`services/model_cache.py`) into a single generic implementation. The union of
their behaviour is preserved deliberately, including the "soft ceiling under
all-pinned load" quirk — that is a product decision (never drop a model that is
serving a request), not a bug to fix.

TASK-530 (R1) added a second concurrency skin. There are now TWO cache classes:

* :class:`ModelCache` — asyncio (``asyncio.Lock`` + in-flight ``Future``), for
  the FastAPI services.
* :class:`SyncModelCache` — threads (``threading.Lock`` + in-flight ``Event``),
  for genuinely synchronous consumers. The harness MiniCheck entailer is one:
  ``llama_cpp.Llama`` construction is a blocking CPU/GPU call, not I/O awaiting
  a socket, and its sole call site (``_atomic_fact_entailer``) is a plain ``def``.

**Policy is shared; only the concurrency primitive differs.** Both classes derive
from :class:`_CacheCore`, which owns the entire policy engine — the ttl → lru →
vram ordering, the pin refcounts, the all-pinned soft ceiling, the eviction
reason labels, :class:`CacheStats`. Neither class carries a copy of it, so the
two cannot drift.

What is NOT here, on purpose: the stt-v2 format→loader map, the tts pipeline
handles, the harness llama handle. Those are service concerns injected as
``factory`` / ``unload`` callables. Contract, not framework.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, Protocol, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Product policy: idle TTL ∈ [60s, 3600s]. Enforced here AND registry-side
# (defense in depth) — a bad control-plane value must not be able to push a
# cache outside its supported window.
_TTL_MIN_SECONDS = 60
_TTL_MAX_SECONDS = 3600

#: Eviction reason labels. Fixed contract — the Prometheus
#: `model_cache_evictions_total{reason=…}` label set and the Grafana dashboard
#: both depend on exactly these three values.
EVICTION_REASONS = ("ttl", "lru", "vram")


def clamp_cache_ttl_seconds(ttl_seconds: int) -> int:
    """Clamp idle TTL to the product window [60, 3600]."""
    return max(_TTL_MIN_SECONDS, min(_TTL_MAX_SECONDS, int(ttl_seconds)))


class ModelUnavailableError(RuntimeError):
    """A required model could not be resolved/loaded (fail-closed → HTTP 503)."""


class MetricsSink(Protocol):
    """What the cache reports. Implemented per service over its own registry."""

    def on_load(self, name: str, key: str) -> None: ...

    def on_evict(self, name: str, key: str, reason: str) -> None: ...

    def on_resident(self, name: str, count: int, bytes_estimate: int) -> None: ...


@dataclass
class EvictionCount:
    """Evictions observed for one reason label."""

    reason: str
    count: int


@dataclass
class CacheStats:
    """A snapshot of cache state — the source for both metrics and `/health`."""

    name: str
    resident_models: int
    resident_bytes_estimate: int
    max_size: int
    max_bytes_estimate: int | None
    ttl_seconds: int
    hits: int
    misses: int
    loads: int
    evictions: int
    evictions_by_reason: list[EvictionCount]
    all_pinned_warnings: int
    vram_probe_enabled: bool
    keys: list[str] = field(default_factory=list)

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total > 0 else 0.0


@dataclass
class _Entry(Generic[T]):
    """A resident instance plus its idle-TTL / pin / size bookkeeping."""

    instance: T
    last_accessed: float
    bytes_estimate: int = 0
    pin_count: int = 0


class _CacheCore(Generic[T]):
    """The policy engine both cache classes share — no locking, no I/O.

    Every method suffixed ``_locked`` assumes the CALLER holds whichever lock its
    concrete subclass uses, and returns evicted ``(key, instance)`` pairs rather
    than unloading them: unload hooks may block, await, or touch the GPU, so they
    always run outside the lock.

    Eviction order under pressure is always **ttl → lru → vram** (§3.1 clause 2).
    """

    def __init__(
        self,
        *,
        factory: Any,
        ttl_seconds: int,
        max_size: int,
        unload: Callable[[str, T], Any] | None = None,
        max_bytes_estimate: int | None = None,
        estimate_bytes: Callable[[str], int] | None = None,
        time_func: Callable[[], float] = time.monotonic,
        metrics: MetricsSink | None = None,
        vram_probe: Callable[[], int] | None = None,
        vram_headroom_bytes: int = 0,
        name: str = "model_cache",
    ) -> None:
        self._factory = factory
        self._unload = unload
        self._ttl_seconds = clamp_cache_ttl_seconds(ttl_seconds)
        self._max_size = max_size
        self._max_bytes_estimate = max_bytes_estimate
        self._estimate_bytes = estimate_bytes
        self._time = time_func
        self._metrics = metrics
        self._vram_probe = vram_probe
        self._vram_headroom_bytes = vram_headroom_bytes
        self._name = name

        self._entries: OrderedDict[str, _Entry[T]] = OrderedDict()
        # key → pin refcount. Kept OUTSIDE `_entries` so a pin survives a brief
        # cache miss during reload (behaviour inherited from all three caches).
        self._pins: dict[str, int] = {}

        self._hits = 0
        self._misses = 0
        self._loads = 0
        self._all_pinned_warnings = 0
        self._evictions: dict[str, int] = {reason: 0 for reason in EVICTION_REASONS}
        #: Flipped off permanently the first time the probe raises (§3.4).
        self._vram_probe_enabled = vram_probe is not None

    # ── introspection ───────────────────────────────────────────────────────

    def cached_keys(self) -> list[str]:
        """Resident keys, least → most recently used (tests / introspection)."""
        return list(self._entries)

    def stats(self) -> CacheStats:
        return CacheStats(
            name=self._name,
            resident_models=len(self._entries),
            resident_bytes_estimate=self._resident_bytes(),
            max_size=self._max_size,
            max_bytes_estimate=self._max_bytes_estimate,
            ttl_seconds=self._ttl_seconds,
            hits=self._hits,
            misses=self._misses,
            loads=self._loads,
            evictions=sum(self._evictions.values()),
            evictions_by_reason=[
                EvictionCount(reason=reason, count=count)
                for reason, count in self._evictions.items()
                if count
            ],
            all_pinned_warnings=self._all_pinned_warnings,
            vram_probe_enabled=self._vram_probe_enabled,
            keys=list(self._entries),
        )

    def configure(
        self,
        *,
        ttl_seconds: int | None = None,
        max_size: int | None = None,
        max_bytes_estimate: int | None = None,
    ) -> None:
        """Adopt new (clamped) limits WITHOUT dropping resident entries.

        An absent/None argument keeps the current value — so a control-plane
        outage that yields a partial payload leaves behaviour unchanged rather
        than resetting knobs to defaults. New limits are enforced by the next
        sweep or access, never by an immediate purge (a mid-request model must
        not vanish because an admin moved a slider).
        """
        if ttl_seconds is not None:
            self._ttl_seconds = clamp_cache_ttl_seconds(ttl_seconds)
        if max_size is not None and max_size > 0:
            self._max_size = max_size
        if max_bytes_estimate is not None and max_bytes_estimate > 0:
            self._max_bytes_estimate = max_bytes_estimate

    # ── lookup / admission ──────────────────────────────────────────────────

    def _lookup_locked(self, key: str) -> tuple[T | None, list[tuple[str, T]]]:
        """Cache lookup + lazy TTL eviction. Caller MUST hold the lock.

        Returns ``(hit_or_None, victims)``. Victims are handed back rather than
        unloaded here because unload hooks may block or await, and this runs
        under the lock.
        """
        entry = self._entries.get(key)
        if entry is None:
            self._misses += 1
            return None, []

        pin_count = self._pins.get(key, 0)
        entry.pin_count = pin_count
        idle = self._time() - entry.last_accessed

        if pin_count == 0 and idle > self._idle_limit():
            victims = self._evict_locked(key, reason="ttl")
            self._misses += 1
            return None, victims

        self._entries.move_to_end(key)
        entry.last_accessed = self._time()
        self._hits += 1
        return entry.instance, []

    def _admit_locked(self, key: str, instance: T) -> tuple[list[tuple[str, T]], int, int]:
        """Install a freshly-loaded instance. Returns (victims, resident, bytes)."""
        self._entries[key] = _Entry(
            instance=instance,
            last_accessed=self._time(),
            bytes_estimate=self._estimate_for(key),
            pin_count=self._pins.get(key, 0),
        )
        self._loads += 1
        victims = self._enforce_size_locked()
        return victims, len(self._entries), self._resident_bytes()

    def _report_load(self, key: str, resident: int, resident_bytes: int) -> None:
        if self._metrics is not None:
            self._metrics.on_load(self._name, key)
            self._metrics.on_resident(self._name, resident, resident_bytes)

    # ── pinning ─────────────────────────────────────────────────────────────

    def _pin_locked(self, key: str) -> None:
        self._pins[key] = self._pins.get(key, 0) + 1
        entry = self._entries.get(key)
        if entry is not None:
            entry.pin_count = self._pins[key]

    def _unpin_locked(self, key: str) -> None:
        current = self._pins.get(key, 0)
        if current <= 1:
            self._pins.pop(key, None)
            new_count = 0
        else:
            new_count = current - 1
            self._pins[key] = new_count

        entry = self._entries.get(key)
        if entry is not None:
            entry.pin_count = new_count
            if new_count == 0:
                entry.last_accessed = self._time()

    # ── explicit eviction / teardown ────────────────────────────────────────

    def _evict_request_locked(self, key: str) -> list[tuple[str, T]]:
        """Body of the public `evict`: refuses pinned entries."""
        if self._pins.get(key, 0) > 0:
            logger.info("%s.refusing_to_evict_pinned key=%s", self._name, key)
            return []
        return self._evict_locked(key, reason="lru")

    def _sweep_locked(self) -> tuple[list[tuple[str, T]], int, int]:
        """Body of the public `sweep`. Returns (victims, resident, bytes)."""
        limit = self._idle_limit()
        now = self._time()
        expired = [
            key
            for key, entry in self._entries.items()
            if self._pins.get(key, 0) == 0 and (now - entry.last_accessed) > limit
        ]
        victims: list[tuple[str, T]] = []
        for key in expired:
            victims.extend(self._evict_locked(key, reason="ttl"))
        return victims, len(self._entries), self._resident_bytes()

    def _clear_locked(self) -> list[tuple[str, T]]:
        """Body of the public `clear`: evicts everything, pins included."""
        victims: list[tuple[str, T]] = []
        for key in list(self._entries):
            self._pins.pop(key, None)
            victims.extend(self._evict_locked(key, reason="lru"))
        return victims

    # ── pressure relief ─────────────────────────────────────────────────────

    def _idle_limit(self) -> float:
        """Effective idle limit — never below the 60 s min-residency floor.

        Anti-thrash guard (§7): with a small TTL and a small `max_size`, bursty
        traffic could otherwise cycle load/evict on every request.
        """
        return max(self._ttl_seconds, _TTL_MIN_SECONDS)

    def _make_room_locked(self, incoming_key: str) -> list[tuple[str, T]]:
        """Pre-load pressure relief: ttl → lru → vram. Caller holds the lock.

        Returns the evicted (key, instance) pairs so the CALLER can run their
        unload hooks after releasing the lock.
        """
        victims: list[tuple[str, T]] = []

        # 1. ttl — expired idle entries are free wins, take them first.
        now, limit = self._time(), self._idle_limit()
        for key in [
            key
            for key, entry in self._entries.items()
            if self._pins.get(key, 0) == 0 and (now - entry.last_accessed) > limit
        ]:
            victims.extend(self._evict_locked(key, reason="ttl"))

        # 2. lru — the estimate-budget path (also the CPU-only / no-NVML path).
        incoming_bytes = self._estimate_for(incoming_key)
        if self._max_bytes_estimate is not None:
            while (
                self._entries
                and self._resident_bytes() + incoming_bytes > self._max_bytes_estimate
            ):
                victim = self._pick_lru_victim_locked(exclude=incoming_key)
                if victim is None:
                    break
                victims.extend(self._evict_locked(victim, reason="lru"))

        # 3. vram — only when a live probe reports an actual shortage.
        free = self._probe_vram()
        if free is not None and incoming_bytes > 0:
            while free < incoming_bytes + self._vram_headroom_bytes:
                victim = self._pick_lru_victim_locked(exclude=incoming_key)
                if victim is None:
                    # Nothing evictable left: proceed and let the load fail
                    # loudly (503) rather than silently skipping the request.
                    break
                victims.extend(self._evict_locked(victim, reason="vram"))
                refreshed = self._probe_vram()
                if refreshed is None or refreshed <= free:
                    # A stubbed/steady probe would spin forever otherwise.
                    break
                free = refreshed

        return victims

    def _enforce_size_locked(self) -> list[tuple[str, T]]:
        """Trim to ``max_size``, keeping the newest entry. Caller holds the lock.

        Returns evicted (key, instance) pairs for out-of-lock unloading.
        """
        victims: list[tuple[str, T]] = []
        while len(self._entries) > self._max_size:
            newest = next(reversed(self._entries))
            victim = self._pick_lru_victim_locked(exclude=newest)
            if victim is None:
                # Soft ceiling (§3.1 clause 4): exceeding max_size beats dropping
                # a model that is currently serving a request.
                self._all_pinned_warnings += 1
                logger.warning(
                    "%s.all_pinned_cannot_evict resident=%d max_size=%d",
                    self._name,
                    len(self._entries),
                    self._max_size,
                )
                return victims
            victims.extend(self._evict_locked(victim, reason="lru"))
        return victims

    def _pick_lru_victim_locked(self, *, exclude: str | None = None) -> str | None:
        """Least-recently-used UNPINNED key, or None when nothing is evictable."""
        for key in self._entries:
            if key == exclude or self._pins.get(key, 0) > 0:
                continue
            return key
        return None

    def _evict_locked(self, key: str, *, reason: str) -> list[tuple[str, T]]:
        """Drop ``key`` and return its (key, instance) for out-of-lock unloading.

        Returning the instance is the ONLY way an evicted model's weights ever
        get released, so every eviction path routes through here and every caller
        must hand the result to its unload runner (R4).
        """
        entry = self._entries.pop(key, None)
        if entry is None:
            return []

        self._evictions[reason] = self._evictions.get(reason, 0) + 1
        logger.info("%s.evicted key=%s reason=%s", self._name, key, reason)
        if self._metrics is not None:
            self._metrics.on_evict(self._name, key, reason)
        return [(key, entry.instance)]

    # ── sizing helpers ──────────────────────────────────────────────────────

    def _estimate_for(self, key: str) -> int:
        if self._estimate_bytes is None:
            return 0
        try:
            return max(0, int(self._estimate_bytes(key)))
        except Exception:
            logger.warning("%s.estimate_failed key=%s", self._name, key, exc_info=True)
            return 0

    def _resident_bytes(self) -> int:
        return sum(entry.bytes_estimate for entry in self._entries.values())

    def _probe_vram(self) -> int | None:
        """Free VRAM in bytes, or None when no probe is available/working.

        Any probe error disables the probe for the life of the process (logged
        once) and the estimates path takes over — CPU-only hosts, absent
        drivers and CI all land here.
        """
        if not self._vram_probe_enabled or self._vram_probe is None:
            return None
        try:
            return int(self._vram_probe())
        except Exception:
            logger.warning("%s.vram_probe_disabled", self._name, exc_info=True)
            self._vram_probe_enabled = False
            return None


class ModelCache(_CacheCore[T]):
    """LRU + idle-TTL + pin cache of lazily-loaded model instances (asyncio)."""

    def __init__(
        self,
        *,
        factory: Callable[[str], Awaitable[T]],
        ttl_seconds: int,
        max_size: int,
        unload: Callable[[str, T], Any] | None = None,
        max_bytes_estimate: int | None = None,
        estimate_bytes: Callable[[str], int] | None = None,
        time_func: Callable[[], float] = time.monotonic,
        metrics: MetricsSink | None = None,
        vram_probe: Callable[[], int] | None = None,
        vram_headroom_bytes: int = 0,
        name: str = "model_cache",
    ) -> None:
        super().__init__(
            factory=factory,
            ttl_seconds=ttl_seconds,
            max_size=max_size,
            unload=unload,
            max_bytes_estimate=max_bytes_estimate,
            estimate_bytes=estimate_bytes,
            time_func=time_func,
            metrics=metrics,
            vram_probe=vram_probe,
            vram_headroom_bytes=vram_headroom_bytes,
            name=name,
        )
        self._lock = asyncio.Lock()
        # key → future of the load in progress (single-flight).
        self._inflight: dict[str, asyncio.Future[T]] = {}

    # ── the load path ───────────────────────────────────────────────────────

    async def get(self, key: str) -> T:
        """Return the instance for ``key``, loading it on miss (single-flight).

        A load failure propagates (routes map it to 503) and is NOT cached, so a
        later request retries. Concurrent callers for the same key share one
        load; a waiter's cancellation cannot cancel it.
        """
        async with self._lock:
            hit, expired = self._lookup_locked(key)
            if hit is not None:
                return hit

            existing = self._inflight.get(key)
            if existing is not None:
                future, is_owner = existing, False
            else:
                future = asyncio.get_running_loop().create_future()
                self._inflight[key] = future
                is_owner = True

        # Release an idle-expired instance found above, outside the lock.
        await self._run_unloads(expired)

        if not is_owner:
            # Shield so one waiter's cancellation cannot cancel the shared load.
            return await asyncio.shield(future)

        try:
            # Pressure is relieved BEFORE the load so the incoming model has
            # room, rather than after it has already been admitted. Unload hooks
            # run OUTSIDE the lock — they may block, await, or touch the GPU.
            async with self._lock:
                victims = self._make_room_locked(key)
            await self._run_unloads(victims)

            instance: T = await self._factory(key)
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
                # Retrieve it so the loop does not log "never retrieved" when
                # no waiter exists.
                future.exception()
            raise
        else:
            await self._admit(key, instance)
            if not future.done():
                future.set_result(instance)
            return instance
        finally:
            async with self._lock:
                self._inflight.pop(key, None)

    async def _admit(self, key: str, instance: T) -> None:
        """Install a freshly-loaded instance and report it."""
        async with self._lock:
            victims, resident, resident_bytes = self._admit_locked(key, instance)

        await self._run_unloads(victims)
        self._report_load(key, resident, resident_bytes)

    # ── pinning ─────────────────────────────────────────────────────────────

    async def pin(self, key: str) -> None:
        """Increment the pin refcount so TTL/LRU/VRAM cannot evict ``key``."""
        async with self._lock:
            self._pin_locked(key)

    async def unpin(self, key: str) -> None:
        """Decrement the pin refcount; the idle clock restarts on the last one."""
        async with self._lock:
            self._unpin_locked(key)

    async def pin_many(self, keys: list[str]) -> None:
        for key in keys:
            if key:
                await self.pin(key)

    async def unpin_many(self, keys: list[str]) -> None:
        for key in keys:
            if key:
                await self.unpin(key)

    # ── explicit eviction / teardown ────────────────────────────────────────

    async def evict(self, key: str) -> bool:
        """Evict ``key``. Refuses pinned entries; returns whether it evicted."""
        async with self._lock:
            victims = self._evict_request_locked(key)
        await self._run_unloads(victims)
        return bool(victims)

    async def sweep(self) -> int:
        """Evict every idle-expired UNPINNED entry; returns how many.

        Called by a periodic task in each service. Without it an idle model
        whose key is never requested again is retained forever despite the TTL —
        the concrete gap the pre-TASK-529 guardrail/nlp caches had.
        """
        async with self._lock:
            victims, resident, resident_bytes = self._sweep_locked()

        await self._run_unloads(victims)
        if self._metrics is not None and victims:
            self._metrics.on_resident(self._name, resident, resident_bytes)
        return len(victims)

    async def clear(self) -> int:
        """Evict everything, pins included (teardown — the process is going)."""
        async with self._lock:
            victims = self._clear_locked()
        await self._run_unloads(victims)
        return len(victims)

    async def _run_unloads(self, victims: list[tuple[str, T]]) -> None:
        """Best-effort unload of evicted instances — never fails the caller."""
        for key, instance in victims:
            if self._unload is None:
                continue
            try:
                result = self._unload(key, instance)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.warning("%s.unload_failed key=%s", self._name, key, exc_info=True)


class _SyncLoad(Generic[T]):
    """One in-flight synchronous load: waiters block on ``done`` (never a lock)."""

    __slots__ = ("done", "error", "result")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: T | None = None
        self.error: BaseException | None = None


class SyncModelCache(_CacheCore[T]):
    """The same policy as :class:`ModelCache`, driven by threads instead of asyncio.

    For consumers whose load is a blocking CPU/GPU call and whose call site is a
    plain ``def`` (TASK-530 §2.1). ``factory`` and ``unload`` are ordinary
    callables; an *async* unload hook cannot be honoured here (there is no loop
    to await it on) and is refused with a warning rather than silently dropped.

    **Sweeping**: this class owns no background task — the harness has no
    guaranteed asyncio loop around the entailer. It sweeps lazily on ``get()``
    like all three original caches, and exposes ``sweep()`` for a host service's
    existing periodic sweeper to call, so an idle instance whose key is never
    re-requested is still released.
    """

    def __init__(
        self,
        *,
        factory: Callable[[str], T],
        ttl_seconds: int,
        max_size: int,
        unload: Callable[[str, T], Any] | None = None,
        max_bytes_estimate: int | None = None,
        estimate_bytes: Callable[[str], int] | None = None,
        time_func: Callable[[], float] = time.monotonic,
        metrics: MetricsSink | None = None,
        vram_probe: Callable[[], int] | None = None,
        vram_headroom_bytes: int = 0,
        name: str = "model_cache",
    ) -> None:
        super().__init__(
            factory=factory,
            ttl_seconds=ttl_seconds,
            max_size=max_size,
            unload=unload,
            max_bytes_estimate=max_bytes_estimate,
            estimate_bytes=estimate_bytes,
            time_func=time_func,
            metrics=metrics,
            vram_probe=vram_probe,
            vram_headroom_bytes=vram_headroom_bytes,
            name=name,
        )
        self._lock = threading.Lock()
        # key → the load in progress (single-flight).
        self._inflight: dict[str, _SyncLoad[T]] = {}

    # ── the load path ───────────────────────────────────────────────────────

    def get(self, key: str) -> T:
        """Return the instance for ``key``, loading it on miss (single-flight).

        The factory is called with NO lock held, and waiters block on an
        ``Event`` rather than on the cache lock — so a slow load never blocks a
        hit for another key, and a nested `get` cannot deadlock.
        """
        with self._lock:
            hit, expired = self._lookup_locked(key)
            if hit is None:
                existing = self._inflight.get(key)
                if existing is not None:
                    load, is_owner = existing, False
                else:
                    load = _SyncLoad[T]()
                    self._inflight[key] = load
                    is_owner = True

        # Release an idle-expired instance found above, outside the lock.
        self._run_unloads(expired)
        if hit is not None:
            return hit

        if not is_owner:
            load.done.wait()
            if load.error is not None:
                raise load.error
            return load.result  # type: ignore[return-value]

        try:
            # Pressure is relieved BEFORE the load so the incoming model has
            # room, rather than after it has already been admitted.
            with self._lock:
                victims = self._make_room_locked(key)
            self._run_unloads(victims)

            instance: T = self._factory(key)
        except BaseException as exc:
            load.error = exc
            raise
        else:
            self._admit(key, instance)
            load.result = instance
            return instance
        finally:
            with self._lock:
                self._inflight.pop(key, None)
            load.done.set()

    def _admit(self, key: str, instance: T) -> None:
        """Install a freshly-loaded instance and report it."""
        with self._lock:
            victims, resident, resident_bytes = self._admit_locked(key, instance)

        self._run_unloads(victims)
        self._report_load(key, resident, resident_bytes)

    # ── pinning ─────────────────────────────────────────────────────────────

    def pin(self, key: str) -> None:
        """Increment the pin refcount so TTL/LRU/VRAM cannot evict ``key``."""
        with self._lock:
            self._pin_locked(key)

    def unpin(self, key: str) -> None:
        """Decrement the pin refcount; the idle clock restarts on the last one."""
        with self._lock:
            self._unpin_locked(key)

    def pin_many(self, keys: list[str]) -> None:
        for key in keys:
            if key:
                self.pin(key)

    def unpin_many(self, keys: list[str]) -> None:
        for key in keys:
            if key:
                self.unpin(key)

    # ── explicit eviction / teardown ────────────────────────────────────────

    def evict(self, key: str) -> bool:
        """Evict ``key``. Refuses pinned entries; returns whether it evicted."""
        with self._lock:
            victims = self._evict_request_locked(key)
        self._run_unloads(victims)
        return bool(victims)

    def sweep(self) -> int:
        """Evict every idle-expired UNPINNED entry; returns how many."""
        with self._lock:
            victims, resident, resident_bytes = self._sweep_locked()

        self._run_unloads(victims)
        if self._metrics is not None and victims:
            self._metrics.on_resident(self._name, resident, resident_bytes)
        return len(victims)

    def clear(self) -> int:
        """Evict everything, pins included (teardown — the process is going)."""
        with self._lock:
            victims = self._clear_locked()
        self._run_unloads(victims)
        return len(victims)

    def _run_unloads(self, victims: list[tuple[str, T]]) -> None:
        """Best-effort unload of evicted instances — never fails the caller."""
        for key, instance in victims:
            if self._unload is None:
                continue
            try:
                result = self._unload(key, instance)
                if inspect.isawaitable(result):
                    # No loop to await on. Close the coroutine so Python does
                    # not warn about it, and say so loudly — an async unload
                    # hook on this class would silently never free the weights.
                    close = getattr(result, "close", None)
                    if close is not None:
                        close()
                    logger.warning(
                        "%s.async_unload_hook_unsupported key=%s", self._name, key
                    )
            except Exception:
                logger.warning("%s.unload_failed key=%s", self._name, key, exc_info=True)
