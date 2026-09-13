"""TASK-957 F-5 (harness half) — `hope_usage_emission_failed_total` on this side of the hop.

The retry and the Redis spool landed under TASK-959 P-HARNESS; the counter did not
(`§10.4`: *"no Prometheus counter on the Python side (structured warnings; the gateway half
owns the metric)"*). That left the loudest half of the finding open: unbilled revenue that
"surfaces only as a warn line" is exactly as invisible on this side of the POST as it was on
the other, and the gateway's counter cannot see a batch that never reached it.

The metric NAME is shared with the gateway deliberately, so one Grafana query covers both
sides of the hop. What is pinned here is that each way of GIVING UP on a batch increments
once, with a label pair that says which lane lost what:

* ``reason="rejected"`` — apps/api refused the body (terminal 4xx). Dropped on purpose.
* ``reason="spooled"``  — the retry budget is spent; the batch is held for a later drain.
  Counted because the row is not billed YET and may never be; a drain that later lands it is
  visible as ``harness.report_trajectory.recovered``, not as a decrement (counters only rise).
* ``reason="dropped"``  — a bounded buffer evicted a batch. Permanently lost.

A drain failure is deliberately NOT counted: the spool re-queues that entry itself, so
counting it would charge one outage once per tick forever.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from prometheus_client import REGISTRY

from harness.services.api_client import ApiClient, TrajectoryStepInput, trajectory_body
from harness.temporal import trajectory_delivery
from harness.temporal.compute_metering import ComputeSample, ComputeSampleBuffer
from harness.temporal.trajectory_delivery import (
    DeliveryOutcome,
    TrajectorySpool,
    deliver_trajectory,
    deliver_trajectory_body,
    reset_trajectory_spool,
)

METRIC = "hope_usage_emission_failed_total"


def _reading(operation: str, reason: str) -> float:
    return REGISTRY.get_sample_value(METRIC, {"operation": operation, "reason": reason}) or 0.0


def _step(seq: int = 0) -> TrajectoryStepInput:
    return TrajectoryStepInput(
        tenant_id="t-1",
        session_id="wf-1",
        run_id="run-1",
        seq=seq,
        step_type="NODE",
        name="core.agent",
        status="OK",
        started_at="2026-09-12T00:00:00+00:00",
    )


def _sample(activity_id: str = "1") -> ComputeSample:
    return ComputeSample(
        tenant_id="t-1",
        session_id="wf-1",
        run_id="run-1",
        activity_id=activity_id,
        attempt=1,
        activity_type="core.agent",
        cpu_ms=1.25,
        wall_ms=40.0,
    )


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://api:8868",
        internal_prefix="/internal/harness",
        service_token="svc-token",
        transport=httpx.MockTransport(handler),
    )


def _refuse(_request: httpx.Request) -> httpx.Response:
    """A terminal 4xx — apps/api refused the body."""
    return httpx.Response(422, json={"message": "unprocessable"})


def _unreachable(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused")


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    monkeypatch.setattr(trajectory_delivery, "BACKOFF_BASE_S", 0.0)
    monkeypatch.setattr(trajectory_delivery, "BACKOFF_JITTER_S", 0.0)
    reset_trajectory_spool()
    yield
    reset_trajectory_spool()


@pytest.fixture
def spool() -> TrajectorySpool:
    return TrajectorySpool(redis_factory=lambda: None)


class TestRejected:
    @pytest.mark.asyncio
    async def test_a_refused_step_batch_counts_once_under_trajectory(self, spool):
        before = _reading("trajectory", "rejected")
        landed = await deliver_trajectory(_client(_refuse), steps=[_step()], spool=spool)
        assert landed is False
        assert _reading("trajectory", "rejected") - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_a_refused_compute_batch_counts_under_workflow_step(self, spool):
        before = _reading("workflow.step", "rejected")
        landed = await deliver_trajectory(
            _client(_refuse), compute_samples=[_sample()], spool=spool
        )
        assert landed is False
        assert _reading("workflow.step", "rejected") - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_a_mixed_batch_counts_both_halves(self, spool):
        before_steps = _reading("trajectory", "rejected")
        before_cpu = _reading("workflow.step", "rejected")
        await deliver_trajectory(
            _client(_refuse), steps=[_step()], compute_samples=[_sample()], spool=spool
        )
        assert _reading("trajectory", "rejected") - before_steps == pytest.approx(1.0)
        assert _reading("workflow.step", "rejected") - before_cpu == pytest.approx(1.0)


class TestSpooled:
    @pytest.mark.asyncio
    async def test_an_exhausted_budget_counts_once_and_spools(self, spool):
        before = _reading("trajectory", "spooled")
        landed = await deliver_trajectory(_client(_unreachable), steps=[_step()], spool=spool)
        assert landed is False
        assert spool.pending() == 1
        assert _reading("trajectory", "spooled") - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_a_drain_failure_is_not_counted_because_the_spool_requeues_it(self, spool):
        body = trajectory_body([_step()], ())
        await spool.offer(body)
        before_spooled = _reading("trajectory", "spooled")
        before_dropped = _reading("trajectory", "dropped")

        outcome = await deliver_trajectory_body(
            _client(_unreachable), body, spool=spool, allow_spool=False
        )

        assert outcome is DeliveryOutcome.FAILED
        assert _reading("trajectory", "spooled") == pytest.approx(before_spooled)
        assert _reading("trajectory", "dropped") == pytest.approx(before_dropped)


class TestDropped:
    @pytest.mark.asyncio
    async def test_a_spool_overflow_counts_the_batch_it_evicted(self):
        one = TrajectorySpool(redis_factory=lambda: None, max_entries=1)
        await one.offer(trajectory_body((), [_sample("evicted")]))

        before = _reading("workflow.step", "dropped")
        await one.offer(trajectory_body([_step()], ()))

        assert one.pending() == 1
        # The EVICTED batch is the lost one — compute samples here, not the steps just offered.
        assert _reading("workflow.step", "dropped") - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_a_compute_sample_buffer_overflow_counts_workflow_step(self):
        async def _never(_batch: Any) -> bool:  # pragma: no cover - not reached
            return True

        buffer = ComputeSampleBuffer(deliver=_never, capacity=1, threshold=10_000)
        buffer.offer(_sample("a"))

        before = _reading("workflow.step", "dropped")
        buffer.offer(_sample("b"))

        assert len(buffer) == 1
        assert _reading("workflow.step", "dropped") - before == pytest.approx(1.0)


class TestTheDrainDistinguishesRefusalFromFailure:
    """A permanently-refusable entry must not sit at the front of the spool forever.

    `_deliver` answered a bare `True`/`False`, so the drain could not tell "apps/api refused
    this body and always will" from "the gateway is down right now". It re-queued BOTH at the
    front — and the refusal is the one that can never leave, so one poisoned entry blocked
    every later batch that worker spooled. Unbounded billing loss behind a `warn` line, which
    is the exact shape of the finding F-5 opened with.

    The refusal is counted exactly ONCE, by `_deliver` itself, on whichever path met it. The
    drain drops the entry and says nothing further: a second increment here would charge one
    dead body twice.
    """

    @pytest.mark.asyncio
    async def test_a_refused_entry_is_dropped_and_the_next_one_gets_through(self, spool):
        await spool.offer(trajectory_body([_step(1)], ()))
        await spool.offer(trajectory_body([_step(2)], ()))

        posted: list[dict[str, Any]] = []

        def _handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            if body["steps"][0]["seq"] == 1:
                return httpx.Response(422, json={"message": "unprocessable"})
            posted.append(body)
            return httpx.Response(202, json={"accepted": 1})

        client = _client(_handler)
        before = _reading("trajectory", "rejected")

        delivered = await spool.drain(
            lambda body: deliver_trajectory_body(client, body, spool=spool, allow_spool=False),
            max_entries=5,
        )

        assert delivered == 1
        assert spool.pending() == 0  # the poison entry is GONE, not back at the front
        assert [b["steps"][0]["seq"] for b in posted] == [2]
        assert _reading("trajectory", "rejected") - before == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_a_transient_failure_still_requeues_at_the_front_and_is_not_counted(self, spool):
        await spool.offer(trajectory_body([_step(1)], ()))
        await spool.offer(trajectory_body([_step(2)], ()))

        before_rejected = _reading("trajectory", "rejected")
        before_spooled = _reading("trajectory", "spooled")

        client = _client(_unreachable)
        delivered = await spool.drain(
            lambda body: deliver_trajectory_body(client, body, spool=spool, allow_spool=False),
            max_entries=5,
        )

        assert delivered == 0
        assert spool.pending() == 2
        assert _reading("trajectory", "rejected") == pytest.approx(before_rejected)
        assert _reading("trajectory", "spooled") == pytest.approx(before_spooled)

        # …and the re-queued entry kept its place at the FRONT.
        seen: list[int] = []

        async def _ok(body: dict[str, Any]) -> bool:
            seen.append(body["steps"][0]["seq"])
            return True

        assert await spool.drain(_ok, max_entries=5) == 2
        assert seen == [1, 2]


class TestSuccess:
    @pytest.mark.asyncio
    async def test_a_delivered_batch_counts_nothing(self, spool):
        def _ok(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(202, json={"accepted": 1})

        before = [
            _reading(op, reason)
            for op in ("trajectory", "workflow.step")
            for reason in ("rejected", "spooled", "dropped")
        ]
        assert await deliver_trajectory(_client(_ok), steps=[_step()], spool=spool) is True
        after = [
            _reading(op, reason)
            for op in ("trajectory", "workflow.step")
            for reason in ("rejected", "spooled", "dropped")
        ]
        assert after == before
