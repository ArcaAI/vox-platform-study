"""Lifecycle-bound tests for :class:`ConsultationLoopWorkflow`.

The loop's main wait was unbounded, so a consultation that never sent
``consultation-ending`` (and ``loop-cancel`` has no production caller)
left the workflow RUNNING forever. The DISABLED branch of the same ``run``
already refuses to do that, in as many words: *"an idle workflow parked forever
would be a resource leak that changes nothing about the consultation"*
(``workflows.py``, the ``config is None or not config.enabled`` branch).

What is asserted here is the BOUND, and the earlier semantics of what
happens when it fires: the run terminates in its own queryable phase and runs no
``ending_actions``.

⚠ That second half is now the LEGACY shape, not the current one. (D-12)
found the abandonment reasoning backwards — a timed-out consultation that never
finalizes loses real recorded clinical work, while the note a truncated
transcript produces goes to the same clinician gate every other note does — so
expiry now RUNS the endpoint sequence. The current behaviour is asserted in
``test_endpoint_stage.py``.

These tests still hold, and still matter, because the configs they build leave
``endpoint_on_timeout`` at its default False: that is exactly the shape every
config recorded before deserialises to, so what they pin is the
replay-compatible legacy path.

Every test runs the REAL workflow definition against stub activities in
Temporal's time-skipping environment. Replay compatibility for the patch era
this ticket adds is covered separately in ``test_replay_compat.py``.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from harness.temporal.models import (
    LOOP_ACTION_LIVEDOC_STOP,
    LOOP_EVENT_LOOP_TIMED_OUT,
    CancelLoopSignal,
    ConsultationEndingSignal,
    ConsultationLoopWorkflowInput,
    ContextAddedSignal,
)
from harness.temporal.workflows import (
    ConsultationLoopWorkflow,
    consultation_loop_workflow_id,
)
from harness.tests.unit.temporal._loop_stubs import (
    LoopStubConfig,
    LoopStubRecorder,
    default_loop_config,
    make_loop_stub_activities,
)
from harness.tests.unit.temporal._temporal_sync import start_time_skipping

# Deliberately large in wall-clock terms and irrelevant in test terms: the
# time-skipping environment advances the clock only while the client is blocked
# on `handle.result()`, i.e. exactly when the loop is genuinely idle. A test
# that keeps signalling therefore never reaches this bound, which is precisely
# the distinction between "idle" and "quiet for a moment" that is under test.
_BOUND_S = 3600.0


def _wf_input(**overrides) -> ConsultationLoopWorkflowInput:
    base = {
        "consultation_id": "c-685",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "session_id": "s-1",
    }
    base.update(overrides)
    return ConsultationLoopWorkflowInput(**base)


def _ctx(item_id: str, *, at: str = "1") -> ContextAddedSignal:
    return ContextAddedSignal(
        context_item_id=item_id, kind_key="transcript", depth=0, occurred_at=at
    )


def _bounded_config(seconds: float | None = _BOUND_S, **overrides):
    return default_loop_config(idle_timeout_seconds=seconds, **overrides)


class _LoopHarness:
    """Runs the loop workflow against the stub activity set (local copy).

    Deliberately not imported from ``test_consultation_loop_workflow`` — pytest
    would collect that module's tests a second time through the import.
    """

    def __init__(self, config: LoopStubConfig | None = None) -> None:
        self.config = config or LoopStubConfig()
        self.recorder = LoopStubRecorder()

    async def __aenter__(self):
        self.env = await start_time_skipping(data_converter=pydantic_data_converter)
        self.task_queue = f"loop-bound-tq-{uuid.uuid4()}"
        self.worker = Worker(
            self.env.client,
            task_queue=self.task_queue,
            workflows=[ConsultationLoopWorkflow],
            activities=make_loop_stub_activities(self.config, self.recorder),
        )
        await self.worker.__aenter__()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.worker.__aexit__(*exc)
        await self.env.shutdown()

    async def start(self, wf_input: ConsultationLoopWorkflowInput):
        return await self.env.client.start_workflow(
            ConsultationLoopWorkflow.run,
            wf_input,
            id=consultation_loop_workflow_id(wf_input.consultation_id) + f"-{uuid.uuid4()}",
            task_queue=self.task_queue,
        )

    def timeout_events(self) -> list:
        return [
            e
            for e in self.recorder.payloads("emit_loop_event")
            if e.event_type == LOOP_EVENT_LOOP_TIMED_OUT
        ]


class TestIdleBound:
    @pytest.mark.asyncio
    async def test_an_idle_loop_terminates_at_the_bound_instead_of_parking(self):
        """TDD-1 — the defect this ticket exists for.

        No ``consultation-ending``, no ``loop-cancel``: before this ticket the
        workflow simply never completed and ``handle.result()`` hung. It must now
        reach a terminal state on its own.
        """
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            result = await handle.result()

        assert result.timed_out is True
        assert result.cancelled is False
        # The work that DID arrive was still done — the bound ends the loop, it
        # does not discard what the consultation already produced.
        assert result.events_processed == 1
        assert result.actions_dispatched == 1

    @pytest.mark.asyncio
    async def test_no_bound_configured_leaves_the_legacy_unbounded_wait(self):
        """A config with no ``idleTimeoutSeconds`` behaves exactly as before.

        This is the pre-era shape, and it is what makes the frozen replay
        fixtures stay green: the workflow must issue no timer at all, so the run
        can only end through an explicit signal.
        """
        async with _LoopHarness(LoopStubConfig(config=_bounded_config(None))) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.timed_out is False


class TestTerminalStateIsDistinguishable:
    @pytest.mark.asyncio
    async def test_the_timed_out_phase_is_queryable_and_is_not_cancelled(self):
        """TDD-2 — a timeout is its OWN terminal phase.

        A timeout and a cancel both abandon without running the ending actions,
        but they have different causes — one is a platform bound firing, the
        other an explicit decision — and conflating them would make the bound
        invisible in every dashboard that already reads ``cancelled``.
        """
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            result = await handle.result()
            state = await handle.query(ConsultationLoopWorkflow.state)

        assert state.phase == "TIMED_OUT"
        assert state.timed_out is True
        assert state.cancelled is False
        assert result.timed_out is True

    @pytest.mark.asyncio
    async def test_a_cancelled_loop_is_not_reported_as_timed_out(self):
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.cancel, CancelLoopSignal(reason="abandoned")
            )
            result = await handle.result()
            state = await handle.query(ConsultationLoopWorkflow.state)

        assert state.phase == "CANCELLED"
        assert result.cancelled is True
        assert result.timed_out is False

    @pytest.mark.asyncio
    async def test_a_normally_ended_loop_is_not_reported_as_timed_out(self):
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()
            state = await handle.query(ConsultationLoopWorkflow.state)

        assert state.phase == "DONE"
        assert result.timed_out is False


class TestNoFalseTermination:
    @pytest.mark.asyncio
    async def test_a_loop_that_keeps_receiving_events_does_not_time_out(self):
        """TDD-3 — the bound is on IDLENESS, and every arrival restarts it.

        Five items and an ending are delivered while the loop is working, so the
        wait is never idle for the full bound. A bound that measured total run
        duration instead of silence would terminate this run.
        """
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            for index in range(5):
                await handle.signal(
                    ConsultationLoopWorkflow.context_added,
                    _ctx(f"i-{index}", at=str(index)),
                )
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.timed_out is False
        assert result.events_processed == 5
        assert h.timeout_events() == []


class TestAbandonmentNotDegradedEnding:
    @pytest.mark.asyncio
    async def test_the_ending_actions_do_not_run_on_a_timeout_without_the_flag(self):
        """The LEGACY expiry path, pinned — the replay-compatibility guarantee.

        ``_bounded_config`` leaves ``endpoint_on_timeout`` at its default False, which is the
        shape every loop config recorded before deserialises to. On that shape the era
        gate short-circuits before ``workflow.patched`` is called and expiry must issue exactly
        the commands it always did: publish ``loop.timed_out`` and nothing else.

        The CURRENT behaviour — expiry runs the endpoint sequence, because a timed-out
        consultation that never finalizes silently loses the encounter (D-12) — is asserted in
        ``test_endpoint_stage.py``. Only ``livedoc.stop`` is configured here so the test needs no
        child workflow registered.
        """
        config = _bounded_config(ending_actions=[LOOP_ACTION_LIVEDOC_STOP])
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            result = await handle.result()

        assert result.timed_out is True
        assert result.finalized is False
        assert h.recorder.count("livedoc_stop") == 0


class TestObservability:
    @pytest.mark.asyncio
    async def test_the_timeout_publishes_exactly_one_event(self):
        """TDD-5 — the bound is never a silent disappearance.

        An operator must be able to see "this loop timed out" on the same feed
        every other loop outcome uses, rather than inferring it from a Temporal
        console.
        """
        async with _LoopHarness(LoopStubConfig(config=_bounded_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await handle.result()

        assert len(h.timeout_events()) == 1


class TestPinnedBound:
    @pytest.mark.asyncio
    async def test_the_bound_comes_from_the_pinned_config_not_a_live_read(self):
        """TDD-4 — C1. A settings change mid-consultation cannot reach a running loop.

        The resolver answers the FIRST (and only) fetch with a bounded config,
        then is reprogrammed to an UNBOUNDED one — the exact effect of an
        operator editing ``harness.loop.idleTimeoutSeconds`` mid-consultation. The
        run must still honour the bound it pinned, and must never re-fetch.
        """
        stub = LoopStubConfig(config=_bounded_config())
        async with _LoopHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))

            # The "operator raises the timeout" moment.
            stub.config = _bounded_config(None)

            result = await handle.result()

        assert h.recorder.count("fetch_loop_config") == 1
        assert result.timed_out is True

    @pytest.mark.asyncio
    async def test_the_bound_survives_a_checkpoint_handover(self):
        """The pin travels with ``continue_as_new``, so the bound does too.

        A checkpoint re-enters ``run()`` on a fresh history; the bound is derived
        from ``pinned_config``, which the checkpoint input carries, so the
        continued execution is bounded without re-fetching anything.
        """
        stub = LoopStubConfig(config=_bounded_config())
        async with _LoopHarness(stub) as h:
            handle = await h.start(_wf_input(checkpoint_signal_threshold=2))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-0", at="0"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", at="1"))
            result = await handle.result()

        assert result.continuations >= 1
        assert result.timed_out is True
        assert h.recorder.count("fetch_loop_config") == 1
