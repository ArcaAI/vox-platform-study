"""Real-time synchronisation helpers for the time-skipping workflow tests.

Every workflow test in this package starts its OWN ephemeral Temporal test
server, so a full-suite run starts one per test. Under contention that makes two
Temporal-infrastructure calls unreliable in a way that says nothing about what
the test asserts — and both used to surface as a test FAILURE:

* **A query is answered by the worker**, so it is only as available as the next
  workflow task. Across a ``continue_as_new`` handover the query follows to the
  new run, whose first workflow task has not been polled yet; on a loaded machine
  a workflow task can simply be late. Either way the server long-polls and the
  RPC deadline expires (``RPCError: Timeout expired``). That is "not yet", not a
  verdict on the predicate.
* **The ephemeral server's port is chosen and then bound**, so another process
  can take it in between (``Address already in use`` -> ``Failed starting test
  server``).

Both are retried here, bounded, so a busy machine costs seconds instead of a red
build. Not collected by pytest (does not match ``test_*``).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from temporalio.service import RPCError, RPCStatusCode
from temporalio.testing import WorkflowEnvironment

# Statuses a query gets when nobody could answer it *yet*. Anything else (an
# unknown query name, a rejected query, a failed query handler) is a real error
# and propagates unchanged.
_TRANSIENT_QUERY_STATUSES = frozenset(
    {
        RPCStatusCode.CANCELLED,
        RPCStatusCode.DEADLINE_EXCEEDED,
        RPCStatusCode.NOT_FOUND,
        RPCStatusCode.UNAVAILABLE,
    }
)

# The wall-clock budget for a poll. Deliberately a DURATION and not an attempt
# count: one attempt that swallows a ~10s RPC deadline used to burn most of a
# 200-attempt/20ms budget, which is how a merely-busy machine failed tests whose
# workflow was progressing perfectly well.
_QUERY_TIMEOUT_S = 30.0

# The per-ATTEMPT RPC deadline, which is the other half of that same problem.
# The SDK default is ~10s, so a query long-polling across a `continue_as_new`
# handover ate a THIRD of the budget above per attempt and the poll got only
# three tries before the budget ran out — observed as
# `RPCError: query deadline exceeded` on a loaded CI runner while the workflow
# itself was fine. A short attempt deadline turns the same 30s into ~15 tries,
# so "the next workflow task is late" costs a retry instead of the whole budget.
_QUERY_ATTEMPT_TIMEOUT = timedelta(seconds=2)


async def await_query(
    handle: Any,
    query: Any,
    predicate: Callable[[Any], bool],
    *,
    timeout: float = _QUERY_TIMEOUT_S,
    delay: float = 0.02,
) -> Any:
    """Poll ``query`` on ``handle`` until ``predicate`` holds.

    Signals are delivered asynchronously, so a test that inspects the workflow
    immediately after signalling is racing it. Polling a query is the supported
    way to synchronise with a long-lived workflow without reaching into its
    internals — this wrapper only makes the polling itself robust.
    """
    deadline = time.monotonic() + timeout
    last: Any = None
    while True:
        try:
            last = await handle.query(query, rpc_timeout=_QUERY_ATTEMPT_TIMEOUT)
        except RPCError as exc:
            if exc.status not in _TRANSIENT_QUERY_STATUSES or time.monotonic() >= deadline:
                raise
            # A fast-failing transient (UNAVAILABLE/NOT_FOUND) would otherwise
            # hot-loop; a deadline already waited out its own timeout.
            await asyncio.sleep(delay)
            continue
        if predicate(last):
            return last
        if time.monotonic() >= deadline:
            raise AssertionError(f"loop state never satisfied the predicate; last seen: {last}")
        await asyncio.sleep(delay)


async def await_history_event(
    handle: Any,
    predicate: Callable[[Any], bool],
    *,
    attempts: int = 200,
    delay: float = 0.02,
    description: str = "matching event",
) -> None:
    """Poll ``handle``'s event history until an event satisfying ``predicate`` is recorded.

    The deterministic alternative to signalling a workflow after a fixed real-time
    delay and hoping it has reached a particular point by then
    a raw ``asyncio.sleep`` before a signal is exactly the flakiness rule 06's
    Pitfalls section warns about: a busy machine can push scheduling past any fixed
    margin). Waiting for e.g. a specific ``EVENT_TYPE_ACTIVITY_TASK_SCHEDULED`` event
    (optionally narrowed by ``predicate`` to one activity type — several activities can
    be scheduled in a single run) to actually appear proves the workflow has reached
    that point, however long it took.
    """
    for _ in range(attempts):
        async for event in handle.fetch_history_events():
            if predicate(event):
                return
        await asyncio.sleep(delay)
    raise AssertionError(f"{description} never appeared in history")


async def start_time_skipping(*, attempts: int = 3, **kwargs: Any) -> WorkflowEnvironment:
    """``WorkflowEnvironment.start_time_skipping`` that survives a port race.

    The SDK picks a free port and the test server then binds it; a concurrent
    process taking that port in the gap fails the START, not the test.
    """
    for attempt in range(1, attempts + 1):
        try:
            return await WorkflowEnvironment.start_time_skipping(**kwargs)
        except RuntimeError as exc:  # noqa: PERF203 - retry is the point
            if attempt == attempts or "test server" not in str(exc):
                raise
            await asyncio.sleep(0.5)
    raise AssertionError("unreachable")  # pragma: no cover
