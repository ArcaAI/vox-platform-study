"""Graceful shutdown manager — tracks active tasks and drains on shutdown."""

from __future__ import annotations

import asyncio

import structlog

logger = structlog.get_logger(__name__)


class ShutdownManager:
    """Tracks active generation tasks and supports graceful drain."""

    def __init__(self) -> None:
        self._active_tasks: set[str] = set()
        self._shutting_down = False
        self._drain_event = asyncio.Event()

    @property
    def active_count(self) -> int:
        return len(self._active_tasks)

    @property
    def is_shutting_down(self) -> bool:
        return self._shutting_down

    def register_task(self, task_id: str) -> None:
        self._active_tasks.add(task_id)

    def complete_task(self, task_id: str) -> None:
        self._active_tasks.discard(task_id)
        if not self._active_tasks:
            self._drain_event.set()

    def initiate_shutdown(self) -> None:
        self._shutting_down = True
        if not self._active_tasks:
            self._drain_event.set()

    async def wait_for_shutdown(self, timeout: float = 30.0) -> bool:
        """Wait for all active tasks to complete. Returns True if timed out."""
        self._shutting_down = True
        if not self._active_tasks:
            return False
        try:
            await asyncio.wait_for(self._drain_event.wait(), timeout=timeout)
            return False
        except asyncio.TimeoutError:
            logger.warning("shutdown.timeout", remaining_tasks=len(self._active_tasks))
            return True
