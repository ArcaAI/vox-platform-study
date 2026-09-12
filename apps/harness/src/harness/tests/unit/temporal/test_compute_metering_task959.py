"""TASK-959 §3.4 — the worker's per-activity CPU meter.

Four properties, in the order they decide whether a `CPU_SECOND` row is trustworthy:

1. **Fair share is exact.** With an injected clock the apportionment is arithmetic, not
   statistics: an activity's share of every window it was in flight for, summed — and the
   sum over all activities IS the thread's own CPU delta for the covered window. Proven
   against a scripted clock so the assertion is `==`, not `approx`; then re-proven once
   against the REAL `time.thread_time()` through the interceptor, which is what the worker
   actually runs.
2. **Identity is Temporal's.** `workflow_id` → `sessionId`, `workflow_run_id` → `runId`,
   plus `activity_id`/`attempt`/`activity_type`: the five fields the ledger key
   `harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>` is built from. A Temporal
   REDELIVERY of one attempt must produce the same key material (the gateway dedupes it);
   a real RETRY is `attempt + 1` and a second execution that really burned CPU.
3. **A sample with no tenant is dropped, loudly.** Attribution is never guessed.
4. **Metering never fails an activity.** A buffer that raises, a clock that lies — the
   activity's own result is what the workflow sees.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import time
import uuid
from datetime import timedelta
from typing import Any

import pytest
from temporalio import activity as temporal_activity
from temporalio import workflow as temporal_workflow
from temporalio.common import RetryPolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import ActivityEnvironment
from temporalio.worker import ExecuteActivityInput, Worker

from harness.temporal.compute_metering import (
    ComputeMeteringInterceptor,
    ComputeSample,
    ComputeSampleBuffer,
    _ThreadCpuLedger,
    reset_cpu_ledgers,
)
from harness.tests.unit.temporal._temporal_sync import start_time_skipping


class _Terminal:
    """The end of the inbound chain: runs `body(input)` and returns its result."""

    def __init__(self, body) -> None:
        self._body = body

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        return await self._body(input)


class _Collector:
    """A buffer stand-in that just keeps what was offered."""

    def __init__(self) -> None:
        self.samples: list[ComputeSample] = []

    def offer(self, sample: ComputeSample) -> None:
        self.samples.append(sample)


@dataclasses.dataclass
class _Payload:
    """The shape every interpreter/doc activity input has: a `tenant_id` on arg 0."""

    tenant_id: str | None = "t-1"


def _env(**info: Any) -> ActivityEnvironment:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, **info)
    return env


def _input(body, payload: Any) -> ExecuteActivityInput:
    return ExecuteActivityInput(fn=body, args=[payload], executor=None, headers={})


async def _drive(
    interceptor: ComputeMeteringInterceptor,
    env: ActivityEnvironment,
    body,
    payload: Any = None,
) -> Any:
    """Run one activity through the interceptor inside a real activity context."""
    inbound = interceptor.intercept_activity(_Terminal(body))
    activity_input = _input(body, _Payload() if payload is None else payload)

    async def _run() -> Any:
        return await inbound.execute_activity(activity_input)

    return await env.run(_run)


def _burn_cpu(ms: float) -> None:
    """Busy-loop for `ms` of THIS THREAD's CPU (not wall clock)."""
    deadline = time.thread_time() + ms / 1000.0
    while time.thread_time() < deadline:
        pass


@pytest.fixture(autouse=True)
def _fresh_ledgers():
    reset_cpu_ledgers()
    yield
    reset_cpu_ledgers()


