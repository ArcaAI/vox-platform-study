"""Per-slot model instance cache for per-request model selection.

The policy (single-flight load, idle TTL clamped to [60s, 3600s],
pin/unpin refcounting, LRU bound, periodic sweep, VRAM-aware eviction) lives
in the shared contract `hope_runtime_models.ModelCache`, which every HOPE
service composes. See `packages/py-runtime-models/README.md` for the contract
and its conformance clauses.

This module is the nlp-facing surface of that contract. It keeps the local
`cached_models()` spelling that nlp callers and tests already use, and nothing
else.

Retention is admin-controlled — `nlp.dependencies` resolves ttl/max from the
control plane and reconfigures these caches without a redeploy.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from hope_runtime_models import ModelCache as _SharedModelCache
from hope_runtime_models import ModelUnavailableError, clamp_cache_ttl_seconds

T = TypeVar("T")


def _shutdown_on_evict(_key: str, instance: Any) -> Any:
    """Default unload hook: call the instance's ``shutdown`` if it has one.

    Returns the (possibly awaitable) result — the shared cache awaits it when
    needed, so BOTH sync and async ``shutdown`` hooks work.
    """
    shutdown = getattr(instance, "shutdown", None)
    return None if shutdown is None else shutdown()


# Per-slot bound on cached model instances (LRU-evicted beyond it).
DEFAULT_MAX_SIZE = 3

# Program default, deliberate and owner-approved. Runtime value comes from the
# control plane; this is the bootstrap fallback only.
DEFAULT_TTL_SECONDS = 600

__all__ = [
    "DEFAULT_MAX_SIZE",
    "DEFAULT_TTL_SECONDS",
    "ModelCache",
    "ModelUnavailableError",
    "clamp_cache_ttl_seconds",
]


class _DetachedLoad(Generic[T]):
    """One load per key, running as a task that OUTLIVES its requesters.

    The shared cache already shields waiters from each other: concurrent callers
    for one key join a single future, and a waiter's cancellation cannot cancel
    it. The OWNER of that future is the exception — it awaits the factory
    directly, so cancelling the owner cancels the load itself.

    That is the whole of TASK-930 D-7. A cold GLiNER2 load takes minutes;
    guardrail (and, above it, `apps/text`'s screen timeout) gives up in seconds
    and the disconnect cancels the request task. Every attempt therefore killed
    the load it had just started, and a stack under a periodic caller reloaded
    from zero forever instead of converging.

    Wrapping the factory moves the work off the requester's task: the load runs
    once per key and every requester — owner included — waits on it under a
    shield. A cancellation then costs the REQUEST and never the WORK, and a load
    that finishes with nobody attached is handed to the next requester, which
    admits it to the cache.

    A FAILED load is still never cached: a finished task is dropped as soon as
    one requester has taken its outcome, and a task that failed while unattached
    is discarded rather than replayed at the next caller.
    """

    def __init__(self, factory: Callable[[str], Awaitable[T]]) -> None:
        self._factory = factory
        self._loads: dict[str, asyncio.Task[T]] = {}

    async def __call__(self, key: str) -> T:
        task = self._loads.get(key)
        if task is not None and task.done() and _failed(task):
            # A load that failed unattached is not an answer for this caller.
            self._loads.pop(key, None)
            task = None
        if task is None:
            task = asyncio.ensure_future(self._factory(key))
            # Retrieve the outcome even if no requester ever does, so an
            # abandoned failure is not reported as "never retrieved" at GC.
            task.add_done_callback(_failed)
            self._loads[key] = task
        try:
            return await asyncio.shield(task)
        finally:
            # Only a FINISHED load is dropped. A cancelled requester leaves the
            # task in place, which is what lets the next one join it.
            if task.done() and self._loads.get(key) is task:
                self._loads.pop(key, None)


def _failed(task: asyncio.Task[Any]) -> bool:
    """True when ``task`` ended badly; retrieves the exception either way."""
    return task.cancelled() or task.exception() is not None


class ModelCache(_SharedModelCache[T], Generic[T]):
    """The shared cache with nlp's defaults and its `cached_models()` spelling."""

    def __init__(
        self,
        *,
        factory: Callable[[str], Awaitable[T]],
        max_size: int = DEFAULT_MAX_SIZE,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        **kwargs: Any,  # pass-through for metrics / vram_probe / time_func
    ) -> None:
        super().__init__(
            factory=_DetachedLoad(factory),
            max_size=max_size,
            ttl_seconds=ttl_seconds,
            name=kwargs.pop("name", "nlp_model_cache"),
            unload=kwargs.pop("unload", _shutdown_on_evict),
            **kwargs,
        )

    def cached_models(self) -> list[str]:
        """Cached model names, oldest → most recently used (nlp's spelling)."""
        return self.cached_keys()
