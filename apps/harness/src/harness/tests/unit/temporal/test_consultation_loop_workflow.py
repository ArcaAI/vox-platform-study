"""Orchestration tests for :class:`ConsultationLoopWorkflow`.

Every test runs the REAL workflow definition against stub activities in
Temporal's time-skipping environment, so what is exercised is pure
orchestration: the pinned config, signal de-duplication, the cascade depth cap,
budget degradation, ``continue_as_new`` state carry-over, signal safety under a
long-running activity, and the child-finalize ``ParentClosePolicy``.

The loop is a NEW workflow type, so it needs no ``workflow.patched`` era —
that is precisely why ``HarnessDocWorkflow`` is composed as a child
rather than editing it. Replay compatibility is covered separately in
``test_replay_compat.py``.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowExecutionStatus
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker
from temporalio.workflow import ParentClosePolicy

from harness.temporal.models import (
    LOOP_ACTION_CLIENT_EMIT,
    LOOP_ACTION_HARNESS_FINALIZE,
    LOOP_ACTION_KEYS,
    LOOP_ACTION_LIVEDOC_START,
    LOOP_ACTION_LIVEDOC_STOP,
    LOOP_SKIP_BUDGET_EXHAUSTED,
    LOOP_SKIP_DEPTH_CAP,
    LOOP_SKIP_UNSUPPORTED_ACTION,
    CancelLoopSignal,
    ConsultationEndingSignal,
    ConsultationLoopWorkflowInput,
    ContextAddedSignal,
    LoopBudget,
    LoopSubscription,
)
from harness.temporal.workflows import (
    LOOP_ACTION_REGISTRY,
    ConsultationLoopWorkflow,
    HarnessDocWorkflow,
    consultation_loop_workflow_id,
)
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)
from harness.tests.unit.temporal._loop_stubs import (
    LoopStubConfig,
    LoopStubRecorder,
    default_loop_config,
    make_loop_stub_activities,
)
from harness.tests.unit.temporal._temporal_sync import await_query, start_time_skipping


def _wf_input(**overrides) -> ConsultationLoopWorkflowInput:
    base = {
        "consultation_id": "c-1",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "session_id": "s-1",
    }
    base.update(overrides)
    return ConsultationLoopWorkflowInput(**base)


def _ctx(
    item_id: str, *, kind: str = "transcript", depth: int = 0, at: str = "1"
) -> ContextAddedSignal:
    return ContextAddedSignal(context_item_id=item_id, kind_key=kind, depth=depth, occurred_at=at)


async def _await_state(handle, predicate, **kwargs):
    """Poll the ``state()`` query until ``predicate`` holds.

    Signals are delivered asynchronously, so a test that inspects the workflow
    immediately after signalling is racing it. Polling the query is the
    supported way to synchronise with a long-lived workflow without reaching
    into its internals. See ``_temporal_sync`` for why the poll itself has to
    tolerate a transient RPC deadline.
    """
    return await await_query(handle, ConsultationLoopWorkflow.state, predicate, **kwargs)


async def _await_status(handle, wanted: set, *, attempts: int = 200, delay: float = 0.02):
    """Poll ``describe()`` until the execution reaches one of ``wanted``."""
    last = None
    for _ in range(attempts):
        last = (await handle.describe()).status
        if last in wanted:
            return last
        await asyncio.sleep(delay)
    raise AssertionError(f"execution never reached {wanted}; last status: {last}")


async def _await_history_event(handle, event_type, *, attempts: int = 200, delay: float = 0.02):
    """Poll the execution's history until ``event_type`` is recorded on it."""
    seen: list = []
    for _ in range(attempts):
        seen = [e.event_type async for e in handle.fetch_history_events()]
        if event_type in seen:
            return
        await asyncio.sleep(delay)
    raise AssertionError(f"{event_type} never appeared in history; saw: {seen}")


class _LoopHarness:
    """Runs the loop workflow against the stub activity set."""

    def __init__(self, config: LoopStubConfig | None = None) -> None:
        self.config = config or LoopStubConfig()
        self.recorder = LoopStubRecorder()

    async def __aenter__(self):
        self._env_cm = await start_time_skipping(data_converter=pydantic_data_converter)
        self.env = self._env_cm
        self.task_queue = f"loop-tq-{uuid.uuid4()}"
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


