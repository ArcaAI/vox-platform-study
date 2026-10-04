"""TASK-982 §3.4.5 — settled-node counts on `workflow.run.completed`.

Three layers, narrowest first:

1. `_settled_node_counts` (workflow.py) — a PURE function over already-settled `StageResult`s,
   unit-tested directly with no Temporal machinery at all.
2. TASK-1038 R6 — the harness now writes run protocol v2 ONLY, and v2's terminal events are
   CLOSED shapes with no count fields. The counts are therefore DERIVED by whoever needs them
   (lane B3a's legacy-frame derivation, the governing-run summary) by folding the run's
   `node.completed` / `node.failed` events — which carry exactly one settled status per node.
   The activity-side `RunEventSpec` still carries them (the workflow's own fact), and the
   end-to-end tests below prove the fold gives the same four numbers.
3. An end-to-end run through the real `WorkflowInterpreter` in Temporal's time-skipping test
   environment, for a mixed SUCCEEDED/DEGRADED/SKIPPED/FAILED graph.
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
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES, interpreter_noop
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import NodeResult, StageResult
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.workflow import WorkflowInterpreter, _settled_node_counts
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_BUCKET = "harness-claim-check"
TENANT = "22222222-2222-2222-2222-222222222222"


class TestSettledNodeCounts:
    """`_settled_node_counts` — pure, no Temporal."""

    def test_empty_run_counts_nothing(self):
        assert _settled_node_counts([]) == (0, 0, 0, 0)

    def test_counts_every_node_across_every_stage_including_a_trailing_gate_stage(self):
        stages = [
            StageResult(
                stage_index=0,
                nodes=[
                    NodeResult(node_id="n1", node_type="core.agent", status="SUCCEEDED"),
                    NodeResult(node_id="n2", node_type="core.agent", status="DEGRADED"),
                ],
            ),
            StageResult(
                stage_index=1,
                nodes=[
                    NodeResult(node_id="n3", node_type="core.agent", status="SKIPPED"),
                    NodeResult(node_id="n4", node_type="core.agent", status="FAILED"),
                ],
            ),
            # The HITL gate is appended as one more StageResult after the walk (workflow.py:451).
            StageResult(
                stage_index=2,
                nodes=[
                    NodeResult(
                        node_id="n_gate", node_type="consultation.hitlGate", status="SUCCEEDED"
                    )
                ],
            ),
        ]

        assert _settled_node_counts(stages) == (5, 1, 1, 1)

    def test_a_successful_run_reports_zero_for_every_failure_class(self):
        stages = [
            StageResult(
                stage_index=0,
                nodes=[
                    NodeResult(node_id="n1", node_type="core.agent", status="SUCCEEDED"),
                    NodeResult(node_id="n2", node_type="core.agent", status="SUCCEEDED"),
                ],
            )
        ]

        assert _settled_node_counts(stages) == (2, 0, 0, 0)


def _folded_counts(events: list[dict]) -> dict[str, int]:
    """The four TASK-982 counts, folded from the run's v2 node events (what B3a derives)."""
    settled = [e for e in events if e["type"] in ("node.completed", "node.failed")]
    return {
        "nodeCount": len(settled),
        "failedNodeCount": sum(1 for e in settled if e["type"] == "node.failed"),
        "degradedNodeCount": sum(1 for e in settled if e["data"].get("status") == "DEGRADED"),
        "skippedNodeCount": sum(1 for e in settled if e["data"].get("status") == "SKIPPED"),
    }


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


def _body(stages: list[dict]) -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "run-completed-counts-test",
        "versionNumber": 1,
        "tenantId": TENANT,
        "paletteKey": "fixture",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": stages,
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


@pytest.fixture
def fake_stream(monkeypatch):
    redis = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    return redis


async def _run(body: dict) -> tuple[str, object]:
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"run-completed-counts-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, *SCAFFOLD_ACTIVITIES],
        ):
            from harness.temporal.interpreter.models import InterpreterInput

            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=TENANT,
                    run_id=run_id,
                ),
                id=f"wf-run-completed-counts-{uuid.uuid4()}",
                task_queue=tq,
            )
            return run_id, await handle.result()


class TestRunCompletedCountsEndToEnd:
    @pytest.mark.asyncio
    async def test_a_fully_succeeded_run_reports_the_node_count_and_zero_everywhere_else(
        self, fake_stream
    ):
        run_id, result = await _run(
            _body(
                [
                    {"stageIndex": 0, "nodes": [_node("n1")]},
                    {"stageIndex": 1, "nodes": [_node("n2")]},
                ]
            )
        )
        assert result.status == "SUCCEEDED"

        counts = _folded_counts(fake_stream.events(run_id))
        assert counts["nodeCount"] == 2
        assert counts["failedNodeCount"] == 0
        assert counts["degradedNodeCount"] == 0
        assert counts["skippedNodeCount"] == 0

    @pytest.mark.asyncio
    async def test_a_degraded_and_a_skipped_node_both_count_in_the_terminal_event(
        self, fake_stream
    ):
        run_id, result = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("ok"),
                            _node("soft", config={"raise_error": True}),
                            _node("off", config={"enabled": False}),
                        ],
                    }
                ]
            )
        )
        assert result.status == "DEGRADED"

        counts = _folded_counts(fake_stream.events(run_id))
        assert counts["nodeCount"] == 3
        assert counts["failedNodeCount"] == 0
        assert counts["degradedNodeCount"] == 1
        assert counts["skippedNodeCount"] == 1

    @pytest.mark.asyncio
    async def test_a_critical_node_failing_still_counts_every_settled_node_in_that_stage(
        self, fake_stream, monkeypatch
    ):
        monkeypatch.setitem(
            NODE_REGISTRY,
            "critical-noop",
            NodeSpec(
                key="critical-noop", implemented=True, activity=interpreter_noop, critical=True
            ),
        )
        run_id, result = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("ok"),
                            _node("bad", config={"raise_error": True}) | {"type": "critical-noop"},
                        ],
                    },
                    # A second stage would be dispatched had the first not failed critically —
                    # it must never be counted, matching the walk's own break-on-failure.
                    {"stageIndex": 1, "nodes": [_node("never_reached")]},
                ]
            )
        )
        assert result.status == "FAILED"

        counts = _folded_counts(fake_stream.events(run_id))
        assert counts["nodeCount"] == 2
        assert counts["failedNodeCount"] == 1
        assert counts["degradedNodeCount"] == 0
        assert counts["skippedNodeCount"] == 0
