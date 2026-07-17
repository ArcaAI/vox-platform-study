"""Per-slot model instance cache for per-request model selection (TASK-506).

Routes resolve their service instance through a slot cache when a request
carries a ``model_name`` override. The default (env-configured) instance is
owned by the ``nlp.dependencies`` singletons and never enters a cache, so it
can never be evicted; up to ``max_size`` per-model instances are created
lazily and evicted least-recently-used. A per-key asyncio lock ensures a
model several requests ask for concurrently is constructed exactly once —
the other requests await the same load.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from nlp.core.logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

# Per-slot bound on non-default cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 3


class ModelCache(Generic[T]):
    """A small LRU cache of lazily-created, initialized model service instances."""

    def __init__(
        self,
        *,
        factory: Callable[[str], Awaitable[T]],
        max_size: int = DEFAULT_MAX_SIZE,
    ) -> None:
        self._factory = factory
        self._max_size = max_size
        self._entries: OrderedDict[str, T] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}

    def cached_models(self) -> list[str]:
        """Cached model names, oldest → most recently used (test/introspection)."""
        return list(self._entries)

    async def get(self, model_name: str) -> T:
        """Return the cached instance for ``model_name``, creating it on miss.

        A load failure propagates to the caller (routes map it to 503) and is
        NOT cached — a later request retries the load.
        """
        entry = self._entries.get(model_name)
        if entry is not None:
            self._entries.move_to_end(model_name)
            return entry

        lock = self._locks.setdefault(model_name, asyncio.Lock())
        async with lock:
            # Re-check: another request may have built it while we awaited.
            entry = self._entries.get(model_name)
            if entry is not None:
                self._entries.move_to_end(model_name)
                return entry

            try:
                instance = await self._factory(model_name)
            except Exception:
                self._locks.pop(model_name, None)
                raise

            self._entries[model_name] = instance
            while len(self._entries) > self._max_size:
                evicted_name, evicted = self._entries.popitem(last=False)
                self._locks.pop(evicted_name, None)
                logger.info(f"Evicting LRU cached model instance: {evicted_name}")
                await _shutdown_quietly(evicted)
            return instance


async def _shutdown_quietly(instance: Any) -> None:
    """Best-effort shutdown of an evicted instance (never fails the request)."""
    shutdown = getattr(instance, "shutdown", None)
    if shutdown is None:
        return
    try:
        await shutdown()
    except Exception:
        logger.warning("Evicted model instance shutdown failed", exc_info=True)
