"""the coalescing micro-batcher that carries the 100-session target.

`gliner2` exposes `batch_extract_entities` / `batch_classify_text`, which run N
texts through ONE forward pass. Before this ticket every guard request took its
own pass, so 100 concurrent sessions meant 100 sequential passes behind a
4-permit semaphore.

`MicroBatcher` coalesces concurrent requests that share a GROUP (same verb, same
taxonomy, same threshold — anything else would change the result) into one call,
with three DECLARED bounds:

* `max_batch_size` — how many items may ride one forward pass;
* `max_queue`      — beyond it, submissions are REJECTED (`InferenceQueueFull`),
                     never queued unboundedly;
* `max_wait_s`     — an item that waited longer is REJECTED
                     (`InferenceQueueTimeout`) rather than served stale.

Backpressure is a declared contract, not an accident of exhaustion.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core.batching import (
    InferenceQueueFull,
    InferenceQueueTimeout,
    MicroBatcher,
)


async def _echo_batch(group: str, items: list[str]) -> list[str]:
    await asyncio.sleep(0.01)
    return [f"{group}:{item}" for item in items]


@pytest.mark.asyncio
async def test_concurrent_submissions_coalesce_into_one_forward_pass() -> None:
    """The whole point: N concurrent items, ONE call to `run_batch`."""
    calls: list[list[str]] = []

    async def run_batch(group: str, items: list[str]) -> list[str]:
        calls.append(list(items))
        return await _echo_batch(group, items)

    batcher = MicroBatcher(run_batch=run_batch, max_batch_size=8, linger_ms=20, name="t")
    try:
        results = await asyncio.gather(*(batcher.submit("g", str(i)) for i in range(8)))
    finally:
        await batcher.aclose()

    assert results == [f"g:{i}" for i in range(8)]
    assert len(calls) == 1, f"expected one coalesced pass, got {calls}"
    assert len(calls[0]) == 8


@pytest.mark.asyncio
async def test_results_are_returned_in_submission_order_per_caller() -> None:
    """Each caller gets ITS OWN result — a mis-zip would cross-contaminate tenants."""

    async def run_batch(group: str, items: list[str]) -> list[str]:
        await asyncio.sleep(0.01)
        return [item.upper() for item in items]

    batcher = MicroBatcher(run_batch=run_batch, max_batch_size=16, linger_ms=20, name="t")
    try:
        results = await asyncio.gather(*(batcher.submit("g", c) for c in "abcdef"))
    finally:
        await batcher.aclose()
    assert results == list("ABCDEF")


@pytest.mark.asyncio
async def test_different_groups_never_share_a_forward_pass() -> None:
    """A different taxonomy/threshold is a different call — mixing them is wrong."""
    seen: list[tuple[str, int]] = []

    async def run_batch(group: str, items: list[str]) -> list[str]:
        seen.append((group, len(items)))
        return await _echo_batch(group, items)

    batcher = MicroBatcher(run_batch=run_batch, max_batch_size=8, linger_ms=20, name="t")
    try:
        await asyncio.gather(
            *(batcher.submit("a", str(i)) for i in range(3)),
            *(batcher.submit("b", str(i)) for i in range(3)),
        )
    finally:
        await batcher.aclose()

    assert sorted(seen) == [("a", 3), ("b", 3)]


@pytest.mark.asyncio
async def test_batch_size_is_a_hard_ceiling() -> None:
    sizes: list[int] = []

    async def run_batch(group: str, items: list[str]) -> list[str]:
        sizes.append(len(items))
        return await _echo_batch(group, items)

    batcher = MicroBatcher(
        run_batch=run_batch, max_batch_size=4, linger_ms=20, max_inflight_batches=1, name="t"
    )
    try:
        await asyncio.gather(*(batcher.submit("g", str(i)) for i in range(10)))
    finally:
        await batcher.aclose()

    assert sizes and max(sizes) <= 4
    assert sum(sizes) == 10


@pytest.mark.asyncio
async def test_a_full_queue_rejects_rather_than_growing() -> None:
    """Backpressure: 503 at the edge beats an unbounded queue and an OOM."""
    gate = asyncio.Event()

    async def run_batch(group: str, items: list[str]) -> list[str]:
        await gate.wait()
        return list(items)

    batcher = MicroBatcher(
        run_batch=run_batch,
        max_batch_size=1,
        linger_ms=1,
        max_queue=2,
        max_inflight_batches=1,
        name="t",
    )
    try:
        # Phase 1: one item is drained into the (blocked) in-flight batch.
        blocker = asyncio.create_task(batcher.submit("g", "blocker"))
        await asyncio.sleep(0.05)
        assert batcher.queue_depth == 0

        # Phase 2: the next two fill the bounded queue; the dispatcher cannot
        # drain them because the single in-flight permit is held.
        queued = [asyncio.create_task(batcher.submit("g", str(i))) for i in range(2)]
        await asyncio.sleep(0.05)
        assert batcher.queue_depth == 2

        # Phase 3: one more is SHED, not queued.
        with pytest.raises(InferenceQueueFull):
            await batcher.submit("g", "overflow")

        gate.set()
        await asyncio.gather(blocker, *queued)
    finally:
        gate.set()
        await batcher.aclose()


@pytest.mark.asyncio
async def test_an_item_that_waited_past_the_ceiling_is_rejected_not_served_stale() -> None:
    gate = asyncio.Event()

    async def run_batch(group: str, items: list[str]) -> list[str]:
        await gate.wait()
        return list(items)

    batcher = MicroBatcher(
        run_batch=run_batch,
        max_batch_size=1,
        linger_ms=1,
        max_queue=64,
        max_wait_s=0.05,
        max_inflight_batches=1,
        name="t",
    )
    try:
        blocker = asyncio.create_task(batcher.submit("g", "blocker"))
        await asyncio.sleep(0.02)
        late = asyncio.create_task(batcher.submit("g", "late"))
        await asyncio.sleep(0.2)
        gate.set()
        with pytest.raises(InferenceQueueTimeout):
            await late
        await blocker
    finally:
        gate.set()
        await batcher.aclose()


@pytest.mark.asyncio
async def test_a_failing_batch_fails_every_member_and_never_fabricates() -> None:
    """Fail-closed: an inference error must not read back as an empty result."""

    async def run_batch(group: str, items: list[str]) -> list[str]:
        raise RuntimeError("boom")

    batcher = MicroBatcher(run_batch=run_batch, max_batch_size=8, linger_ms=20, name="t")
    try:
        results = await asyncio.gather(
            *(batcher.submit("g", str(i)) for i in range(4)), return_exceptions=True
        )
    finally:
        await batcher.aclose()
    assert all(isinstance(r, RuntimeError) for r in results)


@pytest.mark.asyncio
async def test_queue_depth_is_observable() -> None:
    """The metric has to read something real, so the batcher must expose it."""
    gate = asyncio.Event()

    async def run_batch(group: str, items: list[str]) -> list[str]:
        await gate.wait()
        return list(items)

    batcher = MicroBatcher(
        run_batch=run_batch, max_batch_size=1, linger_ms=1, max_inflight_batches=1, name="t"
    )
    try:
        assert batcher.queue_depth == 0
        pending = [asyncio.create_task(batcher.submit("g", str(i))) for i in range(5)]
        await asyncio.sleep(0.05)
        assert batcher.queue_depth > 0
        gate.set()
        await asyncio.gather(*pending)
        assert batcher.queue_depth == 0
    finally:
        gate.set()
        await batcher.aclose()
