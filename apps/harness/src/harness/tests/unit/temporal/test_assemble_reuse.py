"""F-13 — reuse the assembled prompt across pre-delivery regen iterations.

``assemble_prompt`` is a pure read on apps/api (transcript + persisted NER +
clinician notes/attachments/highlights + the live-SOAP warm-start snapshot +
template resolution). Nothing the bounded regen loop does mutates any of those
inputs: the transcript is written before the run, ``persist_entities`` runs ONCE
*before* the loop, and the regen critique is appended later — inside the
``generate`` activity (``prompt_cache.assemble_generation_prompt``), never in
assemble. So re-running it every iteration re-fetched the same bytes.

Skipping a scheduled activity REMOVES a workflow command, so the skip lives
behind ``workflow.patched("task-553-assemble-reuse")`` and, on the first
iteration, is short-circuited BEFORE ``workflow.patched`` is consulted — a
single-iteration run therefore records no marker at all and stays
byte-identical to the legacy history (the ``task-516-mcp-tools`` /
``task-551-redaction`` conditional-patch precedent).

The reuse deliberately stops at the delivery boundary: the post-delivery
regen-if-untouched path (``_regen_compute``) runs AFTER ``persist_draft``, whose
downstream apps/api handling can persist additional ``NamedEntity`` rows for the
delivered note — a genuinely different assemble output — so it keeps its own
call. The replay-compat forward guard for this era lives in
``test_replay_compat.py`` (``doc_workflow_post_task553_assemble_reuse_history``).
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.worker import Worker

from harness.temporal.models import HarnessGateConfig
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)
from harness.tests.unit.temporal.test_doc_workflow import _approval, _env, _input, _opt_gate


async def _run(config: StubConfig, recorder: StubRecorder, wf_input) -> object:
    async with await _env() as env:
        tq = f"harness-reuse-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[HarnessDocWorkflow],
            activities=make_stub_activities(config, recorder),
        ):
            handle = await env.client.start_workflow(
                HarnessDocWorkflow.run,
                wf_input,
                id=f"harness-doc-{uuid.uuid4()}",
                task_queue=tq,
            )
            await handle.signal(HarnessDocWorkflow.approval, _approval())
            return await handle.result()


class TestAssembleReuse:
    @pytest.mark.asyncio
    async def test_regen_loop_assembles_once_but_generates_every_iteration(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "REGEN", "PASS"])

        result = await _run(config, recorder, _input(gate=HarnessGateConfig(max_regen=2)))

        assert result.decision == "PASS"
        assert result.regens_used == 2
        # Three generations, three sensor passes — but ONE assemble.
        assert recorder.calls["generate"] == 3
        assert recorder.calls["run_sensors"] == 3
        assert recorder.calls["assemble_prompt"] == 1

    @pytest.mark.asyncio
    async def test_single_iteration_run_is_unchanged(self):
        """Regression lock: a PASS-first-try run assembles exactly once."""
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])

        result = await _run(config, recorder, _input())

        assert result.decision == "PASS"
        assert recorder.calls["assemble_prompt"] == 1
        assert recorder.calls["generate"] == 1

    @pytest.mark.asyncio
    async def test_reused_assemble_still_threads_response_format_and_segments(self):
        """The regen generate/sensor calls must carry the REUSED assemble output."""
        from harness.temporal.models import SegmentCitationRef

        recorder = StubRecorder()
        config = StubConfig(
            verdicts=["REGEN", "PASS"],
            segment_citations=[SegmentCitationRef(id="seg-1", idx=0)],
        )

        await _run(config, recorder, _input(gate=HarnessGateConfig(max_regen=2)))

        assert recorder.calls["assemble_prompt"] == 1
        # Both generate calls (initial + regen) carry the same assembled prompt
        # and its PHI-safe segment refs; the regen adds only the critique.
        assert [g.prompt for g in recorder.generate_inputs] == ["U", "U"]
        assert all([s.id for s in g.segment_citations] == ["seg-1"] for g in recorder.generate_inputs)
        assert recorder.generate_inputs[0].regen_feedback is None
        assert recorder.generate_inputs[1].regen_feedback is not None
        # run_sensors keeps receiving the assemble-derived response_format + ids.
        assert all(s.allowed_segment_ids == ["seg-1"] for s in recorder.run_sensors_inputs)
        assert all(s.response_format is not None for s in recorder.run_sensors_inputs)

    @pytest.mark.asyncio
    async def test_post_delivery_regen_reassembles(self):
        """The optimistic post-delivery regen keeps its OWN assemble call.

        It runs after ``persist_draft``, so the apps/api-side state the assemble
        reads (NamedEntity rows for the delivered note) can genuinely have
        changed — reuse across that boundary would be unsound.
        """
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["REGEN", "SAFE"])

        await _run(config, recorder, _input(gate=_opt_gate()))

        # One pre-delivery assemble + one for the post-delivery regen pass.
        assert recorder.calls["assemble_prompt"] == 2
        assert recorder.calls["persist_draft"] == 2
