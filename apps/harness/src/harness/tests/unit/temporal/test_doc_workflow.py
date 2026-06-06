"""End-to-end tests for HarnessDocWorkflow via Temporal's time-skipping env.

RED-first: written before the workflow/activities exist. Activities are replaced
with name-matched deterministic stubs (see ``_harness_stubs``) so these tests
exercise pure orchestration: happy path + gate, bounded regen, regen-budget
exhaustion, the gate wait-condition + SLA escalation, and degradation paths.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from temporalio.client import WorkflowFailureError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.models import (
    ApprovalSignal,
    HarnessDocWorkflowInput,
    HarnessGateConfig,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)


def _input(**kw) -> HarnessDocWorkflowInput:
    base = {
        "consultation_id": "c-1",
        "tenant_id": "t-1",
        "user_id": "u-1",
        "job_id": "job-1",
        "context_item_id": "ctx-t1",
        "transcript_text": "Patient has hypertension.",
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


async def _env() -> WorkflowEnvironment:
    return await WorkflowEnvironment.start_time_skipping(data_converter=pydantic_data_converter)


async def _wait_phase(handle, target: str, max_polls: int = 300) -> None:
    for _ in range(max_polls):
        if await handle.query(HarnessDocWorkflow.phase) == target:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"workflow never reached phase {target!r}")


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_pass_first_try_persists_draft_and_closes_on_approval(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                # Buffered signal resolves the gate as soon as it is reached.
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 0
        assert result.approved is True
        assert result.clinician_id == "doc-1"
        assert result.context_item_id == "ctx-draft-1"
        assert recorder.calls["persist_entities"] == 1
        assert recorder.calls["persist_draft"] == 1
        assert recorder.calls["record_gate_decision"] == 1
        assert recorder.calls["escalate_gate"] == 0
        draft = recorder.persist_draft_inputs[0]
        assert draft.gate_decision == "PASS"
        assert draft.is_auto_generated is True
        assert recorder.record_inputs[0].gate_decision == "PASS"
        assert recorder.record_inputs[0].clinician_id == "doc-1"


class TestBoundedRegen:
    @pytest.mark.asyncio
    async def test_regen_then_pass_uses_budget(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "REGEN", "PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.regens_used == 2
        assert recorder.calls["run_sensors"] == 3  # initial + 2 regens
        assert recorder.calls["generate"] == 3
        assert recorder.calls["persist_draft"] == 1

    @pytest.mark.asyncio
    async def test_regen_budget_exhausted_flags(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["REGEN", "REGEN", "REGEN"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 2
        assert recorder.calls["run_sensors"] == 3
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].gate_decision == "FLAG"

    @pytest.mark.asyncio
    async def test_highest_harm_flag_first_try_skips_regen(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["FLAG"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        assert result.regens_used == 0
        assert recorder.calls["run_sensors"] == 1
        assert recorder.calls["persist_draft"] == 1


class TestGate:
    @pytest.mark.asyncio
    async def test_gate_blocks_until_approval_signal(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(gate=HarnessGateConfig(max_regen=2, gate_sla_seconds=1_000_000.0)),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await _wait_phase(handle, "GATE")
                # Still blocked after advancing well short of the SLA.
                await env.sleep(1)
                assert await handle.query(HarnessDocWorkflow.phase) == "GATE"
                assert recorder.calls["record_gate_decision"] == 0

                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert recorder.calls["record_gate_decision"] == 1
        assert recorder.calls["escalate_gate"] == 0

    @pytest.mark.asyncio
    async def test_sla_breach_escalates_then_resolves_on_later_approval(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"])
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(
                        gate=HarnessGateConfig(
                            max_regen=2,
                            gate_sla_seconds=30.0,
                            gate_escalation_seconds=1_000_000.0,
                        )
                    ),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await _wait_phase(handle, "GATE")
                # Advance past the SLA -> escalation fires, gate keeps waiting.
                await env.sleep(60)
                assert recorder.calls["escalate_gate"] >= 1
                assert await handle.query(HarnessDocWorkflow.phase) == "GATE"

                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "PASS"
        assert result.escalations >= 1
        assert recorder.escalate_inputs[0].reason == "gate_sla_breached"
        assert recorder.calls["record_gate_decision"] == 1


class TestDegradation:
    @pytest.mark.asyncio
    async def test_nlp_failure_forces_flag_no_auto_pass(self):
        recorder = StubRecorder()
        # Sensors would PASS, but NLP is down -> degraded -> never auto-PASS.
        config = StubConfig(verdicts=["PASS"], nlp_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.signal(HarnessDocWorkflow.approval, _approval())
                result = await handle.result()

        assert result.decision == "FLAG"
        # No entities extracted -> nothing to persist.
        assert recorder.calls["persist_entities"] == 0
        assert recorder.calls["persist_draft"] == 1
        assert recorder.persist_draft_inputs[0].gate_decision == "FLAG"

    @pytest.mark.asyncio
    async def test_smr_failure_fails_workflow_without_persisting_draft(self):
        recorder = StubRecorder()
        config = StubConfig(verdicts=["PASS"], generate_fails=True)
        async with await _env() as env:
            tq = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[HarnessDocWorkflow],
                activities=make_stub_activities(config, recorder),
            ):
                handle = await env.client.start_workflow(
                    HarnessDocWorkflow.run,
                    _input(),
                    id=f"harness-doc-{uuid.uuid4()}",
                    task_queue=tq,
                )
                with pytest.raises(WorkflowFailureError):
                    await handle.result()

        # Never silently downgrade: no draft on SMR failure.
        assert recorder.calls["persist_draft"] == 0
