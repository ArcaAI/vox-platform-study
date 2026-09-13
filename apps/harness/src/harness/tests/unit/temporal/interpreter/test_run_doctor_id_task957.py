"""TASK-957 F-8 — the interpreter threads the run's clinician onto every node's context.

``RunSubject.user_id`` is the one clinician identity a workflow run has that can be trusted:
the gateway populates ``subject`` only from a path parameter it re-resolved against the caller's
tenant, and there is no request shape that lets a caller write it (that is the whole reason
``RunSubject`` exists beside ``payload``). Until now it stopped at the interpreter — so the
ledger row a node's generation produced carried no ``doctorId`` at all, and the workflow lane
was the one inference plane whose spend could not be attributed to a person.

The two cases below are the whole contract: carry it when the run HAS a subject, and carry
NOTHING when it does not. An unbound exposure-plane run legitimately has no clinical subject,
and filling that in from the payload, the caller, or the tenant's first doctor would put a
fabricated identity on a billing record.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import (
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
    RunSubject,
)
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.models import TrajectoryContext

_BUCKET = "harness-claim-check"
_TENANT = "22222222-2222-2222-2222-222222222222"

#: Every context the capture activity saw, in dispatch order.
_SEEN: list[TrajectoryContext | None] = []


@activity.defn(name="interpreter.capture_trajectory_task957")
async def capture_trajectory(payload: NodeActivityInput) -> NodeActivityResult:
    _SEEN.append(payload.trajectory)
    return NodeActivityResult(status="SUCCEEDED")


def _body() -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "doctor-id-probe",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "summarization",
        "compiledAt": "2026-09-13T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "probe1",
                        "type": "capture-noop",
                        "activity": "interpreter.capture_trajectory_task957",
                        "config": {},
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


async def _run(subject: RunSubject | None) -> TrajectoryContext | None:
    _SEEN.clear()
    body = _body()
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"interpreter-doctorid-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, capture_trajectory],
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=_TENANT,
                    run_id=str(uuid.uuid4()),
                    subject=subject,
                ),
                id=f"wf-doctorid-{uuid.uuid4()}",
                task_queue=tq,
            )
            await handle.result()

    assert _SEEN, "the probe node must have been dispatched"
    return _SEEN[0]


@pytest.fixture(autouse=True)
def _register_probe(monkeypatch: Any):
    monkeypatch.setitem(
        NODE_REGISTRY,
        "capture-noop",
        NodeSpec(key="capture-noop", implemented=True, activity=capture_trajectory),
    )


class TestRunClinicianReachesTheNodeContext:
    @pytest.mark.asyncio
    async def test_carries_the_run_subject_user_id(self):
        ctx = await _run(
            RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001", userId="dr-9")
        )

        assert ctx is not None
        assert ctx.doctor_id == "dr-9"
        # The node identity it has always computed still rides beside it.
        assert ctx.node_id == "probe1"
        assert ctx.workflow_version_id == "v-1"

    @pytest.mark.asyncio
    async def test_an_unbound_run_carries_no_clinician(self):
        ctx = await _run(None)

        assert ctx is not None
        assert ctx.doctor_id is None

    @pytest.mark.asyncio
    async def test_a_subject_with_no_user_carries_no_clinician(self):
        # A consultation-bound run whose subject names no user: the consultation exists, the
        # clinician is simply not part of what the gateway resolved. Absent, never substituted.
        ctx = await _run(RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"))

        assert ctx is not None
        assert ctx.doctor_id is None
