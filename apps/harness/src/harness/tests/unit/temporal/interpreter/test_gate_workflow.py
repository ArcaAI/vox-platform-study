"""``ConsultationGateWorkflow`` — the durable human wait (TASK-731 Phase B).

Run against a real time-skipping Temporal test server, because the property under test IS the
timing: an SLA that expires, an escalation ladder that fires, a terminal bound that abandons.
A mocked clock would prove the mock.

**The property this file exists to defend: a timeout never signs.** Every test below is
ultimately about that one sentence from `03-compliance-posture.md` §3 — the escalation ladder
can end in exactly two states, and the one that a caller could read as sign-off is only ever
reached from a real `approval` signal.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.api_client import RecordGateResponse
from harness.temporal.interpreter.gate_workflow import (
    ConsultationGateWorkflow,
    gate_workflow_id,
)
from harness.temporal.interpreter.models import ConsultationGateInput, GateApprovalSignal
from harness.temporal.models import (
    EscalateInput,
    EscalateResult,
    FetchPolicyInput,
    HarnessPolicy,
    RecordGateInput,
)

_TENANT = "10000000-0000-0000-0000-000000000001"

#: A short ladder so the time-skipping server can walk it in test time.
_SLA_SECONDS = 60.0
_ESCALATION_SECONDS = 30.0


def _input(**overrides) -> ConsultationGateInput:
    base = {
        "run_id": "run-1",
        "node_id": "n_gate",
        "tenant_id": _TENANT,
        "consultation_id": "c1",
        "gate_type": "consultation.hitlGate",
        "timeout_seconds": 900,
        "on_timeout": "TIMED_OUT",
    }
    base.update(overrides)
    return ConsultationGateInput(**base)


class _Recorder:
    """Captures what the gate actually wrote, so a test can assert on side effects rather than
    only on the return value."""

    def __init__(self) -> None:
        self.escalations: list[str] = []
        self.decisions: list[RecordGateInput] = []


def _activities(recorder: _Recorder, *, policy: HarnessPolicy | None = None):
    @activity.defn(name="fetch_policy")
    async def fetch_policy_stub(payload: FetchPolicyInput) -> HarnessPolicy:
        if policy is None:
            raise RuntimeError("policy service unreachable")
        return policy

    @activity.defn(name="escalate_gate")
    async def escalate_gate_stub(payload: EscalateInput) -> EscalateResult:
        recorder.escalations.append(payload.reason)
        return EscalateResult(escalated=True)

    @activity.defn(name="record_gate_decision")
    async def record_gate_decision_stub(payload: RecordGateInput) -> RecordGateResponse:
        recorder.decisions.append(payload)
        return RecordGateResponse(recorded=True)

    return [fetch_policy_stub, escalate_gate_stub, record_gate_decision_stub]


def _policy(max_escalations_irrelevant: bool = True) -> HarnessPolicy:
    """`gate_max_escalations` is NOT a policy field — it is a loop-safety bound carried on
    `HarnessGateConfig` (default 3). The policy only supplies the two timers."""
    return HarnessPolicy(
        gate_sla_seconds=_SLA_SECONDS,
        gate_escalation_seconds=_ESCALATION_SECONDS,
    )


async def _run_gate(env: WorkflowEnvironment, client: Client, recorder: _Recorder, *, policy, signal_after=None, payload=None):
    task_queue = f"gate-{uuid.uuid4()}"
    async with Worker(
        client,
        task_queue=task_queue,
        workflows=[ConsultationGateWorkflow],
        activities=_activities(recorder, policy=policy),
    ):
        handle = await client.start_workflow(
            ConsultationGateWorkflow.run,
            _input(),
            id=gate_workflow_id(f"run-{uuid.uuid4()}"),
            task_queue=task_queue,
        )
        if signal_after is not None:
            await env.sleep(signal_after)
            await handle.signal(ConsultationGateWorkflow.approval, payload)
        return await handle.result()


@pytest.fixture
async def env():
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as environment:
        yield environment


class TestApprovalPath:
    @pytest.mark.asyncio
    async def test_a_real_approval_signs_and_records_the_decision(self, env):
        recorder = _Recorder()
        result = await _run_gate(
            env,
            env.client,
            recorder,
            policy=_policy(),
            signal_after=timedelta(seconds=5),
            payload=GateApprovalSignal(
                decision="SIGNED", clinician_id="dr-1", context_item_version_id="v2"
            ),
        )

        assert result.approved is True
        assert result.outcome == "APPROVED"
        assert result.clinician_id == "dr-1"
        assert result.context_item_version_id == "v2"
        assert result.escalations == 0
        # The WORM GATE_DECISION is written exactly once, carrying the clinician's own fields.
        assert len(recorder.decisions) == 1
        assert recorder.decisions[0].clinician_id == "dr-1"
        assert recorder.decisions[0].decision == "SIGNED"
        assert recorder.escalations == []

    @pytest.mark.asyncio
    async def test_an_approval_arriving_after_an_escalation_still_wins(self, env):
        # A late clinician is still a real clinician: the ladder having fired does not close the
        # gate, only the terminal bound does.
        recorder = _Recorder()
        result = await _run_gate(
            env,
            env.client,
            recorder,
            policy=_policy(),
            signal_after=timedelta(seconds=_SLA_SECONDS + 5),
            payload=GateApprovalSignal(decision="SIGNED", clinician_id="dr-late"),
        )

        assert result.approved is True
        assert result.escalations == 1
        assert recorder.escalations == ["gate_sla_breached"]
        assert len(recorder.decisions) == 1

    @pytest.mark.asyncio
    async def test_decision_defaults_to_signed_when_the_signal_omits_it(self, env):
        recorder = _Recorder()
        result = await _run_gate(
            env,
            env.client,
            recorder,
            policy=_policy(),
            signal_after=timedelta(seconds=5),
            payload=GateApprovalSignal(clinician_id="dr-1"),
        )
        assert result.decision == "SIGNED"


class TestTimeoutNeverSigns:
    """The load-bearing property. Nothing in this class may ever end with `approved is True`."""

    @pytest.mark.asyncio
    async def test_the_ladder_abandons_without_signing(self, env):
        recorder = _Recorder()
        result = await _run_gate(env, env.client, recorder, policy=_policy())

        assert result.approved is False
        assert result.outcome == "ABANDONED"
        # No decision is recorded, because there was none. An abandoned gate leaves the draft
        # where the graph left it; it does not sign, retract or deliver.
        assert recorder.decisions == []

    @pytest.mark.asyncio
    async def test_the_ladder_is_bounded_and_the_last_escalation_is_terminal(self, env):
        recorder = _Recorder()
        result = await _run_gate(env, env.client, recorder, policy=_policy())

        # HarnessGateConfig.gate_max_escalations defaults to 3 — the bound that stops an
        # un-signed gate escalating forever.
        assert result.escalations == 3
        assert recorder.escalations == [
            "gate_sla_breached",
            "gate_sla_breached",
            "gate_sla_abandoned",
        ]

    @pytest.mark.asyncio
    async def test_an_abandoned_result_carries_no_clinician_or_version(self, env):
        recorder = _Recorder()
        result = await _run_gate(env, env.client, recorder, policy=_policy())
        assert result.decision is None
        assert result.clinician_id is None
        assert result.context_item_version_id is None


class TestPolicyDegradation:
    @pytest.mark.asyncio
    async def test_an_unreachable_policy_service_still_waits_on_the_defaults(self, env):
        # Refusing to wait because a config read timed out would strand a real clinical
        # decision. The defaults are the conservative direction — a LONGER wait (86400s SLA),
        # never a shorter one that could abandon early.
        recorder = _Recorder()
        task_queue = f"gate-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=task_queue,
            workflows=[ConsultationGateWorkflow],
            activities=_activities(recorder, policy=None),
        ):
            handle = await env.client.start_workflow(
                ConsultationGateWorkflow.run,
                _input(),
                id=gate_workflow_id(f"run-{uuid.uuid4()}"),
                task_queue=task_queue,
            )
            # Well past the SHORT test SLA, nowhere near the 86400s default: still waiting.
            await env.sleep(timedelta(seconds=_SLA_SECONDS * 3))
            assert recorder.escalations == []

            await handle.signal(
                ConsultationGateWorkflow.approval, GateApprovalSignal(clinician_id="dr-1")
            )
            result = await handle.result()

        assert result.approved is True
        assert result.escalations == 0


class TestSignalDiscipline:
    @pytest.mark.asyncio
    async def test_a_second_approval_does_not_overwrite_the_first(self, env):
        # The gate is decided once. A second signal must not rewrite who signed.
        recorder = _Recorder()
        task_queue = f"gate-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=task_queue,
            workflows=[ConsultationGateWorkflow],
            activities=_activities(recorder, policy=_policy()),
        ):
            handle = await env.client.start_workflow(
                ConsultationGateWorkflow.run,
                _input(),
                id=gate_workflow_id(f"run-{uuid.uuid4()}"),
                task_queue=task_queue,
            )
            await handle.signal(
                ConsultationGateWorkflow.approval, GateApprovalSignal(clinician_id="dr-first")
            )
            await handle.signal(
                ConsultationGateWorkflow.approval, GateApprovalSignal(clinician_id="dr-second")
            )
            result = await handle.result()

        assert result.clinician_id == "dr-first"
        assert len(recorder.decisions) == 1


class TestWorkflowId:
    def test_gate_id_is_derived_from_the_run_id_alone(self):
        # What lets the approve route address the child without reading run state.
        assert gate_workflow_id("run-abc") == "run-abc-gate"