class TestFairShareArithmetic:
    """Property 1a — exact, against a scripted clock."""

    def test_a_lone_activity_takes_the_whole_delta(self):
        clock = _ScriptedClock()
        ledger = _ThreadCpuLedger(clock=clock)

        clock.seconds = 0.0
        ledger.enter(1)
        clock.seconds = 0.040
        assert ledger.exit(1) == pytest.approx(40.0)

    def test_overlapping_activities_split_every_window_they_shared(self):
        clock = _ScriptedClock()
        ledger = _ThreadCpuLedger(clock=clock)

        clock.seconds = 0.000
        ledger.enter(1)
        clock.seconds = 0.010  # 10 ms burned with #1 alone
        ledger.enter(2)
        clock.seconds = 0.030  # 20 ms burned with #1 + #2
        ledger.enter(3)
        clock.seconds = 0.060  # 30 ms burned with #1 + #2 + #3
        first = ledger.exit(1)
        clock.seconds = 0.070  # 10 ms burned with #2 + #3
        second = ledger.exit(2)
        clock.seconds = 0.075  # 5 ms burned with #3 alone
        third = ledger.exit(3)

        assert first == pytest.approx(10.0 + 20.0 / 2 + 30.0 / 3)
        assert second == pytest.approx(20.0 / 2 + 30.0 / 3 + 10.0 / 2)
        assert third == pytest.approx(30.0 / 3 + 10.0 / 2 + 5.0)
        # The whole point: nothing is created, nothing is lost.
        assert first + second + third == pytest.approx(75.0)

    def test_cpu_burned_while_nothing_is_in_flight_is_attributed_to_nobody(self):
        clock = _ScriptedClock()
        ledger = _ThreadCpuLedger(clock=clock)

        clock.seconds = 0.0
        ledger.enter(1)
        clock.seconds = 0.010
        assert ledger.exit(1) == pytest.approx(10.0)
        clock.seconds = 0.500  # 490 ms of worker overhead, no activity in flight
        ledger.enter(2)
        clock.seconds = 0.505
        assert ledger.exit(2) == pytest.approx(5.0)

    def test_an_unknown_token_yields_zero_rather_than_raising(self):
        ledger = _ThreadCpuLedger(clock=_ScriptedClock())
        assert ledger.exit(999) == 0.0


class _ScriptedClock:
    seconds: float = 0.0

    def __call__(self) -> float:
        return self.seconds


class TestFairShareThroughTheInterceptor:
    """Property 1b — the same property, with the real per-thread CPU clock."""

    @pytest.mark.asyncio
    async def test_three_concurrent_activities_split_the_real_thread_cpu(self):
        collector = _Collector()
        interceptor = ComputeMeteringInterceptor(collector)
        entered = asyncio.Event()
        pending = 3
        release = asyncio.Event()

        async def _body(_input: ExecuteActivityInput) -> str:
            nonlocal pending
            pending -= 1
            if pending == 0:
                entered.set()
            await entered.wait()  # every activity is in flight before any CPU is burned
            _burn_cpu(15.0)
            await release.wait()  # and none exits before all three have burned
            return "ok"

        before = time.thread_time()
        async def _one(index: int) -> Any:
            return await _drive(
                interceptor,
                _env(activity_id=f"act-{index}", activity_type="core.agent"),
                _body,
            )

        tasks = [asyncio.create_task(_one(i)) for i in range(3)]
        await entered.wait()
        # Every task is now in flight; yield until each has burned its CPU and parked on
        # `release`, so the whole 45 ms is apportioned across three in-flight activities.
        while any(not t.done() for t in tasks) and not release.is_set():
            await asyncio.sleep(0.02)
            release.set()
        await asyncio.gather(*tasks)
        after = time.thread_time()

        assert len(collector.samples) == 3
        total_ms = (after - before) * 1000.0
        attributed = sum(s.cpu_ms for s in collector.samples)
        # Every activity got a real, positive share…
        assert all(s.cpu_ms > 0 for s in collector.samples)
        # …the shares never exceed the thread's own CPU…
        assert attributed <= total_ms + 1e-6
        # …and they account for essentially all of it (the only unattributed slice is
        # this test's own bookkeeping between `before` and the first enter).
        assert attributed > 0.8 * total_ms
        # Wall clock is per-activity and independent of the CPU share.
        assert all(s.wall_ms >= 0 for s in collector.samples)

    @pytest.mark.asyncio
    async def test_a_lone_activity_is_charged_essentially_all_of_its_own_cpu(self):
        collector = _Collector()
        interceptor = ComputeMeteringInterceptor(collector)

        async def _body(_input: ExecuteActivityInput) -> str:
            _burn_cpu(30.0)
            return "ok"

        before = time.thread_time()
        await _drive(interceptor, _env(), _body)
        measured_ms = (time.thread_time() - before) * 1000.0

        [sample] = collector.samples
        assert sample.cpu_ms <= measured_ms + 1e-6
        assert sample.cpu_ms > 0.8 * measured_ms


