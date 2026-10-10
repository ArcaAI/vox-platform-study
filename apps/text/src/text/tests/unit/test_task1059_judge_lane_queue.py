"""TASK-1059 OD-6 (RC-3) — the judge lane queues, boundedly, instead of shedding at once.

TASK-1058 saw `CONCURRENCY_LIMIT` 503s from `/generate/internal/judge` the moment every permit
was busy (5 s acquire, no queue), each failing a whole medical validation. Now a judge call waits
up to 30 s for a permit, in a BOUNDED queue: a call that finds the queue full is still refused at
once (guardrail then retries only that window), so the lane never grows an unbounded backlog.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest

from text.api.endpoints.judge import acquire_judge_permit
from text.core.exceptions import ConcurrencyLimitError
from text.core.runtime_defaults import JUDGE_LANE_FLOOR
from text.services.resizable_semaphore import ResizableSemaphore


def test_the_judge_lane_waits_30_seconds_in_a_bounded_queue() -> None:
    assert JUDGE_LANE_FLOOR.acquire_timeout_s == 30.0
    assert 0 < JUDGE_LANE_FLOOR.queue_max_size <= 4 * JUDGE_LANE_FLOOR.max_concurrent
    assert JUDGE_LANE_FLOOR.queue_max_wait_s == JUDGE_LANE_FLOOR.acquire_timeout_s


async def test_a_queued_call_gets_the_permit_when_it_is_released() -> None:
    semaphore = ResizableSemaphore(1)
    await semaphore.acquire()
    budget = replace(JUDGE_LANE_FLOOR, max_concurrent=1, queue_max_size=1, acquire_timeout_s=5.0)

    waiter = asyncio.create_task(acquire_judge_permit(semaphore, budget, "lm-studio"))
    await asyncio.sleep(0)
    assert not waiter.done()  # queued, not refused
    semaphore.release()
    await asyncio.wait_for(waiter, timeout=1)

    assert semaphore.in_flight == 1


async def test_a_call_that_finds_the_queue_full_is_refused_at_once() -> None:
    semaphore = ResizableSemaphore(1)
    await semaphore.acquire()
    budget = replace(JUDGE_LANE_FLOOR, max_concurrent=1, queue_max_size=1, acquire_timeout_s=5.0)
    queued = asyncio.create_task(acquire_judge_permit(semaphore, budget, "lm-studio"))
    await asyncio.sleep(0)

    with pytest.raises(ConcurrencyLimitError):
        await asyncio.wait_for(acquire_judge_permit(semaphore, budget, "lm-studio"), timeout=0.5)

    queued.cancel()
    with pytest.raises(asyncio.CancelledError):
        await queued


async def test_a_queued_call_that_waits_past_the_acquire_timeout_is_refused() -> None:
    semaphore = ResizableSemaphore(1)
    await semaphore.acquire()
    budget = replace(JUDGE_LANE_FLOOR, max_concurrent=1, queue_max_size=1, acquire_timeout_s=0.05)

    with pytest.raises(ConcurrencyLimitError):
        await acquire_judge_permit(semaphore, budget, "lm-studio")

    # The queue slot is given back: the next caller may wait again.
    semaphore.release()
    await acquire_judge_permit(semaphore, budget, "lm-studio")
    assert semaphore.in_flight == 1


async def test_a_free_permit_is_taken_without_queueing() -> None:
    semaphore = ResizableSemaphore(2)
    budget = replace(JUDGE_LANE_FLOOR, queue_max_size=0)

    await acquire_judge_permit(semaphore, budget, "lm-studio")

    assert semaphore.in_flight == 1
