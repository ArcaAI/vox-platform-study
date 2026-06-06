"""End-to-end test for HarnessPingWorkflow using Temporal's time-skipping test
environment — no external Temporal server required.

RED-first: written before the workflow/activity exist. Proves the durable
workflow substrate (workflow drives a deterministic body; the activity holds
the I/O) executes end-to-end and returns the expected result.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.activities import ping_activity
from harness.temporal.workflows import HarnessPingWorkflow


class TestHarnessPingWorkflow:
    @pytest.mark.asyncio
    async def test_ping_workflow_executes_activity_and_returns_result(self):
        """HarnessPingWorkflow runs the ping activity and returns 'pong: <msg>'."""
        async with await WorkflowEnvironment.start_time_skipping() as env:
            task_queue = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=task_queue,
                workflows=[HarnessPingWorkflow],
                activities=[ping_activity],
            ):
                result = await env.client.execute_workflow(
                    HarnessPingWorkflow.run,
                    "hello",
                    id=f"harness-ping-{uuid.uuid4()}",
                    task_queue=task_queue,
                )

        assert result.message == "pong: hello"
        assert result.task_queue == task_queue

    @pytest.mark.asyncio
    async def test_ping_workflow_is_deterministic_across_replay(self):
        """A second execution with the same input yields the same result
        (the workflow body must stay deterministic; I/O lives in the activity)."""
        async with await WorkflowEnvironment.start_time_skipping() as env:
            task_queue = f"harness-test-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=task_queue,
                workflows=[HarnessPingWorkflow],
                activities=[ping_activity],
            ):
                first = await env.client.execute_workflow(
                    HarnessPingWorkflow.run,
                    "determinism",
                    id=f"harness-ping-{uuid.uuid4()}",
                    task_queue=task_queue,
                )
                second = await env.client.execute_workflow(
                    HarnessPingWorkflow.run,
                    "determinism",
                    id=f"harness-ping-{uuid.uuid4()}",
                    task_queue=task_queue,
                )

        assert first.message == second.message == "pong: determinism"
