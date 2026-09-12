"""TASK-959 §3.4 — per-activity worker CPU, measured by a Temporal worker interceptor.

Every workflow node, sensor, claim-check write and run-event emission in this service is a
Temporal ACTIVITY. Their wall-clock is already recorded per trajectory step, but wall-clock
on an LLM node is 20 s of *waiting on apps/text*, not 20 s of worker CPU — and no CPU clock
was read anywhere in the worker. So "CPU time for each workflow" (the owner's measurement
model, M-6) had no source at all.

This module is that source, and it is deliberately a WORKER INTERCEPTOR rather than a change
to 94 activity bodies: ``Worker(interceptors=[...])`` wraps every activity execution without
touching any of them, and the repo already relies on the same seam (the OpenTelemetry
``TracingInterceptor`` wired on the client in ``temporal/client.py`` IS a worker interceptor).

## What is measured, and what is honestly not

``time.thread_time()`` is the CPU the worker's PYTHON actually burned on the thread the
activity's coroutine runs on. All 94 activities are ``async def``, so they share one event-loop
thread, admitted up to ``max_concurrent_activities``. Concurrent activities therefore share one
CPU clock, and the only defensible per-activity figure is a FAIR SHARE of it: at every
enter/exit transition the thread's CPU delta since the last transition is apportioned equally
across the activities in flight during that window (owner decision D-5).

Three properties make that approximation safe to bill from:

* it is EXACT when one activity runs alone;
* the shares always SUM to the thread's true CPU over the windows covered, so the meter can
  neither invent nor lose CPU;
* CPU burned while nothing is in flight (poller overhead, housekeeping ticks) is attributed to
  NOBODY rather than smeared over the next activity.

Deliberately NOT measured, and reported rather than hidden (§3.5): the SDK's Rust core threads;
the sandboxed workflow bodies and their replay (reading a clock inside a ``@workflow.defn`` is
a determinism hazard — rule 06); and the CPU of a SYNC activity, which runs on an executor
thread while this interceptor's coroutine waits on the loop thread (there are none today —
every registered activity is ``async def``). All three land in the pod's
``container_cpu_usage_seconds_total``, which is what the monthly reconciliation compares
against, so the unattributed residual is a reported number.

## Failure posture

The meter is the least important thing in this process. Every fault — a clock that lies, a
buffer that raises, an input whose tenant cannot be established — costs at most one sample and
NEVER the activity's own result.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from temporalio import activity
from temporalio.worker import ActivityInboundInterceptor, ExecuteActivityInput, Interceptor

#: Flush cadence for the per-worker sample buffer. A sample is worth nothing until the gateway
#: has it, and a worker rolled mid-window must not lose more than this much metering, so the
#: interval is short relative to the graceful-shutdown budget rather than tuned for throughput.
FLUSH_INTERVAL_S = 5.0

#: Flush early once this many samples are buffered, so a busy worker posts in bounded batches
#: instead of one large body every interval.
FLUSH_THRESHOLD = 100

#: Hard ceiling on buffered samples. Reached only when the gateway has been unreachable for a
#: long time AND the spool is also full; the oldest are dropped, because the alternative is an
#: unbounded queue in a process that holds clinical work.
BUFFER_CAPACITY = 10_000


@dataclass(frozen=True)
class ComputeSample:
    """One activity execution's compute, as the gateway's `computeSamples[]` needs it.

    The five identity fields are exactly what the ledger key
    ``harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>`` is built from (§3.4). That key
    is derived on the TypeScript side and deliberately not duplicated here — this model's job
    is to carry the material, not to re-spell the key and let the two drift.

    ``attempt`` is what separates a Temporal REDELIVERY of one execution (same attempt, same
    key, deduped at the gateway) from a real RETRY (attempt + 1, a second execution that
    really burned CPU).
    """

    tenant_id: str
    session_id: str
    run_id: str
    activity_id: str
    attempt: int
    activity_type: str
    cpu_ms: float
    wall_ms: float
    #: OD-E's closed usage-trigger vocabulary, when the activity input carries one. No activity
    #: input declares a `trigger` field today, so this is absent in practice — stated as an
    #: optional rather than defaulted, because a guessed trigger is worse than none.
    trigger: str | None = None

    def to_wire(self) -> dict[str, Any]:
        """camelCase wire object, `trigger` omitted when absent (strict apps/api DTO).

        ``cpuMs``/``wallMs`` are FLOATS rounded to microsecond resolution. A fast activity
        burns well under a millisecond of CPU, so an integer field would round the majority of
        this worker's samples to zero — the gateway DTO must accept a number, not an int.
        """
        wire: dict[str, Any] = {
            "tenantId": self.tenant_id,
            "sessionId": self.session_id,
            "runId": self.run_id,
            "activityId": self.activity_id,
            "attempt": self.attempt,
            "activityType": self.activity_type,
            "cpuMs": round(self.cpu_ms, 3),
            "wallMs": round(self.wall_ms, 3),
        }
        if self.trigger:
            wire["trigger"] = self.trigger
        return wire


class _ThreadCpuLedger:
    """Fair-share apportionment of ONE thread's CPU across the activities in flight on it.

    Kept per-thread rather than per-process because ``time.thread_time()`` is a per-thread
    clock: mixing two threads' readings into one delta would produce a number that is not any
    thread's CPU. The event loop is single-threaded, so in practice there is exactly one of
    these — the partitioning is what makes that an invariant instead of an assumption.

    ``clock`` is injectable so the apportionment arithmetic can be proven with ``==`` against a
    scripted clock rather than sampled statistically.
    """

    def __init__(self, clock: Callable[[], float] = time.thread_time) -> None:
        self._clock = clock
        self._inflight: dict[int, float] = {}
        self._mark = clock()

    def __len__(self) -> int:
        return len(self._inflight)

    def _apportion(self) -> None:
        """Split the CPU burned since the last transition across whoever was in flight."""
        now = self._clock()
        delta_ms = max(0.0, (now - self._mark) * 1000.0)
        self._mark = now
        if not self._inflight:
            # Worker overhead: pollers, heartbeats, housekeeping. Attributed to nobody —
            # smearing it onto the next activity would bill one tenant for the fleet's idle.
            return
        share = delta_ms / len(self._inflight)
        for token in self._inflight:
            self._inflight[token] += share

    def enter(self, token: int) -> None:
        """Admit one activity. Apportion FIRST: the newcomer did not run during that window."""
        self._apportion()
        self._inflight[token] = 0.0

    def exit(self, token: int) -> float:
        """Release one activity and return its accumulated share in milliseconds.

        Apportion FIRST, because the leaver WAS in flight during the window just ended.
        An unknown token yields ``0.0``: a meter must not raise into an activity's teardown.
        """
        self._apportion()
        return self._inflight.pop(token, 0.0)


#: One ledger per thread. ``dict.setdefault`` is atomic under the GIL, so no lock is needed to
#: get-or-create; each ledger is then touched only by its own thread.
_LEDGERS: dict[int, _ThreadCpuLedger] = {}
_NEXT_TOKEN = threading.local()


def _ledger() -> _ThreadCpuLedger:
    ident = threading.get_ident()
    existing = _LEDGERS.get(ident)
    if existing is not None:
        return existing
    return _LEDGERS.setdefault(ident, _ThreadCpuLedger())


def _next_token() -> int:
    """A per-thread monotonic token identifying one in-flight activity."""
    value = getattr(_NEXT_TOKEN, "value", 0) + 1
    _NEXT_TOKEN.value = value
    return value


def reset_cpu_ledgers() -> None:
    """Drop every thread's ledger. For tests, which must not inherit another test's marks."""
    _LEDGERS.clear()


class _SampleSink(Protocol):
    def offer(self, sample: ComputeSample) -> None: ...


class ComputeSampleBuffer:
    """Per-worker buffer of compute samples, flushed through the trajectory POST.

    ``offer`` is SYNCHRONOUS and allocation-only: it runs in an activity's teardown, where
    awaiting (or spawning a task) would tangle the meter with activity cancellation. The flush
    is somebody else's turn of the loop — the worker's background flusher, and once more at
    graceful shutdown.

    ``deliver`` returns whether the batch landed. A batch that did NOT land is NOT re-buffered:
    the delivery layer owns the retry and the Redis spool (TASK-957 F-5), and re-buffering on
    top of that would double-book every sample.
    """

    def __init__(
        self,
        *,
        deliver: Callable[[Sequence[ComputeSample]], Awaitable[bool]],
        threshold: int = FLUSH_THRESHOLD,
        capacity: int = BUFFER_CAPACITY,
    ) -> None:
        self._deliver = deliver
        self._threshold = max(1, threshold)
        self._samples: deque[ComputeSample] = deque(maxlen=max(1, capacity))
        self._ready = asyncio.Event()
        self._dropped = 0

    def __len__(self) -> int:
        return len(self._samples)

    def offer(self, sample: ComputeSample) -> None:
        full = len(self._samples) == self._samples.maxlen
        self._samples.append(sample)
        if full:
            self._dropped += 1
            activity.logger.warning(
                "harness.compute_metering.buffer_overflow",
                extra={"dropped_total": self._dropped, "capacity": self._samples.maxlen},
            )
        if len(self._samples) >= self._threshold:
            self._ready.set()

    async def wait_for_work(self, *, timeout_s: float = FLUSH_INTERVAL_S) -> None:
        """Sleep until the threshold is reached or ``timeout_s`` elapses, whichever is first."""
        with contextlib.suppress(TimeoutError, asyncio.TimeoutError):
            await asyncio.wait_for(self._ready.wait(), timeout_s)
        self._ready.clear()

    async def flush(self) -> int:
        """Deliver everything buffered; returns how many samples LANDED.

        The buffer is emptied before the POST so an activity finishing mid-flush is never
        delivered twice. Never raises: a metering flush must not take down the loop it runs on.
        """
        if not self._samples:
            return 0
        batch = list(self._samples)
        self._samples.clear()
        self._ready.clear()
        try:
            return len(batch) if await self._deliver(batch) else 0
        except Exception as exc:  # noqa: BLE001 — metering never breaks the worker
            activity.logger.warning(
                "harness.compute_metering.flush_failed",
                extra={"samples": len(batch), "error": str(exc)},
            )
            return 0


class ComputeMeteringInterceptor(Interceptor):
    """Worker interceptor that meters every activity execution's CPU and wall clock.

    Additive to whatever the CLIENT already installs: ``Worker`` prepends the client's
    interceptors to the ones it is given, so passing this one does not displace the
    OpenTelemetry ``TracingInterceptor``.
    """

    def __init__(self, sink: _SampleSink) -> None:
        self._sink = sink

    def intercept_activity(
        self, next: ActivityInboundInterceptor
    ) -> ActivityInboundInterceptor:
        return _ComputeMeteringActivityInbound(next, self._sink)


class _ComputeMeteringActivityInbound(ActivityInboundInterceptor):
    def __init__(self, next: ActivityInboundInterceptor, sink: _SampleSink) -> None:
        super().__init__(next)
        self._sink = sink

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        ledger = _ledger()
        token = _next_token()
        ledger.enter(token)
        wall_started = time.perf_counter()
        try:
            return await self.next.execute_activity(input)
        finally:
            # The CPU was burned whether the activity succeeded, failed or was cancelled, so
            # it is metered on every exit — and this whole block is best-effort.
            cpu_ms = ledger.exit(token)
            wall_ms = (time.perf_counter() - wall_started) * 1000.0
            self._offer(input, cpu_ms=cpu_ms, wall_ms=wall_ms)

    def _offer(self, input: ExecuteActivityInput, *, cpu_ms: float, wall_ms: float) -> None:
        try:
            sample = _build_sample(input, cpu_ms=cpu_ms, wall_ms=wall_ms)
            if sample is not None:
                self._sink.offer(sample)
        except Exception as exc:  # noqa: BLE001 — metering NEVER fails an activity
            activity.logger.warning(
                "harness.compute_metering.sample_failed",
                extra={"error": str(exc), "error_type": type(exc).__name__},
            )


async def _deliver_samples(samples: Sequence[ComputeSample]) -> bool:
    """Post one batch of samples on the existing trajectory route, retried and spooled.

    Deliberately NO ``Idempotency-Key``. The header dedupes a whole POST, and this batch is a
    non-deterministic slice of whatever happened to be buffered when the flusher woke — two
    different slices could share a worker-side counter and one would be suppressed. The
    idempotency that matters is PER SAMPLE and already exists at the gateway
    (``harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>``), which is exactly why a
    retried or re-drained batch converges instead of double-billing.
    """
    from harness.core.config import get_settings  # noqa: PLC0415 — avoids an import cycle
    from harness.temporal.trajectory_delivery import (  # noqa: PLC0415
        deliver_trajectory,
        trajectory_api_client,
    )

    settings = get_settings()
    return await deliver_trajectory(
        trajectory_api_client(settings), compute_samples=samples
    )


_BUFFER: ComputeSampleBuffer | None = None


def get_compute_sample_buffer() -> ComputeSampleBuffer:
    """The process-wide sample buffer. One per worker, by design."""
    global _BUFFER  # noqa: PLW0603 — a worker has exactly one meter
    if _BUFFER is None:
        _BUFFER = ComputeSampleBuffer(deliver=_deliver_samples)
    return _BUFFER


def reset_compute_sample_buffer() -> None:
    """Drop the process-wide buffer. For tests, which must not inherit another's samples."""
    global _BUFFER  # noqa: PLW0603
    _BUFFER = None


