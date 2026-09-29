"""EnginePool — one lazily built engine per runtime key, admitted by GiB, with pins and kinds.

The service holds no per-stream state: every request names a model, the gateway resolves
it to a ``ResolvedServingSpec``, and the pool maps ``runtimeKey`` → a resident vLLM engine.
That is what lets N identical replicas sit behind one Service.

What a POOL is (TASK-1021 C-4): this process serves exactly one entry of ``vllm.pools`` —
the one ``VLLM_POOL`` names — read through :class:`PoolConfig` at EVERY admission, so a
platform-admin change applies without a restart.

* **Kinds.** ``spec.kind`` outside ``accepted_kinds`` is refused
  (``ModelNotServable("KIND_NOT_ACCEPTED")``) before anything loads — an ``asr`` pool never
  builds an LLM because a client named one.
* **GiB admission.** An engine is admitted while ``Σ resident + loading vramGiB + new ≤
  vram_budget_gib`` and the engine count stays within ``max_resident``. Otherwise the
  least-recently-used IDLE, UNPINNED engines are evicted, oldest first, until it fits; if
  even evicting every candidate would not make room, NOTHING is evicted and the request is
  refused (``EngineCapacityError`` → 503 + Retry-After) — never an eviction mid-decode, and
  never an eviction for an ask that fails anyway. A spec larger than the whole budget is
  refused by name (``VRAM_BUDGET_EXCEEDED``).
* **Pins are SLUGS.** ``warm_pins`` / ``refresh_pins`` resolve the pool's pinned slugs
  against the SYSTEM tenant (a pin is platform configuration, never a customer's row) and
  load them; the pinned set is the runtime keys those slugs resolve to NOW. A row edit
  changes its runtime key (``<id>:v<version>``), so every refresh re-resolves: the new key
  is warmed and pinned, the old one becomes an ordinary evictable engine. A pinned runtime
  key is never evicted.
* **Release before build.** Evicted engines are shut down INSIDE the (shielded) load task,
  before the new engine builds: vLLM checks free GPU memory at startup, and the evicted
  engine-core holds its share until shutdown returns. Until then the victims still count
  against the budget, and a caller that goes away cannot interrupt the release.
* **Lazy + single-flight.** Everything else loads on first use; concurrent first requests
  share ONE load, shielded so a client disconnect never cancels a load others wait on.
* **Fresh at build.** ``before_build`` (the control-plane pull) is awaited before every build.
* **Saturation.** A lease beyond ``maxNumSeqs × inflight_factor`` on one engine is refused
  (``EngineSaturatedError`` → 429 + Retry-After): past that the request would only queue
  inside vLLM, and the caller can retry against another replica sooner.
* **Fail closed on drift.** One runtime key must always mean one set of WEIGHTS: a request
  that reuses a resident key for different weights (path, source, checksum, format,
  dtype, quantization, context length, owner) is refused. Engine SIZING may differ — a
  row edit to ``vramGiB`` / ``maxNumSeqs`` that keeps the runtime key is served by the
  engine already resident, which keeps the shape it was built with until evicted.
* **Failures are not cached.** A NAMED refusal (``EngineBuildRefused``) keeps its code
  through the pool, so the HTTP layer answers with the reason.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from hope_obs import get_logger

from hope_vllm.core import metrics
from hope_vllm.core.pools import PoolConfig
from hope_vllm.core.serving_spec_client import ModelNotServable
from hope_vllm.engine.base import (
    DEFAULT_MAX_NUM_SEQS,
    EngineBuildRefused,
    EngineFactory,
    WhisperEngine,
)
from hope_vllm.spec import ResolvedServingSpec

logger = get_logger(__name__)

#: The reserved platform-configuration tenant. Pins resolve here, and only here.
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: The code of a load failure the backend did not name.
ENGINE_LOAD_FAILED = "ENGINE_LOAD_FAILED"


class EngineCapacityError(RuntimeError):
    """The new engine does not fit, and evicting every idle unpinned engine would not help."""


class EngineSaturatedError(RuntimeError):
    """The engine already holds ``maxNumSeqs × inflight_factor`` leases."""


class EngineLoadError(RuntimeError):
    """The backend failed to build the engine; ``code`` names why (503)."""

    def __init__(self, message: str, *, code: str = ENGINE_LOAD_FAILED) -> None:
        super().__init__(message)
        self.code = code


class RuntimeKeySpecMismatchError(RuntimeError):
    """A runtime key already bound to one spec was requested with another."""


def weights_identity(spec: ResolvedServingSpec) -> tuple[object, ...]:
    """What a runtime key PINS: the weights and how they load — never engine sizing."""
    return (
        spec.slug,
        spec.kind,
        spec.tenant_id,
        spec.local_path,
        spec.source_uri,
        spec.source_revision,
        spec.checksum,
        spec.format,
        spec.compute_type,
        spec.quantization,
        spec.max_model_len,
    )


@dataclass
class _Resident:
    engine: WhisperEngine
    spec: ResolvedServingSpec
    load_seconds: float
    inflight: int = 0
    last_used: float = 0.0


class EnginePool:
    def __init__(
        self,
        factory: EngineFactory,
        *,
        pool_config: Callable[[], PoolConfig],
        before_build: Callable[[], Awaitable[None]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._pool_config = pool_config
        self._before_build = before_build
        self._clock = clock
        self._lock = asyncio.Lock()
        self._resident: dict[str, _Resident] = {}
        self._loading: dict[str, asyncio.Task[_Resident]] = {}
        self._loading_specs: dict[str, ResolvedServingSpec] = {}
        #: Evicted engines whose shutdown has not completed — still on the GPU.
        self._releasing: dict[str, _Resident] = {}
        #: pinned slug → the spec it resolves to NOW (SYSTEM tenant).
        self._pin_specs: dict[str, ResolvedServingSpec] = {}

    # ── public ──────────────────────────────────────────────────────────────

    @asynccontextmanager
    async def lease(
        self, spec: ResolvedServingSpec, *, enforce_saturation: bool = True
    ) -> AsyncIterator[WhisperEngine]:
        """Hold the engine for ``spec`` for one decode; it cannot be evicted meanwhile.

        Raises :class:`EngineSaturatedError` when the engine is already at its lease cap
        (``enforce_saturation=False`` for a warm, which decodes nothing).
        """
        resident = await self._acquire(spec, enforce_saturation)
        inflight = metrics.INFLIGHT.labels(model=spec.slug)
        inflight.inc()
        try:
            yield resident.engine
        finally:
            inflight.dec()
            resident.inflight -= 1
            resident.last_used = self._clock()

    async def warm(self, spec: ResolvedServingSpec) -> tuple[float, bool]:
        """Load ``spec`` if needed; returns ``(load_seconds, already_resident)``."""
        already = spec.runtime_key in self._resident
        async with self.lease(spec, enforce_saturation=False):
            resident = self._resident[spec.runtime_key]
        return resident.load_seconds, already

    @property
    def _pinned(self) -> set[str]:
        return {spec.runtime_key for spec in self._pin_specs.values()}

    async def warm_pins(self, resolve: Callable[[str], Awaitable[ResolvedServingSpec]]) -> None:
        """Startup: resolve and load every pin. Raises on the first failure."""
        await self.refresh_pins(resolve)

    async def refresh_pins(self, resolve: Callable[[str], Awaitable[ResolvedServingSpec]]) -> None:
        """Re-resolve the pool's pinned SLUGS and load what they resolve to now.

        ``resolve`` maps a slug to its spec for the SYSTEM tenant (the caller binds it). The
        pinned set is replaced BEFORE anything loads, so a key a slug no longer resolves to
        (an edited row, or a slug dropped from ``pins``) is evictable to make room for the
        new one. Raises on the first failure; the slugs resolved so far stay pinned.
        """
        resolved: dict[str, ResolvedServingSpec] = {}
        for slug in self._pool_config().pins:
            resolved[slug] = await resolve(slug)
        released = self._pinned - {spec.runtime_key for spec in resolved.values()}
        self._pin_specs = resolved
        for key in sorted(released):
            logger.info("vllm.engine.unpinned", runtime_key=key)
        for slug, spec in resolved.items():
            _, already = await self.warm(spec)
            if not already:
                logger.info("vllm.engine.pinned", slug=slug, runtime_key=spec.runtime_key)

    def inflight(self, runtime_key: str) -> int:
        """Leases currently held on ``runtime_key`` (0 when not resident)."""
        resident = self._resident.get(runtime_key)
        return resident.inflight if resident is not None else 0

    def pending_pins(self) -> list[tuple[str, str]]:
        """``(slug, kind)`` of every pin resolved but not (yet) resident."""
        return [
            (spec.slug, spec.kind)
            for spec in self._pin_specs.values()
            if spec.runtime_key not in self._resident
        ]

    def resident_specs(self) -> list[tuple[ResolvedServingSpec, bool]]:
        """``(spec, pinned)`` for every resident engine."""
        return [(r.spec, key in self._pinned) for key, r in self._resident.items()]

    def snapshot(self) -> dict[str, Any]:
        config = self._pool_config()
        return {
            "accepted_kinds": sorted(config.accepted_kinds),
            "max_resident": config.max_resident,
            "vram_budget_gib": config.vram_budget_gib,
            "resident_gib": self._committed_gib(),
            "loaded": [
                {
                    "runtime_key": key,
                    "slug": r.spec.slug,
                    "kind": r.spec.kind,
                    "vram_gib": r.spec.engine.vram_gib,
                    "pinned": key in self._pinned,
                    "inflight": r.inflight,
                    "load_seconds": round(r.load_seconds, 3),
                }
                for key, r in self._resident.items()
            ],
            "loading": sorted(self._loading),
        }

    def idle(self) -> bool:
        """No lease is held on any engine (a drain may close the pool)."""
        return all(r.inflight == 0 for r in self._resident.values())

    async def close(self) -> None:
        tasks = list(self._loading.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # Anything a cancelled load task had not finished releasing.
        residents = [*self._releasing.values(), *self._resident.values()]
        self._releasing.clear()
        self._resident.clear()
        for resident in residents:
            self._publish_residency(resident.spec.slug)
            await self._shutdown(resident)
        metrics.RESIDENT_GIB.set(self._committed_gib())

    # ── internals ───────────────────────────────────────────────────────────

    def _publish_residency(self, slug: str) -> None:
        """``model_resident_bytes`` for ``slug``: the GPU claim of its resident engines."""
        claimed = sum(
            r.spec.engine.vram_gib for r in self._resident.values() if r.spec.slug == slug
        )
        metrics.MODEL_RESIDENT_BYTES.labels(
            service=metrics.SERVICE, model=slug, device=metrics.DEVICE
        ).set(claimed * 2**30)

    def _committed_gib(self) -> float:
        """GiB the GPU is holding or about to hold: resident, being released, loading."""
        return (
            sum(r.spec.engine.vram_gib for r in self._resident.values())
            + sum(r.spec.engine.vram_gib for r in self._releasing.values())
            + sum(s.engine.vram_gib for s in self._loading_specs.values())
        )

    async def _acquire(self, spec: ResolvedServingSpec, enforce_saturation: bool) -> _Resident:
        key = spec.runtime_key
        while True:
            async with self._lock:
                config = self._pool_config()
                if spec.kind not in config.accepted_kinds:
                    metrics.REJECTIONS_TOTAL.labels(reason="kind_not_accepted").inc()
                    raise ModelNotServable(
                        "KIND_NOT_ACCEPTED",
                        f"model '{spec.slug}' is a '{spec.kind}' model; this pool accepts "
                        f"{', '.join(sorted(config.accepted_kinds))}",
                    )
                resident = self._resident.get(key)
                if resident is not None:
                    if weights_identity(resident.spec) != weights_identity(spec):
                        raise RuntimeKeySpecMismatchError(key)
                    cap = (
                        resident.spec.engine.max_num_seqs or DEFAULT_MAX_NUM_SEQS
                    ) * config.inflight_factor
                    if enforce_saturation and resident.inflight >= cap:
                        metrics.REJECTIONS_TOTAL.labels(reason="engine_saturated").inc()
                        raise EngineSaturatedError(key)
                    resident.inflight += 1
                    return resident
                task = self._loading.get(key)
                if task is None:
                    victims = self._admit(spec, config)
                    task = asyncio.create_task(self._load(spec, victims))
                    self._loading[key] = task
                    self._loading_specs[key] = spec
                elif weights_identity(self._loading_specs[key]) != weights_identity(spec):
                    raise RuntimeKeySpecMismatchError(key)
            queued = metrics.QUEUE_DEPTH.labels(model=spec.slug)
            queued.inc()
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.cancelled():
                    raise EngineLoadError(f"load of {key} was cancelled") from None
                raise
            except Exception as exc:
                code = exc.code if isinstance(exc, EngineBuildRefused) else ENGINE_LOAD_FAILED
                raise EngineLoadError(str(exc), code=code) from exc
            finally:
                queued.dec()
            # Loop: pick the now-resident engine up under the lock (and re-check the spec).

    def _admit(self, spec: ResolvedServingSpec, config: PoolConfig) -> list[_Resident]:
        """Make room for ``spec`` (under the lock). Returns the evicted engines to shut down.

        Evicts nothing unless the plan as a whole makes the new engine fit.
        """
        need = spec.engine.vram_gib
        metrics.VRAM_BUDGET_GIB.set(config.vram_budget_gib)
        if need > config.vram_budget_gib:
            metrics.REJECTIONS_TOTAL.labels(reason="vram_budget_exceeded").inc()
            raise EngineBuildRefused(
                "VRAM_BUDGET_EXCEEDED",
                f"model '{spec.slug}' needs {need:g} GiB; this pool's whole budget is "
                f"{config.vram_budget_gib:g} GiB",
            )
        committed = self._committed_gib()
        count = len(self._resident) + len(self._releasing) + len(self._loading)

        def fits(gib: float, engines: int) -> bool:
            return gib + need <= config.vram_budget_gib and engines + 1 <= config.max_resident

        if fits(committed, count):
            metrics.RESIDENT_GIB.set(committed + need)
            return []
        candidates = sorted(
            (r.last_used, key)
            for key, r in self._resident.items()
            if r.inflight == 0 and key not in self._pinned
        )
        plan: list[str] = []
        for _, key in candidates:
            plan.append(key)
            committed -= self._resident[key].spec.engine.vram_gib
            count -= 1
            if fits(committed, count):
                break
        else:
            metrics.REJECTIONS_TOTAL.labels(reason="engine_capacity").inc()
            raise EngineCapacityError(spec.runtime_key)
        victims = [self._resident.pop(key) for key in plan]
        for victim in victims:
            # Still on the GPU until `_load` has shut it down.
            self._releasing[victim.spec.runtime_key] = victim
        metrics.RESIDENT_GIB.set(self._committed_gib() + need)
        for victim in victims:
            metrics.ENGINE_EVICTIONS_TOTAL.inc()
            logger.info(
                "vllm.engine.evicted",
                runtime_key=victim.spec.runtime_key,
                vram_gib=victim.spec.engine.vram_gib,
                for_runtime_key=spec.runtime_key,
            )
        return victims

    async def _release(self, victims: list[_Resident]) -> None:
        """Shut the victims down, THEN stop counting them (even if a shutdown failed —
        the attempt is over and ``_shutdown`` logged it)."""
        for victim in victims:
            await self._shutdown(victim)
            async with self._lock:
                self._releasing.pop(victim.spec.runtime_key, None)
                self._publish_residency(victim.spec.slug)
                metrics.RESIDENT_GIB.set(self._committed_gib())

    async def _load(self, spec: ResolvedServingSpec, victims: list[_Resident]) -> _Resident:
        key = spec.runtime_key
        started = self._clock()
        logger.info(
            "vllm.engine.load_started",
            runtime_key=key,
            slug=spec.slug,
            kind=spec.kind,
            vram_gib=spec.engine.vram_gib,
        )
        try:
            await self._release(victims)
            started = self._clock()  # the load proper, not the release before it
            if self._before_build is not None:
                await self._before_build()
            engine = await self._factory.build(spec)
        except BaseException as exc:
            async with self._lock:
                self._loading.pop(key, None)
                self._loading_specs.pop(key, None)
                metrics.RESIDENT_GIB.set(self._committed_gib())
            metrics.ENGINE_LOADS_TOTAL.labels(result="failed").inc()
            logger.warning(
                "vllm.engine.load_failed",
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
            self._publish_residency(spec.slug)
        metrics.ENGINE_LOADS_TOTAL.labels(result="loaded").inc()
        metrics.MODEL_LOAD_SECONDS.labels(service=metrics.SERVICE, model=spec.slug).observe(
            resident.load_seconds
        )
        logger.info(
            "vllm.engine.loaded", runtime_key=key, load_seconds=round(resident.load_seconds, 3)
        )
        return resident

    async def _shutdown(self, resident: _Resident) -> None:
        try:
            await resident.engine.shutdown()
        except Exception as exc:  # noqa: BLE001 — a failed shutdown must not fail a request
            logger.warning(
                "vllm.engine.shutdown_failed",
                runtime_key=resident.spec.runtime_key,
                error=str(exc),
            )
