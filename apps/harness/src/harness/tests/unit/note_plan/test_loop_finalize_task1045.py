"""The loop's finalize child executes the note plan the ending signal carries.

``ConsultationEndingSignal.finalize.note_plan_ref`` → ``LoopFinalizeRequest`` → the child
``HarnessDocWorkflowInput.note_plan_ref``, where the child's own ``task-1045-note-plan`` gate runs
``execute_note_plan`` in place of ``generate``. Without a ref the child keeps the legacy
``generate`` path and records no marker, so a pre-existing history replays byte-identically. The
loop workflow itself records no marker either way: it only passes the ref through.

Hermetic: the REAL ``ConsultationLoopWorkflow`` and ``HarnessDocWorkflow`` run in Temporal's
time-skipping environment against name-matched stub activities.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from harness.services.note_plan.models import NotePlanRef
from harness.services.text_client import TextGenerationResult
from harness.temporal.models import (
    LOOP_ACTION_HARNESS_FINALIZE,
    ConsultationEndingSignal,
    ConsultationLoopWorkflowInput,
    ExecuteNotePlanInput,
    ExecuteNotePlanResult,
    LoopFinalizeRequest,
)
from harness.temporal.workflows import (
    ConsultationLoopWorkflow,
    HarnessDocWorkflow,
    consultation_loop_workflow_id,
)
from harness.tests.unit.temporal._harness_stubs import (
    _OK_NOTE,
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
from harness.tests.unit.temporal._temporal_sync import start_time_skipping

_PATCH_ID = "task-1045-note-plan"
_PLAN_ID = "0199a000-0000-7000-8000-000000000001"


async def _markers(handle) -> list[str]:
    """Every MARKER_RECORDED event of an execution, rendered (patch ids are in the details)."""
    return [
        str(event.marker_recorded_event_attributes)
        async for event in handle.fetch_history_events()
        if event.event_type == EventType.EVENT_TYPE_MARKER_RECORDED
    ]


async def _finalize(note_plan_ref: NotePlanRef | None):
    """Run the loop to its ending, let the finalize child draft its note, and report back."""
    plan_inputs: list[ExecuteNotePlanInput] = []

    @activity.defn(name="execute_note_plan")
    async def execute_note_plan(payload: ExecuteNotePlanInput) -> ExecuteNotePlanResult:
        plan_inputs.append(payload)
        return ExecuteNotePlanResult(
            generation=TextGenerationResult(
                content=_OK_NOTE, model="gemma-4-e2b-it-qat", provider="lmstudio"
            ),
            coverage={"schema": "hope.coverage.v1", "status": "complete"},
        )

    config = default_loop_config(ending_actions=[LOOP_ACTION_HARNESS_FINALIZE])
    doc_recorder = StubRecorder()
    env = await start_time_skipping(data_converter=pydantic_data_converter)
    try:
        task_queue = f"loop-plan-tq-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=task_queue,
            workflows=[ConsultationLoopWorkflow, HarnessDocWorkflow],
            activities=[
                *make_loop_stub_activities(LoopStubConfig(config=config), LoopStubRecorder()),
                *make_stub_activities(StubConfig(), doc_recorder),
                execute_note_plan,
            ],
        ):
            consultation_id = f"c-{uuid.uuid4()}"
            handle = await env.client.start_workflow(
                ConsultationLoopWorkflow.run,
                ConsultationLoopWorkflowInput(
                    consultation_id=consultation_id, tenant_id="t-1", user_id="u-1"
                ),
                id=consultation_loop_workflow_id(consultation_id),
                task_queue=task_queue,
            )
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending,
                ConsultationEndingSignal(
                    reason="recording_stopped",
                    finalize=LoopFinalizeRequest(note_plan_ref=note_plan_ref),
                ),
            )
            for _ in range(600):
                if doc_recorder.calls["persist_draft"] >= 1:
                    break
                await asyncio.sleep(0.02)
            assert doc_recorder.calls["persist_draft"] >= 1, "the finalize child never drafted"

            child = env.client.get_workflow_handle(f"harness-doc-{consultation_id}")
            child_markers = await _markers(child)
            loop_markers = await _markers(handle)
            await handle.cancel()
    finally:
        await env.shutdown()
    return plan_inputs, doc_recorder, child_markers, loop_markers


class TestLoopFinalizeNotePlan:
    @pytest.mark.asyncio
    async def test_the_ending_ref_reaches_the_child_and_its_plan_path_runs(self):
        ref = NotePlanRef(consultation_id="c-plan", plan_id=_PLAN_ID, mode="final")

        plan_inputs, doc_recorder, child_markers, loop_markers = await _finalize(ref)

        assert [p.note_plan_ref for p in plan_inputs] == [ref]
        assert plan_inputs[0].tenant_id == "t-1"
        assert doc_recorder.calls["generate"] == 0
        # The plan path is gated by the child's own patch marker.
        assert any(_PATCH_ID in marker for marker in child_markers)
        # The loop only passes the ref through: no marker of its own.
        assert not any(_PATCH_ID in marker for marker in loop_markers)

    @pytest.mark.asyncio
    async def test_without_a_ref_the_child_keeps_the_legacy_generate_path_and_no_marker(self):
        plan_inputs, doc_recorder, child_markers, loop_markers = await _finalize(None)

        assert plan_inputs == []
        assert doc_recorder.calls["generate"] == 1
        assert not any(_PATCH_ID in marker for marker in child_markers)
        assert not any(_PATCH_ID in marker for marker in loop_markers)
