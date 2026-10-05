"""HarnessDocWorkflow + NotePlan: the post-delivery regen re-executes the PLAN, and every
delivery stamps the note record of the generation it delivers — once.

Time-skipping Temporal env with the name-matched stub activities (``_harness_stubs``) plus an
``execute_note_plan`` stub; pure orchestration, no server, DB or model.
"""

from __future__ import annotations

import uuid
from typing import Any

from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.note_plan.models import NotePlanRef
from harness.services.text_client import TextGenerationResult
from harness.temporal.models import (
    ApprovalSignal,
    ExecuteNotePlanInput,
    ExecuteNotePlanResult,
    HarnessDocWorkflowInput,
    HarnessGateConfig,
    HarnessPolicy,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    _OK_NOTE,
    StubConfig,
    StubRecorder,
    make_stub_activities,
)

REF = NotePlanRef(consultation_id="c-1", plan_id="plan-1", mode="final")
FALLBACK = {"autoSwitch": True, "chain": []}


def _input(**kw: Any) -> HarnessDocWorkflowInput:
    base: dict[str, Any] = {
        "consultation_id": "c-1",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "job_id": "job-1",
        "context_item_id": "ctx-t1",
        "transcript_text": "Patient has hypertension.",
        "gate": HarnessGateConfig(optimistic_delivery_enabled=True, max_regen=2),
    }
    base.update(kw)
    return HarnessDocWorkflowInput(**base)


def _approval() -> ApprovalSignal:
    return ApprovalSignal(
        decision="SIGNED",
        clinician_id="doc-1",
        context_item_version_id="v-1",
        attestation_hash="h-1",
    )


def _plan_stub(executed: list[ExecuteNotePlanInput]):
    @activity.defn(name="execute_note_plan")
    async def execute_note_plan(payload: ExecuteNotePlanInput) -> ExecuteNotePlanResult:
        executed.append(payload)
        n = len(executed)
        return ExecuteNotePlanResult(
            generation=TextGenerationResult(
                content=_OK_NOTE, model="gemma", provider="lmstudio", usage={"total_tokens": 10}
            ),
            coverage={"schema": "hope.note_coverage.v1", "status": "complete", "execution": n},
            note_run_stats={"activity_kind": "NOTE_GENERATE", "plan_id": "plan-1", "execution": n},
        )

    return execute_note_plan


async def _run(inp: HarnessDocWorkflowInput, config: StubConfig, recorder: StubRecorder):
    executed: list[ExecuteNotePlanInput] = []
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"harness-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[HarnessDocWorkflow],
            activities=[*make_stub_activities(config, recorder), _plan_stub(executed)],
        ):
            handle = await env.client.start_workflow(
                HarnessDocWorkflow.run, inp, id=f"harness-doc-{uuid.uuid4()}", task_queue=tq
            )
            await handle.signal(HarnessDocWorkflow.approval, _approval())
            result = await handle.result()
    return result, executed


def _regen_config() -> StubConfig:
    # Delivered early, the assurance pass asks for ONE regen, the second pass is safe.
    return StubConfig(
        verdicts=["PASS", "PASS"],
        inferential_verdicts=["REGEN", "SAFE"],
        policy=HarnessPolicy(text_fallback=FALLBACK),
    )


async def test_the_post_delivery_regen_re_executes_the_plan_not_a_single_generate() -> None:
    recorder = StubRecorder()
    result, executed = await _run(_input(note_plan_ref=REF), _regen_config(), recorder)

    assert result.regens_used == 1
    assert recorder.calls["generate"] == 0
    assert len(executed) == 2
    assert all(e.note_plan_ref == REF for e in executed)
    # The regen carries the run's fallback chain like the first execution.
    assert all(e.text_fallback == FALLBACK for e in executed)
    assert executed[1].trajectory is not None and executed[1].trajectory.is_regen is True


async def test_each_delivery_stamps_the_note_record_of_the_generation_it_delivers() -> None:
    recorder = StubRecorder()
    await _run(_input(note_plan_ref=REF), _regen_config(), recorder)

    [first, second] = recorder.persist_draft_inputs
    assert first.note_run_stats is not None and first.note_run_stats["execution"] == 1
    assert first.coverage is not None and first.coverage["execution"] == 1
    # The re-delivery describes the REGENERATED note, never the first plan execution again.
    assert second.note_run_stats is not None and second.note_run_stats["execution"] == 2
    assert second.coverage is not None and second.coverage["execution"] == 2


async def test_a_run_without_a_plan_still_stamps_one_note_record_per_generation() -> None:
    recorder = StubRecorder()
    result, executed = await _run(_input(), _regen_config(), recorder)

    assert executed == []
    assert recorder.calls["generate"] == 2
    stamps = [p.note_run_stats for p in recorder.persist_draft_inputs]
    assert stamps == [{"activity_kind": "NOTE_GENERATE", "call_count": 1}] * 2
    assert [p.coverage for p in recorder.persist_draft_inputs] == [None, None]


async def test_the_legacy_single_phase_persist_stamps_the_last_plan_execution() -> None:
    recorder = StubRecorder()
    config = StubConfig(verdicts=["REGEN", "PASS"])
    inp = _input(note_plan_ref=REF, gate=HarnessGateConfig(max_regen=2))
    result, executed = await _run(inp, config, recorder)

    assert len(executed) == 2
    [persisted] = recorder.persist_draft_inputs
    assert persisted.note_run_stats is not None and persisted.note_run_stats["execution"] == 2