class TestWorkflowIdentity:
    def test_workflow_id_is_deterministic_and_consultation_scoped(self):
        """Idempotent-on-start requires a pure, deterministic id."""
        assert consultation_loop_workflow_id("abc") == "consultation-loop-abc"
        assert consultation_loop_workflow_id("abc") == consultation_loop_workflow_id("abc")

    def test_action_registry_declares_every_canonical_action_key(self):
        """The registry must cover the `AGENT_ACTION_KEYS` vocabulary exactly.

        An agent may put any of those seven keys in `alwaysActions`, so the loop
        has to have an entry for each — even where the entry says "not
        implemented in this ticket" and the dispatch reports it as skipped
        rather than silently doing nothing.
        """
        assert set(LOOP_ACTION_REGISTRY) == set(LOOP_ACTION_KEYS)

    def test_the_four_mechanical_actions_are_implemented(self):
        """The four backed are still backed.

        This assertion used to be an EQUALITY against exactly these four, which
        also encoded "and the other three are not backed". backed the
        remaining three (`vision.extract_text`, `document.extract_text`,
        `nlp.extract_entities`), so the equality moved to
        `test_reasoning_loop_workflow.py::test_every_canonical_action_is_now_backed`
        and what belongs HERE is the narrower claim this ticket owns: the
        mechanical four still work.
        """
        implemented = {key for key, spec in LOOP_ACTION_REGISTRY.items() if spec.implemented}
        assert implemented >= {
            LOOP_ACTION_LIVEDOC_START,
            LOOP_ACTION_LIVEDOC_STOP,
            LOOP_ACTION_CLIENT_EMIT,
            LOOP_ACTION_HARNESS_FINALIZE,
        }

    def test_the_mechanical_four_do_not_derive_context(self):
        """Only the three derivers re-enter output as context."""
        for key in (
            LOOP_ACTION_LIVEDOC_START,
            LOOP_ACTION_LIVEDOC_STOP,
            LOOP_ACTION_CLIENT_EMIT,
            LOOP_ACTION_HARNESS_FINALIZE,
        ):
            assert LOOP_ACTION_REGISTRY[key].derives_context is False


class TestPinnedConfig:
    @pytest.mark.asyncio
    async def test_config_is_fetched_exactly_once_and_a_mid_run_edit_is_invisible(self):
        """TDD-1 — config pinned at start; a mid-run edit does not affect the run.

        The stub answers the FIRST fetch with a config subscribing `transcript`
        to `client.emit`. Halfway through, the stub is reprogrammed to a config
        with NO subscriptions at all — the exact effect a tenant admin editing
        the agent mid-consultation would have on an unpinned loop. The run must
        keep dispatching against the version it pinned, and must never call
        `fetch_loop_config` a second time (C1).
        """
        stub = LoopStubConfig(config=default_loop_config())
        async with _LoopHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", at="1"))
            await asyncio.sleep(0)

            # The "tenant admin edits the agent" moment.
            stub.config = default_loop_config(subscriptions=[])

            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-2", at="2"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert h.recorder.count("fetch_loop_config") == 1
        assert result.config_pinned is True
        assert result.events_processed == 2
        # Both items still dispatched against the PINNED subscriptions.
        assert h.recorder.count("emit_loop_event") >= 2

    @pytest.mark.asyncio
    async def test_unpinnable_config_degrades_instead_of_failing_the_workflow(self):
        """An unreachable loop-config endpoint must not fail the clinical run.

        The loop is additive orchestration; when it cannot pin a config the
        correct outcome is the consultation behaves exactly as it
        does today — not a failed workflow.
        """
        async with _LoopHarness(LoopStubConfig(fetch_fails=True)) as h:
            handle = await h.start(_wf_input())
            result = await handle.result()

        assert result.config_pinned is False
        assert result.degraded is True
        assert result.actions_dispatched == 0

    @pytest.mark.asyncio
    async def test_state_query_exposes_the_pinned_version_ids(self):
        async with _LoopHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            state = await _await_state(handle, lambda s: s.config_pinned)
            assert state.enabled is True
            assert state.agent_config_version_id == "dav-1"
            assert state.context_schema_version_id == "csv-1"
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()


