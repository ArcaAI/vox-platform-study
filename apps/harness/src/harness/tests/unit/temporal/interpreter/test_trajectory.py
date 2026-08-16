"""Per-node trajectory emission tests (Task 7).

Reuses `_TrajectoryBatch` (harness.temporal.activities) — no second emitter. `_TrajectoryBatch
.record()` calls `activity.info()`, so (matching test_activities_claim_check.py's pattern) the
seed activities run inside a real Temporal `ActivityEnvironment` with `ApiClient
.report_trajectory` monkeypatched — no network call, no live Temporal server.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.services import api_client as api_client_module
from harness.services.api_client import TrajectoryReportResponse
from harness.temporal.interpreter.activities import interpreter_noop, interpreter_passthrough
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.models import TrajectoryContext


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _payload(*, raise_error: bool = False, trajectory: TrajectoryContext | None) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n1",
        node_type="noop",
        config={"raise_error": raise_error},
        tenant_id="t-1",
        trajectory=trajectory,
    )


class TestTrajectoryContextIsAdditiveOptional:
    def test_every_new_field_is_optional_in_model_fields(self):
        # Mirrors test_gating_consolidation_replay.py's additive-optional-field assertion
        # style for RunInferentialSensorsInput.
        for name in ("workflow_version_id", "stage_id", "node_id", "node_type", "consultation_id"):
            field = TrajectoryContext.model_fields[name]
            assert not field.is_required(), f"{name} must be optional (additive-optional)"

    def test_constructs_with_only_tenant_id(self):
        # An old caller that only ever set tenant_id must still construct successfully.
        ctx = TrajectoryContext(tenant_id="t-1")
        assert ctx.consultation_id is None
        assert ctx.workflow_version_id is None


class TestEmittedShape:
    @pytest.mark.asyncio
    async def test_success_emits_one_ok_node_step(self, env, monkeypatch):
        captured: list[Any] = []

        async def _fake_report_trajectory(self, steps, *, idempotency_key=None):
            captured.extend(steps)
            return TrajectoryReportResponse(accepted=len(steps))

        monkeypatch.setattr(
            api_client_module.ApiClient, "report_trajectory", _fake_report_trajectory
        )

        ctx = TrajectoryContext(tenant_id="t-1", node_id="n1", node_type="noop", seq=4)
        await env.run(interpreter_noop, _payload(trajectory=ctx))

        assert len(captured) == 1
        step = captured[0]
        assert step.step_type == "NODE"
        assert step.status == "OK"
        assert step.name == "noop"
        assert step.tenant_id == "t-1"

    @pytest.mark.asyncio
    async def test_degraded_emits_error_status_before_raising(self, env, monkeypatch):
        captured: list[Any] = []

        async def _fake_report_trajectory(self, steps, *, idempotency_key=None):
            captured.extend(steps)
            return TrajectoryReportResponse(accepted=len(steps))

        monkeypatch.setattr(
            api_client_module.ApiClient, "report_trajectory", _fake_report_trajectory
        )

        ctx = TrajectoryContext(tenant_id="t-1", node_id="n1", node_type="noop")
        with pytest.raises(RuntimeError):
            await env.run(interpreter_noop, _payload(raise_error=True, trajectory=ctx))

        assert len(captured) == 1
        assert captured[0].status == "ERROR"
        assert captured[0].error_code == "simulated_failure"


class TestTrajectoryFailureNeverFailsTheNode:
    @pytest.mark.asyncio
    async def test_raising_report_trajectory_does_not_fail_the_activity(self, env, monkeypatch):
        async def _raising_report_trajectory(self, steps, *, idempotency_key=None):
            raise RuntimeError("gateway down")

        monkeypatch.setattr(
            api_client_module.ApiClient, "report_trajectory", _raising_report_trajectory
        )

        ctx = TrajectoryContext(tenant_id="t-1", node_id="n1", node_type="passthrough")
        result = await env.run(interpreter_passthrough, _payload(trajectory=ctx))
        assert result.status == "SUCCEEDED"  # the node itself never sees the failure

    @pytest.mark.asyncio
    async def test_no_trajectory_context_emits_nothing_and_does_not_error(self, env, monkeypatch):
        called = False

        async def _fake_report_trajectory(self, steps, *, idempotency_key=None):
            nonlocal called
            called = True
            return TrajectoryReportResponse(accepted=len(steps))

        monkeypatch.setattr(
            api_client_module.ApiClient, "report_trajectory", _fake_report_trajectory
        )

        result = await env.run(interpreter_noop, _payload(trajectory=None))
        assert result.status == "SUCCEEDED"
        assert called is False
