"""TASK-777 Lane B — throughput at >= 100 concurrent consultation sessions.

Guardrail is on the critical path of every generation and fails CLOSED, so
saturating guardrail is a denial of *generation* for every tenant (threat T9).
The primitives pinned here are the ones that turn saturation into a bounded,
declared rejection instead of an unbounded queue:

* an **admission gate** — bounded concurrency plus a queue-wait ceiling, with
  rejection as a DECLARED outcome (503 + `Retry-After`), never an unbounded wait;
* a **circuit breaker per peer** with a **declared** fail posture, so a dead peer
  sheds load instead of costing `attempts × timeout` on every request;
* explicit connect/read/write/**pool** timeouts on the one shared client.
"""

from __future__ import annotations

import asyncio

import pytest

from guardrail.core.breaker import (
    BreakerOpenError,
    CircuitBreaker,
    FailPosture,
)
from guardrail.core.concurrency import AdmissionGate, AdmissionRejected

# ---------------------------------------------------------------------------
# Admission control
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gate_bounds_concurrency_without_dropping_work() -> None:
    gate = AdmissionGate(name="analyze", max_concurrent=4, max_wait_s=5.0)
    peak = 0
    live = 0

    async def one() -> None:
        nonlocal peak, live
        async with gate.admit():
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0.005)
            live -= 1

    await asyncio.gather(*(one() for _ in range(100)))

    assert peak <= 4, "the gate is the concurrency bound"
    assert gate.in_flight == 0
    assert gate.queue_depth == 0


@pytest.mark.asyncio
async def test_gate_rejects_rather_than_queueing_forever() -> None:
    """Backpressure is DECLARED: past the ceiling the caller is told, not parked."""
    gate = AdmissionGate(name="analyze", max_concurrent=1, max_wait_s=0.01)

    async def hold() -> None:
        async with gate.admit():
            await asyncio.sleep(0.2)

    holder = asyncio.create_task(hold())
    await asyncio.sleep(0.01)

    with pytest.raises(AdmissionRejected) as excinfo:
        async with gate.admit():
            pass

    assert excinfo.value.retry_after_s > 0
    assert gate.rejections == 1
    holder.cancel()


@pytest.mark.asyncio
async def test_gate_releases_its_slot_when_the_body_raises() -> None:
    gate = AdmissionGate(name="analyze", max_concurrent=1, max_wait_s=1.0)
    with pytest.raises(ValueError):
        async with gate.admit():
            raise ValueError("boom")
    assert gate.in_flight == 0
    async with gate.admit():
        pass  # slot was returned


@pytest.mark.asyncio
async def test_gate_reports_queue_depth_while_waiting() -> None:
    gate = AdmissionGate(name="analyze", max_concurrent=1, max_wait_s=5.0)

    async def hold() -> None:
        async with gate.admit():
            await asyncio.sleep(0.05)

    tasks = [asyncio.create_task(hold()) for _ in range(5)]
    await asyncio.sleep(0.01)
    assert gate.queue_depth == 4
    assert gate.in_flight == 1
    await asyncio.gather(*tasks)
    assert gate.queue_depth == 0


@pytest.mark.asyncio
async def test_gate_map_bounds_a_batch_fan_out() -> None:
    """A caller-supplied batch must not become an unbounded `gather`."""
    gate = AdmissionGate(name="batch", max_concurrent=3, max_wait_s=5.0)
    peak = 0
    live = 0

    async def work(item: int) -> int:
        nonlocal peak, live
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.002)
        live -= 1
        return item * 2

    results = await gate.map(work, range(50))

    assert results == [i * 2 for i in range(50)]
    assert peak <= 3


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_breaker_opens_after_the_declared_failure_threshold() -> None:
    breaker = CircuitBreaker(
        name="text",
        posture=FailPosture.FAIL_CLOSED,
        failure_threshold=3,
        recovery_timeout_s=60.0,
    )

    async def boom() -> None:
        raise RuntimeError("peer down")

    for _ in range(3):
        with pytest.raises(RuntimeError):
            await breaker.call(boom)

    assert breaker.state == "open"
    # The 4th request costs NO peer call at all — that is the load shedding.
    with pytest.raises(BreakerOpenError):
        await breaker.call(boom)