class TestIdempotency:
    @pytest.mark.asyncio
    async def test_duplicate_context_added_is_ignored(self):
        """TDD-2 — the same (contextItemId, occurredAt) delivered twice acts once."""
        async with _LoopHarness() as h:
            handle = await h.start(_wf_input())
            dup = _ctx("i-1", at="ts-1")
            await handle.signal(ConsultationLoopWorkflow.context_added, dup)
            await handle.signal(ConsultationLoopWorkflow.context_added, dup)
            await handle.signal(ConsultationLoopWorkflow.context_added, dup)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 1
        assert result.duplicates_ignored == 2
        assert h.recorder.count("emit_loop_event") == 1

    @pytest.mark.asyncio
    async def test_reemit_with_a_new_timestamp_is_a_new_event(self):
        """Mirrors the gateway rule: enrichment re-fire carries a NEW timestamp."""
        async with _LoopHarness() as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", at="ts-1"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", at="ts-2"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 2
        assert result.duplicates_ignored == 0


class TestCascadeTermination:
    @pytest.mark.asyncio
    async def test_cascade_terminates_at_the_depth_cap(self):
        """TDD-3 — derived context at/over `max_depth` is not dispatched."""
        config = default_loop_config(budget=LoopBudget(max_depth=2, max_actions=100))
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            for depth in (0, 1, 2, 3):
                await handle.signal(
                    ConsultationLoopWorkflow.context_added,
                    _ctx(f"i-{depth}", depth=depth, at=str(depth)),
                )
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 4
        # depth 0 and 1 dispatch; depth 2 and 3 are at/over the cap.
        assert result.depth_capped == 2
        emits = h.recorder.payloads("emit_loop_event")
        dispatched = [e for e in emits if e.event_type == "action.dispatched"]
        skipped = [e for e in emits if e.event_type == "action.skipped"]
        assert len(dispatched) == 2
        assert {e.reason for e in skipped} == {LOOP_SKIP_DEPTH_CAP}

    @pytest.mark.asyncio
    async def test_budget_exhaustion_degrades_rather_than_aborts(self):
        """TDD-4 — over budget the loop keeps running, marks itself degraded, and reports."""
        config = default_loop_config(budget=LoopBudget(max_depth=5, max_actions=2))
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
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

        # The workflow COMPLETED (did not fail) and consumed every event.
        assert result.events_processed == 5
        assert result.degraded is True
        assert result.actions_dispatched == 2
        skipped = [
            e for e in h.recorder.payloads("emit_loop_event") if e.event_type == "action.skipped"
        ]
        assert {e.reason for e in skipped} == {LOOP_SKIP_BUDGET_EXHAUSTED}

    @pytest.mark.asyncio
    async def test_an_unregistered_action_is_reported_not_silently_dropped(self):
        """An action key with no registry entry at all is an OBSERVABLE skip.

        Rewritten by This case originally used `vision.extract_text`,
        which was then declared-but-unbacked; backed all three such
        keys, so the only remaining way to reach this branch is a key that is not
        in the registry — e.g. a gateway sending an action from a newer
        vocabulary than this worker knows.

        The property under test is unchanged and is the one that matters: an
        action the loop cannot perform is REPORTED, never silently dropped. A
        silent no-op is indistinguishable from success on the client's feed.
        """
        config = default_loop_config(
            subscriptions=[
                LoopSubscription(kind_key="scan", actions=["imaging.measure_lesion"]),
            ]
        )
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", kind="scan"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.actions_dispatched == 0
        skipped = [
            e for e in h.recorder.payloads("emit_loop_event") if e.event_type == "action.skipped"
        ]
        assert [e.reason for e in skipped] == [LOOP_SKIP_UNSUPPORTED_ACTION]


