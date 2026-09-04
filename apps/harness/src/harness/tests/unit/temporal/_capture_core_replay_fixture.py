"""Capture the TASK-864 `core` vocabulary replay fixture (`interpreter_core_v1_history.json`).

Runs ONE scenario that records every NEW command the `task-864-core-vocabulary` patch adds to
`WorkflowInterpreter` — a `ReviewGateWorkflow` child (signalled `approved`) and a `LoopWorkflow`
child (a `foreach` over two items, so a `continue_as_new` chain) — alongside branch gating, a
condition, a variable node, and the run-event mirror, in Temporal's time-skipping environment
with the CURRENTLY IMPORTED definitions. Not collected by pytest (no `test_` prefix), mirroring
`_capture_interpreter_replay_fixture.py`.

The two network-bound activities (`interpreter.core_agent`, `interpreter.core_classify`) are
stubbed exactly as `test_core_interpreter.py` stubs them; activity BODIES are never replayed, so
the stub changes nothing about what the fixture proves.

Usage (from the repo root, conda env `arcaenv`):

    PYTHONPATH=apps/harness/src python -m harness.tests.unit.temporal._capture_core_replay_fixture \\
        apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_core_v1_history.json
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from temporalio.api.enums.v1 import EventType
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import InterpreterInput, ReviewDecisionSignal
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow, review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event
from harness.tests.unit.temporal.interpreter.test_core_interpreter import (
    _ACTIVITIES,
    _WORKFLOWS,
    _body,
    _edge,
    _node,
    _output,
    _trigger,
)

_BUCKET = "harness-claim-check"
_TENANT = "22222222-2222-2222-2222-222222222222"
_RUN_ID = "run-core-fixture-1"


def _scenario() -> dict[str, Any]:
    return _body(
        [
            {
                "stageIndex": 0,
                "nodes": [
                    _trigger(),
                    _node(
                        "n_vars",
                        "core.variable",
                        "interpreter.core_variables",
                        config={"variables": [{"key": "threshold", "default": 1}]},
                    ),
                ],
            },
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_cond",
                        "core.condition",
                        "interpreter.core_condition",
                        config={
                            "branches": [
                                {"key": "go", "when": "size(trigger.items) > vars.threshold"}
                            ]
                        },
                    )
                ],
            },
            {
                "stageIndex": 2,
                "nodes": [
                    _node(
                        "n_skipped",
                        "noop",
                        "interpreter.noop",
                        guards=[{"fromNodeId": "n_cond", "handle": "else"}],
                    ),
                    _node(
                        "n_loop",
                        "core.loop",
                        "interpreter.core_loop",
                        config={
                            "mode": "foreach",
                            "over": "trigger.items",
                            "bounds": {
                                "maxIterations": 5,
                                "maxDurationSeconds": 600,
                                "maxTotalTokens": 10000,
                            },
                            "collect": "text",
                        },
                        inputs=[_edge("n_trigger", "out", "in")],
                        guards=[{"fromNodeId": "n_cond", "handle": "go"}],
                        timeout=3600,
                    ),
                ],
            },
            {
                "stageIndex": 3,
                "nodes": [
                    _node(
                        "n_review",
                        "core.humanReview",
                        "interpreter.core_human_review",
                        config={"timeoutSeconds": 600},
                        inputs=[_edge("n_loop", "done", "in")],
                        timeout=3600,
                    )
                ],
            },
            {
                "stageIndex": 4,
                "nodes": [
                    _output(
                        [_edge("n_review", "out", "in")],
                        guards=[{"fromNodeId": "n_review", "handle": "approved"}],
                    )
                ],
            },
        ],
        loops=[
            {
                "nodeId": "n_loop",
                "body": {
                    "stages": [
                        {
                            "stageIndex": 0,
                            "nodes": [
                                _node(
                                    "n_body",
                                    "core.agent",
                                    "interpreter.core_agent",
                                    config={"agentRef": {"slug": "a"}},
                                    inputs=[_edge("n_loop", "each", "context")],
                                )
                            ],
                        }
                    ]
                },
            }
        ],
    )


async def capture(out_path: Path) -> None:
    body = _scenario()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"core-capture-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-fixture",
                    workflow_version_id="v-fixture",
                    config_ref=ref,
                    tenant_id=_TENANT,
                    run_id=_RUN_ID,
                    payload={"items": ["x", "y"]},
                ),
                id=f"interpreter-core-fixture-{uuid.uuid4()}",
                task_queue=tq,
            )

            def _review_started(event: Any) -> bool:
                return (
                    event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                    and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                    == review_gate_workflow_id(_RUN_ID, "n_review")
                )

            await await_history_event(handle, _review_started, description="review child started")
            await env.client.get_workflow_handle(
                review_gate_workflow_id(_RUN_ID, "n_review")
            ).signal(
                ReviewGateWorkflow.review,
                ReviewDecisionSignal(decision="approved", reviewer_id="dr-fixture"),
            )
            result = await handle.result()
            print(f"status={result.status} stages={len(result.stages)}")
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    target = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(
            "apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_core_v1_history.json"
        )
    )
    asyncio.run(capture(target))
