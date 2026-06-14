"""Capture a HarnessDocWorkflow history fixture for the replay-compat tests.

Runs a scenario against the stub activities in Temporal's time-skipping environment
using the CURRENTLY IMPORTED workflow definition, and writes the resulting history
JSON to the given path. Not collected by pytest (does not match ``test_*``).

Two scenarios:

* ``happy`` (default) — PASS verdict, immediate approval, policy endpoint
  unavailable -> code defaults. Captures the full success path.
* ``--failure`` — PASS verdict but ``persist_draft`` raises AFTER the inferential
  pass, so the workflow runs ``run_inferential_sensors``, then hits ``run()``'s
  ``except Exception`` block: it records the ``task-348-failure-terminal`` patch
  marker, emits the failed terminal progress, and re-raises. The recorded history
  therefore carries BOTH patch gates (``task-345-harness-progress`` +
  ``task-348-failure-terminal``) and the ``run_inferential_sensors`` command —
  the post-TASK-348 forward-guard fixture (incl. the TASK-354 option change).
* ``--optimistic`` — PASS verdict with the TASK-355 Phase D optimistic flag ON, so
  the workflow takes the patch-gated reorder: computational settle -> early
  ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> terminal progress ->
  ``run_inferential_sensors`` (assurance) -> ``finalize_assurance`` -> gate ->
  ``record_gate_decision``. The recorded history carries the
  ``task-355-optimistic-delivery`` marker + the reordered command sequence — the
  post-TASK-355 (Slice 4a) forward-guard fixture.
* ``--regen`` — optimistic flag ON + an inferential REGEN-then-SAFE sequence so the
  workflow takes the Slice-4b regen-if-untouched path: early deliver ->
  ``run_inferential_sensors`` (REGEN) -> regenerate (assemble/generate/extract/
  run_sensors) -> re-deliver ``persist_draft`` -> ``run_inferential_sensors`` (SAFE)
  -> ``finalize_assurance``. The recorded history carries BOTH the
  ``task-355-optimistic-delivery`` AND ``task-355-assurance-signals`` markers + the
  regen reorder — the post-TASK-355 (Slice 4b) forward-guard fixture.

Usage (from the repo root):

    conda run -n arcaenv python -m harness.tests.unit.temporal._capture_replay_fixture \
        [--failure] apps/harness/src/harness/tests/unit/temporal/fixtures/<name>.json

Fixture provenance notes:
- ``doc_workflow_pre_task345_history.json`` was captured from the PRE-TASK-345
  definition (commit ``50059301^``) by loading that revision's workflows.py and
  running this same happy path. It represents in-flight executions started
  before the progress feed existed and must never be regenerated from newer
  code — it is the frozen "old era" contract (TASK-348 / CRIT-1).
- ``doc_workflow_task345_history.json`` — happy path, post-TASK-345 era.
- ``doc_workflow_post_task348_history.json`` — ``--failure`` scenario, post-TASK-348
  era (TASK-354). Recapture whenever a ``workflow.patched()`` gate is added so future
  definition changes stay replay-compatible with every era still in flight.
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

from temporalio.client import WorkflowFailureError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.models import ApprovalSignal, HarnessDocWorkflowInput, HarnessGateConfig
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)


async def capture(out_path: Path, *, scenario: str = "happy") -> None:
    recorder = StubRecorder()
    # The failure scenario fails at persist_draft (AFTER the inferential pass) so the
    # history reaches the TASK-348 failure-terminal gate while still recording
    # run_inferential_sensors; the happy path runs straight through to approval; the
    # optimistic scenario takes the TASK-355 Slice-4a reorder; the regen scenario takes
    # the Slice-4b regen-if-untouched path (inferential REGEN -> regenerate -> SAFE).
    if scenario == "failure":
        config = StubConfig(
            verdicts=["PASS"], inferential_verdicts=["SAFE"], persist_draft_fails=True
        )
    elif scenario == "regen":
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["REGEN", "SAFE"])
    else:
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])

    # TASK-355 Phase D — the optimistic + regen scenarios enable the flag in the
    # snapshotted gate config so the patch-gated reorder path is exercised and recorded.
    gate = (
        HarnessGateConfig(optimistic_delivery_enabled=True)
        if scenario in ("optimistic", "regen")
        else None
    )

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
            input_kwargs: dict = {
                "consultation_id": "c-replay-1",
                "tenant_id": "t-replay-1",
                "user_id": "u-replay-1",
                "job_id": "job-replay-1",
                "context_item_id": "ctx-replay-1",
                "transcript_text": "Patient has hypertension.",
            }
            if gate is not None:
                input_kwargs["gate"] = gate
            handle = await env.client.start_workflow(
                HarnessDocWorkflow.run,
                HarnessDocWorkflowInput(**input_kwargs),
                id=f"harness-doc-fixture-{uuid.uuid4()}",
                task_queue=tq,
            )
            # The failure path never reaches the clinician gate, so only the happy
            # path signals approval (a late signal on a failed run would error).
            if scenario != "failure":
                await handle.signal(
                    HarnessDocWorkflow.approval,
                    ApprovalSignal(
                        decision="SIGNED",
                        clinician_id="doc-1",
                        context_item_version_id="v-1",
                        attestation_hash="h-1",
                    ),
                )
            try:
                result = await handle.result()
                print(f"decision={result.decision}")
            except WorkflowFailureError as exc:
                # Expected for --failure: the workflow re-raises after the terminal
                # emission. We still capture its (now complete) history below.
                print(f"workflow failed as expected: {type(exc.cause).__name__}: {exc.cause}")
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    scenario = "happy"
    if args and args[0] in ("--failure", "--optimistic", "--regen"):
        scenario, args = args[0].lstrip("-"), args[1:]
    if len(args) != 1:
        raise SystemExit(
            "usage: python -m ..._capture_replay_fixture "
            "[--failure|--optimistic|--regen] <output.json>"
        )
    asyncio.run(capture(Path(args[0]), scenario=scenario))
