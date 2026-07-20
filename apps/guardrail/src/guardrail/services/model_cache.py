"""Idle-TTL + pin model instance cache for the guardrail aux models.

Guardrail's auxiliary ML models — the GLiNER content-safety detector and the
MiniCheck groundedness scorer — are loaded LAZILY on first use (never in the
lifespan) and released when they go idle, mirroring the STT / NLP runtime
policy so a freshly-booted worker holds no ML weights.

Each instance is created lazily through an injected async ``factory`` keyed by
the DB-resolved runtime model id (``AiModel.sourceUri``); a per-key
:class:`asyncio.Lock` makes concurrent first-use callers share one load
(single-flight) instead of each loading their own copy. On top of the LRU
bound this adds:

- idle TTL clamped to the product window ``[60s, 3600s]``; an entry idle past
  its TTL (and not pinned) is evicted on next access and reloaded on the fly;
- ``pin``/``unpin`` refcounting so a model in active use for a request can
  never be evicted by idle TTL or LRU pressure.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from guardrail.core.logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

# Per-cache bound on cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 2

# product policy: idle TTL ∈ [60s, 3600s] (mirrors STT / NLP).
_TTL_MIN_SECONDS = 60
_TTL_MAX_SECONDS = 3600
DEFAULT_TTL_SECONDS = 3600


def clamp_cache_ttl_seconds(ttl_seconds: int) -> int:
    """Clamp idle TTL to the product window [60, 3600]."""
    return max(_TTL_MIN_SECONDS, min(_TTL_MAX_SECONDS, int(ttl_seconds)))


class ModelUnavailableError(RuntimeError):
    """A required model could not be resolved/loaded (fail-closed → HTTP 503)."""


@dataclass
class _CacheEntry(Generic[T]):
    """A cached instance plus the idle-TTL / pin bookkeeping."""

    instance: T
    last_accessed: float
    pin_count: int = 0


class ModelCache(Generic[T]):
    """LRU cache of lazily-created model instances with idle-TTL + pinning."""

    def __init__(
        self,
        *,
        factory: Callable[[str], Awaitable[T]],
        max_size: int = DEFAULT_MAX_SIZE,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = factory
        self._max_size = max_size
        self._ttl_seconds = clamp_cache_ttl_seconds(ttl_seconds)
        self._time = time_func
        self._entries: OrderedDict[str, _CacheEntry[T]] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        # model id → pin refcount; kept separate so a pin may outlive a brief
        # cache miss during reload (mirrors the STT cache).
        self._pins: dict[str, int] = {}

    def cached_models(self) -> list[str]:
        """Cached model ids, oldest → most recently used (test/introspection)."""
        return list(self._entries)

    async def get(self, model_id: str) -> T:
        """Return the cached instance for ``model_id``, creating it on miss.

        An idle entry past its TTL (and not pinned) is evicted and reloaded. A
        load failure propagates to the caller (routes map it to 503 / degrade)
        and is NOT cached — a later request retries the load.
        """
        entry = self._entries.get(model_id)
        if entry is not None:
            pin_count = self._pins.get(model_id, 0)
            entry.pin_count = pin_count
            idle = self._time() - entry.last_accessed
            if pin_count == 0 and idle > self._ttl_seconds:
                logger.info(
                    "guardrail.model_cache.idle_expired",
                    model_id=model_id,
                    idle_s=round(idle),
                    ttl_s=self._ttl_seconds,
                )
                await self._evict(model_id)
            else:
                self._entries.move_to_end(model_id)
                entry.last_accessed = self._time()
                return entry.instance

        lock = self._locks.setdefault(model_id, asyncio.Lock())
        async with lock:
            # Re-check: another request may have built it while we awaited.
            entry = self._entries.get(model_id)
            if entry is not None:
                self._entries.move_to_end(model_id)
                entry.last_accessed = self._time()
                return entry.instance

            try:
                instance = await self._factory(model_id)
            except Exception:
                self._locks.pop(model_id, None)
                raise

            self._entries[model_id] = _CacheEntry(
                instance=instance,
                last_accessed=self._time(),
                pin_count=self._pins.get(model_id, 0),
            )
            await self._evict_over_capacity()
            return instance

    async def pin(self, model_id: str) -> None:
        """Increment pin refcount so TTL/LRU cannot evict ``model_id``."""
        self._pins[model_id] = self._pins.get(model_id, 0) + 1
        entry = self._entries.get(model_id)
        if entry is not None:
            entry.pin_count = self._pins[model_id]

    async def unpin(self, model_id: str) -> None:
        """Decrement pin refcount; idle TTL applies after the last release."""
        current = self._pins.get(model_id, 0)
        if current <= 1:
            self._pins.pop(model_id, None)
            new_count = 0
        else:
            new_count = current - 1
            self._pins[model_id] = new_count
        entry = self._entries.get(model_id)
        if entry is not None:
            entry.pin_count = new_count
            # Refresh idle clock when the last pin drops so TTL starts now.
            if new_count == 0:
                entry.last_accessed = self._time()

    async def clear(self) -> int:
        """Evict every cached instance (service teardown / test helper)."""
        count = len(self._entries)
        for model_id in list(self._entries):
            # Teardown ignores pins — the process is going away.
            self._pins.pop(model_id, None)
            await self._evict(model_id)
        return count

    async def _evict_over_capacity(self) -> None:
        """Evict least-recently-used UNPINNED entries beyond ``max_size``.

        Pinned entries are never evicted, and the most-recently-added entry
        (the one serving the current request) is kept — so when the only
        eviction candidates are pinned, the cache is allowed to exceed
        ``max_size`` rather than drop a model in use.
        """
        while len(self._entries) > self._max_size:
            newest = next(reversed(self._entries))
            victim: str | None = None
            for name in self._entries:
                if name == newest:
                    continue
                if self._pins.get(name, 0) == 0:
                    victim = name
                    break
            if victim is None:
                logger.warning("guardrail.model_cache.all_pinned_cannot_evict")
                break
            await self._evict(victim)

    async def _evict(self, model_id: str) -> None:
        """Evict a specific entry and best-effort shut its instance down."""
        entry = self._entries.pop(model_id, None)
        self._locks.pop(model_id, None)
        if entry is None:
            return
        logger.info("guardrail.model_cache.evicting", model_id=model_id)
        await _shutdown_quietly(entry.instance)


async def _shutdown_quietly(instance: Any) -> None:
    """Best-effort shutdown of an evicted instance (never fails the request).

    Tolerates both sync (e.g. GLiNER's thread-pool ``shutdown``) and async
    shutdown hooks; instances with no hook (e.g. the MiniCheck scorer, whose
    llama handle is freed on GC) are a no-op.
    """
    shutdown = getattr(instance, "shutdown", None)
    if shutdown is None:
        return
    try:
        result = shutdown()
        if inspect.isawaitable(result):
            await result
    except Exception:
        logger.warning("guardrail.model_cache.shutdown_failed", exc_info=True)
