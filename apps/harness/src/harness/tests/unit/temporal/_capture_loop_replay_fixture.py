"""Capture the agentic.loop history fixture for the replay-compat tests (b step 9).

Companion to ``_capture_interpreter_replay_fixture.py``, and deliberately the same shape. What it
adds is the ONE command the loop introduced: the interpreter starting `AgenticLoopWorkflow` as a
CHILD, gated behind ``workflow.patched(_LOOP_PATCH)``.

This is the FORWARD guard. The backward guard is already covered — `interpreter_v1_history.json`
was recorded before the loop existed, carries no loop node, and so never reaches the patch call at
all (the cheap operand short-circuits). This fixture is the other direction: a CURRENT-era history
that a future interpreter change must not break. Without it, someone can move the loop dispatch
and only discover it against live in-flight clinical runs.

The loop runs to `max_iterations` rather than converging, so the history captures the full
per-iteration command shape — child start, orchestrator activity, checkpoint activity — repeated
across `continue_as_new` generations rather than a single lucky iteration.

Usage (from the repo root, conda env `arcaenv`):

    PYTHONPATH=apps/harness/src python -m harness.tests.unit.temporal._capture_loop_replay_fixture \
        apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_loop_v1_history.json
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import uuid
from pathlib import Path

from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.loop_workflow import (
    AgenticLoopWorkflow,
    AgenticSubAgentWorkflow,
)
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter._agentic_loop_stubs import stub_agentic_agent

_BUCKET = "harness-claim-check"
_LOOP_NODE = "n_loop"
_ORCHESTRATOR = "n_master"


def _agent_node(node_id: str, config: dict) -> dict:
    return {
        "nodeId": node_id,
        "type": "agentic.agent",
        "activity": "interpreter.agentic_agent",
        "config": config,
        "inputs": [],
        "timeoutSeconds": 30,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "onError": "degrade",
        "emitsTrajectory": True,
    }


def _body() -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "loop-fixture",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "consultation",
        "compiledAt": "2026-09-01T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "fixture",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    _agent_node(_ORCHESTRATOR, {"_stub_mode": "progress"}),
                    {
                        "nodeId": _LOOP_NODE,
                        "type": "agentic.loop",
                        "activity": "interpreter.agentic_loop",
                        "config": {
                            "bounds": {
                                "maxIterations": 3,
                                "maxDurationSeconds": 300,
                                "maxTotalTokens": 1000000,
                                "noProgressIterations": 99,
                            },
                            "orchestratorNodeId": _ORCHESTRATOR,
                        },
                        "inputs": [],
                        "timeoutSeconds": 60,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    },
                ],
            }
        ],
        "gates": [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }


async def capture(out_path: Path) -> None:
    from harness.temporal.claim_check import _MEMORY_STORE, store_blob

    body = _body()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )

    real = [
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition", None) is None
        or a.__temporal_activity_definition.name != "interpreter.agentic_agent"
    ]

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"loop-capture-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter, AgenticLoopWorkflow, AgenticSubAgentWorkflow],
            activities=[*real, *LOOP_ACTIVITIES, stub_agentic_agent],
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-loop-fixture",
                    workflow_version_id="v-loop-fixture",
                    config_ref=ref,
                    tenant_id="t-loop-fixture",
                    run_id="run-loop-fixture",
                    sandbox=False,
                ),
                id=f"loop-fixture-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            print(f"status={result.status} stages={len(result.stages)}")
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    asyncio.run(capture(Path(sys.argv[1])))
