"""Priority queue for buffering requests when providers are rate-limited."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


class QueueFullError(Exception):
    """Raised when the provider queue is at max capacity."""


@dataclass(order=True)
class QueueItem:
    priority: int
    request_id: str = field(compare=False)
    future: asyncio.Future = field(compare=False)


class ProviderQueue:
    """Async priority queue with max-size backpressure."""

    def __init__(self, max_size: int = 200) -> None:
        self._max_size = max_size
        self._queue: asyncio.PriorityQueue[QueueItem] = asyncio.PriorityQueue(maxsize=max_size)

    @property
    def size(self) -> int:
        return self._queue.qsize()

    @property
    def is_full(self) -> bool:
        return self._queue.full()

    async def enqueue(self, priority: int, future: asyncio.Future, request_id: str) -> None:
        if self._queue.full():
            raise QueueFullError(f"Queue is full ({self._max_size})")
        item = QueueItem(priority=priority, request_id=request_id, future=future)
        await self._queue.put(item)

    async def dequeue(self) -> QueueItem:
        return await self._queue.get()
