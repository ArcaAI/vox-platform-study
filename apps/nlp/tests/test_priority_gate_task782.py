"""the shared per-model execution permit, and why it must be priority-aware.

Separate QUEUES for the interactive and bulk lanes are necessary and not
sufficient: both lanes ultimately drive the SAME weights, so a bulk forward pass
already running is head-of-line blocking for an inline gate no matter how short
the interactive queue is. The permit that admits a batch to the model is
therefore shared per weight slot AND priority-ordered.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core.priority_gate import PriorityGate

pytestmark = pytest.mark.asyncio


async def test_a_free_permit_is_granted_without_waiting() -> None:
    gate = PriorityGate(limit=2)
    await gate.acquire(priority=5)
    await gate.acquire(priority=5)
    assert gate.held == 2
    gate.release()
    assert gate.held == 1


async def test_interactive_waiters_are_served_before_bulk_waiters() -> None:
    """The whole point: a later-arriving interactive batch overtakes queued bulk."""
    gate = PriorityGate(limit=1)
    await gate.acquire(priority=0)  # occupy the only permit

    order: list[str] = []

    async def waiter(name: str, priority: int) -> None:
        await gate.acquire(priority=priority)
        order.append(name)

    bulk_a = asyncio.create_task(waiter("bulk-a", 10))
    bulk_b = asyncio.create_task(waiter("bulk-b", 10))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    interactive = asyncio.create_task(waiter("interactive", 0))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    for _ in range(3):
        gate.release()
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    await asyncio.gather(bulk_a, bulk_b, interactive)
    assert order[0] == "interactive", order
    # Same-priority waiters keep FIFO order among themselves — priority reorders
    # ACROSS lanes, it never makes one lane starve inside itself.
    assert order[1:] == ["bulk-a", "bulk-b"], order


async def test_a_cancelled_waiter_never_leaks_its_permit() -> None:
    """A client disconnect must not permanently shrink the model's capacity."""
    gate = PriorityGate(limit=1)
    await gate.acquire(priority=0)

    pending = asyncio.create_task(gate.acquire(priority=0))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending

    gate.release()
    # The permit must be reusable immediately, not lost to the cancelled waiter.
    await asyncio.wait_for(gate.acquire(priority=0), timeout=0.5)
    assert gate.held == 1


async def test_release_without_a_holder_is_refused_rather_than_inflating_capacity() -> None:
    gate = PriorityGate(limit=1)
    with pytest.raises(RuntimeError):
        gate.release()