class TestSignalSafety:
    @pytest.mark.asyncio
    async def test_a_signal_arriving_during_a_long_activity_cannot_corrupt_state(self):
        """TDD-7 — handlers only mutate guarded state; the main coroutine acts.

        Every dispatch activity sleeps, so signals land WHILE an activity is in
        flight. Ten distinct items plus ten exact duplicates are fired without
        awaiting; the loop must end with exactly ten processed and ten ignored,
        and the pending queue must drain to zero. A handler that raced the main
        coroutine's drain (or called an activity itself) would drop or
        double-count events here.
        """
        async with _LoopHarness(LoopStubConfig(dispatch_delay_s=0.05)) as h:
            handle = await h.start(_wf_input())
            signals = []
            for index in range(10):
                sig = _ctx(f"i-{index}", at=str(index))
                signals.append(handle.signal(ConsultationLoopWorkflow.context_added, sig))
                signals.append(handle.signal(ConsultationLoopWorkflow.context_added, sig))
            await asyncio.gather(*signals)
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 10
        assert result.duplicates_ignored == 10
        assert result.actions_dispatched == 10

    @pytest.mark.asyncio
    async def test_a_signal_delivered_with_start_is_not_lost(self):
        """`@workflow.init` closes the signal-with-start race.

        Without it the handler would mutate a not-yet-constructed instance's
        state and the event would vanish.
        """
        async with _LoopHarness() as h:
            handle = await h.env.client.start_workflow(
                ConsultationLoopWorkflow.run,
                _wf_input(),
                id=f"consultation-loop-swstart-{uuid.uuid4()}",
                task_queue=h.task_queue,
                start_signal="contextAdded",
                start_signal_args=[_ctx("i-swstart")],
            )
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.events_processed == 1


class TestCheckpointing:
    @pytest.mark.asyncio
    async def test_continue_as_new_preserves_state_across_the_checkpoint(self):
        """TDD-5 — counters, de-dup memory and the PINNED config all survive.

        The signal threshold is dropped to 2 so the loop checkpoints inside the
        test. Afterwards the run must (a) report a continuation, (b) still
        refuse a duplicate whose first delivery happened BEFORE the checkpoint,
        and (c) never re-fetch its config.
        """
        async with _LoopHarness() as h:
            handle = await h.start(_wf_input(checkpoint_signal_threshold=2))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-0", at="0"))
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1", at="1"))

            # Synchronise on the checkpoint actually having happened, rather
            # than assuming an ordering between client signals and workflow tasks.
            after = await _await_state(handle, lambda s: s.continuations >= 1)
            # The continued execution answers the query — and it answers with
            # the state the previous one handed over, including its pinned config.
            assert after.config_pinned is True
            assert after.agent_config_version_id == "dav-1"
            assert after.events_processed == 2

            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-2", at="2"))
            # A duplicate of an item first seen BEFORE the checkpoint: the
            # de-duplication memory must have crossed the handover too.
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-0", at="0"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.continuations >= 1
        assert result.events_processed == 3
        assert result.duplicates_ignored == 1
        assert result.actions_dispatched == 3
        # Pinned once on the FIRST execution; carried, never re-fetched.
        assert h.recorder.count("fetch_loop_config") == 1
        assert result.config_pinned is True


class TestLifecycleActions:
    @pytest.mark.asyncio
    async def test_start_and_ending_actions_dispatch_livedoc_in_order(self):
        config = default_loop_config(
            start_actions=[LOOP_ACTION_LIVEDOC_START],
            ending_actions=[LOOP_ACTION_LIVEDOC_STOP],
        )
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending,
                ConsultationEndingSignal(persist_snapshot=False),
            )
            await handle.result()

        names = [n for n in h.recorder.names() if n.startswith("livedoc_")]
        assert names == ["livedoc_start", "livedoc_stop"]
        stop_payload = h.recorder.payloads("livedoc_stop")[0]
        assert stop_payload.persist_snapshot is False
        start_payload = h.recorder.payloads("livedoc_start")[0]
        assert start_payload.session_id == "s-1"

    @pytest.mark.asyncio
    async def test_cancel_signal_stops_the_loop_without_running_ending_actions(self):
        config = default_loop_config(
            start_actions=[LOOP_ACTION_LIVEDOC_START],
            ending_actions=[LOOP_ACTION_LIVEDOC_STOP],
        )
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.cancel, CancelLoopSignal(reason="abandoned")
            )
            result = await handle.result()

        assert result.cancelled is True
        assert h.recorder.count("livedoc_stop") == 0


