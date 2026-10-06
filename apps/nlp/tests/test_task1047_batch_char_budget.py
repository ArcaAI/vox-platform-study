"""TASK-1047 F1 — a batch closes on a CHARACTER budget, not only on a count.

Eight 4,000-char windows in one forward pass pad to the longest and cost
~8 x 0.5 GiB per batch; the budget bounds that transient memory.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.core import bounds as bounds_mod
from nlp.core.batching import MicroBatcher
from nlp.core.bounds import apply_snapshot, get_bounds, reset_bounds
from nlp.services import guard_dispatch
from nlp.services.guard_dispatch import LANE_BULK, LANE_INTERACTIVE, get_batcher


def _batcher(seen: list[list[str]], budget: int | None, size: int = 8) -> MicroBatcher[str, int]:
    async def run(_group: str, items: list[str]) -> list[int]:
        seen.append(items)
        return [len(i) for i in items]

    return MicroBatcher(
        run_batch=run,
        max_batch_size=size,
        linger_ms=20,
        max_batch_chars=budget,
        max_inflight_batches=4,
    )


async def _submit_all(b: MicroBatcher[str, int], texts: list[str]) -> list[int]:
    return list(await asyncio.gather(*(b.submit("g", t, cost=len(t)) for t in texts)))


async def test_eight_4000_char_items_with_8192_budget_batch_by_two() -> None:
    seen: list[list[str]] = []
    b = _batcher(seen, 8192)
    try:
        await _submit_all(b, ["x" * 4000] * 8)
    finally:
        await b.aclose()
    assert [len(batch) for batch in seen] == [2, 2, 2, 2]


async def test_item_over_budget_runs_alone() -> None:
    seen: list[list[str]] = []
    b = _batcher(seen, 4000)
    try:
        await _submit_all(b, ["x" * 8192, "y" * 10, "z" * 10])
    finally:
        await b.aclose()
    assert seen[0] == ["x" * 8192]
    assert sum(len(s) for s in seen) == 3


async def test_small_items_still_batch_up_to_max_size() -> None:
    seen: list[list[str]] = []
    b = _batcher(seen, 8192, size=8)
    try:
        await _submit_all(b, ["a" * 100] * 8)
    finally:
        await b.aclose()
    assert [len(batch) for batch in seen] == [8]


async def test_no_budget_keeps_count_only_behaviour() -> None:
    seen: list[list[str]] = []
    b = _batcher(seen, None)
    try:
        await _submit_all(b, ["x" * 4000] * 8)
    finally:
        await b.aclose()
    assert [len(batch) for batch in seen] == [8]


def test_budget_default_and_control_plane() -> None:
    reset_bounds()
    assert get_bounds().max_batch_chars == 8192

    class Snap:
        def setting(self, key: str):  # noqa: ANN202
            return {"nlp.inference.maxBatchChars": 5000}.get(key)

    apply_snapshot(Snap())  # type: ignore[arg-type]
    assert get_bounds().max_batch_chars == 5000
    reset_bounds()


@pytest.mark.parametrize("lane", [LANE_BULK, LANE_INTERACTIVE])
async def test_guard_batchers_read_the_budget_for_both_lanes(lane: str) -> None:
    reset_bounds()
    seen: list[list[str]] = []

    async def run(_g: str, items: list[str]) -> list[int]:
        seen.append(items)
        return [0] * len(items)

    await guard_dispatch.reset_guard_batchers()
    b = await get_batcher("slot", "pii", run, lane)
    try:
        bounds_mod.set_bounds(max_batch_chars=8192)
        await asyncio.gather(*(b.submit("g", "x" * 4000, cost=4000) for _ in range(4)))
    finally:
        await guard_dispatch.reset_guard_batchers()
    assert max(len(s) for s in seen) == 2
