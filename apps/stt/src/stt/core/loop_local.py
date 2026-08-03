"""Loop-local singletons for the per-message event loops of the Dramatiq worker.

BUG-015. The worker runs one ``asyncio.run()`` per message, so a fresh event loop
is created and destroyed for every job, while the objects the job needs — a
SQLAlchemy async engine's connection pool, an ``httpx.AsyncClient``, an
``asyncio.Lock`` — are bound to the loop that built them. Caching any of those
process-wide hands a live job an object owned by a loop that no longer exists.

Keying such a cache on ``id(loop)`` is NOT sufficient, which is what made the
original bug so hard to see: CPython recycles loop addresses almost immediately
(measured: 47 distinct addresses over 400 sequential ``asyncio.run()`` calls), so
after a handful of jobs a new loop routinely collided with a CLOSED loop's entry
and was handed its dead pool. The symptom was not a crash but a 300s stall in the
job's first query while a dead socket timed out.

Two rules make it correct:

1. **Identity, not address.** A binding holds a STRONG reference to its loop and
   is reused only when ``binding.loop is running_loop``. A recycled address fails
   that check, so a dead loop's value can never be served. The strong reference
   also pins the address for as long as the binding lives, so the collision
   cannot even arise while the entry is cached.
2. **Prune on every lookup.** Bindings whose loop has closed are disposed and
   dropped, so a long-running worker holds at most one binding per LIVE loop
   rather than one per job. Without this the engine cache grew unboundedly and
   exhausted Postgres `max_connections` after ~24 jobs.

`dispose` runs on a loop that is already gone, so it must not await anything —
for a SQLAlchemy engine that means ``sync_engine.dispose(close=False)``, which
abandons the pooled connections rather than trying to close them on a dead loop.
A failing `dispose` is logged and swallowed: reclaiming a stale binding must
never break the job that triggered the prune.
"""

import asyncio
import threading
from asyncio import AbstractEventLoop
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class _Binding:
    """One namespace's value for one event loop.

    ``loop`` is a STRONG reference on purpose — see rule 1 above. It is ``None``
    only for values created outside any running loop (CLI/startup paths), which
    hold no loop-bound state and so are safe to share.
    """

    loop: AbstractEventLoop | None
    value: Any
    dispose: Callable[[Any], None] | None = None


# (namespace, id(loop)) -> binding. `id()` is the fast index; `binding.loop is
# loop` is the actual correctness check.
_REGISTRY: dict[tuple[str, int], _Binding] = {}

# The worker runs 4 threads, each with its own loop, all reaching this registry.
_REGISTRY_LOCK = threading.Lock()


def _running_loop() -> AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _release(binding: _Binding) -> None:
    if binding.dispose is None:
        return
    try:
        binding.dispose(binding.value)
    except Exception as exc:  # noqa: BLE001 — reclaiming must never break a job
        logger.warning(
            "stt.loop_local.dispose_error", error=str(exc), error_type=type(exc).__name__
        )


def _prune_closed(namespace: str) -> None:
    """Drop bindings whose loop has closed. Caller holds `_REGISTRY_LOCK`."""
    for key in [
        k
        for k, b in _REGISTRY.items()
        if k[0] == namespace and b.loop is not None and b.loop.is_closed()
    ]:
        _release(_REGISTRY.pop(key))


def get_loop_local(
    namespace: str,
    factory: Callable[[], Any],
    dispose: Callable[[Any], None] | None = None,
) -> Any:
    """Return this event loop's value for ``namespace``, building it on first use.

    ``factory`` runs while the registry lock is held, so it must be cheap and
    must not await — build the object, don't connect with it.
    """
    loop = _running_loop()
    key = (namespace, id(loop) if loop is not None else 0)

    with _REGISTRY_LOCK:
        _prune_closed(namespace)

        existing = _REGISTRY.get(key)
        if existing is not None:
            if existing.loop is loop:
                return existing.value
            # Same address, different loop: the address was recycled after the
            # original loop was collected. Reclaim it rather than serve it.
            logger.debug("stt.loop_local.recycled_address", namespace=namespace)
            _release(_REGISTRY.pop(key))

        binding = _Binding(loop=loop, value=factory(), dispose=dispose)
        _REGISTRY[key] = binding
        return binding.value


def loop_local_size(namespace: str | None = None) -> int:
    """Live binding count — used by tests to pin that bindings do not accumulate."""
    with _REGISTRY_LOCK:
        if namespace is None:
            return len(_REGISTRY)
        return sum(1 for k in _REGISTRY if k[0] == namespace)


def reset_loop_locals(namespace: str | None = None) -> None:
    """Dispose and drop bindings (tests, and shutdown paths)."""
    with _REGISTRY_LOCK:
        for key in [k for k in _REGISTRY if namespace is None or k[0] == namespace]:
            _release(_REGISTRY.pop(key))
