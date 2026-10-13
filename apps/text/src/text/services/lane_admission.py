"""Admission of a live-marked generation: its reserved permit first, idle user capacity second.

The live lane reserves `lmStudio.serving.liveLaneSlots` permits so a live flush never queues
behind finalize / pre-summary work. A reserve is a floor, not a ceiling: when every live permit
is held (several concurrent consultations flushing at once) a live generation BORROWS an idle
user-lane permit rather than waiting while user capacity sits unused, and when both lanes are
full it waits on both, jumping ahead of queued user-lane work on the user semaphore. The user
lane never borrows live permits, so the reserve still holds against batch work.
"""

from __future__ import annotations

import asyncio
import contextlib

from text.services.resizable_semaphore import ResizableSemaphore


async def acquire_live_permit(
    live: ResizableSemaphore,
    user: ResizableSemaphore | None,
    timeout: float,
) -> ResizableSemaphore:
    """Take one permit for a live generation and return the semaphore it came from.

    The caller releases exactly that semaphore. Raises ``TimeoutError`` after ``timeout``
    seconds with no permit taken (nothing is left held or queued).
    """
    if live.try_acquire():
        return live
    if user is None or user is live:
        await asyncio.wait_for(live.acquire(), timeout=timeout)
        return live
    if user.try_acquire():
        return user

    tasks = {
        asyncio.ensure_future(live.acquire()): live,
        asyncio.ensure_future(user.acquire(priority=True)): user,
    }
    try:
        done, _ = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        await _settle(tasks, keep=None)
        raise
    winner = next((task for task in tasks if task in done and not task.exception()), None)
    await _settle(tasks, keep=winner)
    if winner is None:
        raise TimeoutError("no live-lane or user-lane permit within the queue wait")
    return tasks[winner]


async def _settle(
    tasks: dict[asyncio.Future[None], ResizableSemaphore], keep: asyncio.Future[None] | None
) -> None:
    """Cancel every losing acquire; give back any permit a loser took in the same tick."""
    for task, semaphore in tasks.items():
        if task is keep:
            continue
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if task.done() and not task.cancelled() and task.exception() is None:
            semaphore.release()
