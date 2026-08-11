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
  the failure-terminal forward-guard fixture.
* ``--optimistic`` — PASS verdict with the optimistic delivery flag ON, so
  the workflow takes the patch-gated reorder: computational settle -> early
  ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> terminal progress ->
  ``run_inferential_sensors`` (assurance) -> ``finalize_assurance`` -> gate ->
  ``record_gate_decision``. The recorded history carries the
  ``task-355-optimistic-delivery`` marker + the reordered command sequence — the
  optimistic-delivery forward-guard fixture.
* ``--regen`` — optimistic flag ON + an inferential REGEN-then-SAFE sequence so the
  workflow takes the regen-if-untouched path: early deliver ->
  ``run_inferential_sensors`` (REGEN) -> regenerate (assemble/generate/extract/
  run_sensors) -> re-deliver ``persist_draft`` -> ``run_inferential_sensors`` (SAFE)
  -> ``finalize_assurance``. The recorded history carries BOTH the
  ``task-355-optimistic-delivery`` AND ``task-355-assurance-signals`` markers + the
  regen reorder — the assurance-signals forward-guard fixture.
* ``--gate-abandon`` — a never-signed gate with a low escalation bound
  so it escalates to the terminal bound and ABANDONS (approved=False): two
  ``escalate_gate`` calls (the second terminal) then a terminal completion WITHOUT
  ``record_gate_decision``. Records the ``task-458-gate-terminal-abandon`` marker — the
  gate-terminal forward-guard fixture.
* ``--edit-cap`` — an optimistic run with edits on TWO assurance passes
  and ``max_edit_reruns=1`` so the loop CAPS the edit-driven re-runs (ONE re-run, not
  two). Records the ``task-458-edit-rerun-cap`` marker — the edit-cap forward-guard fixture.
* ``--retract`` — an optimistic run whose post-delivery assurance FLAGs
  (inferential UNSAFE), so the delivered draft is RETRACTED: early
  ``persist_draft(phase=DRAFT_PENDING_SENSORS)`` -> ``run_inferential_sensors`` (FLAG) ->
  ``retract_draft`` -> terminal completion (retracted, no gate/finalize). Records the
  ``task-481-optimistic-retraction`` marker — the retraction forward-guard fixture.
* ``--claim-check`` — the happy path with the ``generate`` + ``assemble_prompt``
  stubs returning OFFLOADED results (content/prompt emptied + a ``ClaimCheckRef``), so the
  recorded history threads the claim-check REF shape through every downstream activity. The
  command sequence is byte-identical to the inline happy path (NO new command, NO patch
  marker), so this fixture proves ref-threading is command-neutral on replay.
* ``--assemble-reuse`` — F-13. A COMPUTATIONAL regen (``REGEN`` then ``PASS``)
  so the pre-delivery loop runs twice: the second iteration takes the patch-gated
  skip, so the recorded history carries the ``task-553-assemble-reuse`` marker and
  only ONE ``assemble_prompt`` command for TWO ``generate`` commands. The
  assemble-reuse forward-guard fixture.

Usage (from the repo root):

    conda run -n arcaenv python -m harness.tests.unit.temporal._capture_replay_fixture \
        [--failure] apps/harness/src/harness/tests/unit/temporal/fixtures/<name>.json

Fixture provenance notes:
- ``doc_workflow_pre_task345_history.json`` was captured from the workflow
  definition that predates the progress feed (commit ``50059301^``) by loading
  that revision's workflows.py and running this same happy path. It represents
  in-flight executions started before the progress feed existed and must never
  be regenerated from newer code — it is the frozen "old era" contract.
- ``doc_workflow_task345_history.json`` — happy path, with the progress feed.
- ``doc_workflow_post_task348_history.json`` — ``--failure`` scenario, with the
  failure-terminal gate. Recapture whenever a ``workflow.patched()`` gate is added so
  future definition changes stay replay-compatible with every era still in flight.
- ``doc_workflow_post_task458_gate_abandon_history.json`` — ``--gate-abandon``
  scenario (gate terminal abandon).
- ``doc_workflow_post_task458_edit_cap_history.json`` — ``--edit-cap`` scenario
  (edit-rerun cap).
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

