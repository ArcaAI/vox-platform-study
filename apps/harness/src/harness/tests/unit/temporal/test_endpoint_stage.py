"""TASK-812 — the ENDPOINT STAGE, asserted against the REAL workflow definition.

The endpoint stage is the ordered sequence that runs before a consultation session closes. Three
defects define it, and each has a test here that FAILS on the pre-TASK-812 workflow:

* **D-10** — the sequence was a hardcoded literal an admin could only SUBTRACT from. The loop now
  runs whatever ordered list the pinned config carries, including keys that did not exist before
  (``session.timeout``, ``summary.finalize``, ``feedback.capture``), IN THE AUTHORED ORDER.
* **D-11** — no feedback-capture action existed anywhere. It does now, and the loop dispatches it.
* **D-12** — the idle timeout deliberately did NOT run the ending actions, so a timed-out
  consultation never finalized. It does now, behind its own patch era.

Every test runs the real ``ConsultationLoopWorkflow`` against stub activities in Temporal's
time-skipping environment; nothing here touches a network, a DB or Redis (the CI harness suite is
hermetic and must stay that way).

Replay compatibility for the D-12 era is covered separately in ``test_replay_compat.py`` — and by
``test_expiry_without_the_config_flag_abandons_exactly_as_before`` below, which is the behavioural
half of the same guarantee: with ``endpoint_on_timeout`` False (the shape every pre-812 recorded
config deserialises to) the loop must issue exactly the commands it always did.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from harness.temporal.models import (
    ENDPOINT_REASON_ENDED,
    ENDPOINT_REASON_TIMED_OUT,
    LOOP_ACTION_FEEDBACK_CAPTURE,
    LOOP_ACTION_LIVEDOC_STOP,
    LOOP_ACTION_SESSION_TIMEOUT,
    LOOP_ACTION_SUMMARY_FINALIZE,
    LOOP_EVENT_ACTION_SKIPPED,
    LOOP_EVENT_LOOP_TIMED_OUT,
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

#: Large in wall-clock terms, irrelevant in test terms — the time-skipping environment only
#: advances while the client blocks on `result()`, i.e. exactly when the loop is genuinely idle.
_BOUND_S = 3600.0

#: The default endpoint sequence, in the order the platform ships it. `livedoc.stop` first so the
#: audio session is closed before anything reads the transcript; finalize BEFORE feedback so a
#: feedback capture that degrades can never cost the note.
_DEFAULT_SEQUENCE = [
    LOOP_ACTION_LIVEDOC_STOP,
    LOOP_ACTION_SESSION_TIMEOUT,
    LOOP_ACTION_SUMMARY_FINALIZE,
    LOOP_ACTION_FEEDBACK_CAPTURE,
]


def _wf_input(**overrides) -> ConsultationLoopWorkflowInput:
    base = {
        "consultation_id": "c-812",
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


def _endpoint_config(*, sequence=None, on_timeout=True, bound=_BOUND_S, **overrides):
    return default_loop_config(
        idle_timeout_seconds=bound,
        endpoint_on_timeout=on_timeout,
        ending_actions=list(_DEFAULT_SEQUENCE if sequence is None else sequence),
        **overrides,
    )


class _LoopHarness:
    """Runs the loop workflow against the stub activity set."""

    def __init__(self, config: LoopStubConfig | None = None) -> None:
        self.config = config or LoopStubConfig()
        self.recorder = LoopStubRecorder()

    async def __aenter__(self):
        self.env = await start_time_skipping(data_converter=pydantic_data_converter)
        self.task_queue = f"endpoint-tq-{uuid.uuid4()}"
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

    def endpoint_calls(self) -> list[str]:
        """The endpoint activities the loop dispatched, in dispatch order."""
        wanted = {
            "livedoc_stop",
            "record_session_endpoint",
            "finalize_documents",
            "capture_feedback",
        }
        return [name for name in self.recorder.names() if name in wanted]

    def skipped(self) -> list:
        return [
            e
            for e in self.recorder.payloads("emit_loop_event")
            if e.event_type == LOOP_EVENT_ACTION_SKIPPED
        ]

    def timeout_events(self) -> list:
        return [
            e
            for e in self.recorder.payloads("emit_loop_event")
            if e.event_type == LOOP_EVENT_LOOP_TIMED_OUT
        ]


class TestD12TimeoutRunsTheEndpointSequence:
    """D-12 — a timed-out consultation FINALIZES. It is the defect with clinical consequence."""

    @pytest.mark.asyncio
    async def test_a_timed_out_consultation_runs_the_whole_endpoint_sequence(self):
        """The test that would have caught D-12.

        Before this ticket the expiry branch broke out of the loop having published
        ``loop.timed_out`` and nothing else, so a consultation whose clinician simply closed the
        laptop left real recorded clinical work unfinalized, unlocked, and never queued for
        review. Here nobody ever sends ``consultation-ending``; the run reaches its idle bound,
        and the endpoint sequence must still run end to end.
        """
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            result = await handle.result()
            state = await handle.query(ConsultationLoopWorkflow.state)

        assert result.timed_out is True
        assert h.endpoint_calls() == [
            "livedoc_stop",
            "record_session_endpoint",
            "finalize_documents",
            "capture_feedback",
        ]
        # The timeout is still its OWN terminal phase — running the sequence must not disguise an
        # expiry as a normal ending, or the bound becomes invisible to every dashboard that
        # already reads it.
        assert state.phase == "TIMED_OUT"
        assert state.timed_out is True
        assert len(h.timeout_events()) == 1

    @pytest.mark.asyncio
    async def test_the_disposition_stamped_on_expiry_says_TIMED_OUT(self):
        """A finalized-on-expiry consultation must not be indistinguishable from a normal one.

        Running the sequence is the fix; erasing HOW the session ended would be a new defect —
        a clinician reviewing the note is entitled to know the transcript may be truncated.
        """
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.result()

        stamped = h.recorder.payloads("record_session_endpoint")
        assert len(stamped) == 1
        assert stamped[0].reason == ENDPOINT_REASON_TIMED_OUT
        assert stamped[0].sequence == _DEFAULT_SEQUENCE

    @pytest.mark.asyncio
    async def test_an_explicitly_ended_consultation_stamps_ENDED(self):
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(ConsultationLoopWorkflow.context_added, _ctx("i-1"))
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        assert result.timed_out is False
        stamped = h.recorder.payloads("record_session_endpoint")
        assert [s.reason for s in stamped] == [ENDPOINT_REASON_ENDED]

    @pytest.mark.asyncio
    async def test_expiry_without_the_config_flag_abandons_exactly_as_before(self):
        """The replay-compatibility guarantee, stated behaviourally.

        Every loop config recorded before this ticket deserialises with
        ``endpoint_on_timeout=False``, and the era gate reads that operand FIRST — so
        ``workflow.patched`` is never called and the recorded command sequence is reproduced
        exactly. What that means at runtime is this: expiry publishes ``loop.timed_out`` and
        runs NOTHING else.
        """
        config = _endpoint_config(on_timeout=False)
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            result = await handle.result()

        assert result.timed_out is True
        assert h.endpoint_calls() == []
        assert len(h.timeout_events()) == 1

    @pytest.mark.asyncio
    async def test_a_cancelled_loop_still_runs_no_endpoint_sequence(self):
        """A cancel is an explicit ABANDONMENT and stays one.

        D-12 is about a bound firing on a consultation nobody abandoned. Someone cancelling a
        consultation has said, in as many words, that they do not want its output — finalizing it
        anyway would be the mirror-image defect.
        """
        from harness.temporal.models import CancelLoopSignal

        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.cancel, CancelLoopSignal(reason="abandoned")
            )
            result = await handle.result()

        assert result.cancelled is True
        assert h.endpoint_calls() == []


class TestD10OrderedAndExtensible:
    """D-10 — the sequence is ORDERED and EXTENSIBLE, not a literal you may only subtract from."""

    @pytest.mark.asyncio
    async def test_the_loop_runs_the_endpoint_actions_in_the_authored_order(self):
        """Reordering the persisted sequence reorders the dispatch. That is the whole of D-10.

        The old code could not express this at all: `endingActionsBase` was
        ``['livedoc.stop', 'harness.finalize']``, in that order, always, and `neverActions` could
        only remove an entry from it.
        """
        reversed_sequence = [
            LOOP_ACTION_FEEDBACK_CAPTURE,
            LOOP_ACTION_SUMMARY_FINALIZE,
            LOOP_ACTION_SESSION_TIMEOUT,
        ]
        config = _endpoint_config(sequence=reversed_sequence)
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        assert h.endpoint_calls() == [
            "capture_feedback",
            "finalize_documents",
            "record_session_endpoint",
        ]

    @pytest.mark.asyncio
    async def test_an_endpoint_action_that_fails_is_an_observable_skip_and_the_rest_still_run(
        self,
    ):
        """A failing endpoint action must not take the note down with it.

        This is why the default sequence puts finalize BEFORE feedback, and why the loop wraps
        each endpoint action rather than letting an exhausted retry fail the workflow: the
        alternative is that a feedback endpoint outage costs a clinician their finalized note.
        The failure is never silent — it lands on the same ``action.skipped`` feed every other
        withholding uses.
        """
        config = _endpoint_config()
        stub = LoopStubConfig(
            config=config, failing_endpoint_actions={LOOP_ACTION_SUMMARY_FINALIZE}
        )
        async with _LoopHarness(stub) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            result = await handle.result()

        # The sequence continued past the failure.
        assert "capture_feedback" in h.endpoint_calls()
        # …and the failure is visible.
        reasons = [(e.action, e.reason) for e in h.skipped()]
        assert (LOOP_ACTION_SUMMARY_FINALIZE, "endpoint_action_failed") in reasons
        assert result.degraded is True

    @pytest.mark.asyncio
    async def test_an_empty_endpoint_sequence_dispatches_nothing(self):
        """Subtracting everything is still allowed — it just is no longer the ONLY lever."""
        config = _endpoint_config(sequence=[])
        async with _LoopHarness(LoopStubConfig(config=config)) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        assert h.endpoint_calls() == []


class TestTask814S2bAcceptedProposalsReachFeedbackCapture:
    """TASK-814 §2b — the promotion path (TASK-812 DD-8) is inert until the loop actually
    threads what the console recorded into ``capture_feedback``.

    Before this, ``ConsultationEndingSignal`` had no field to carry a clinician's accepted
    corrections at all, so ``_run_endpoint_action``'s feedback branch always dispatched
    ``CaptureFeedbackInput`` with ``accepted_proposals`` at its empty default — DD-8's filter had
    nothing to promote no matter what a console recorded.
    """

    @pytest.mark.asyncio
    async def test_accepted_proposals_on_the_ending_signal_reach_capture_feedback(self):
        proposal = {
            "proposalId": "p-1",
            "start": 10,
            "end": 16,
            "original": "Toprovol",
            "proposed": "Toprol",
            "category": "drugName",
            "confidence": 0.92,
            "status": "ACCEPTED",
        }
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending,
                ConsultationEndingSignal(accepted_proposals=[proposal]),
            )
            await handle.result()

        calls = h.recorder.payloads("capture_feedback")
        assert len(calls) == 1
        assert calls[0].accepted_proposals == [proposal]

    @pytest.mark.asyncio
    async def test_omits_nothing_extra_when_the_signal_carries_no_accepted_proposals(self):
        """The common case — most stops accept nothing — must not regress to a non-empty
        default or a crash on the absent field."""
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        calls = h.recorder.payloads("capture_feedback")
        assert len(calls) == 1
        assert calls[0].accepted_proposals == []


class TestDD3FinalizeLocksEveryDocument:
    @pytest.mark.asyncio
    async def test_finalize_is_dispatched_with_no_document_selector(self):
        """DD-3, at the boundary the loop owns.

        The loop cannot narrow the lock even if a graph author wanted it to: ``FinalizeDocumentsInput``
        has no ``document_key`` field at all, so the scope is the CONSULTATION by construction.
        The gateway-side proof that every document actually locks lives in
        ``consultation-endpoint.service`` tests; what is asserted here is that nothing on this
        side can scope it.
        """
        async with _LoopHarness(LoopStubConfig(config=_endpoint_config())) as h:
            handle = await h.start(_wf_input())
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )
            await handle.result()

        payloads = h.recorder.payloads("finalize_documents")
        assert len(payloads) == 1
        assert payloads[0].consultation_id == "c-812"
        assert not hasattr(payloads[0], "document_key")
        assert "document_key" not in payloads[0].model_dump()
