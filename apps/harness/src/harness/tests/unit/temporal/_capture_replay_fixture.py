"""Capture a HarnessDocWorkflow history fixture for the replay-compat tests.

Runs the standard happy path (PASS verdict, immediate approval, policy endpoint
unavailable -> code defaults) against the stub activities in Temporal's
time-skipping environment using the CURRENTLY IMPORTED workflow definition, and
writes the resulting history JSON to the given path. Not collected by pytest
(does not match ``test_*``).

Usage (from the repo root):

    conda run -n arcaenv python -m harness.tests.unit.temporal._capture_replay_fixture \
        apps/harness/src/harness/tests/unit/temporal/fixtures/<name>.json

Fixture provenance notes:
- ``doc_workflow_pre_task345_history.json`` was captured from the PRE-TASK-345
  definition (commit ``50059301^``) by loading that revision's workflows.py and
  running this same happy path. It represents in-flight executions started
  before the progress feed existed and must never be regenerated from newer
  code — it is the frozen "old era" contract (TASK-348 / CRIT-1).
- New-era fixtures (e.g. post-TASK-345) SHOULD be captured with this script
  whenever a ``workflow.patched()`` gate is added, so future definition changes
  stay replay-compatible with every era still potentially in flight.
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.models import ApprovalSignal, HarnessDocWorkflowInput
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)


async def capture(out_path: Path) -> None:
    recorder = StubRecorder()
    config = StubConfig(verdicts=["PASS"])

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"harness-capture-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[HarnessDocWorkflow],
            activities=make_stub_activities(config, recorder),
        ):
            handle = await env.client.start_workflow(
                HarnessDocWorkflow.run,
                HarnessDocWorkflowInput(
                    consultation_id="c-replay-1",
                    tenant_id="t-replay-1",
                    user_id="u-replay-1",
                    job_id="job-replay-1",
                    context_item_id="ctx-replay-1",
                    transcript_text="Patient has hypertension.",
                ),
                id=f"harness-doc-fixture-{uuid.uuid4()}",
                task_queue=tq,
            )
            await handle.signal(
                HarnessDocWorkflow.approval,
                ApprovalSignal(
                    decision="SIGNED",
                    clinician_id="doc-1",
                    context_item_version_id="v-1",
                    attestation_hash="h-1",
                ),
            )
            result = await handle.result()
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"decision={result.decision}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m ..._capture_replay_fixture <output.json>")
    asyncio.run(capture(Path(sys.argv[1])))