from harness.redaction.engine import RedactionRule
from harness.temporal.models import (
    ApprovalSignal,
    EditSignal,
    HarnessDocWorkflowInput,
    HarnessGateConfig,
    HarnessPolicy,
    McpServerConfig,
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
    # history reaches the failure-terminal gate while still recording
    # run_inferential_sensors; the happy path runs straight through to approval; the
    # optimistic scenario takes the optimistic-delivery reorder; the regen scenario takes
    # the regen-if-untouched path (inferential REGEN -> regenerate -> SAFE).
    # ``gate-abandon`` never signs so the gate escalates to its terminal
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
        # Optimistic delivery, then the assurance pass FLAGs (UNSAFE) so the
        # delivered draft is RETRACTED (records the task-481-optimistic-retraction marker).
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["UNSAFE"])
    elif scenario == "mcp":
        # the MCP tool path ARMED — the policy enables mcpToolsEnabled
        # and registers an enabled terminology server whose allowlist includes the
        # validate_codes tool. The workflow records the ``task-516-mcp-tools`` patch marker
        # + the new ``call_mcp_tool`` command (after the transcript NER, before retrieval).
        # This is the forward-guard fixture for the MCP command-sequence change.
        config = StubConfig(
            verdicts=["PASS"],
            inferential_verdicts=["SAFE"],
            policy=HarnessPolicy(
                mcp_tools_enabled=True,
                tool_allowlist=["validate_codes"],
                mcp_servers=[
                    McpServerConfig(
                        id="srv-term",
                        name="fhir-term",
                        base_url="http://terminology.local/mcp",
                        tool_allowlist=["validate_codes"],
                        phi_boundary="in-boundary",
                        enabled=True,
                    )
                ],
            ),
        )
    elif scenario in ("redaction", "redaction-audit"):
        # DNA redaction/rewrite ARMED — the start payload carries a
        # redaction rule and the ``apply_redaction`` stub returns a CHANGED note, so the
        # workflow records the ``task-551-redaction`` patch marker AND the new command
        # sequence (apply_redaction -> extract_entities -> run_sensors re-run) after the
        # computational loop settles and before persist. This is the forward-guard fixture
        # for the redaction command-sequence change.
        #
        # ``redaction-audit`` captures the SAME armed path against the CURRENT (audit-era)
        # definition, so the recorded history ALSO carries the ``task-551-redaction-audit``
        # marker + the manifest marker threaded into ``persist_draft``. It is the
        # forward-guard fixture for the audit-marker change; the frozen (pre-audit)
        # ``redaction`` fixture stays green because it lacks that marker (the audit gate
        # short-circuits on replay), proving the audit trail is gated + replay-safe.
        config = StubConfig(
            verdicts=["PASS"],
            inferential_verdicts=["SAFE"],
            redaction_text=(
                '{"subjective": "s-redacted", "objective": "o", ' '"assessment": "a", "plan": "p"}'
            ),
        )
    elif scenario == "assemble-reuse":
        # F-13 — a COMPUTATIONAL regen so the pre-delivery loop runs twice and the
        # second iteration takes the patch-gated assemble skip. The recorded history
        # carries the ``task-553-assemble-reuse`` marker with ONE assemble_prompt and
        # TWO generate commands — the forward-guard fixture for that skip.
        config = StubConfig(verdicts=["REGEN", "PASS"], inferential_verdicts=["SAFE"])
    elif scenario == "claim-check":
        # Happy path with the generate + assemble stubs returning OFFLOADED
        # results (content/prompt emptied + a ClaimCheckRef), so the recorded history
        # threads the claim-check REF shape through every downstream activity. The command
        # sequence is byte-identical to the inline happy path (no new command, no patch
        # marker) — this fixture proves ref-threading is command-neutral on replay.
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"], claim_check=True)
    else:
        config = StubConfig(verdicts=["PASS"], inferential_verdicts=["SAFE"])

    # The optimistic + regen scenarios enable the flag in the
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
            if scenario in ("redaction", "redaction-audit"):
                input_kwargs["redaction_rules"] = [
                    RedactionRule(id="r1", type="remove", match="literal", pattern="employer")
                ]
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


