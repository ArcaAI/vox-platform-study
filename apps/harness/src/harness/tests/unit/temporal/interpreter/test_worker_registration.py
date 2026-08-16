"""Task 8: WorkflowInterpreter + INTERPRETER_ACTIVITIES register cleanly on the SAME worker
registration lists `harness.temporal.worker.run_worker` uses.

No live Temporal server is available in this environment (infra down), so this cannot exercise
`pnpm worker:dev` end-to-end (gated — see the ticket README). What CAN be proven hermetically:
the exact combined `workflows=[...]`/`activities=[...]` lists `run_worker` passes to `Worker(...)`
construct without error (no duplicate name, no invalid class) against an ephemeral time-skipping
Temporal test server — the same proof `Worker.__init__` performs internally at real startup.
"""

from __future__ import annotations

import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.activities import (
    DOCUMENT_ACTIVITIES,
    LOOP_ACTIVITIES,
    REASONING_ACTIVITIES,
    ping_activity,
)
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.workflows import (
    ConsultationLoopWorkflow,
    HarnessDocWorkflow,
    HarnessPingWorkflow,
    SpecialistWorkflow,
)


class TestFullWorkerRegistration:
    @pytest.mark.asyncio
    async def test_all_workflows_and_activities_construct_on_one_worker(self):
        async with await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        ) as env:
            # Mirrors worker.py:263-276 exactly (the combined registration lists).
            async with Worker(
                env.client,
                task_queue=f"interpreter-worker-reg-{uuid.uuid4()}",
                workflows=[
                    HarnessPingWorkflow,
                    HarnessDocWorkflow,
                    ConsultationLoopWorkflow,
                    SpecialistWorkflow,
                    WorkflowInterpreter,
                ],
                activities=[
                    ping_activity,
                    *DOCUMENT_ACTIVITIES,
                    *LOOP_ACTIVITIES,
                    *REASONING_ACTIVITIES,
                    *INTERPRETER_ACTIVITIES,
                ],
            ):
                pass  # construction + clean shutdown is the assertion

    def test_interpreter_activity_names_do_not_collide_with_existing_activities(self):
        from temporalio import activity as temporal_activity

        def _name(fn: object) -> str:
            defn = temporal_activity._Definition.from_callable(fn)  # noqa: SLF001
            assert defn is not None
            return defn.name

        existing_names = {
            _name(fn)
            for fn in (ping_activity, *DOCUMENT_ACTIVITIES, *LOOP_ACTIVITIES, *REASONING_ACTIVITIES)
        }
        interpreter_names = {_name(fn) for fn in INTERPRETER_ACTIVITIES}
        assert existing_names.isdisjoint(interpreter_names)
