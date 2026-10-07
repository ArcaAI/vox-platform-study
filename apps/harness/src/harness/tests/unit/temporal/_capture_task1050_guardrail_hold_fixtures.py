"""TASK-1050 W2f — capture the FORWARD replay guards for ``task-1050-guardrail-hold``.

Records, against the CURRENTLY IMPORTED (post-change) definition, two runs of a trigger plus one
``core.agent`` whose generation guardrail refuses (the node activity reports a ``guardrail_hold``):

* ``interpreter_task1050_guardrail_hold_resumed_history.json`` — the walk publishes
  ``guardrail.notice`` + ``run.paused``, parks on the ``guardrail_resolution`` signal, receives
  ``acknowledged``, re-executes ONLY that node (with the override) and the run SUCCEEDS;
* ``interpreter_task1050_guardrail_hold_timed_out_history.json`` — nobody resolves the hold within
  ``limits.guardrailHoldTimeoutSeconds``; the node and the run fail ``GUARDRAIL_BLOCKED``.

A later ungated change to the hold's command sequence then fails
``test_task1050_guardrail_hold_replay.py`` instead of wedging a run parked on a clinician. The
BACKWARD guard (every history recorded before the marker carries no ``guardrail_hold`` and must
replay without consulting it) is the existing interpreter-family fixture set in
``test_replay_compat*.py``.

Not collected by pytest (no ``test_`` prefix), mirroring the other ``_capture_*`` scripts. The
node activity is a stub; activity BODIES are never replayed, so the stub changes nothing about what
the fixtures prove. The run-event mirror writes to an in-memory fake (never a real Redis).

Usage (from ``apps/harness``, conda env ``arcaenv``)::

    PYTHONPATH=src python -m harness.tests.unit.temporal._capture_task1050_guardrail_hold_fixtures \\
        src/harness/tests/unit/temporal/fixtures
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import node_activity_envelope
from harness.temporal.interpreter.models import (
    GuardrailHold,
    GuardrailResolutionSignal,
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
    RunLimits,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_query
from harness.tests.unit.temporal.interpreter import _task1038_harness as h
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

RESUMED = "interpreter_task1050_guardrail_hold_resumed_history"
TIMED_OUT = "interpreter_task1050_guardrail_hold_timed_out_history"
NOTICE_ID = "01927f6e-9999-7000-8000-0000000000ab"
NOTICE: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": NOTICE_ID,
    "type": "guardrail.blocked",
    "direction": "inbound",
    "action": "block",
    "checks": [{"checkId": "injection_judge", "severity": "high"}],
    "nodeId": "n_note",
    "itemIds": [],
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": "A safety check stopped this request. Review the flagged input to continue.",
    "requiresAcknowledgement": True,
    "resumable": True,
    "policyVersion": "pv-capture",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}
#: What each stub call was handed (the override is the re-run's proof).
SEEN: list[NodeActivityInput] = []


async def _stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    SEEN.append(payload)
    if payload.config.get("_stub") == "hold_always" or payload.guardrail_override is None:
        return NodeActivityResult(
            status="DEGRADED",
            reason="GUARDRAIL_BLOCKED: core.agent: guardrail_blocked (stub)",
            guardrail_hold=GuardrailHold(
                kind="blocked",
                notice={**NOTICE, "runId": payload.run_id},
                evaluation_ids=["ev-capture"],
            ),
        )
    return NodeActivityResult(status="SUCCEEDED", output={"text": "the note (after resume)"})


stub_core_agent = activity.defn(name="interpreter.core_agent")(
    node_activity_envelope(_stub_core_agent)
)


def scenario(mode: str) -> dict[str, Any]:
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [h.agent("n_note", inputs=[h.edge("n_trigger", "out", "in")], _stub=mode)],
            },
        ]
    )


async def _run(name: str, mode: str, *, resolve: bool, out_dir: Path) -> Path:
    SEEN.clear()
    ref = await h._store(scenario(mode))  # noqa: SLF001 — the shared harness's claim-check writer
    activities = [
        a
        for a in h.ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name != "interpreter.core_agent"
    ] + [stub_core_agent]
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"task1050-capture-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=h.WORKFLOWS, activities=activities):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-task1050",
                    workflow_version_id="v-task1050",
                    config_ref=ref,
                    tenant_id=h.TENANT,
                    run_id=f"run-task1050-{mode}",
                    payload={"consultationId": "c-task1050"},
                    limits=RunLimits(
                        activityInputMaxBytes=2_000_000, guardrailHoldTimeoutSeconds=600
                    ),
                    retention_seconds=3600,
                ),
                id=f"interpreter-task1050-{uuid.uuid4()}",
                task_queue=tq,
            )
            if resolve:
                await await_query(
                    handle, WorkflowInterpreter.guardrail_holds, lambda holds: bool(holds)
                )
                await handle.signal(
                    WorkflowInterpreter.guardrail_resolution,
                    GuardrailResolutionSignal(
                        noticeId=NOTICE_ID, resolution="acknowledged", by="doctor-capture"
                    ),
                )
            result = await handle.result()
            print(
                f"task1050 {mode}: status={result.status} "
                f"nodes={[(n.node_id, n.status, n.reason) for s in result.stages for n in s.nodes]} "
                f"overrides={[p.guardrail_override for p in SEEN]}"
            )
            history = await handle.fetch_history()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.json"
    path.write_text(history.to_json())
    print(f"wrote {path}")
    return path


async def capture(out_dir: Path) -> list[Path]:
    # The run-event mirror goes to an in-memory fake, never a real Redis.
    stream = FakeRunStreamRedis()
    interpreter_activities._RUN_EVENT_REDIS = stream  # noqa: SLF001
    interpreter_activities._RUN_EVENT_REDIS_BUILT = True  # noqa: SLF001
    paths = [
        await _run(RESUMED, "hold_once", resolve=True, out_dir=out_dir),
        await _run(TIMED_OUT, "hold_always", resolve=False, out_dir=out_dir),
    ]
    for mode in ("hold_once", "hold_always"):
        print(mode, [e["type"] for e in stream.events(f"run-task1050-{mode}")])
    return paths


if __name__ == "__main__":
    target = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src/harness/tests/unit/temporal/fixtures")
    )
    asyncio.run(capture(target))
