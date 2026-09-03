"""The inference bound nlp never had.

Before this module the service had ZERO semaphores anywhere: every concurrent
NER / classification / diagnosis request went straight at the model, so load was
bounded only by however many requests happened to arrive.

`ResizableSemaphore` is mirrored from `text.services.resizable_semaphore` —
deliberately duplicated rather than shared, because factoring the per-service
clients and primitives into a common package is a settled decision and must not be
preempted here. Keep the two implementations in step.
"""

from __future__ import annotations

import asyncio
from collections import deque
from types import TracebackType
from typing import Any

import structlog

from nlp.core.config import settings

logger = structlog.get_logger(__name__)


class ResizableSemaphore:
    """An asyncio semaphore whose limit can be changed while it is in use.

    Capacity is admitted by comparing `in_flight` against the CURRENT limit on
    every acquire, so a shrink binds immediately for new work while never
    revoking a permit an in-flight inference already holds.
    """

    def __init__(self, limit: int) -> None:
        self._validate(limit)
        self._limit = limit
        self._in_flight = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    @staticmethod
    def _validate(limit: int) -> None:
        if limit < 1:
            raise ValueError(f"semaphore limit must be >= 1, got {limit}")

    @property
    def limit(self) -> int:
        """The current ceiling. May be below `in_flight` right after a shrink."""
        return self._limit

    @property
    def in_flight(self) -> int:
        """Inferences currently running."""
        return self._in_flight

    def set_limit(self, limit: int) -> None:
        """Move the ceiling. Idempotent; never revokes an in-flight permit."""
        self._validate(limit)
        if limit == self._limit:
            return
        self._limit = limit
        self._wake()

    async def acquire(self) -> None:
        """Wait for capacity, then take a permit."""
        while self._in_flight >= self._limit:
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            try:
                await waiter
            except asyncio.CancelledError:
                self._discard(waiter)
                if waiter.done() and not waiter.cancelled():
                    self._wake()
                raise
        self._in_flight += 1

    def release(self) -> None:
        """Return a permit and hand the capacity to the next waiter."""
        if self._in_flight == 0:
            raise RuntimeError("ResizableSemaphore released more times than acquired")
        self._in_flight -= 1
        self._wake()

    def _wake(self) -> None:
        headroom = self._limit - self._in_flight
        while headroom > 0 and self._waiters:
            waiter = self._waiters.popleft()
            if waiter.done():
                continue
            waiter.set_result(None)
            headroom -= 1

    def _discard(self, waiter: asyncio.Future[None]) -> None:
        try:
            self._waiters.remove(waiter)
        except ValueError:
            pass

    async def __aenter__(self) -> ResizableSemaphore:
        await self.acquire()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()


_inference_semaphore: ResizableSemaphore | None = None


def get_inference_semaphore() -> ResizableSemaphore:
    """The process-wide inference bound.

    A module singleton, matching how `dependencies.py` holds its model caches.
    The object is stable for the process's lifetime so the control plane can
    resize it without stranding in-flight inferences.
    """
    global _inference_semaphore
    if _inference_semaphore is None:
        _inference_semaphore = ResizableSemaphore(settings.service.inference_max_concurrent)
    return _inference_semaphore


def reset_inference_semaphore() -> None:
    """Drop the singleton (tests only)."""
    global _inference_semaphore
    _inference_semaphore = None


async def refresh_inference_limit(client: Any) -> ResizableSemaphore:
    """Pull the control-plane bound (cached; cheap) and apply it.

    NEVER raises: an inference must not fail because the config plane is
    unavailable. No opinion from the control plane ⇒ the env bound stays in force,
    which is exactly the env-only behaviour.
    """
    semaphore = get_inference_semaphore()
    if client is None:
        return semaphore

    try:
        snapshot = await client.get()

        # Same refresh, same fail-safe posture: retention
        # rides the existing pull rather than opening a second poll loop.
        # Imported here to avoid a dependencies↔concurrency import cycle.
        from nlp.dependencies import apply_model_cache_retention

        apply_model_cache_retention(snapshot.retention())

        # Same refresh, same fail-safe posture, for the two other groups the
        # control plane now serves. Both are no-ops when the
        # served values match what is already running, which is every request but
        # the first after a write.
        from nlp.core.logging import apply_log_sinks
        from nlp.services.guard_dispatch import apply_batching

        apply_log_sinks(snapshot.logging())
        await apply_batching(snapshot.batching())

        limit = snapshot.max_concurrent()
        if limit is not None and limit != semaphore.limit:
            previous = semaphore.limit
            semaphore.set_limit(limit)
            logger.info(
                "nlp.effective_config.inference_limit_resized",
                previous=previous,
                current=limit,
                in_flight=semaphore.in_flight,
            )
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break inference
        logger.warning(
            "nlp.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )

    return semaphore


_peer_call_semaphore: ResizableSemaphore | None = None


def get_peer_call_semaphore() -> ResizableSemaphore:
    """The process-wide OUTBOUND PEER HTTP bound (owner decision 2026-08-20).

    A SEPARATE singleton from `get_inference_semaphore`: it bounds this
    process's own concurrent calls to `text` (the `/classify/topic` and
    `/classify/intent` delegation), never local model inference. Sharing
    `inference_bound` would let a slow HTTP round-trip to a peer service
    starve local GPU/CPU inference slots, or vice versa — two different
    resources, so two different semaphores.
    """
    global _peer_call_semaphore
    if _peer_call_semaphore is None:
        _peer_call_semaphore = ResizableSemaphore(settings.service.peer_call_max_concurrent)
    return _peer_call_semaphore


def reset_peer_call_semaphore() -> None:
    """Drop the singleton (tests only)."""
    global _peer_call_semaphore
    _peer_call_semaphore = None


async def refresh_peer_call_limit(client: Any) -> ResizableSemaphore:
    """Pull the control-plane peer-call bound (cached; cheap) and apply it.

    Mirrors `refresh_inference_limit` exactly, but for the peer-call
    semaphore and its OWN control-plane key (`nlp.peerCall.maxConcurrent`).
    Deliberately does NOT re-apply model-cache retention — that stays the
    sole responsibility of `refresh_inference_limit`, so a request path that
    resolves both bounds never applies the same retention snapshot twice.
    NEVER raises: a peer call must not fail because the config plane is
    unavailable. No opinion from the control plane ⇒ the env bound stays in
    force.
    """
    semaphore = get_peer_call_semaphore()
    if client is None:
        return semaphore

    try:
        snapshot = await client.get()
        limit = snapshot.peer_call_max_concurrent()
        if limit is not None and limit != semaphore.limit:
            previous = semaphore.limit
            semaphore.set_limit(limit)
            logger.info(
                "nlp.effective_config.peer_call_limit_resized",
                previous=previous,
                current=limit,
                in_flight=semaphore.in_flight,
            )
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a peer call
        logger.warning(
            "nlp.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )

    return semaphore