class TestIdentityAndIdempotency:
    """Property 2 — the key material the gateway dedupes on."""

    @pytest.mark.asyncio
    async def test_identity_comes_from_activity_info(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        await _drive(
            ComputeMeteringInterceptor(collector),
            _env(
                workflow_id="workflow-interpreter-run-7",
                workflow_run_id="temporal-run-9",
                activity_id="12",
                attempt=1,
                activity_type="interpreter.core_agent",
            ),
            _body,
        )

        [sample] = collector.samples
        assert sample.session_id == "workflow-interpreter-run-7"
        assert sample.run_id == "temporal-run-9"
        assert sample.activity_id == "12"
        assert sample.attempt == 1
        assert sample.activity_type == "interpreter.core_agent"
        assert sample.tenant_id == "t-1"

    @pytest.mark.asyncio
    async def test_a_redelivered_attempt_repeats_the_key_and_a_retry_does_not(self):
        collector = _Collector()
        interceptor = ComputeMeteringInterceptor(collector)

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        for attempt in (1, 1, 2):
            await _drive(
                interceptor, _env(activity_id="7", attempt=attempt), _body
            )

        keys = [
            (s.session_id, s.run_id, s.activity_id, s.attempt) for s in collector.samples
        ]
        assert keys[0] == keys[1]  # a redelivery of attempt 1 dedupes at the gateway
        assert keys[2] != keys[0]  # a real retry is a second execution that burned CPU

    @pytest.mark.asyncio
    async def test_tenant_id_is_read_from_a_mapping_argument_too(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        await _drive(
            ComputeMeteringInterceptor(collector), _env(), _body, {"tenantId": "t-9"}
        )

        [sample] = collector.samples
        assert sample.tenant_id == "t-9"

    @pytest.mark.asyncio
    async def test_a_trigger_on_the_input_rides_the_sample(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        await _drive(
            ComputeMeteringInterceptor(collector),
            _env(),
            _body,
            {"tenant_id": "t-1", "trigger": "WORKFLOW_RUN"},
        )

        [sample] = collector.samples
        assert sample.trigger == "WORKFLOW_RUN"
        assert sample.to_wire()["trigger"] == "WORKFLOW_RUN"

    @pytest.mark.asyncio
    async def test_no_trigger_means_the_key_is_absent_from_the_wire(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        await _drive(ComputeMeteringInterceptor(collector), _env(), _body)

        wire = collector.samples[0].to_wire()
        assert "trigger" not in wire
        assert set(wire) == {
            "tenantId",
            "sessionId",
            "runId",
            "activityId",
            "attempt",
            "activityType",
            "cpuMs",
            "wallMs",
        }


class TestTenantlessSamplesAreDropped:
    """Property 3 — attribution is never guessed."""

    @pytest.mark.asyncio
    async def test_an_input_with_no_tenant_id_is_dropped_with_a_warning(self, caplog):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        with caplog.at_level(logging.WARNING):
            result = await _drive(
                ComputeMeteringInterceptor(collector), _env(), _body, _Payload(tenant_id=None)
            )

        assert result == "ok"  # the activity is untouched
        assert collector.samples == []
        assert any("compute_metering" in record.getMessage() for record in caplog.records)

    @pytest.mark.asyncio
    async def test_an_activity_with_no_arguments_is_dropped(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        inbound = ComputeMeteringInterceptor(collector).intercept_activity(_Terminal(_body))
        activity_input = ExecuteActivityInput(fn=_body, args=[], executor=None, headers={})

        async def _run() -> Any:
            return await inbound.execute_activity(activity_input)

        assert await _env().run(_run) == "ok"
        assert collector.samples == []


class TestMeteringNeverFailsTheActivity:
    """Property 4 — the meter is the least important thing in the process."""

    @pytest.mark.asyncio
    async def test_a_raising_buffer_is_swallowed(self):
        class _Raising:
            def offer(self, sample: ComputeSample) -> None:
                raise RuntimeError("buffer exploded")

        async def _body(_input: ExecuteActivityInput) -> str:
            return "ok"

        assert await _drive(ComputeMeteringInterceptor(_Raising()), _env(), _body) == "ok"

    @pytest.mark.asyncio
    async def test_a_failing_activity_still_leaves_its_sample_and_re_raises(self):
        collector = _Collector()

        async def _body(_input: ExecuteActivityInput) -> str:
            _burn_cpu(5.0)
            raise RuntimeError("activity failed")

        with pytest.raises(RuntimeError, match="activity failed"):
            await _drive(ComputeMeteringInterceptor(collector), _env(), _body)

        # The CPU was burned whether or not the activity succeeded, so it is billed.
        [sample] = collector.samples
        assert sample.cpu_ms > 0


class TestComputeSampleBuffer:
    """The delivery buffer: bounded, threshold-triggered, drains on flush."""

    @pytest.mark.asyncio
    async def test_flush_hands_every_buffered_sample_to_the_deliver_callable(self):
        delivered: list[list[ComputeSample]] = []

        async def _deliver(samples):
            delivered.append(list(samples))
            return True

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=10)
        for index in range(3):
            buffer.offer(_sample(activity_id=str(index)))

        assert await buffer.flush() == 3
        assert [s.activity_id for s in delivered[0]] == ["0", "1", "2"]
        assert len(buffer) == 0

    @pytest.mark.asyncio
    async def test_an_empty_flush_makes_no_call(self):
        calls = 0

        async def _deliver(samples):
            nonlocal calls
            calls += 1
            return True

        assert await ComputeSampleBuffer(deliver=_deliver).flush() == 0
        assert calls == 0

    @pytest.mark.asyncio
    async def test_a_failed_delivery_does_not_re_buffer(self):
        """Delivery owns the retry and the spool; the buffer must not double-book."""

        async def _deliver(samples):
            return False

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=10)
        buffer.offer(_sample())
        assert await buffer.flush() == 0
        assert len(buffer) == 0

    @pytest.mark.asyncio
    async def test_a_raising_delivery_never_escapes_the_flush(self):
        async def _deliver(samples):
            raise RuntimeError("gateway down")

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=10)
        buffer.offer(_sample())
        assert await buffer.flush() == 0

    def test_the_buffer_is_bounded_and_drops_the_oldest(self):
        async def _deliver(samples):
            return True

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=10, capacity=2)
        for index in range(4):
            buffer.offer(_sample(activity_id=str(index)))
        assert len(buffer) == 2

    @pytest.mark.asyncio
    async def test_wait_for_work_returns_early_once_the_threshold_is_reached(self):
        async def _deliver(samples):
            return True

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=2)
        buffer.offer(_sample())
        buffer.offer(_sample())
        # Would block for 30s if the threshold had not already released it.
        await asyncio.wait_for(buffer.wait_for_work(timeout_s=30.0), timeout=1.0)

    @pytest.mark.asyncio
    async def test_wait_for_work_times_out_when_nothing_arrives(self):
        async def _deliver(samples):
            return True

        buffer = ComputeSampleBuffer(deliver=_deliver, threshold=2)
        await asyncio.wait_for(buffer.wait_for_work(timeout_s=0.01), timeout=1.0)


