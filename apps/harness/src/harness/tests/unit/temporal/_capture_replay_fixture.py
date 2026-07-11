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
* ``--gate-abandon`` (TASK-458 C1-02) — a never-signed gate with a low escalation bound
  so it escalates to the terminal bound and ABANDONS (approved=False): two
  ``escalate_gate`` calls (the second terminal) then a terminal completion WITHOUT
  ``record_gate_decision``. Records the ``task-458-gate-terminal-abandon`` marker — the
  gate-terminal forward-guard fixture.
* ``--edit-cap`` (TASK-458 C1-02) — an optimistic run with edits on TWO assurance passes
  and ``max_edit_reruns=1`` so the loop CAPS the edit-driven re-runs (ONE re-run, not
  two). Records the ``task-458-edit-rerun-cap`` marker — the edit-cap forward-guard fixture.
* ``--retract`` (TASK-481 E2) — an optimistic run whose post-delivery assurance FLAGs
  (inferential UNSAFE), so the delivered draft is RETRACTED: early
  ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> ``run_inferential_sensors`` (FLAG) ->
  ``retract_draft`` -> terminal completion (retracted, no gate/finalize). Records the
  ``task-481-optimistic-retraction`` marker — the retraction forward-guard fixture.
* ``--claim-check`` (TASK-483) — the happy path with the ``generate`` + ``assemble_prompt``
  stubs returning OFFLOADED results (content/prompt emptied + a ``ClaimCheckRef``), so the
  recorded history threads the claim-check REF shape through every downstream activity. The
  command sequence is byte-identical to the inline happy path (NO new command, NO patch
  marker), so this fixture proves ref-threading is command-neutral on replay (AC-4).

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
- ``doc_workflow_post_task458_gate_abandon_history.json`` — ``--gate-abandon`` scenario,
  post-TASK-458 era (C1-02 gate terminal abandon).
- ``doc_workflow_post_task458_edit_cap_history.json`` — ``--edit-cap`` scenario,
  post-TASK-458 era (C1-02 edit-rerun cap).
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

from harness.temporal.models import (
    ApprovalSignal,
    EditSignal,
    HarnessDocWorkflowInput,
    HarnessGateConfig,
)
from harness.temporal.workflows import HarnessDocWorkflow
from harness.tests.unit.temporal._harness_stubs import (
    StubConfig,
    StubRecorder,
    make_stub_activities,
)

_EDITED_NOTE = '{"subjective": "s-edited", "objective": "o", "assessment": "a", "plan": "p-edit"}'


async def capture(out_path: Path, *, scenario: str = "happy") -> None:
    recorder = StubRecorder()
    # The failure scenario fails at persist_draft (AFTER the inferential pass) so the
    # history reaches the TASK-348 failure-terminal gate while still recording
    # run_inferential_sensors; the happy path runs straight through to approval; the
    # optimistic scenario takes the TASK-355 Slice-4a reorder; the regen scenario takes
    # the Slice-4b regen-if-untouched path (inferential REGEN -> regenerate -> SAFE).
    # C1-02 (TASK-458): ``gate-abandon`` never signs so the gate escalates to its terminal
    # bound and ABANDONS (records ``task-458-gate-terminal-abandon``); ``edit-cap`` fires
    # edits on TWO assurance passes with ``max_edit_reruns=1`` so the loop CAPS the re-runs
    # (records ``task-458-edit-rerun-cap``).
    if scenario == "failure":
        config = StubConfig(
            verdicts=["PASS"], inferential_verdicts=["SAFE"], persist_draft_fails=True
        )
    elif scenario == "regen":
        config = StubConfig(verdicts=["PASS", "PASS"], inferential_verdicts=["REGEN", "SAFE"])
    elif scenario == "edit-cap":
        config = StubConfig(
            verdicts=["PASS", "PASS", "PASS"], inferential_verdicts=["SAFE", "SAFE", "SAFE"]
        )
    elif scenario == "retract":
        # TASK-481 (E2): optimistic delivery, then the assurance pass FLAGs (UNSAFE) so the
        # delivered draft is RETRACTED (records the task-481-optimistic-retraction marker).
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["UNSAFE"])
    elif scenario == "claim-check":
        # TASK-483: happy path with the generate + assemble stubs returning OFFLOADED
        # results (content/prompt emptied + a ClaimCheckRef), so the recorded history
        # threads the claim-check REF shape through every downstream activity. The command
        # sequence is byte-identical to the inline happy path (no new command, no patch
        # marker) — this fixture proves ref-threading is command-neutral on replay (AC-4).
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"], claim_check=True)
    else:
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])

    # TASK-355 Phase D — the optimistic + regen scenarios enable the flag in the
    # snapshotted gate config so the patch-gated reorder path is exercised and recorded.
    if scenario in ("optimistic", "regen", "retract"):
        gate = HarnessGateConfig(optimistic_delivery_enabled=True)
    elif scenario == "edit-cap":
        gate = HarnessGateConfig(optimistic_delivery_enabled=True, max_regen=2, max_edit_reruns=1)
    elif scenario == "gate-abandon":
        gate = HarnessGateConfig(
            gate_sla_seconds=30.0, gate_escalation_seconds=30.0, gate_max_escalations=2
        )
    else:
        gate = None

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"harness-capture-{uuid.uuid4()}"
        wf_id = f"harness-doc-fixture-{uuid.uuid4()}"
        # edit-cap: wire the edit-injection hook (needs the handle BEFORE start) so an
        # ``edit`` fires from inside inferential passes 0 and 1 — the second is capped.
        if scenario == "edit-cap":
            recorder.edit_signal_handle = env.client.get_workflow_handle(wf_id)
            recorder.edit_on_inferential_indices = {0, 1}
            recorder.edit_payload = EditSignal(
                content=_EDITED_NOTE, context_item_version_id="ver-edit-cap"
            )
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
                id=wf_id,
                task_queue=tq,
            )
            # The failure path never reaches the gate; gate-abandon deliberately never
            # signs (it abandons on the terminal bound); retract terminates on the FLAG
            # WITHOUT a gate wait. Everything else signs to close it.
            if scenario not in ("failure", "gate-abandon", "retract"):
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
                print(
                    f"decision={result.decision} approved={result.approved} "
                    f"escalations={result.escalations}"
                )
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
    _scenarios = (
        "--failure",
        "--optimistic",
        "--regen",
        "--gate-abandon",
        "--edit-cap",
        "--retract",
        "--claim-check",
    )
    if args and args[0] in _scenarios:
        scenario, args = args[0].lstrip("-"), args[1:]
    if len(args) != 1:
        raise SystemExit(
            "usage: python -m ..._capture_replay_fixture "
            "[--failure|--optimistic|--regen|--gate-abandon|--edit-cap|--retract|--claim-check]"
            " <output.json>"
        )
    asyncio.run(capture(Path(args[0]), scenario=scenario))
