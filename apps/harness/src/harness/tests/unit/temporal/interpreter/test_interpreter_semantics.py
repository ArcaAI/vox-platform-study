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
from typing import Any

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import caps as interpreter_caps
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import CancelSignal, InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event

_BUCKET = "harness-claim-check"


def _node(
    node_id: str, node_type: str, *, activity: str, config: dict | None = None, **overrides
) -> dict:
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


async def _run(body: dict, *, signal_cancel_after_start: bool = False):
    ref = await _store_config(body)
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"interpreter-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, *SCAFFOLD_ACTIVITIES],
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                _input(ref),
                id=f"wf-interp-{uuid.uuid4()}",
                task_queue=tq,
            )
            if signal_cancel_after_start:
                # Deterministic, not a wall-clock guess: wait for stage
                # 0's own node activity (never `interpreter.load_config`, which is scheduled
                # first and would defeat the point) to actually be SCHEDULED before
                # signalling. That event can only appear once the workflow has passed the
                # `if self._cancelled: break` check for stage 0 and committed to
                # `_run_stage`, which is exactly the ordering this test asserts — however
                # long it took a busy machine to get there. A fixed `asyncio.sleep(...)`
                # before the signal raced that same ordering against real wall-clock
                # scheduling overhead and was observed flaky under load.
                def _stage0_node_scheduled(event: Any) -> bool:
                    return (
                        event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
                        and event.activity_task_scheduled_event_attributes.activity_type.name
                        != "interpreter.load_config"
                    )

                await await_history_event(
                    handle,
                    _stage0_node_scheduled,
                    description="stage 0 node activity scheduled",
                )
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
                            "ok1",
                            "noop",
                            activity="interpreter.noop",
                            config={"raise_error": False},
                        ),
                        _node(
                            "bad", "noop", activity="interpreter.noop", config={"raise_error": True}
                        ),
                        _node(
                            "ok2",
                            "noop",
                            activity="interpreter.noop",
                            config={"raise_error": False},
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
        # F13 — the ActivityError's cause travels onto the reason.
        assert by_id["bad"].reason == (
            "activity_error: RuntimeError: interpreter.noop: simulated failure for node bad"
        )
        assert result.status == "DEGRADED"


class TestCriticalNodeFails:
    @pytest.mark.asyncio
    async def test_critical_node_failing_fails_the_run_and_stops_walking(self, monkeypatch):
        # Temporarily register a CRITICAL node type pointing at the same noop activity —
        # criticality is a registry (code-owned) property, never tenant config.
        from harness.temporal.interpreter.activities import interpreter_noop

        critical_spec = NodeSpec(
            key="critical-noop", implemented=True, activity=interpreter_noop, critical=True
        )
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
        assert (
            interpreter_caps.clamp_timeout(requested) == interpreter_caps.MAX_NODE_TIMEOUT_SECONDS
        )

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
        # n1 sleeps briefly (real wall-clock — activities are not time-skipped) so it is
        # still genuinely in flight when the cancel signal lands. `_run` waits for n1's
        # ActivityTaskScheduled history event (not a fixed real-time delay — see
        # `_temporal_sync.await_history_event`) before signalling, so cancellation
        # deterministically lands after the workflow has committed to stage 0 (stage 0
        # still completes; stage 1 never starts) regardless of how long a busy machine
        # takes to get there.
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
        result = await _run(body, signal_cancel_after_start=True)
        assert result.status == "CANCELLED"
        assert len(result.stages) == 1  # stage 0 completed; stage 1 never started
        assert result.stages[0].nodes[0].status == "SUCCEEDED"