def _field(args: Sequence[Any], *names: str) -> Any:
    """Read the first present ``names`` off the activity's FIRST argument, or ``None``.

    Only argument 0: every activity on both lanes takes exactly one pydantic input model, and
    scanning further arguments would be a licence to pick a tenant id out of an unrelated
    payload. Both spellings are accepted because the doc/interpreter models are snake_case and
    a plain-dict input (tests, a future dynamic activity) would be camelCase.
    """
    if not args:
        return None
    first = args[0]
    for name in names:
        value = first.get(name) if isinstance(first, Mapping) else getattr(first, name, None)
        if value is not None:
            return value
    return None


def _build_sample(
    input: ExecuteActivityInput, *, cpu_ms: float, wall_ms: float
) -> ComputeSample | None:
    """One sample from the activity context + its own input, or ``None`` to DROP it.

    Tenant comes from the activity's own input, and a sample whose tenant cannot be established
    is dropped with a warning rather than attributed to a default. "Which tenant burned this
    CPU" has exactly one honest answer, and a guess at it is a cross-tenant billing error.
    """
    info = activity.info()
    tenant_id = _field(input.args, "tenant_id", "tenantId")
    if not isinstance(tenant_id, str) or not tenant_id:
        activity.logger.warning(
            "harness.compute_metering.sample_dropped_no_tenant",
            extra={
                "activity_type": info.activity_type,
                "activity_id": info.activity_id,
                "cpu_ms": round(cpu_ms, 3),
            },
        )
        return None

    trigger = _field(input.args, "trigger")
    return ComputeSample(
        tenant_id=tenant_id,
        session_id=str(info.workflow_id),
        run_id=str(info.workflow_run_id),
        activity_id=str(info.activity_id),
        attempt=int(info.attempt),
        activity_type=str(info.activity_type),
        cpu_ms=cpu_ms,
        wall_ms=wall_ms,
        trigger=trigger if isinstance(trigger, str) and trigger else None,
    )
