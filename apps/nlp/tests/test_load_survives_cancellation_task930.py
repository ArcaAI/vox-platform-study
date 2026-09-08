"""A cancelled requester must not throw away a model load that is already running.

Measured defect (TASK-930 D-7). On a cold stack the first `/guard/*` request
triggers a GLiNER2 load that takes minutes. Its upstream — guardrail, itself
bounded by `apps/text`'s screen timeout — gives up long before that and the
client disconnects, which cancels the request task and, with it, the load.

The shared cache shields WAITERS from each other's cancellation
(`hope_runtime_models.ModelCache.get`), but the OWNER of the in-flight load
awaits the factory directly: cancelling the owner cancels the load, discards
every second of work it had done, and drops the key from `_inflight`. The next
request starts from zero and is cancelled at the same point, so a stack under a
periodic caller never converges — exactly the "load banner repeating, no access
line, `loaded: false` after 980 s" signature in `nlp.log`.

The load therefore has to outlive whoever asked for it: one task per key,
awaited under a shield by owner and waiters alike, so a cancellation costs the
REQUEST and never the WORK.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.services.model_cache import ModelCache


class _GatedFactory:
    """A load that blocks until the test releases it, counting its invocations."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.fail = False

    async def __call__(self, key: str) -> str:
        self.calls.append(key)
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError(f"load failed: {key}")
        return f"loaded:{key}"


async def test_a_cancelled_requester_does_not_discard_the_running_load() -> None:
    factory = _GatedFactory()
    cache = ModelCache(factory=factory, max_size=3)

    first = asyncio.create_task(cache.get("m-a"))
    await asyncio.wait_for(factory.started.wait(), timeout=1)

    # The upstream gave up: this requester is cancelled mid-load.
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    # A second requester arrives while the load is still running. It must JOIN
    # that load rather than start a second one...
    second = asyncio.create_task(cache.get("m-a"))
    await asyncio.sleep(0)
    factory.release.set()

    assert await asyncio.wait_for(second, timeout=1) == "loaded:m-a"
    assert factory.calls == ["m-a"], "the load must run exactly once"
    # ...and the instance must be resident, so no later request reloads it.
    assert cache.cached_models() == ["m-a"]


async def test_a_load_that_completed_unwatched_is_still_kept() -> None:
    """Nobody is awaiting when the load finishes — the model must not be lost."""
    factory = _GatedFactory()
    cache = ModelCache(factory=factory, max_size=3)

    first = asyncio.create_task(cache.get("m-b"))
    await asyncio.wait_for(factory.started.wait(), timeout=1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    # The load completes with no requester attached to it at all.
    factory.release.set()
    await asyncio.sleep(0.05)

    assert await asyncio.wait_for(cache.get("m-b"), timeout=1) == "loaded:m-b"
    assert factory.calls == ["m-b"]


async def test_a_failure_left_behind_by_a_cancelled_requester_is_not_served_again() -> None:
    """A failed load is never cached — including one whose requester had gone."""
    factory = _GatedFactory()
    factory.fail = True
    cache = ModelCache(factory=factory, max_size=3)

    first = asyncio.create_task(cache.get("m-c"))
    await asyncio.wait_for(factory.started.wait(), timeout=1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    factory.release.set()
    await asyncio.sleep(0.05)

    # The next requester gets a FRESH attempt, not the stale exception.
    factory.fail = False
    assert await asyncio.wait_for(cache.get("m-c"), timeout=1) == "loaded:m-c"
    assert factory.calls == ["m-c", "m-c"]