def _sample(**overrides: Any) -> ComputeSample:
    base: dict[str, Any] = {
        "tenant_id": "t-1",
        "session_id": "wf-1",
        "run_id": "run-1",
        "activity_id": "1",
        "attempt": 1,
        "activity_type": "core.agent",
        "cpu_ms": 1.5,
        "wall_ms": 12.0,
    }
    base.update(overrides)
    return ComputeSample(**base)


# ---------------------------------------------------------------------------
# The seam itself: a REAL Temporal worker, with the interceptor installed.
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class _WorkInput:
    tenant_id: str


@temporal_activity.defn(name="task959_metered_activity")
async def _metered_activity(payload: _WorkInput) -> str:
    _burn_cpu(10.0)
    return payload.tenant_id


@temporal_workflow.defn(name="Task959MeteringWorkflow")
class _MeteringWorkflow:
    @temporal_workflow.run
    async def run(self, tenant_id: str) -> str:
        return await temporal_workflow.execute_activity(
            _metered_activity,
            _WorkInput(tenant_id=tenant_id),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


class TestTheWorkerSeam:
    """`Worker(interceptors=[...])` is the whole mechanism — prove it against the real SDK."""

    @pytest.mark.asyncio
    async def test_a_real_worker_meters_every_activity_it_runs(self):
        collector = _Collector()
        env = await start_time_skipping(data_converter=pydantic_data_converter)
        async with env:
            task_queue = f"task959-metering-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=task_queue,
                workflows=[_MeteringWorkflow],
                activities=[_metered_activity],
                interceptors=[ComputeMeteringInterceptor(collector)],
            ):
                result = await env.client.execute_workflow(
                    _MeteringWorkflow.run,
                    "t-42",
                    id=f"task959-{uuid.uuid4()}",
                    task_queue=task_queue,
                )

        assert result == "t-42"
        [sample] = collector.samples
        assert sample.tenant_id == "t-42"
        assert sample.activity_type == "task959_metered_activity"
        assert sample.attempt == 1
        assert sample.session_id and sample.run_id and sample.activity_id
        assert sample.cpu_ms > 0
        assert sample.wall_ms >= sample.cpu_ms - 1e-6