@pytest.mark.asyncio
async def test_open_breaker_half_opens_after_the_recovery_window() -> None:
    clock = {"t": 0.0}
    breaker = CircuitBreaker(
        name="nlp",
        posture=FailPosture.FAIL_CLOSED,
        failure_threshold=1,
        recovery_timeout_s=10.0,
        time_func=lambda: clock["t"],
    )

    async def boom() -> None:
        raise RuntimeError("down")

    with pytest.raises(RuntimeError):
        await breaker.call(boom)
    assert breaker.state == "open"

    clock["t"] = 11.0

    async def ok() -> str:
        return "fine"

    assert await breaker.call(ok) == "fine"
    assert breaker.state == "closed"


@pytest.mark.asyncio
async def test_a_half_open_probe_that_fails_re_opens_immediately() -> None:
    clock = {"t": 0.0}
    breaker = CircuitBreaker(
        name="nlp",
        posture=FailPosture.FAIL_CLOSED,
        failure_threshold=1,
        recovery_timeout_s=10.0,
        time_func=lambda: clock["t"],
    )

    async def boom() -> None:
        raise RuntimeError("down")

    with pytest.raises(RuntimeError):
        await breaker.call(boom)
    clock["t"] = 11.0
    with pytest.raises(RuntimeError):
        await breaker.call(boom)
    assert breaker.state == "open"


def test_fail_posture_must_be_declared_at_construction() -> None:
    """Rule 06: a peer client carries a DECLARED fail posture — not an ad hoc one."""
    with pytest.raises(TypeError):
        CircuitBreaker(name="text")  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_breaker_success_resets_the_failure_run() -> None:
    breaker = CircuitBreaker(name="text", posture=FailPosture.FAIL_CLOSED, failure_threshold=3)

    async def boom() -> None:
        raise RuntimeError("blip")

    async def ok() -> int:
        return 1

    for _ in range(2):
        with pytest.raises(RuntimeError):
            await breaker.call(boom)
    await breaker.call(ok)
    for _ in range(2):
        with pytest.raises(RuntimeError):
            await breaker.call(boom)
    assert breaker.state == "closed", "an intermittent blip must not open the circuit"


# ---------------------------------------------------------------------------
# The one shared client
# ---------------------------------------------------------------------------


def test_shared_client_declares_every_timeout_phase() -> None:
    """B-1. A single 300 s scalar let a stalled peer hold a pool slot for five
    minutes; with `max_connections=100` and no POOL timeout, request 101 waited
    forever."""
    from guardrail.core.config import Settings
    from guardrail.main import build_http_client

    client = build_http_client(Settings())
    timeout = client.timeout

    for phase in ("connect", "read", "write", "pool"):
        value = getattr(timeout, phase)
        assert value is not None, f"{phase} timeout must be explicit"
        assert value < 300.0, f"{phase} timeout must be bounded well under 300s"


# ---------------------------------------------------------------------------
# End-to-end: 100 concurrent consultation sessions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_one_hundred_concurrent_screenings_all_resolve() -> None:
    """The owner's target as an executable gate.

    Everything guardrail owns runs for real (routing precondition, admission gate,
    screener, sanitization, containment, decision record); the `apps/nlp` peer is
    stubbed at the analyzer seam with a latency, because the number under test is
    guardrail's own queueing behaviour. `scripts/loadtest.py` is the same harness
    with percentile reporting.
    """
    from types import SimpleNamespace

    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound
    from guardrail.core.config import Settings
    from guardrail.main import build_admission_gates
    from guardrail.services.screening import Screener

    class _Analyzer:
        policy = SimpleNamespace(pii_labels=[], benign_labels=None)

        async def classify_tasks(self, task_names, text):
            await asyncio.sleep(0.005)
            return dict.fromkeys(task_names, "benign")

        async def extract_pii_entities(self, text):
            return []

        def model_for(self, check):
            return "stub"

    async def _build(app_state, tenant_id):
        return Screener(analyzer=_Analyzer(), tenant_id=tenant_id)

    original = screen_mod.build_screener
    screen_mod.build_screener = _build
    try:
        state = SimpleNamespace(admission_gates=build_admission_gates(Settings()))
        request = SimpleNamespace(
            app=SimpleNamespace(state=state),
            headers={"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"},
        )
        results = await asyncio.gather(
            *(screen_inbound(InboundScreenRequest(text="chest pain"), request) for _ in range(100))
        )
    finally:
        screen_mod.build_screener = original

    assert len(results) == 100
    assert all(r.decision == "allow" for r in results)
    # Every session got its own containment nonce — no reuse across concurrent work.
    assert len({r.nonce for r in results}) == 100
    assert state.admission_gates["request"].in_flight == 0
