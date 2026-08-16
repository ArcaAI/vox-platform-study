"""Capture the WorkflowInterpreter v1 history fixture for the replay-compat tests (Task 9).

Runs one scenario against the REAL seed activities (interpreter.noop / interpreter.passthrough)
in Temporal's time-skipping environment, using the CURRENTLY IMPORTED workflow definition, and
writes the resulting history JSON. Not collected by pytest (does not match ``test_*``) — mirrors
``_capture_replay_fixture.py``'s own convention exactly.

The one scenario captured here (``v1``) covers, in a single run, the three command shapes a
future interpreter change is most likely to break (ticket §4 Task 9):

1. A multi-stage walk (three stages, one node each).
2. A fan-out stage (three concurrent nodes).
3. One DEGRADED node (a `config["raise_error"]` noop) alongside a SUCCEEDED sibling in the
   SAME stage, proving the all-settled join's command shape is captured too.

Usage (from the repo root, conda env `arcaenv`):

    PYTHONPATH=apps/harness/src python -m harness.tests.unit.temporal._capture_interpreter_replay_fixture \
        apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_v1_history.json
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
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_BUCKET = "harness-claim-check"


def _node(node_id: str, *, activity: str = "interpreter.noop", config: dict | None = None) -> dict:
    return {
        "nodeId": node_id,
        "type": "noop" if activity == "interpreter.noop" else "passthrough",
        "activity": activity,
        "config": config or {},
        "timeoutSeconds": 30,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "inputs": [],
        "onError": "degrade",
        "emitsTrajectory": True,
    }


def _v1_body() -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "interpreter-fixture-v1",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "fixture",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "fixture-registry-checksum",
        "ruleSetVersion": 1,
        "stages": [
            {"stageIndex": 0, "nodes": [_node("stage0-linear")]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node("fanout-a", activity="interpreter.passthrough"),
                    _node("fanout-b", activity="interpreter.passthrough"),
                    _node("fanout-degraded", config={"raise_error": True}),
                ],
            },
            {"stageIndex": 2, "nodes": [_node("stage2-final")]},
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

    body = _v1_body()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    doc = json.dumps({**body, "checksum": checksum})
    ref = await store_blob(doc, store=_MEMORY_STORE, bucket=_BUCKET)

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"interpreter-capture-{uuid.uuid4()}"
        wf_id = f"interpreter-fixture-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=INTERPRETER_ACTIVITIES,
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-fixture-1",
                    workflow_version_id="v-fixture-1",
                    config_ref=ref,
                    tenant_id="t-fixture-1",
                    run_id="run-fixture-1",
                    sandbox=False,
                ),
                id=wf_id,
                task_queue=tq,
            )
            result = await handle.result()
            print(f"status={result.status} stages={len(result.stages)}")
            history = await handle.fetch_history()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(history.to_json())
    print(f"wrote {out_path}")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        "apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_v1_history.json"
    )
    asyncio.run(capture(target))
