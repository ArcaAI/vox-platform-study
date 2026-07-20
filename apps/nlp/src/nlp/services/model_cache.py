"""Per-slot model instance cache for per-request model selection (TASK-506).

Routes resolve their service instance through this cache from the required,
gateway-injected ``model_name`` (there is no env-configured default
selection). Each instance is created lazily and initialized on first use; a
per-key asyncio lock ensures a model several requests ask for concurrently is
constructed exactly once — the other requests await the same load.

This cache adds the STT-style runtime policy on top of the LRU bound:

- idle TTL clamped to the product window ``[60s, 3600s]``; an entry idle past
  its TTL is evicted on next access and reloaded on the fly;
- ``pin``/``unpin`` refcounting so a model in active use for a request/session
  can never be evicted by idle TTL or LRU pressure.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from nlp.core.logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

# Per-slot bound on cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 3

# product policy: idle TTL ∈ [60s, 3600s] (mirrors the STT cache).
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
    ) -> None:
        self._factory = factory
        self._max_size = max_size
        self._ttl_seconds = clamp_cache_ttl_seconds(ttl_seconds)
        self._entries: OrderedDict[str, _CacheEntry[T]] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        # Slug → pin refcount; kept separate so a pin may outlive a brief
        # cache miss during reload (mirrors the STT cache).
        self._pins: dict[str, int] = {}

    def cached_models(self) -> list[str]:
        """Cached model names, oldest → most recently used (test/introspection)."""
        return list(self._entries)

    async def get(self, model_name: str) -> T:
        """Return the cached instance for ``model_name``, creating it on miss.

        An idle entry past its TTL (and not pinned) is evicted and reloaded. A
        load failure propagates to the caller (routes map it to 503) and is NOT
        cached — a later request retries the load.
        """
        entry = self._entries.get(model_name)
        if entry is not None:
            pin_count = self._pins.get(model_name, 0)
            entry.pin_count = pin_count
            idle = time.monotonic() - entry.last_accessed
            if pin_count == 0 and idle > self._ttl_seconds:
                logger.info(
                    f"Model {model_name} idle-expired "
                    f"(idle={idle:.0f}s, ttl={self._ttl_seconds}s)"
                )
                await self._evict(model_name)
            else:
                self._entries.move_to_end(model_name)
                entry.last_accessed = time.monotonic()
                return entry.instance

        lock = self._locks.setdefault(model_name, asyncio.Lock())
        async with lock:
            # Re-check: another request may have built it while we awaited.
            entry = self._entries.get(model_name)
            if entry is not None:
                self._entries.move_to_end(model_name)
                entry.last_accessed = time.monotonic()
                return entry.instance

            try:
                instance = await self._factory(model_name)
            except Exception:
                self._locks.pop(model_name, None)
                raise

            self._entries[model_name] = _CacheEntry(
                instance=instance,
                last_accessed=time.monotonic(),
                pin_count=self._pins.get(model_name, 0),
            )
            await self._evict_over_capacity()
            return instance

    async def pin(self, model_name: str) -> None:
        """Increment pin refcount so TTL/LRU cannot evict ``model_name``."""
        self._pins[model_name] = self._pins.get(model_name, 0) + 1
        entry = self._entries.get(model_name)
        if entry is not None:
            entry.pin_count = self._pins[model_name]

    async def unpin(self, model_name: str) -> None:
        """Decrement pin refcount; idle TTL applies after the last release."""
        current = self._pins.get(model_name, 0)
        if current <= 1:
            self._pins.pop(model_name, None)
            new_count = 0
        else:
            new_count = current - 1
            self._pins[model_name] = new_count
        entry = self._entries.get(model_name)
        if entry is not None:
            entry.pin_count = new_count
            # Refresh idle clock when the last pin drops so TTL starts now.
            if new_count == 0:
                entry.last_accessed = time.monotonic()

    async def pin_many(self, model_names: list[str]) -> None:
        """Pin every non-empty name in ``model_names``."""
        for name in model_names:
            if name:
                await self.pin(name)

    async def unpin_many(self, model_names: list[str]) -> None:
        """Unpin every non-empty name in ``model_names``."""
        for name in model_names:
            if name:
                await self.unpin(name)

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
                logger.warning("Cannot LRU-evict: all cached NLP model instances are pinned")
                break
            await self._evict(victim)

    async def _evict(self, model_name: str) -> None:
        """Evict a specific entry and best-effort shut its instance down."""
        entry = self._entries.pop(model_name, None)
        self._locks.pop(model_name, None)
        if entry is None:
            return
        logger.info(f"Evicting cached model instance: {model_name}")
        await _shutdown_quietly(entry.instance)


async def _shutdown_quietly(instance: Any) -> None:
    """Best-effort shutdown of an evicted instance (never fails the request)."""
    shutdown = getattr(instance, "shutdown", None)
    if shutdown is None:
        return
    try:
        await shutdown()
    except Exception:
        logger.warning("Evicted model instance shutdown failed", exc_info=True)
