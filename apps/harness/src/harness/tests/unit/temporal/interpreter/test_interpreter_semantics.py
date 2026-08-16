"""End-to-end tests for WorkflowInterpreter via Temporal's time-skipping env (Task 3/6).

Same pattern as test_doc_workflow.py: a real ephemeral Temporal server (time-skipping),
INTERPRETER_ACTIVITIES run for real (against the process-shared InMemoryBlobStore claim-check
store), nothing stubbed except what a test needs to force a specific node outcome (via
config["raise_error"] on the seed `noop`/`passthrough` activities — see
interpreter/activities.py's docstring for why this substitutes for a real multi-second timeout).
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
from harness.temporal.interpreter import caps as interpreter_caps
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import CancelSignal, InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_BUCKET = "harness-claim-check"


def _node(node_id: str, node_type: str, *, activity: str, config: dict | None = None, **overrides) -> dict:
    node = {
        "nodeId": node_id,
        "type": node_type,
        "activity": activity,
        "config": config or {},
        "timeoutSeconds": 30,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "inputs": [],
        "onError": "degrade",
        "emitsTrajectory": True,
    }
    node.update(overrides)
    return node


def _body(stages: list[dict], **overrides) -> dict:
    body = {
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
    body.update(overrides)
    return body


async def _store_config(body: dict) -> object:
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    doc = json.dumps({**body, "checksum": checksum})
    return await store_blob(doc, store=_MEMORY_STORE, bucket=_BUCKET)


def _input(config_ref, *, sandbox: bool = False) -> InterpreterInput:
    return InterpreterInput(
        session_id="s-1",
        workflow_version_id="v-1",
        config_ref=config_ref,
        tenant_id="t-1",
        run_id=str(uuid.uuid4()),
        sandbox=sandbox,
    )


async def _run(
    body: dict, *, signal_cancel_after_start: bool = False, cancel_delay_seconds: float = 0.0
):
    ref = await _store_config(body)
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"interpreter-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=INTERPRETER_ACTIVITIES,
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                _input(ref),
                id=f"wf-interp-{uuid.uuid4()}",
                task_queue=tq,
            )
            if signal_cancel_after_start:
                if cancel_delay_seconds:
                    import asyncio

                    await asyncio.sleep(cancel_delay_seconds)
                await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="test"))
            return await handle.result()


class TestLinearWalk:
    @pytest.mark.asyncio
    async def test_three_stage_walk_completes_in_order_and_succeeds(self):
        body = _body(
            [
                {"stageIndex": 0, "nodes": [_node("n1", "noop", activity="interpreter.noop")]},
                {"stageIndex": 1, "nodes": [_node("n2", "noop", activity="interpreter.noop")]},
                {"stageIndex": 2, "nodes": [_node("n3", "noop", activity="interpreter.noop")]},
            ]
        )
        result = await _run(body)
        assert result.status == "SUCCEEDED"
        assert [s.stage_index for s in result.stages] == [0, 1, 2]
        assert [s.nodes[0].node_id for s in result.stages] == ["n1", "n2", "n3"]
        assert all(s.nodes[0].status == "SUCCEEDED" for s in result.stages)


class TestFanOut:
    @pytest.mark.asyncio
    async def test_three_node_fan_out_all_settle_and_join(self):
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node("a", "passthrough", activity="interpreter.passthrough"),
                        _node("b", "passthrough", activity="interpreter.passthrough"),
                        _node("c", "passthrough", activity="interpreter.passthrough"),
                    ],
                }
            ]
        )
        result = await _run(body)
        assert result.status == "SUCCEEDED"
        assert len(result.stages) == 1
        node_ids = {n.node_id for n in result.stages[0].nodes}
        assert node_ids == {"a", "b", "c"}
        assert all(n.status == "SUCCEEDED" for n in result.stages[0].nodes)


class TestDegradeAndContinue:
    @pytest.mark.asyncio
    async def test_one_node_failing_degrades_and_siblings_still_complete(self):
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node(
                            "ok1", "noop", activity="interpreter.noop", config={"raise_error": False}
                        ),
                        _node(
                            "bad", "noop", activity="interpreter.noop", config={"raise_error": True}
                        ),
                        _node(
                            "ok2", "noop", activity="interpreter.noop", config={"raise_error": False}
                        ),
                    ],
                }
            ]
        )
        result = await _run(body)
        by_id = {n.node_id: n for n in result.stages[0].nodes}
        assert by_id["ok1"].status == "SUCCEEDED"
        assert by_id["ok2"].status == "SUCCEEDED"
        assert by_id["bad"].status == "DEGRADED"
        assert by_id["bad"].reason == "activity_error"
        assert result.status == "DEGRADED"


class TestCriticalNodeFails:
    @pytest.mark.asyncio
    async def test_critical_node_failing_fails_the_run_and_stops_walking(self, monkeypatch):
        # Temporarily register a CRITICAL node type pointing at the same noop activity —
        # criticality is a registry (code-owned) property, never tenant config.
        from harness.temporal.interpreter.activities import interpreter_noop

        critical_spec = NodeSpec(key="critical-noop", implemented=True, activity=interpreter_noop, critical=True)
        monkeypatch.setitem(NODE_REGISTRY, "critical-noop", critical_spec)

        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node(
                            "crit",
                            "critical-noop",
                            activity="interpreter.noop",
                            config={"raise_error": True},
                        )
                    ],
                },
                {"stageIndex": 1, "nodes": [_node("never", "noop", activity="interpreter.noop")]},
            ]
        )
        result = await _run(body)
        assert result.status == "FAILED"
        assert len(result.stages) == 1  # stage 1 never started
        assert result.stages[0].nodes[0].status == "FAILED"


class TestUnknownNodeType:
    @pytest.mark.asyncio
    async def test_unknown_type_is_an_observable_skip_not_a_silent_success(self):
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [_node("x", "this-type-does-not-exist", activity="nope")],
                }
            ]
        )
        result = await _run(body)
        node = result.stages[0].nodes[0]
        assert node.status == "SKIPPED"
        assert node.reason == "unsupported_node_type"
        assert result.status == "DEGRADED"


class TestCapClamping:
    @pytest.mark.asyncio
    async def test_node_timeout_above_platform_cap_is_clamped(self):
        # Not directly observable from InterpreterResult (the clamp affects the activity
        # call's start_to_close_timeout, not a returned field), so this asserts the pure
        # clamp function directly plus that a wildly-over-cap config still runs successfully
        # (i.e. the clamp did not raise / reject the config, and the run isn't stalled by an
        # attempted 10,000s timeout).
        requested = 10_000
        assert interpreter_caps.clamp_timeout(requested) == interpreter_caps.MAX_NODE_TIMEOUT_SECONDS

        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node("n1", "noop", activity="interpreter.noop", timeoutSeconds=requested)
                    ],
                }
            ]
        )
        result = await _run(body)
        assert result.status == "SUCCEEDED"


class TestCancel:
    @pytest.mark.asyncio
    async def test_cancel_signal_stops_the_walk_at_the_next_stage_boundary(self):
        # n1 sleeps briefly (real wall-clock — activities are not time-skipped); the test
        # itself waits past config-load before signaling, so cancellation reliably lands
        # WHILE stage 0's node is in flight (stage 0 still completes; stage 1 never starts) —
        # deterministic, not a race on whether the signal beats the workflow's first await.
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node(
                            "n1",
                            "noop",
                            activity="interpreter.noop",
                            config={"sleep_seconds": 0.5},
                        )
                    ],
                },
                {"stageIndex": 1, "nodes": [_node("n2", "noop", activity="interpreter.noop")]},
            ]
        )
        result = await _run(body, signal_cancel_after_start=True, cancel_delay_seconds=0.2)
        assert result.status == "CANCELLED"
        assert len(result.stages) == 1  # stage 0 completed; stage 1 never started
        assert result.stages[0].nodes[0].status == "SUCCEEDED"
