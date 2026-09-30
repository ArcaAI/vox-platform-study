"""TASK-1022 L-RESUME — how the gateway retires a governing run parked at its human review.

When a governed consultation records again after a stop, the gateway SUPERSEDES the governing
run (`ConsultationWorkflowDispatchService.supersedeGoverningRun`): a fresh run of the same graph
re-finalises the whole visit, and the parked run must go away WITH its `ReviewGateWorkflow`
child — otherwise a clinician would be left with two reviews for one note.

These tests pin the two Temporal facts that choice rests on, with no workflow-code change:

1. the interpreter's `cancel` SIGNAL does not release a run parked on its review — the flag is
   read between stages, and the walk is awaiting the child — so the gateway cannot use it;
2. TERMINATING the parked run closes its review child too (the default parent-close policy,
   `_run_review` sets none), which is what the gateway's `terminateWorkflowRun` relies on.

The third fact — a FRESH run whose first handoff poll answers `ended` finalizes at once — is
already pinned by `test_task932_live_handoff.py::test_a_live_owned_node_s_persisted_output_binds_into_its_durable_consumer`.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowExecutionStatus
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.review_workflow import review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event
from harness.tests.unit.temporal.interpreter.test_core_interpreter import (
    _ACTIVITIES,
    _TENANT,
    _WORKFLOWS,
    _review_body,
    _store,
)

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


async def _parked_run(env: WorkflowEnvironment, tq: str) -> tuple[Any, str]:
    """Start an interpreter run and return once its review child is waiting on a human."""
    ref = await _store(_review_body(timeout_seconds=3600))
    run_id = str(uuid.uuid4())
    handle = await env.client.start_workflow(
        WorkflowInterpreter.run,
        InterpreterInput(
            session_id="s-1",
            workflow_version_id="v-1",
            config_ref=ref,
            tenant_id=_TENANT,
            run_id=run_id,
            payload={},
        ),
        id=f"workflow-interpreter-{run_id}",
        task_queue=tq,
    )

    def _review_child_started(event: Any) -> bool:
        return (
            event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
            and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
            == review_gate_workflow_id(run_id, "n_review")
        )

    await await_history_event(handle, _review_child_started, description="review child started")
    return handle, run_id


class TestRetiringAParkedGoverningRun:
    @pytest.mark.asyncio
    async def test_the_cancel_signal_does_not_release_a_run_parked_on_its_review(self):
        async with await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        ) as env:
            tq = f"task1022-{uuid.uuid4()}"
            async with Worker(
                env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES
            ):
                handle, run_id = await _parked_run(env, tq)

                await handle.signal(WorkflowInterpreter.cancel)
                await asyncio.sleep(1.0)

                parent = await handle.describe()
                child = await env.client.get_workflow_handle(
                    review_gate_workflow_id(run_id, "n_review")
                ).describe()
                assert parent.status == WorkflowExecutionStatus.RUNNING
                assert child.status == WorkflowExecutionStatus.RUNNING
                await handle.terminate(reason="test cleanup")

    @pytest.mark.asyncio
    async def test_terminating_the_parked_run_closes_its_review_child_too(self):
        # A REAL (local dev) server, deliberately: the time-skipping Java test server does not
        # enforce the parent-close policy — measured 2026-09-30, the child stayed RUNNING after its
        # parent was TERMINATED there — so it cannot state what a deployed Temporal does.
        async with await WorkflowEnvironment.start_local(
            data_converter=pydantic_data_converter
        ) as env:
            tq = f"task1022-{uuid.uuid4()}"
            async with Worker(
                env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES
            ):
                handle, run_id = await _parked_run(env, tq)

                await handle.terminate(reason="superseded by run-new")

                child_handle = env.client.get_workflow_handle(
                    review_gate_workflow_id(run_id, "n_review")
                )
                for _ in range(50):
                    child = await child_handle.describe()
                    if child.status != WorkflowExecutionStatus.RUNNING:
                        break
                    await asyncio.sleep(0.1)

                assert (await handle.describe()).status == WorkflowExecutionStatus.TERMINATED
                assert child.status == WorkflowExecutionStatus.TERMINATED
