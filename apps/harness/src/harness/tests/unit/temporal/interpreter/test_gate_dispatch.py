"""The interpreter's side of the HITL gate (TASK-731 Phase B).

`test_gate_workflow.py` covers what the gate DOES once started. This file covers whether the
interpreter starts it at all — the four refusals and the two outcomes — plus the two properties
that make shipping the new command safe:

* the gate runs as a CHILD, so the interpreter's own signal surface stays `cancel`-only;
* the new command is `workflow.patched`-gated behind a cheap operand (`config.gates`) that is
  provably False on every pre-existing history, because admission refused a non-empty `gates`
  until this change.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid

import pytest
from temporalio import activity
from temporalio import workflow as temporal_workflow
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.service import RPCError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.api_client import RecordGateResponse
from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.gate_workflow import (
    ConsultationGateWorkflow,
    gate_workflow_id,
)
from harness.temporal.interpreter.models import GateApprovalSignal, InterpreterInput
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.models import (
    EscalateInput,
    EscalateResult,
    FetchPolicyInput,
    HarnessPolicy,
    RecordGateInput,
)

_BUCKET = "harness-claim-check"
_GATE_NODE = "n_gate"


def _body(*, gates: list | None = None, with_stage_node: bool = True) -> dict:
    """A minimal config carrying one `passthrough` stage node plus (optionally) one gate."""
    stages = (
        [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "n1",
                        "type": "passthrough",
                        "activity": "interpreter.passthrough",
                        "config": {"contextItemId": "ci-1"},
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    }
                ],
            }
        ]
        if with_stage_node
        else []
    )
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "gate-test",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "consultation",
        "compiledAt": "2026-08-19T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": stages,
        "gates": gates if gates is not None else [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }


def _gate_row() -> dict:
    return {
        "nodeId": _GATE_NODE,
        "gateType": "consultation.hitlGate",
        "blocking": True,
        "timeoutSeconds": 900,
        "onTimeout": "TIMED_OUT",
    }


async def _config_ref(body: dict):
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return await store_blob(json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET)


class _Recorder:
    def __init__(self) -> None:
        self.escalations: list[str] = []
        self.decisions: list[RecordGateInput] = []


def _gate_activities(recorder: _Recorder):
    @activity.defn(name="fetch_policy")
    async def fetch_policy_stub(payload: FetchPolicyInput) -> HarnessPolicy:
        return HarnessPolicy(gate_sla_seconds=60.0, gate_escalation_seconds=30.0)

    @activity.defn(name="escalate_gate")
    async def escalate_gate_stub(payload: EscalateInput) -> EscalateResult:
        recorder.escalations.append(payload.reason)
        return EscalateResult(escalated=True)

    @activity.defn(name="record_gate_decision")
    async def record_gate_decision_stub(payload: RecordGateInput) -> RecordGateResponse:
        recorder.decisions.append(payload)
        return RecordGateResponse(recorded=True)

    return [fetch_policy_stub, escalate_gate_stub, record_gate_decision_stub]


@pytest.fixture
async def env():
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as environment:
        yield environment


async def _run_to_completion(env, recorder, *, body, payload=None, sandbox=False, approve=None):
    """Run the interpreter to a terminal state, optionally signalling the gate child first."""
    ref = await _config_ref(body)
    run_id = str(uuid.uuid4())
    tq = f"interp-gate-{uuid.uuid4()}"
    async with Worker(
        env.client,
        task_queue=tq,
        workflows=[WorkflowInterpreter, ConsultationGateWorkflow],
        activities=[*INTERPRETER_ACTIVITIES, *_gate_activities(recorder)],
    ):
        handle = await env.client.start_workflow(
            WorkflowInterpreter.run,
            InterpreterInput(
                session_id="s-1",
                workflow_version_id="v-1",
                config_ref=ref,
                tenant_id="t-1",
                run_id=run_id,
                sandbox=sandbox,
                payload=payload if payload is not None else {"consultationId": "c1", "userId": "u1"},
            ),
            id=f"wf-interp-{run_id}",
            task_queue=tq,
        )
        if approve is not None:
            await _signal_gate_when_started(env, run_id, approve)
        return await handle.result(), run_id


async def _signal_gate_when_started(env, run_id: str, approve: GateApprovalSignal) -> None:
    """The child only exists once the parent has walked its stages and started it, so a signal
    sent the instant the parent starts races it. Retry until the child is addressable — the same
    thing a real caller does by only offering the Approve action once the run reports it is
    waiting at the gate."""
    child = env.client.get_workflow_handle(gate_workflow_id(run_id))
    for _ in range(200):
        try:
            await child.signal(ConsultationGateWorkflow.approval, approve)
            return
        except RPCError:
            await asyncio.sleep(0.05)
    raise AssertionError("gate child never started")


def _gate_node(result):
    for stage in result.stages:
        for node in stage.nodes:
            if node.node_id == _GATE_NODE:
                return node
    return None


class TestGateOutcomes:
    @pytest.mark.asyncio
    async def test_an_approved_gate_succeeds_the_run(self, env):
        recorder = _Recorder()
        result, _ = await _run_to_completion(
            env,
            recorder,
            body=_body(gates=[_gate_row()]),
            approve=GateApprovalSignal(decision="SIGNED", clinician_id="dr-1"),
        )

        node = _gate_node(result)
        assert node is not None and node.status == "SUCCEEDED"
        assert result.status == "SUCCEEDED"
        assert len(recorder.decisions) == 1

    @pytest.mark.asyncio
    async def test_an_abandoned_gate_fails_the_run(self, env):
        # The gate is `critical: true`. An unsigned gate is not a degraded success — the run
        # did not reach the authority boundary its own graph requires.
        recorder = _Recorder()
        result, _ = await _run_to_completion(env, recorder, body=_body(gates=[_gate_row()]))

        node = _gate_node(result)
        assert node is not None and node.status == "FAILED"
        assert node.reason == "gate_abandoned"
        assert result.status == "FAILED"
        assert recorder.decisions == []


class TestGateRefusals:
    @pytest.mark.asyncio
    async def test_a_sandboxed_run_never_parks_on_a_human(self, env):
        # The stage-level `external_write` suppression cannot reach the gate (it is lifted out
        # of `stages`), so the check is repeated in `_run_gate` — this test is the reason.
        recorder = _Recorder()
        result, _ = await _run_to_completion(
            env, recorder, body=_body(gates=[_gate_row()]), sandbox=True
        )

        node = _gate_node(result)
        assert node is not None and node.status == "SKIPPED"
        assert node.reason == "sandbox"
        assert recorder.escalations == []
        assert recorder.decisions == []

    @pytest.mark.asyncio
    async def test_no_consultation_id_fails_rather_than_gating_the_wrong_record(self, env):
        recorder = _Recorder()
        result, _ = await _run_to_completion(
            env, recorder, body=_body(gates=[_gate_row()]), payload={}
        )

        node = _gate_node(result)
        assert node is not None and node.status == "FAILED"
        assert node.reason == "no_consultation_id"
        assert recorder.decisions == []


class TestNoGate:
    @pytest.mark.asyncio
    async def test_a_config_with_no_gate_is_byte_identical_to_before(self, env):
        # The cheap operand (`config.gates`) is False here, so `workflow.patched` is never even
        # called — the property that makes the new command safe for every recorded history.
        recorder = _Recorder()
        result, _ = await _run_to_completion(env, recorder, body=_body(gates=[]))

        assert result.status == "SUCCEEDED"
        assert _gate_node(result) is None
        assert len(result.stages) == 1
        assert recorder.escalations == [] and recorder.decisions == []


class TestSignalSurface:
    def test_the_interpreter_still_accepts_only_cancel(self):
        # TASK-718 R-2: v1 refuses a durable-wait signal surface, and Phase B must not widen it
        # for every palette. The gate's `approval` belongs to the CHILD type, not this one.
        definition = temporal_workflow._Definition.from_class(WorkflowInterpreter)  # noqa: SLF001
        assert definition is not None
        assert set(definition.signals) == {"cancel"}

    def test_the_gate_child_owns_approval(self):
        definition = temporal_workflow._Definition.from_class(ConsultationGateWorkflow)  # noqa: SLF001
        assert definition is not None
        assert set(definition.signals) == {"approval"}
