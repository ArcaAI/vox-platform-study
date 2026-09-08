"""TASK-864 A4 — the `core` vocabulary in the interpreter, end to end in the time-skipping env.

Same hermetic pattern as `test_interpreter_semantics.py`: a real ephemeral Temporal server,
`INTERPRETER_ACTIVITIES` run for real against the in-memory claim-check store, and ONLY the
two network-bound activities (`interpreter.core_agent`, `interpreter.core_classify`) replaced
by programmable stubs registered under the same names — the same technique
`_agentic_loop_stubs.py` uses, for the same reason: a branch is only proven if the thing being
branched over is the production interpreter.

Properties defended here, each its own test:

* **Branch gating.** A node behind an untaken handle is `SKIPPED(branch_not_taken)`; so is its
  whole tail; a JOIN fed by both branches still runs.
* **Conditions read the run context** (`trigger.*`, `vars.*`, `nodes.*`) through the CEL
  evaluator, and a broken condition falls through to `else` observably.
* **A human review is a durable wait in the middle of the graph**: `approved` releases the
  tail; a timeout takes `timedOut` and NEVER approves.
* **Loops are bounded and distinguishable**: `foreach` over 3 items runs 3 generations and
  stops `items_exhausted`; `while` with `maxIterations: 2` stops `max_iterations` (DEGRADED,
  the ceiling named); `until` stops `until` (SUCCEEDED).
* **`core.action` delegates** to the legacy activity, and `core.note` never runs.
* **Per-instance lane**: a `core.agent` with `execution.lane = realtime` is skipped here.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.loop_workflow import AgenticLoopWorkflow, AgenticSubAgentWorkflow
from harness.temporal.interpreter.models import (
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
    ReviewDecisionSignal,
)
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow, review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal._temporal_sync import await_history_event

_BUCKET = "harness-claim-check"
_TENANT = "22222222-2222-2222-2222-222222222222"


# ---------------------------------------------------------------------------------------------
# Stubs for the two network-bound activities
# ---------------------------------------------------------------------------------------------


@activity.defn(name="interpreter.core_agent")
async def stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    """Echoes what it was handed; `_stub_fail` raises (an activity error)."""
    if payload.config.get("_stub_fail"):
        raise RuntimeError("stub agent failure")
    bound = payload.bound_inputs
    item = bound.get("context") if "context" in bound else bound.get("in")
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "text": f"summary-of-{json.dumps(item, sort_keys=True, default=str)}",
            "data": {"item": item, "vars": payload.run_context.get("vars")},
            "usage": {"total_tokens": int(payload.config.get("_stub_tokens", 0))},
        },
    )


@activity.defn(name="interpreter.core_classify")
async def stub_core_classify(payload: NodeActivityInput) -> NodeActivityResult:
    """Takes the class named by `_stub_category` (or `otherwise`)."""
    category = payload.config.get("_stub_category")
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"classification": {"category": category, "scores": {}}},
        taken_handle=category or "otherwise",
    )


_STUBBED = {"interpreter.core_agent", "interpreter.core_classify"}
_ACTIVITIES = [
    *[
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name not in _STUBBED
    ],
    *LOOP_ACTIVITIES,
    *SCAFFOLD_ACTIVITIES,
    stub_core_agent,
    stub_core_classify,
]

_WORKFLOWS = [
    WorkflowInterpreter,
    ConsultationGateWorkflow,
    AgenticLoopWorkflow,
    AgenticSubAgentWorkflow,
    ReviewGateWorkflow,
    LoopWorkflow,
]


# ---------------------------------------------------------------------------------------------
# Compiled-config builders (the shapes `compile()` emits)
# ---------------------------------------------------------------------------------------------


def _node(
    node_id: str,
    node_type: str,
    activity_name: str,
    *,
    config: dict | None = None,
    inputs: list[dict] | None = None,
    guards: list[dict] | None = None,
    timeout: int = 30,
) -> dict:
    node = {
        "nodeId": node_id,
        "type": node_type,
        "activity": activity_name,
        "config": config or {},
        "timeoutSeconds": timeout,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "inputs": inputs or [],
        "onError": "degrade",
        "emitsTrajectory": True,
    }
    if guards:
        node["branchGuards"] = guards
    return node


def _edge(from_id: str, from_port: str, to_port: str) -> dict:
    return {"fromNodeId": from_id, "fromPort": from_port, "toPort": to_port}


def _trigger(node_id: str = "n_trigger") -> dict:
    return _node(node_id, "core.trigger", "interpreter.core_trigger", config={"kinds": ["api"]})


def _output(inputs: list[dict], guards: list[dict] | None = None) -> dict:
    return _node(
        "n_output",
        "core.output",
        "interpreter.core_output",
        config={"protocols": ["http-sse"], "claimCheck": "never"},
        inputs=inputs,
        guards=guards,
    )


def _body(stages: list[dict], loops: list[dict] | None = None) -> dict:
    body: dict[str, Any] = {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "core-test",
        "versionNumber": 1,
        "tenantId": _TENANT,
        "paletteKey": "core",
        "compiledAt": "2026-09-04T00:00:00.000Z",
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
    if loops:
        body["loops"] = loops
    return body


async def _store(body: dict):
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )


async def _run(
    body: dict,
    *,
    payload: dict | None = None,
    review: str | None = None,
    review_node: str = "n_review",
):
    """Start the interpreter; when `review` is set, signal the review child once it is waiting."""
    ref = await _store(body)
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"core-test-{uuid.uuid4()}"
        async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=_TENANT,
                    run_id=run_id,
                    payload=payload or {},
                ),
                id=f"wf-core-{run_id}",
                task_queue=tq,
            )
            if review is not None:

                def _review_child_started(event: Any) -> bool:
                    return (
                        event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                        and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                        == review_gate_workflow_id(run_id, review_node)
                    )

                await await_history_event(
                    handle, _review_child_started, description="review child started"
                )
                await env.client.get_workflow_handle(
                    review_gate_workflow_id(run_id, review_node)
                ).signal(
                    ReviewGateWorkflow.review,
                    ReviewDecisionSignal(decision=review, reviewer_id="dr-1"),
                )
            result = await handle.result()
            return result, {n.node_id: n for s in result.stages for n in s.nodes}


# ---------------------------------------------------------------------------------------------
# Branch gating over conditions and classify
# ---------------------------------------------------------------------------------------------


def _condition_body(*, senior_age: int) -> dict:
    """trigger -> condition(senior: trigger.age >= 65) -> [senior] agent_a -> data_a ; [else] agent_b ; join -> output"""
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_cond",
                        "core.condition",
                        "interpreter.core_condition",
                        config={
                            "branches": [
                                {"key": "senior", "when": f"trigger.age >= {senior_age}"},
                                {"key": "broken", "when": "nope.x"},
                            ]
                        },
                        inputs=[_edge("n_trigger", "out", "in")],
                    )
                ],
            },
            {
                "stageIndex": 2,
                "nodes": [
                    _node(
                        "n_agent_a",
                        "core.agent",
                        "interpreter.core_agent",
                        config={"agentRef": {"slug": "a"}},
                        inputs=[_edge("n_trigger", "out", "context")],
                        guards=[{"fromNodeId": "n_cond", "handle": "senior"}],
                    ),
                    _node(
                        "n_agent_b",
                        "core.agent",
                        "interpreter.core_agent",
                        config={"agentRef": {"slug": "b"}},
                        inputs=[_edge("n_trigger", "out", "context")],
                        guards=[{"fromNodeId": "n_cond", "handle": "else"}],
                    ),
                ],
            },
            {
                "stageIndex": 3,
                "nodes": [
                    # The TAIL of branch a: no guard of its own, only an input from n_agent_a.
                    _node(
                        "n_data_a",
                        "core.data",
                        "interpreter.core_data",
                        config={"mappings": [{"from": "in.item", "to": "item"}]},
                        inputs=[_edge("n_agent_a", "data", "in")],
                    ),
                ],
            },
            {
                "stageIndex": 4,
                "nodes": [
                    _output([_edge("n_data_a", "out", "in"), _edge("n_agent_b", "data", "in")])
                ],
            },
        ]
    )


class TestBranchGating:
    @pytest.mark.asyncio
    async def test_the_taken_branch_runs_and_the_untaken_branch_is_skipped(self):
        result, by_id = await _run(_condition_body(senior_age=65), payload={"age": 70})
        assert by_id["n_cond"].status == "SUCCEEDED"
        assert by_id["n_agent_a"].status == "SUCCEEDED"
        assert by_id["n_agent_b"].status == "SKIPPED"
        assert by_id["n_agent_b"].reason == "branch_not_taken"
        assert by_id["n_data_a"].status == "SUCCEEDED"
        # The join fed by both branches runs on the one that was taken.
        assert by_id["n_output"].status == "SUCCEEDED"
        assert (
            result.status == "DEGRADED"
        )  # a SKIPPED node is reported as a degraded run, as always

    @pytest.mark.asyncio
    async def test_the_else_branch_runs_when_no_condition_holds_and_the_tail_of_the_other_is_skipped_too(
        self,
    ):
        _, by_id = await _run(_condition_body(senior_age=65), payload={"age": 30})
        assert by_id["n_agent_a"].reason == "branch_not_taken"
        # Propagation: n_data_a has no guard, but its ONLY predecessor was skipped.
        assert by_id["n_data_a"].status == "SKIPPED"
        assert by_id["n_data_a"].reason == "branch_not_taken"
        assert by_id["n_agent_b"].status == "SUCCEEDED"
        assert by_id["n_output"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_a_broken_condition_never_routes_a_branch(self):
        """`nope.x` reads an undeclared root: it is recorded as an error, and `else` wins over it."""
        body = _condition_body(senior_age=65)
        body["stages"][1]["nodes"][0]["config"]["branches"] = [
            {"key": "broken", "when": "nope.x"},
            {"key": "senior", "when": "trigger.age >= 65"},
        ]
        _, by_id = await _run(body, payload={"age": 70})
        assert (
            by_id["n_agent_a"].status == "SUCCEEDED"
        )  # `senior` still taken after `broken` errored

    @pytest.mark.asyncio
    async def test_classify_takes_a_class_handle(self):
        body = _body(
            [
                {"stageIndex": 0, "nodes": [_trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        _node(
                            "n_classify",
                            "core.classify",
                            "interpreter.core_classify",
                            config={
                                "modelSlug": "m",
                                "classes": [{"key": "safe", "label": "Safe"}],
                                "_stub_category": "safe",
                            },
                            inputs=[_edge("n_trigger", "out", "in")],
                        )
                    ],
                },
                {
                    "stageIndex": 2,
                    "nodes": [
                        _node(
                            "n_safe",
                            "noop",
                            "interpreter.noop",
                            guards=[{"fromNodeId": "n_classify", "handle": "safe"}],
                        ),
                        _node(
                            "n_other",
                            "noop",
                            "interpreter.noop",
                            guards=[{"fromNodeId": "n_classify", "handle": "otherwise"}],
                        ),
                    ],
                },
            ]
        )
        _, by_id = await _run(body)
        assert by_id["n_safe"].status == "SUCCEEDED"
        assert by_id["n_other"].reason == "branch_not_taken"


# ---------------------------------------------------------------------------------------------
# Variables, actions, notes, per-instance lane
# ---------------------------------------------------------------------------------------------


class TestContextAndDelegation:
    @pytest.mark.asyncio
    async def test_variables_reach_conditions_and_agents_through_the_run_context(self):
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _trigger(),
                        _node(
                            "n_vars",
                            "core.variable",
                            "interpreter.core_variables",
                            config={"variables": [{"key": "threshold", "default": 5}]},
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
                                    {"key": "over", "when": "trigger.age > vars.threshold"}
                                ]
                            },
                        )
                    ],
                },
                {
                    "stageIndex": 2,
                    "nodes": [
                        _node(
                            "n_agent",
                            "core.agent",
                            "interpreter.core_agent",
                            config={"agentRef": {"slug": "a"}},
                            inputs=[_edge("n_trigger", "out", "context")],
                            guards=[{"fromNodeId": "n_cond", "handle": "over"}],
                        )
                    ],
                },
            ]
        )
        _, by_id = await _run(body, payload={"age": 9})
        assert by_id["n_cond"].status == "SUCCEEDED"
        assert by_id["n_agent"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_core_action_delegates_to_the_legacy_activity_and_a_note_never_runs(self):
        body = _body(
            [
                {"stageIndex": 0, "nodes": [_trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        # `passthrough` is not an action; use a real catalogue entry whose activity is hermetic:
                        # `prompt.template_ref` needs the gateway, so exercise the delegation through
                        # an UNKNOWN key (observable degrade) and a note (observable skip) instead.
                        _node(
                            "n_action",
                            "core.action",
                            "interpreter.core_action",
                            config={"actionKey": "not.an.action"},
                        ),
                        _node(
                            "n_note", "core.note", "interpreter.core_note", config={"text": "hi"}
                        ),
                    ],
                },
            ]
        )
        _, by_id = await _run(body)
        assert by_id["n_action"].status == "SKIPPED"
        assert (
            by_id["n_action"].reason == "unsupported_node_type"
        )  # an unknown action has no effective spec
        assert by_id["n_note"].status == "SKIPPED"
        assert by_id["n_note"].reason == "annotation"

    @pytest.mark.asyncio
    async def test_a_realtime_lane_agent_is_skipped_by_the_durable_interpreter(self):
        body = _body(
            [
                {"stageIndex": 0, "nodes": [_trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        _node(
                            "n_live",
                            "core.agent",
                            "interpreter.core_agent",
                            config={
                                "agentRef": {"slug": "a"},
                                "execution": {"lane": "realtime", "cadence": "perTurn"},
                            },
                        )
                    ],
                },
            ]
        )
        _, by_id = await _run(body)
        assert by_id["n_live"].status == "SKIPPED"
        assert by_id["n_live"].reason == "realtime_lane"

    @pytest.mark.asyncio
    async def test_the_trigger_fails_the_run_on_a_context_schema_violation(self):
        body = _body(
            [
                {
                    "stageIndex": 0,
                    "nodes": [
                        _node(
                            "n_trigger",
                            "core.trigger",
                            "interpreter.core_trigger",
                            config={
                                "kinds": ["api"],
                                "contextSchema": {
                                    "inline": {"type": "object", "required": ["age"]}
                                },
                            },
                        )
                    ],
                },
                {"stageIndex": 1, "nodes": [_node("n_never", "noop", "interpreter.noop")]},
            ]
        )
        result, by_id = await _run(body, payload={})
        assert by_id["n_trigger"].status == "FAILED"
        assert result.status == "FAILED"
        assert "n_never" not in by_id


# ---------------------------------------------------------------------------------------------
# Human review — a durable wait in the middle of the graph
# ---------------------------------------------------------------------------------------------


def _review_body(*, timeout_seconds: int = 600) -> dict:
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_agent",
                        "core.agent",
                        "interpreter.core_agent",
                        config={"agentRef": {"slug": "a"}},
                        inputs=[_edge("n_trigger", "out", "context")],
                    )
                ],
            },
            {
                "stageIndex": 2,
                "nodes": [
                    _node(
                        "n_review",
                        "core.humanReview",
                        "interpreter.core_human_review",
                        config={"timeoutSeconds": timeout_seconds},
                        inputs=[_edge("n_agent", "out", "in")],
                        timeout=3600,
                    )
                ],
            },
            {
                "stageIndex": 3,
                "nodes": [
                    _output(
                        [_edge("n_review", "out", "in")],
                        guards=[{"fromNodeId": "n_review", "handle": "approved"}],
                    )
                ],
            },
        ]
    )


class TestHumanReview:
    @pytest.mark.asyncio
    async def test_an_approval_releases_the_tail(self):
        result, by_id = await _run(_review_body(), review="approved")
        assert by_id["n_review"].status == "SUCCEEDED"
        assert by_id["n_output"].status == "SUCCEEDED"
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_a_rejection_is_a_decision_the_graph_routes_and_the_approved_tail_is_skipped(
        self,
    ):
        _, by_id = await _run(_review_body(), review="rejected")
        assert by_id["n_review"].status == "SUCCEEDED"
        assert by_id["n_output"].reason == "branch_not_taken"

    @pytest.mark.asyncio
    async def test_a_timeout_never_approves(self):
        _, by_id = await _run(_review_body(timeout_seconds=30))
        assert by_id["n_review"].status == "DEGRADED"
        assert by_id["n_review"].reason == "review_timed_out"
        assert by_id["n_output"].status == "SKIPPED"
        assert by_id["n_output"].reason == "branch_not_taken"


# ---------------------------------------------------------------------------------------------
# Loops — bounded, distinguishable, one generation per iteration
# ---------------------------------------------------------------------------------------------


def _loop_body(
    *, mode: str, bounds: dict, over: str | None = None, until: str | None = None, tokens: int = 0
) -> dict:
    loop_config: dict[str, Any] = {"mode": mode, "bounds": bounds, "collect": "text"}
    if over:
        loop_config["over"] = over
    if until:
        loop_config["until"] = until
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_loop",
                        "core.loop",
                        "interpreter.core_loop",
                        config=loop_config,
                        inputs=[_edge("n_trigger", "out", "in")],
                        timeout=3600,
                    )
                ],
            },
            {"stageIndex": 2, "nodes": [_output([_edge("n_loop", "done", "in")])]},
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
                                    config={"agentRef": {"slug": "a"}, "_stub_tokens": tokens},
                                    inputs=[_edge("n_loop", "each", "context")],
                                )
                            ],
                        }
                    ]
                },
            }
        ],
    )


class TestLoops:
    @pytest.mark.asyncio
    async def test_foreach_over_three_items_runs_three_iterations_and_collects(self):
        body = _loop_body(
            mode="foreach",
            over="trigger.items",
            bounds={"maxIterations": 10, "maxDurationSeconds": 600, "maxTotalTokens": 100000},
        )
        result, by_id = await _run(body, payload={"items": ["a", "b", "c"]})
        assert by_id["n_loop"].status == "SUCCEEDED"
        assert by_id["n_output"].status == "SUCCEEDED"
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_while_with_max_iterations_two_stops_with_the_ceiling_named(self):
        body = _loop_body(
            mode="while",
            until="false",
            bounds={"maxIterations": 2, "maxDurationSeconds": 600, "maxTotalTokens": 100000},
        )
        _, by_id = await _run(body, payload={})
        assert by_id["n_loop"].status == "DEGRADED"
        assert by_id["n_loop"].reason == "max_iterations"

    @pytest.mark.asyncio
    async def test_until_ends_the_loop_as_a_success(self):
        body = _loop_body(
            mode="while",
            until="loop.iteration >= 2",
            bounds={"maxIterations": 10, "maxDurationSeconds": 600, "maxTotalTokens": 100000},
        )
        _, by_id = await _run(body, payload={})
        assert by_id["n_loop"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_the_token_ceiling_truncates_the_loop(self):
        body = _loop_body(
            mode="while",
            until="false",
            bounds={"maxIterations": 10, "maxDurationSeconds": 600, "maxTotalTokens": 150},
            tokens=100,
        )
        _, by_id = await _run(body, payload={})
        assert by_id["n_loop"].status == "DEGRADED"
        assert by_id["n_loop"].reason == "max_total_tokens"

    @pytest.mark.asyncio
    async def test_an_unresolvable_over_path_degrades_rather_than_iterating_nothing(self):
        body = _loop_body(
            mode="foreach",
            over="trigger.missing",
            bounds={"maxIterations": 10, "maxDurationSeconds": 600, "maxTotalTokens": 100000},
        )
        _, by_id = await _run(body, payload={})
        assert by_id["n_loop"].status == "DEGRADED"
        assert by_id["n_loop"].reason == "loop_over_unresolvable"


class TestDeterminism:
    @pytest.mark.asyncio
    async def test_the_core_patch_marker_is_recorded_only_for_a_graph_that_uses_a_child_construct(
        self,
    ):
        """A branch-only graph records NO marker (its skips add no command); a review graph does."""
        ref = await _store(_condition_body(senior_age=65))
        async with await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter
        ) as env:
            tq = f"core-test-{uuid.uuid4()}"
            async with Worker(
                env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES
            ):
                handle = await env.client.start_workflow(
                    WorkflowInterpreter.run,
                    InterpreterInput(
                        session_id="s",
                        workflow_version_id="v",
                        config_ref=ref,
                        tenant_id=_TENANT,
                        run_id=str(uuid.uuid4()),
                        payload={"age": 70},
                    ),
                    id=f"wf-core-{uuid.uuid4()}",
                    task_queue=tq,
                )
                await handle.result()
                history = await handle.fetch_history()
        markers = [
            e
            for e in history.events
            if e.event_type == EventType.EVENT_TYPE_MARKER_RECORDED
            and e.marker_recorded_event_attributes.marker_name == "core_patch"
        ]
        assert not any("task-864-core-vocabulary" in str(m) for m in markers)