async def capture_loop(out_path: Path) -> None:
    """Capture a ``ConsultationLoopWorkflow`` history fixture (TASK-662).

    One scenario, chosen to record every command shape the loop can issue:
    ``fetch_loop_config`` (the pin) -> ``livedoc_start`` (start action) ->
    ``emit_loop_event`` for a subscribed item and again for one SKIPPED over the
    depth cap -> ``livedoc_stop`` (ending action) -> ``start_child_workflow``
    (the unmodified ``HarnessDocWorkflow`` finalize, which is signed so the
    parent's await resolves and the history closes).

    The loop is a NEW workflow type, so unlike the document fixtures this one
    guards nothing historical — it exists so that FUTURE edits to the loop
    cannot silently change its command sequence. Recapture alongside any
    intentional change (and only then).
    """
    from harness.temporal.models import (
        LOOP_ACTION_HARNESS_FINALIZE,
        LOOP_ACTION_LIVEDOC_START,
        LOOP_ACTION_LIVEDOC_STOP,
        ConsultationEndingSignal,
        ConsultationLoopWorkflowInput,
        ContextAddedSignal,
        LoopBudget,
    )
    from harness.temporal.workflows import (
        ConsultationLoopWorkflow,
        consultation_loop_workflow_id,
    )
    from harness.tests.unit.temporal._loop_stubs import (
        LoopStubConfig,
        LoopStubRecorder,
        default_loop_config,
        make_loop_stub_activities,
    )

    consultation_id = "c-loop-fixture"
    loop_config = default_loop_config(
        budget=LoopBudget(max_depth=1, max_actions=50),
        start_actions=[LOOP_ACTION_LIVEDOC_START],
        ending_actions=[LOOP_ACTION_LIVEDOC_STOP, LOOP_ACTION_HARNESS_FINALIZE],
    )
    loop_recorder = LoopStubRecorder()
    doc_recorder = StubRecorder()

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        task_queue = f"loop-fixture-tq-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=task_queue,
            workflows=[ConsultationLoopWorkflow, HarnessDocWorkflow],
            activities=[
                *make_loop_stub_activities(
                    LoopStubConfig(config=loop_config), loop_recorder
                ),
                *make_stub_activities(StubConfig(), doc_recorder),
            ],
        ):
            handle = await env.client.start_workflow(
                ConsultationLoopWorkflow.run,
                ConsultationLoopWorkflowInput(
                    consultation_id=consultation_id, tenant_id="t-1", session_id="s-1"
                ),
                id=consultation_loop_workflow_id(consultation_id),
                task_queue=task_queue,
            )
            await handle.signal(
                ConsultationLoopWorkflow.context_added,
                ContextAddedSignal(
                    context_item_id="ci-1", kind_key="transcript", depth=0, occurred_at="1"
                ),
            )
            # Over the depth cap -> records the `action.skipped` emission.
            await handle.signal(
                ConsultationLoopWorkflow.context_added,
                ContextAddedSignal(
                    context_item_id="ci-2", kind_key="transcript", depth=3, occurred_at="2"
                ),
            )
            await handle.signal(
                ConsultationLoopWorkflow.consultation_ending, ConsultationEndingSignal()
            )

            # The loop awaits its finalize child, so the child must be signed for
            # the parent to complete and the history to close.
            child = env.client.get_workflow_handle(f"harness-doc-{consultation_id}")
            for _ in range(400):
                state = await handle.query(ConsultationLoopWorkflow.state)
                if state.finalize_workflow_id:
                    break
                await asyncio.sleep(0.02)
            for _ in range(400):
                try:
                    await child.signal(
                        HarnessDocWorkflow.approval,
                        ApprovalSignal(
                            decision="SIGNED",
                            clinician_id="doc-1",
                            context_item_version_id="v-1",
                            attestation_hash="h-1",
                        ),
                    )
                    break
                except Exception:  # noqa: BLE001 - the child may not be started yet
                    await asyncio.sleep(0.02)

            result = await handle.result()
            print(
                f"events={result.events_processed} dispatched={result.actions_dispatched} "
                f"depth_capped={result.depth_capped} finalized={result.finalized}"
            )
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    scenario = "happy"
    _scenarios = (
        "--loop",
        "--failure",
        "--optimistic",
        "--regen",
        "--gate-abandon",
        "--edit-cap",
        "--retract",
        "--claim-check",
        "--mcp",
        "--redaction",
        "--redaction-audit",
        "--assemble-reuse",
    )
    if args and args[0] in _scenarios:
        scenario, args = args[0].lstrip("-"), args[1:]
    if len(args) != 1:
        raise SystemExit(
            "usage: python -m ..._capture_replay_fixture "
            "[--loop|--failure|--optimistic|--regen|--gate-abandon|--edit-cap|--retract"
            "|--claim-check|--mcp|--redaction|--redaction-audit|--assemble-reuse]"
            " <output.json>"
        )
    if scenario == "loop":
        # A different workflow TYPE, so it gets its own capture entry point
        # rather than another branch inside the document-workflow scenario tree.
        asyncio.run(capture_loop(Path(args[0])))
    else:
        asyncio.run(capture(Path(args[0]), scenario=scenario))
