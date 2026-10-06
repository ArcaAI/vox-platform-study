"""One resident copy per weight identity (TASK-1047 C8).

The guard cache and the token-classifier cache can both ask for the same
GLiNER2 checkpoint; without this each held its own copy. The registry is keyed
by ``(model_name, model_path)`` and holds its values WEAKLY: it only
deduplicates while at least one cache still serves the weights, so eviction
from every cache still frees the memory.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

WeightKey = tuple[str, str | None]


class WeightRegistry:
    def __init__(self) -> None:
        self._entries: weakref.WeakValueDictionary[WeightKey, Any] = weakref.WeakValueDictionary()
        self._locks: dict[WeightKey, asyncio.Lock] = {}

    async def get_or_load(self, key: WeightKey, loader: Callable[[], Awaitable[Any]]) -> Any:
        existing = self._entries.get(key)
        if existing is not None:
            return existing
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            existing = self._entries.get(key)
            if existing is not None:
                return existing
            value = await loader()
            self._entries[key] = value
            return value


_registry = WeightRegistry()


def get_weight_registry() -> WeightRegistry:
    return _registry


def reset_weight_registry() -> None:
    global _registry
    _registry = WeightRegistry()
