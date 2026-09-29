"""EnginePool — one lazily built engine per runtime key, single-flight, bounded residency.

The service holds no per-stream state: every request names its model (the resolved
spec), and the pool maps ``runtimeKey`` → a resident vLLM engine. That is what lets N
identical replicas sit behind one Service — any replica can serve any window.

* **Lazy.** Nothing loads at boot; the model is only known when a request names it.
  ``warm()`` exists so a router (or the bench) can load a replica before it takes traffic.
* **Single-flight.** Concurrent first requests for one key share ONE load; waiters are
  shielded, so a client disconnect never cancels a load other requests are waiting on.
* **Bounded.** At most ``max_resident`` engines (resident + loading). At the bound the
  least-recently-used IDLE engine is evicted; if every engine is busy the request is
  refused (``EngineCapacityError`` → 503 + Retry-After) — never an eviction mid-decode.
  The bound is read at EVERY eviction check (``asrVllm.engine.maxResidentEngines`` is a
  control-plane knob — TASK-1010 OD-6), so a change applies without a restart.
* **Fresh at build.** ``before_build`` (the control-plane pull) is awaited before every
  build, so the engine knobs the factory reads next are the platform's current ones.
* **Fail closed on drift.** One runtime key must always mean one spec. A request that
  reuses a key for different weights is refused rather than served by the wrong model.
* **Failures are not cached.** A failed load leaves nothing behind; the next request retries.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from hope_obs import get_logger

from asr_vllm.core import metrics
from asr_vllm.engine.base import EngineFactory, WhisperEngine
from asr_vllm.spec import ResolvedVllmAsrSpec

logger = get_logger(__name__)


class EngineCapacityError(RuntimeError):
    """Every resident engine is busy and the residency bound is reached."""


class EngineLoadError(RuntimeError):
    """The backend failed to build the engine."""


class RuntimeKeySpecMismatchError(RuntimeError):
    """A runtime key already bound to one spec was requested with another."""


@dataclass
class _Resident:
    engine: WhisperEngine
    spec: ResolvedVllmAsrSpec
    load_seconds: float
    inflight: int = 0
    last_used: float = 0.0


class EnginePool:
    def __init__(
        self,
        factory: EngineFactory,
        *,
        max_resident: int | Callable[[], int],
        before_build: Callable[[], Awaitable[None]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._max_resident: Callable[[], int] = (
            max_resident if callable(max_resident) else (lambda: max_resident)
        )
        self._before_build = before_build
        self._clock = clock
        self._lock = asyncio.Lock()
        self._resident: dict[str, _Resident] = {}
        self._loading: dict[str, asyncio.Task[_Resident]] = {}
        self._loading_specs: dict[str, ResolvedVllmAsrSpec] = {}

    # ── public ──────────────────────────────────────────────────────────────

    @asynccontextmanager
    async def lease(self, spec: ResolvedVllmAsrSpec) -> AsyncIterator[WhisperEngine]:
        """Hold the engine for ``spec`` for one decode; it cannot be evicted meanwhile."""
        resident = await self._acquire(spec)
        try:
            yield resident.engine
        finally:
            resident.inflight -= 1
            resident.last_used = self._clock()

    async def warm(self, spec: ResolvedVllmAsrSpec) -> tuple[float, bool]:
        """Load ``spec`` if needed; returns ``(load_seconds, already_resident)``."""
        already = spec.runtime_key in self._resident
        async with self.lease(spec):
            resident = self._resident[spec.runtime_key]
        return resident.load_seconds, already

    def snapshot(self) -> dict[str, Any]:
        return {
            "max_resident": self._max_resident(),
            "loaded": [
                {
                    "runtime_key": key,
                    "slug": r.spec.slug,
                    "inflight": r.inflight,
                    "load_seconds": round(r.load_seconds, 3),
                }
                for key, r in self._resident.items()
            ],
            "loading": sorted(self._loading),
        }

    async def close(self) -> None:
        for task in list(self._loading.values()):
            task.cancel()
        residents = list(self._resident.values())
        self._resident.clear()
        for resident in residents:
            await self._shutdown(resident)

    # ── internals ───────────────────────────────────────────────────────────

    async def _acquire(self, spec: ResolvedVllmAsrSpec) -> _Resident:
        key = spec.runtime_key
        while True:
            victim: _Resident | None = None
            async with self._lock:
                resident = self._resident.get(key)
                if resident is not None:
                    if resident.spec != spec:
                        raise RuntimeKeySpecMismatchError(key)
                    resident.inflight += 1
                    return resident
                task = self._loading.get(key)
                if task is None:
                    if len(self._resident) + len(self._loading) >= self._max_resident():
                        victim = self._evict_idle_lru()
                        if victim is None:
                            raise EngineCapacityError(key)
                    task = asyncio.create_task(self._load(spec))
                    self._loading[key] = task
                    self._loading_specs[key] = spec
                elif self._loading_specs[key] != spec:
                    raise RuntimeKeySpecMismatchError(key)
            if victim is not None:
                await self._shutdown(victim)
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.cancelled():
                    raise EngineLoadError(f"load of {key} was cancelled") from None
                raise
            except Exception as exc:
                raise EngineLoadError(str(exc)) from exc
            # Loop: pick the now-resident engine up under the lock (and re-check the spec).

    async def _load(self, spec: ResolvedVllmAsrSpec) -> _Resident:
        key = spec.runtime_key
        started = self._clock()
        logger.info("asr_vllm.engine.load_started", runtime_key=key, slug=spec.slug)
        try:
            if self._before_build is not None:
                await self._before_build()
            engine = await self._factory.build(spec)
        except BaseException as exc:
            async with self._lock:
                self._loading.pop(key, None)
                self._loading_specs.pop(key, None)
            logger.warning(
                "asr_vllm.engine.load_failed",
                runtime_key=key,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise
        resident = _Resident(
            engine=engine,
            spec=spec,
            load_seconds=self._clock() - started,
            last_used=self._clock(),
        )
        async with self._lock:
            self._loading.pop(key, None)
            self._loading_specs.pop(key, None)
            self._resident[key] = resident
        metrics.ENGINE_LOAD_SECONDS.observe(resident.load_seconds)
        logger.info(
            "asr_vllm.engine.loaded", runtime_key=key, load_seconds=round(resident.load_seconds, 3)
        )
        return resident

    def _evict_idle_lru(self) -> _Resident | None:
        idle = [(r.last_used, key) for key, r in self._resident.items() if r.inflight == 0]
        if not idle:
            return None
        _, key = min(idle)
        logger.info("asr_vllm.engine.evicted", runtime_key=key)
        return self._resident.pop(key)

    async def _shutdown(self, resident: _Resident) -> None:
        try:
            await resident.engine.shutdown()
        except Exception as exc:  # noqa: BLE001 — a failed shutdown must not fail a request
            logger.warning(
                "asr_vllm.engine.shutdown_failed",
                runtime_key=resident.spec.runtime_key,
                error=str(exc),
            )
