"""Sandbox mode tests (Task 11, S-8).

A sandboxed run of a config containing an `external_write` node must produce ZERO writes and a
SKIPPED(sandbox) trajectory row — never a real call with a suppressed side effect.
"""

from __future__ import annotations

import hashlib
import json
import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES, interpreter_noop
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES

#: TASK-893 — this suite drives the interpreter through the retired `noop`/`passthrough` seed
#: types, which now exist only as test scaffolding (see `../conftest.py`).
pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_BUCKET = "harness-claim-check"


def _body_with_external_write_node() -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "smoke-test",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "summarization",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "write1",
                        "type": "writer-noop",
                        "activity": "interpreter.noop",
                        "config": {"would_write": True},
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    }
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


class TestSandboxSkipsExternalWrites:
    @pytest.mark.asyncio
    async def test_sandboxed_run_skips_external_write_node_with_zero_writes(self, monkeypatch):
        # Register a temporary node type whose registry entry is external_write=True — a
        # code-owned property, matching how the real palette registry will mark its writing
        # nodes. It points at the real `interpreter_noop` activity (registered on
        # the worker) so a bug that dispatches it anyway would be observable as SUCCEEDED, not
        # silently absorbed by a missing registration.
        writer_spec = NodeSpec(
            key="writer-noop", implemented=True, activity=interpreter_noop, external_write=True
        )
        monkeypatch.setitem(NODE_REGISTRY, "writer-noop", writer_spec)

        body = _body_with_external_write_node()
        checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        doc = json.dumps({**body, "checksum": checksum})
        ref = await store_blob(doc, store=_MEMORY_STORE, bucket=_BUCKET)

        async with await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        ) as env:
            tq = f"interpreter-sandbox-{uuid.uuid4()}"
            async with Worker(
                env.client,
                task_queue=tq,
                workflows=[WorkflowInterpreter],
                activities=[*INTERPRETER_ACTIVITIES, *SCAFFOLD_ACTIVITIES],
            ):
                handle = await env.client.start_workflow(
                    WorkflowInterpreter.run,
                    InterpreterInput(
                        session_id="s-1",
                        workflow_version_id="v-1",
                        config_ref=ref,
                        tenant_id="t-1",
                        run_id=str(uuid.uuid4()),
                        sandbox=True,
                    ),
                    id=f"wf-interp-sandbox-{uuid.uuid4()}",
                    task_queue=tq,
                )
                result = await handle.result()

        node = result.stages[0].nodes[0]
        assert node.status == "SKIPPED"
        assert node.reason == "sandbox"
        assert result.status == "DEGRADED"  # a sandbox-skip is a marked nothing, not silent
