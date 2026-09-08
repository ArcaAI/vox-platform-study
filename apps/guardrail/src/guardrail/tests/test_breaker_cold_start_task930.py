"""The breaker must not amplify a peer's COLD START (TASK-930 D-7).

Measured: `apps/nlp` needs minutes to load a guard model on a cold stack, while
guardrail — itself bounded by `apps/text`'s ~10 s screen timeout — gives up in
seconds. Two properties of the breaker turned that slow start into an outage:

* **half-open admitted unlimited probes.** The moment the recovery window
  elapsed, every queued request went to the peer at once — a stampede aimed at
  the one peer that was already struggling, which is precisely the load
  amplification a breaker exists to prevent;
* **a probe cancelled by the CALLER reported nothing**, so the breaker was left
  in `half_open` forever: it never re-opened (no failure was recorded) and it
  never closed (no success was recorded), and in that state it waved every
  subsequent request through. Under the D-7 shape — the upstream giving up on
  every attempt — that is a permanently open floodgate.

The posture that is NOT changing: a caller's cancellation still never counts as
a peer failure (we learned nothing about the peer), and a peer that genuinely
refuses or errors still opens the circuit and still fails CLOSED.

A call this suite expects to be SHED is awaited under `wait_for`: without the
gate it reaches the peer stub and blocks there, and a hang is a far worse test
failure than an assertion — it tells you nothing and it stops the suite.
"""

from __future__ import annotations

import asyncio

import pytest

from guardrail.core.breaker import BreakerOpenError, CircuitBreaker, FailPosture

SHED_TIMEOUT_S = 0.5


def _breaker(clock: list[float]) -> CircuitBreaker:
    return CircuitBreaker(
        name="nlp",
        posture=FailPosture.FAIL_CLOSED,
        failure_threshold=2,
        recovery_timeout_s=10.0,
        time_func=lambda: clock[0],
    )


async def _open(breaker: CircuitBreaker) -> None:
    async def boom() -> None:
        raise RuntimeError("peer down")

    for _ in range(breaker.failure_threshold):
        with pytest.raises(RuntimeError):
            await breaker.call(boom)
    assert breaker.state == "open"


async def _cancel(task: asyncio.Task[object]) -> None:
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_half_open_admits_one_probe_at_a_time() -> None:
    """A recovered window must not release a stampede into a cold peer."""
    clock = [0.0]
    breaker = _breaker(clock)
    await _open(breaker)
    clock[0] += 11.0  # the recovery window has elapsed

    entered = asyncio.Event()
    release = asyncio.Event()
    probes = 0

    async def slow_probe() -> str:
        nonlocal probes
        probes += 1
        entered.set()
        await release.wait()
        return "ok"

    first = asyncio.create_task(breaker.call(slow_probe))
    await asyncio.wait_for(entered.wait(), timeout=1)

    # The second caller must be SHED, not sent at the peer alongside the probe.
    with pytest.raises(BreakerOpenError):
        await asyncio.wait_for(breaker.call(slow_probe), timeout=SHED_TIMEOUT_S)

    release.set()
    assert await asyncio.wait_for(first, timeout=1) == "ok"
    assert probes == 1
    assert breaker.state == "closed", "a successful probe closes the circuit"


@pytest.mark.asyncio
async def test_a_cancelled_probe_does_not_leave_the_circuit_wide_open() -> None:
    """The upstream gave up mid-probe. The next caller may probe — ONE of them."""
    clock = [0.0]
    breaker = _breaker(clock)
    await _open(breaker)
    clock[0] += 11.0

    entered = asyncio.Event()

    async def hangs() -> None:
        entered.set()
        await asyncio.Event().wait()

    probe = asyncio.create_task(breaker.call(hangs))
    await asyncio.wait_for(entered.wait(), timeout=1)
    await _cancel(probe)

    # The abandoned probe released its slot: exactly one caller gets through...
    second = asyncio.create_task(breaker.call(hangs))
    await asyncio.sleep(0)
    # ...and the next is shed rather than piling onto the same cold peer.
    with pytest.raises(BreakerOpenError):
        await asyncio.wait_for(breaker.call(hangs), timeout=SHED_TIMEOUT_S)
    await _cancel(second)


@pytest.mark.asyncio
async def test_a_cancelled_call_is_never_counted_as_a_peer_failure() -> None:
    """We learned nothing about the peer, so the failure run must not move."""
    clock = [0.0]
    breaker = _breaker(clock)

    async def hangs() -> None:
        await asyncio.Event().wait()

    for _ in range(breaker.failure_threshold + 1):
        call = asyncio.create_task(breaker.call(hangs))
        await asyncio.sleep(0)
        await _cancel(call)

    assert breaker.state == "closed"

    async def ok() -> str:
        return "fine"

    assert await breaker.call(ok) == "fine"


@pytest.mark.asyncio
async def test_a_genuinely_down_peer_still_opens_the_circuit() -> None:
    """The posture is unchanged: refusals and errors still shed load."""
    clock = [0.0]
    breaker = _breaker(clock)
    await _open(breaker)

    async def boom() -> None:
        raise ConnectionRefusedError("connection refused")

    with pytest.raises(BreakerOpenError):
        await asyncio.wait_for(breaker.call(boom), timeout=SHED_TIMEOUT_S)