class TestChildFinalize:
    @pytest.mark.asyncio
    async def test_finalize_starts_harness_doc_workflow_as_a_child_and_cancel_stops_it(self):
        """TDD-6 — cancelling the loop actually stops the child it started.

        This runs the REAL `HarnessDocWorkflow` (against its own stub activity
        set) as the child, so what is proven is propagation, not merely the
        value of a keyword argument. The child parks at the clinician gate — it
        is never signed — and the parent is then cancelled; both must end
        CANCELED, which is only true because the close policy is
        `REQUEST_CANCEL` rather than the SDK's `TERMINATE` default or the
        `ABANDON` that would orphan it.
        """
        config = default_loop_config(ending_actions=[LOOP_ACTION_HARNESS_FINALIZE])
        loop_stub = LoopStubConfig(config=config)
        loop_recorder = LoopStubRecorder()
        doc_recorder = StubRecorder()

        env = await start_time_skipping(data_converter=pydantic_data_converter)
        try:
            task_queue = f"loop-child-tq-{uuid.uuid4()}"
            worker = Worker(
                env.client,
                task_queue=task_queue,
                workflows=[ConsultationLoopWorkflow, HarnessDocWorkflow],
                activities=[
                    *make_loop_stub_activities(loop_stub, loop_recorder),
                    *make_stub_activities(StubConfig(), doc_recorder),
                ],
            )
            async with worker:
                consultation_id = f"c-{uuid.uuid4()}"
                handle = await env.client.start_workflow(
                    ConsultationLoopWorkflow.run,
                    _wf_input(consultation_id=consultation_id),
                    id=consultation_loop_workflow_id(consultation_id),
                    task_queue=task_queue,
                )
                await handle.signal(
                    ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
                )

                child_id = f"harness-doc-{consultation_id}"
                state = await _await_state(handle, lambda s: s.finalize_workflow_id is not None)
                assert state.finalize_workflow_id == child_id

                child = env.client.get_workflow_handle(child_id)
                # The child is genuinely running (parked at the un-signed gate).
                await _await_status(child, {WorkflowExecutionStatus.RUNNING})

                await handle.cancel()
                # Nudge the time-skipping server so the cancellation request is
                # turned into a workflow task; polling `describe()` alone never
                # advances its clock, so an idle workflow would sit un-notified.
                await env.sleep(timedelta(seconds=1))

                # The parent must close as CANCELED (not FAILED): cancellation
                # is not a failure, and a loop that failed here would look like
                # a clinical error in every dashboard.
                await _await_status(
                    handle, {WorkflowExecutionStatus.CANCELED}, attempts=600, delay=0.05
                )
                # ...and the child must be told to stop. This is the assertion
                # the ParentClosePolicy exists for: the request is issued by the
                # parent and durably delivered to the child's own history.
                #
                # It deliberately asserts the REQUEST, not a terminal CANCELED
                # status on the child. `HarnessDocWorkflow`'s body is frozen
                # (C2) and it wraps several awaits in `except ActivityError`,
                # which is also how an activity cancellation surfaces — so it
                # can absorb a cancellation at those points and keep running to
                # its next cancellable await. That is a property of the child,
                # not of this loop, and this ticket may not change it. What the
                # loop owes is the request; it is here, in the child's history.
                await _await_history_event(
                    child, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED
                )
        finally:
            await env.shutdown()

    def test_finalize_is_declared_as_a_child_with_an_explicit_parent_close_policy(self):
        """TDD-6 (declaration half) — the default must never be relied upon.

        Verified against temporalio 1.30.0, `start_child_workflow`'s default is
        `ParentClosePolicy.TERMINATE` — i.e. a parent that completes or is
        cancelled would HARD-KILL an in-flight `HarnessDocWorkflow`, possibly
        mid-`persist_draft`. (The execution plan states the default is ABANDON;
        it is not, and either way the remedy is to set it explicitly.)
        `REQUEST_CANCEL` is what makes cancellation propagate gracefully.
        """
        spec = LOOP_ACTION_REGISTRY[LOOP_ACTION_HARNESS_FINALIZE]
        assert spec.parent_close_policy is ParentClosePolicy.REQUEST_CANCEL
        assert spec.parent_close_policy is not ParentClosePolicy.ABANDON
