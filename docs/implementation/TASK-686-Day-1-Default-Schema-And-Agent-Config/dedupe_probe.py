"""TASK-686 — live dedupe probe against a real Temporal server.

Question the owner asked: the loop's `harness.finalize` starts
`HarnessDocWorkflow` as a CHILD with id `harness-doc-{consultationId}`
(`workflows.py:2371`), while the legacy path
(`ConsultationEventHandler.handleTranscriptionCreated` ->
`HarnessGatewayService.start` -> `api/endpoints/internal.py:234`) starts it
DIRECTLY with the SAME id. Both catch `WorkflowAlreadyStartedError`. Does the
second start actually collide, or can a note generate twice?

Dedupe here is a SERVER-side property of the workflow id, decided before any
workflow code runs, so the stubs below exercise exactly the mechanism the real
code relies on: same id, same start calls, one direct + one `start_child_workflow`.

Two cases, because they have different answers:
  A. the first execution is still RUNNING when the loop finalizes
  B. the first execution has already CLOSED
"""

import asyncio
import sys
from datetime import timedelta

from temporalio import workflow
from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

TASK_QUEUE = "task-686-probe"


@workflow.defn(name="HarnessDocWorkflow")
class DocStub:
    """Stands in for HarnessDocWorkflow. `hold` mimics sitting at a clinician gate."""

    @workflow.run
    async def run(self, hold_seconds: int) -> str:
        if hold_seconds:
            await asyncio.sleep(hold_seconds)
        return "doc-done"


@workflow.defn(name="LoopFinalizeProbe")
class LoopFinalizeProbe:
    """The loop's `_run_harness_finalize`, reduced to its start-child call."""

    @workflow.run
    async def run(self, child_id: str) -> str:
        try:
            handle = await workflow.start_child_workflow(
                DocStub.run,
                0,
                id=child_id,
                parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
                cancellation_type=workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_REQUESTED,
            )
        except WorkflowAlreadyStartedError:
            return "ALREADY_STARTED (deduped, no-op)"
        await handle
        return "STARTED_A_NEW_EXECUTION"


async def runs_for(client: Client, workflow_id: str) -> list[str]:
    out = []
    async for e in client.list_workflows(f"WorkflowId = '{workflow_id}'"):
        out.append(f"{e.run_id[:8]} {e.status.name}")
    return out


async def main() -> None:
    client = await Client.connect("localhost:7234")
    async with Worker(client, task_queue=TASK_QUEUE, workflows=[DocStub, LoopFinalizeProbe]):
        # ---- Case A: legacy doc workflow still RUNNING -------------------
        wid_a = "harness-doc-consultation-A"
        await client.start_workflow(DocStub.run, 30, id=wid_a, task_queue=TASK_QUEUE)
        await asyncio.sleep(1)
        result_a = await client.execute_workflow(
            LoopFinalizeProbe.run, wid_a, id="consultation-loop-A", task_queue=TASK_QUEUE,
            execution_timeout=timedelta(seconds=60),
        )
        await asyncio.sleep(2)
        print(f"CASE A (legacy still RUNNING): loop finalize -> {result_a}")
        print(f"CASE A executions for {wid_a}: {await runs_for(client, wid_a)}")

        # ---- Case B: legacy doc workflow already CLOSED ------------------
        wid_b = "harness-doc-consultation-B"
        await client.execute_workflow(DocStub.run, 0, id=wid_b, task_queue=TASK_QUEUE)
        await asyncio.sleep(1)
        result_b = await client.execute_workflow(
            LoopFinalizeProbe.run, wid_b, id="consultation-loop-B", task_queue=TASK_QUEUE,
            execution_timeout=timedelta(seconds=60),
        )
        await asyncio.sleep(2)
        print(f"CASE B (legacy already COMPLETED): loop finalize -> {result_b}")
        print(f"CASE B executions for {wid_b}: {await runs_for(client, wid_b)}")

        # ---- Case C: reverse order — loop finalizes first, legacy arrives after
        wid_c = "harness-doc-consultation-C"
        await client.execute_workflow(
            LoopFinalizeProbe.run, wid_c, id="consultation-loop-C", task_queue=TASK_QUEUE,
            execution_timeout=timedelta(seconds=60),
        )
        await asyncio.sleep(1)
        try:
            await client.start_workflow(DocStub.run, 0, id=wid_c, task_queue=TASK_QUEUE)
            legacy = "STARTED_A_NEW_EXECUTION"
        except WorkflowAlreadyStartedError:
            legacy = "ALREADY_STARTED (deduped, no-op)"
        await asyncio.sleep(2)
        print(f"CASE C (loop finalized first, then legacy start): legacy -> {legacy}")
        print(f"CASE C executions for {wid_c}: {await runs_for(client, wid_c)}")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
