"""TASK-957 F-8 — clinician and node identity reach the gateway on a trajectory step.

The interpreter already COMPUTES all of this. ``TrajectoryContext`` carries
``workflow_version_id`` / ``stage_id`` / ``node_id`` / ``node_type`` per node, and the run's
SERVER-RESOLVED ``RunSubject.user_id`` names the clinician the run acts for. None of it reached
``_TrajectoryBatch.record()``, the wire DTO forbids extra keys, and so the ledger row for a
workflow generation could say what it cost but not which node of which definition version spent
it, nor for whom. ``requestId = runId`` was the closest proxy and it stops at the run.

Three properties are pinned here, and they are the ones that make the change safe to deploy in
either order:

1. every new field is ADDITIVE-OPTIONAL on both models, so an in-flight workflow whose history
   carries a context without them still deserializes;
2. ``to_wire()`` PRUNES what is absent, so an older gateway (whose DTO whitelist would 400 the
   whole batch on an unknown key) is unaffected by a newer worker;
3. nothing is GUESSED — a consultation-lane context carries no clinician, and the wire says so
   by omission rather than by inventing the activity's caller.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.services import api_client as api_client_module
from harness.services.api_client import TrajectoryReportResponse, TrajectoryStepInput
from harness.temporal.interpreter.activities import interpreter_noop
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.models import TrajectoryContext

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _context(**over: Any) -> TrajectoryContext:
    base: dict[str, Any] = {
        "tenant_id": "t-1",
        "seq": 4,
        "workflow_version_id": "wfv-7",
        "stage_id": "2",
        "node_id": "draft-note",
        "node_type": "core.agent",
    }
    base.update(over)
    return TrajectoryContext(**base)


async def _run_and_capture(
    env: ActivityEnvironment, monkeypatch, ctx: TrajectoryContext
) -> list[Any]:
    captured: list[Any] = []

    async def _fake_report_trajectory(self, steps, *, idempotency_key=None):
        captured.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))

    monkeypatch.setattr(api_client_module.ApiClient, "report_trajectory", _fake_report_trajectory)
    await env.run(
        interpreter_noop,
        NodeActivityInput(
            node_id="draft-note", node_type="noop", config={}, tenant_id="t-1", trajectory=ctx
        ),
    )
    return captured


class TestAdditiveOptional:
    def test_doctor_id_is_optional_on_the_context(self):
        assert not TrajectoryContext.model_fields["doctor_id"].is_required()

    def test_old_context_still_constructs(self):
        ctx = TrajectoryContext(tenant_id="t-1")
        assert ctx.doctor_id is None
        assert ctx.node_id is None

    def test_every_new_wire_field_is_optional_on_the_step(self):
        for name in ("doctor_id", "node_id", "workflow_version_id", "node_type"):
            assert not TrajectoryStepInput.model_fields[name].is_required(), name


class TestWirePruning:
    def _step(self, **over: Any) -> TrajectoryStepInput:
        base: dict[str, Any] = {
            "tenant_id": "t-1",
            "session_id": "wf-1",
            "run_id": "run-1",
            "seq": 4,
            "step_type": "LLM_CALL",
            "name": "generate",
            "status": "OK",
            "started_at": datetime.now(UTC).isoformat(),
        }
        base.update(over)
        return TrajectoryStepInput(**base)

    def test_carries_all_four_when_known(self):
        wire = self._step(
            doctor_id="user-9",
            node_id="draft-note",
            workflow_version_id="wfv-7",
            node_type="core.agent",
        ).to_wire()

        assert wire["doctorId"] == "user-9"
        assert wire["nodeId"] == "draft-note"
        assert wire["workflowVersionId"] == "wfv-7"
        assert wire["nodeType"] == "core.agent"

    def test_omits_every_one_it_does_not_know(self):
        wire = self._step().to_wire()

        for key in ("doctorId", "nodeId", "workflowVersionId", "nodeType"):
            assert key not in wire, f"{key} must be pruned, not sent as null"


class TestRecordThreadsTheContext:
    @pytest.mark.asyncio
    async def test_node_identity_rides_every_step(self, env, monkeypatch):
        captured = await _run_and_capture(env, monkeypatch, _context(doctor_id="user-9"))

        assert captured, "the node activity must have emitted a step"
        step = captured[0]
        assert step.doctor_id == "user-9"
        assert step.node_id == "draft-note"
        assert step.workflow_version_id == "wfv-7"
        assert step.node_type == "core.agent"

    @pytest.mark.asyncio
    async def test_absent_clinician_is_absent_rather_than_guessed(self, env, monkeypatch):
        # The consultation lane builds its context without a clinician (nothing in that
        # workflow's input carries one), so the step must say nothing rather than reach for
        # the activity's caller or the tenant's first doctor.
        captured = await _run_and_capture(env, monkeypatch, _context())

        assert captured[0].doctor_id is None
        assert "doctorId" not in captured[0].to_wire()
