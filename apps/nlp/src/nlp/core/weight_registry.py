"""One resident copy per weight identity (TASK-1047 C8).

The guard cache and the token-classifier cache can both ask for the same
GLiNER2 checkpoint; without this each held its own copy. The registry is keyed
by the weight identity — ``(model_name, model_path)``, plus the device when the
load was placed on an explicit one (TASK-1055: a copy on ``cuda:1`` is not the
copy on ``cuda:0``) — and holds its values WEAKLY: it only deduplicates while at
least one cache still serves the weights, so eviction from every cache still
frees the memory.

TASK-1055: each successful :meth:`get_or_load` is one HOLDER (one cache entry).
An unload calls :meth:`release`; only the LAST holder's release answers True, and
that caller — and only that caller — shuts the weights down. Shutting them down
earlier would pull the runtime out from under a cache still serving it.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

WeightKey = tuple[Any, ...]


class WeightRegistry:
    def __init__(self) -> None:
        self._entries: weakref.WeakValueDictionary[WeightKey, Any] = weakref.WeakValueDictionary()
        self._locks: dict[WeightKey, asyncio.Lock] = {}
        self._holders: dict[WeightKey, int] = {}

    async def get_or_load(self, key: WeightKey, loader: Callable[[], Awaitable[Any]]) -> Any:
        existing = self._entries.get(key)
        if existing is not None:
            self._holders[key] = self._holders.get(key, 0) + 1
            return existing
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            existing = self._entries.get(key)
            if existing is not None:
                self._holders[key] = self._holders.get(key, 0) + 1
                return existing
            value = await loader()
            self._entries[key] = value
            # A fresh load: any count left over from weights that were garbage
            # collected without a release belongs to a value that no longer exists.
            self._holders[key] = 1
            return value

    def release(self, key: WeightKey, value: Any) -> bool:
        """Drop one holder of ``value``; True when it was the last (shut it down).

        A value the registry does not hold under ``key`` (never registered, already
        dropped, or superseded by a reload) belongs to its caller alone: True.
        """
        if self._entries.get(key) is not value:
            return True
        remaining = self._holders.get(key, 0) - 1
        if remaining > 0:
            self._holders[key] = remaining
            return False
        self._holders.pop(key, None)
        self._entries.pop(key, None)
        return True

    def holders(self, key: WeightKey) -> int:
        """How many cache entries currently hold the weights under ``key``."""
        return self._holders.get(key, 0) if self._entries.get(key) is not None else 0


_registry = WeightRegistry()


def get_weight_registry() -> WeightRegistry:
    return _registry


def reset_weight_registry() -> None:
    global _registry
    _registry = WeightRegistry()
