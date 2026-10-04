"""TASK-1038 R-8 — capture the replay fixtures the interpreter was missing.

The pre-TASK-1038 fixtures cover only two of the interpreter's six patch eras (``task-849`` run
event stream, ``task-864`` core vocabulary) and none of its CHILD workflows. This script records,
against the CURRENTLY IMPORTED definitions, one history per missing era plus the children:

* ``interpreter_gate_task731_history`` — a run that parks at its blocking HITL gate and is
  approved (``task-731-hitl-gate``), and its child ``consultation_gate_task731_history``.
* ``interpreter_live_handoff_task932_history`` — a consultation-bound run whose durable finalizer
  binds a realtime node's output: the walk polls the live handoff (``ended: false`` twice, then
  ``ended: true``) before dispatching the finalizer (``task-932-live-handoff``).
* ``interpreter_review_skip_task946_history`` — a ``core.humanReview`` whose bound payload is
  empty (its producer degraded with no output) and is therefore never opened
  (``task-946-review-skip-empty-payload``).
* ``review_gate_task864_history`` — the ``ReviewGateWorkflow`` child of the core scenario
  (signalled ``approved``).
* ``loop_workflow_task864_first_run_history`` / ``loop_workflow_task864_last_run_history`` — the
  first and the last generation of the ``LoopWorkflow`` ``continue_as_new`` chain of the core
  scenario (a ``foreach`` over two items).

It was run ONCE on the pre-change definition (base ``45ce54bc6``) BEFORE any TASK-1038 workflow
edit, which is what makes the histories evidence: they are what an in-flight run of each era
looks like when the TASK-1038 definition is deployed under it.

Not collected by pytest (no ``test_`` prefix), mirroring the other ``_capture_*`` scripts. The two
network-bound activities are stubbed exactly as ``test_core_interpreter.py`` stubs them; activity
BODIES are never replayed, so the stubs change nothing about what the fixtures prove.

Usage (from the repo root, conda env ``arcaenv``)::

    PYTHONPATH=apps/harness/src python -m \\
        harness.tests.unit.temporal._capture_task1038_replay_fixtures \\
        apps/harness/src/harness/tests/unit/temporal/fixtures

``--task1038`` instead records the TASK-1038 era itself on the POST-change definition (forward
guards for its markers): ``interpreter_task1038_v1_history`` (payload references, a kept degraded
output, the retry policy, the deadline, a review), ``interpreter_task1038_timed_out_history``,
``interpreter_task1038_cancelled_history`` and ``interpreter_task1038_loop_ref_history``.

``--task1036`` records the wave-B data-contract era (lane B1) on its post-change definition, the
forward guards for ``task-1038-run-protocol-v2``, ``task-1036-bindings`` and
``task-1036-consultation-reads``: ``interpreter_task1036_contract_history`` (run.started, a
run-start AND a node-start declared read, bound inputs, an End-wired node, a review fed by a
binding) and ``loop_workflow_task1036_bindings_history`` / ``interpreter_task1036_loop_history``
(a loop body bound to ``nodes.<loop>.outputs.item``).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.api_client import RecordGateResponse
from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.core_loop_workflow import core_loop_workflow_id
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow, gate_workflow_id
from harness.temporal.interpreter.models import (
    GateApprovalSignal,
    InterpreterInput,
    LiveOutputsRequest,
    LiveOutputsResult,
    ReviewDecisionSignal,
    RunSubject,
)
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow, review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.temporal.models import (
    EscalateInput,
    EscalateResult,
    FetchPolicyInput,
    HarnessPolicy,
    RecordGateInput,
)
from harness.tests.unit.temporal._capture_core_replay_fixture import _scenario as _core_scenario
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
_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"


async def _ref(body: dict[str, Any]) -> Any:
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )


def _write(out_dir: Path, name: str, history: Any) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}.json"
    path.write_text(history.to_json())
    print(f"wrote {path}")


def _child_first_run_id(parent_history: Any, child_id: str) -> str | None:
    for event in parent_history.events:
        if event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED:
            execution = event.child_workflow_execution_started_event_attributes.workflow_execution
            if execution.workflow_id == child_id:
                return execution.run_id
    return None


# ---------------------------------------------------------------------------------------------
# Stubs for the gate's three activities and the live handoff
# ---------------------------------------------------------------------------------------------


@activity.defn(name="fetch_policy")
async def _fetch_policy(payload: FetchPolicyInput) -> HarnessPolicy:
    return HarnessPolicy(gate_sla_seconds=60.0, gate_escalation_seconds=30.0)


@activity.defn(name="escalate_gate")
async def _escalate_gate(payload: EscalateInput) -> EscalateResult:
    return EscalateResult(escalated=True)


@activity.defn(name="record_gate_decision")
async def _record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
    return RecordGateResponse(recorded=True)


_HANDOFF_SCRIPT: list[LiveOutputsResult] = []


@activity.defn(name="interpreter.load_live_outputs")
async def _load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
    if len(_HANDOFF_SCRIPT) > 1:
        return _HANDOFF_SCRIPT.pop(0)
    return _HANDOFF_SCRIPT[0] if _HANDOFF_SCRIPT else LiveOutputsResult(ended=True)


def _activities(*extra: Any) -> list[Any]:
    names = {getattr(a, "__temporal_activity_definition").name for a in extra}
    return [
        *[a for a in _ACTIVITIES if getattr(a, "__temporal_activity_definition").name not in names],
        *extra,
    ]


# ---------------------------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------------------------


def _gate_scenario() -> dict[str, Any]:
    body = _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_vars",
                        "core.variable",
                        "interpreter.core_variables",
                        config={"variables": [{"key": "k", "default": 1}]},
                    )
                ],
            },
        ]
    )
    body["gates"] = [
        {
            "nodeId": "n_gate",
            "gateType": "core.humanReview",
            "blocking": True,
            "timeoutSeconds": 900,
            "onTimeout": "TIMED_OUT",
        }
    ]
    return body


def _live_handoff_scenario() -> dict[str, Any]:
    realtime = _node(
        "n_summary",
        "core.agent",
        "interpreter.core_agent",
        config={
            "agentRef": {"slug": "general-medicine-summarization"},
            "execution": {"lane": "realtime", "cadence": "perTurn"},
        },
        inputs=[_edge("n_trigger", "out", "context")],
    )
    finalizer = _node(
        "n_finalize",
        "core.agent",
        "interpreter.core_agent",
        config={
            "agentRef": {"slug": "casenote-finalization"},
            "execution": {"lane": "durable", "cadence": "onEnd"},
        },
        inputs=[_edge("n_summary", "out", "in")],
    )
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {"stageIndex": 1, "nodes": [realtime]},
            {"stageIndex": 2, "nodes": [finalizer]},
            {"stageIndex": 3, "nodes": [_output([_edge("n_finalize", "out", "in")])]},
        ]
    )


def _review_skip_scenario() -> dict[str, Any]:
    return _body(
        [
            {"stageIndex": 0, "nodes": [_trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    _node(
                        "n_draft",
                        "core.agent",
                        "interpreter.core_agent",
                        # The stub raises: a DEGRADED producer that stores no output — the shape
                        # the 2026-09-10 trials hit.
                        config={"agentRef": {"slug": "a"}, "_stub_fail": True},
                        inputs=[_edge("n_trigger", "out", "in")],
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
                        config={"timeoutSeconds": 600},
                        inputs=[_edge("n_draft", "out", "in")],
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


async def _start(client: Client, tq: str, body: dict[str, Any], run_id: str, **kwargs: Any) -> Any:
    return await client.start_workflow(
        WorkflowInterpreter.run,
        InterpreterInput(
            session_id="s-fixture",
            workflow_version_id="v-fixture",
            config_ref=await _ref(body),
            tenant_id=_TENANT,
            run_id=run_id,
            **kwargs,
        ),
        id=f"interpreter-task1038-fixture-{uuid.uuid4()}",
        task_queue=tq,
    )


async def capture_gate(env: WorkflowEnvironment, out_dir: Path) -> None:
    run_id = "run-task1038-gate"
    tq = f"task1038-gate-{uuid.uuid4()}"
    async with Worker(
        env.client,
        task_queue=tq,
        workflows=_WORKFLOWS,
        activities=_activities(_fetch_policy, _escalate_gate, _record_gate_decision),
    ):
        handle = await _start(
            env.client,
            tq,
            _gate_scenario(),
            run_id,
            payload={"consultationId": _CONSULTATION, "userId": "u-fixture"},
        )
        child_id = gate_workflow_id(run_id)

        def _gate_started(event: Any) -> bool:
            return (
                event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                == child_id
            )

        await await_history_event(handle, _gate_started, description="gate child started")
        await env.client.get_workflow_handle(child_id).signal(
            ConsultationGateWorkflow.approval,
            GateApprovalSignal(decision="approve", clinician_id="dr-fixture"),
        )
        result = await handle.result()
        print(f"gate: status={result.status}")
        _write(out_dir, "interpreter_gate_task731_history", await handle.fetch_history())
        _write(
            out_dir,
            "consultation_gate_task731_history",
            await env.client.get_workflow_handle(child_id).fetch_history(),
        )


async def capture_live_handoff(env: WorkflowEnvironment, out_dir: Path) -> None:
    _HANDOFF_SCRIPT[:] = [
        LiveOutputsResult(ended=False),
        LiveOutputsResult(ended=False),
        LiveOutputsResult(ended=True, outputs={"n_summary": {"text": "S: cough for 3 days"}}),
    ]
    run_id = "run-task1038-live"
    tq = f"task1038-live-{uuid.uuid4()}"
    async with Worker(
        env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_activities(_load_live_outputs)
    ):
        handle = await _start(
            env.client,
            tq,
            _live_handoff_scenario(),
            run_id,
            payload={"visit_type": "new-visit", "consultationId": _CONSULTATION},
            subject=RunSubject(consultationId=_CONSULTATION),
        )
        result = await handle.result()
        print(f"live handoff: status={result.status}")
        _write(out_dir, "interpreter_live_handoff_task932_history", await handle.fetch_history())


async def capture_review_skip(env: WorkflowEnvironment, out_dir: Path) -> None:
    run_id = "run-task1038-review-skip"
    tq = f"task1038-review-skip-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
        handle = await _start(env.client, tq, _review_skip_scenario(), run_id, payload={"q": 1})
        result = await handle.result()
        print(f"review skip: status={result.status}")
        _write(out_dir, "interpreter_review_skip_task946_history", await handle.fetch_history())


async def capture_core_children(env: WorkflowEnvironment, out_dir: Path) -> None:
    run_id = "run-task1038-core-children"
    tq = f"task1038-core-{uuid.uuid4()}"
    async with Worker(env.client, task_queue=tq, workflows=_WORKFLOWS, activities=_ACTIVITIES):
        handle = await _start(
            env.client, tq, _core_scenario(), run_id, payload={"items": ["x", "y"]}
        )
        review_id = review_gate_workflow_id(run_id, "n_review")

        def _review_started(event: Any) -> bool:
            return (
                event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                == review_id
            )

        await await_history_event(handle, _review_started, description="review child started")
        await env.client.get_workflow_handle(review_id).signal(
            ReviewGateWorkflow.review,
            ReviewDecisionSignal(decision="approved", reviewer_id="dr-fixture"),
        )
        result = await handle.result()
        print(f"core children: status={result.status}")
        parent = await handle.fetch_history()
        _write(
            out_dir,
            "review_gate_task864_history",
            await env.client.get_workflow_handle(review_id).fetch_history(),
        )
        loop_id = core_loop_workflow_id(run_id, "n_loop")
        first_run = _child_first_run_id(parent, loop_id)
        _write(
            out_dir,
            "loop_workflow_task864_first_run_history",
            await env.client.get_workflow_handle(loop_id, run_id=first_run).fetch_history(),
        )
        _write(
            out_dir,
            "loop_workflow_task864_last_run_history",
            await env.client.get_workflow_handle(loop_id).fetch_history(),
        )


async def capture(out_dir: Path) -> None:
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        await capture_gate(env, out_dir)
        await capture_live_handoff(env, out_dir)
        await capture_review_skip(env, out_dir)
        await capture_core_children(env, out_dir)


# ---------------------------------------------------------------------------------------------
# The TASK-1038 era itself (`--task1038`): FORWARD guards for the new markers, captured on the
# post-change definition so a later ungated change to any of these paths fails a replay.
# ---------------------------------------------------------------------------------------------


async def capture_task1038_era(out_dir: Path) -> None:
    from datetime import timedelta

    from harness.temporal.interpreter.models import CancelSignal, RunLimits
    from harness.tests.unit.temporal.interpreter import _task1038_harness as h

    fast_heartbeats = {
        "max_heartbeat_throttle_interval": timedelta(milliseconds=200),
        "default_heartbeat_throttle_interval": timedelta(milliseconds=200),
    }
    limits = RunLimits(activityInputMaxBytes=1_572_864)

    # 1. Payload refs + degraded output kept + retry policy + deadline + review, one happy walk.
    review = _node(
        "n_review",
        "core.humanReview",
        "interpreter.core_human_review",
        config={"timeoutSeconds": 600},
        inputs=[_edge("n_finalize", "out", "in")],
        timeout=3600,
    )
    era = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    h.agent(
                        "n_big",
                        _stub="big",
                        _stub_bytes=60_000,
                        inputs=[h.edge("n_trigger", "out", "in")],
                    ),
                    h.agent(
                        "n_finalize",
                        _stub="degraded_with_output",
                        inputs=[h.edge("n_trigger", "out", "in")],
                    ),
                ],
            },
            {"stageIndex": 2, "nodes": [review]},
            {"stageIndex": 3, "nodes": [h.output([h.edge("n_big", "out", "in")])]},
        ]
    )
    _, _, history = await h.run_graph(era, payload={"note": "n" * 30_000}, limits=limits)
    _write(out_dir, "interpreter_task1038_v1_history", history)

    # 2. The deadline firing on a node still in flight.
    slow = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    h.agent(
                        "n_slow",
                        _stub="sleep",
                        _stub_seconds=60,
                        _timeout=600,
                        inputs=[h.edge("n_trigger", "out", "in")],
                    )
                ],
            },
        ]
    )
    slow["caps"]["maxTotalSeconds"] = 5
    _, _, history = await h.run_graph(
        slow, payload={"q": 1}, limits=limits, worker_options=fast_heartbeats
    )
    _write(out_dir, "interpreter_task1038_timed_out_history", history)

    # 3. A cancel landing on a node still in flight.
    slow["caps"]["maxTotalSeconds"] = 3600

    async def cancel_once_running(env, handle):  # noqa: ANN001
        while h.ATTEMPTS["n_slow"] < 1:
            await asyncio.sleep(0.05)
        await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="fixture"))

    h.reset()
    _, _, history = await h.run_graph(
        slow,
        payload={"q": 1},
        limits=limits,
        during=cancel_once_running,
        worker_options=fast_heartbeats,
    )
    _write(out_dir, "interpreter_task1038_cancelled_history", history)

    # 4. A foreach over a claim-checked trigger (`interpreter.resolve_context_path`).
    loop = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
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
                                "maxTotalTokens": 100000,
                            },
                            "collect": "text",
                        },
                        inputs=[_edge("n_trigger", "out", "in")],
                        timeout=3600,
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
                                h.agent("n_body", inputs=[h.edge("n_loop", "each", "context")])
                            ],
                        }
                    ]
                },
            }
        ],
    )
    items = [f"item-{i}-" + "w" * 9_000 for i in range(3)]
    _, _, history = await h.run_graph(loop, payload={"items": items}, limits=limits)
    _write(out_dir, "interpreter_task1038_loop_ref_history", history)


# ---------------------------------------------------------------------------------------------
# The TASK-1036 / TASK-1038 wave-B era (`--task1036`), lane B1.
# ---------------------------------------------------------------------------------------------


async def capture_task1036_era(out_dir: Path) -> None:
    from harness.temporal.interpreter import activities as interpreter_activities
    from harness.tests.unit.temporal.interpreter import _task1038_harness as h
    from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

    class _Api:
        async def read_consultation(self, consultation_id: str, **kwargs: Any) -> dict[str, Any]:
            answers = {"consultation.patient.age": 41, "consultation.visitType": "revisit"}
            return {
                "values": {p: answers.get(p) for p in kwargs["paths"]},
                "readAt": "2026-10-04T10:00:00.000Z",
                "schemaVersion": 1,
            }

    interpreter_activities._RUN_EVENT_REDIS = FakeRunStreamRedis()  # noqa: SLF001
    interpreter_activities._RUN_EVENT_REDIS_BUILT = True  # noqa: SLF001
    interpreter_activities._api_client = lambda _settings: _Api()  # type: ignore[assignment]  # noqa: SLF001

    def bound(node: dict[str, Any], **extra: Any) -> dict[str, Any]:
        return {**node, **extra}

    review = _node(
        "n_review",
        "core.humanReview",
        "interpreter.core_human_review",
        config={"timeoutSeconds": 600},
        inputs=[_edge("n_note", "out", "in")],
        timeout=3600,
    )
    review["bindings"] = {"in": {"from": "nodes.n_note.outputs.text"}}
    contract = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
                    bound(
                        h.agent("n_note", label="Write the note"),
                        bindings={
                            "message": {"from": "context.note"},
                            "age": {"from": "consultation.patient.age"},
                            "visit": {"from": "consultation.visitType", "at": "runStart"},
                            "now": {"from": "run.now"},
                        },
                        consultationReads=[
                            {"path": "consultation.patient.age", "at": "nodeStart"},
                            {"path": "consultation.visitType", "at": "runStart"},
                        ],
                    )
                ],
            },
            {"stageIndex": 2, "nodes": [review]},
            {
                "stageIndex": 3,
                "nodes": [
                    bound(
                        h.output([h.edge("n_note", "out", "in")]),
                        bindings={"in": {"from": "nodes.n_note.outputs.text"}},
                    )
                ],
            },
        ]
    )

    async def approve(env, handle):  # noqa: ANN001
        review_id = review_gate_workflow_id(run_id, "n_review")

        def _started(event: Any) -> bool:
            return (
                event.event_type == EventType.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED
                and event.child_workflow_execution_started_event_attributes.workflow_execution.workflow_id
                == review_id
            )

        await await_history_event(handle, _started, description="review child started")
        await env.client.get_workflow_handle(review_id).signal(
            ReviewGateWorkflow.review,
            ReviewDecisionSignal(decision="approved", reviewer_id="dr-fixture"),
        )

    run_id = "run-task1036-contract"
    _, _, history = await h.run_graph(
        contract,
        payload={"note": "cough three days"},
        subject=RunSubject(consultationId=_CONSULTATION),
        run_id=run_id,
        retention_seconds=86_400,
        during=approve,
    )
    _write(out_dir, "interpreter_task1036_contract_history", history)

    loop = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [
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
                                "maxTotalTokens": 100000,
                            },
                            "collect": "text",
                        },
                        inputs=[_edge("n_trigger", "out", "in")],
                        timeout=3600,
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
                                bound(
                                    h.agent("n_body", _stub="echo"),
                                    bindings={
                                        "message": {"from": "nodes.n_loop.outputs.item.name"}
                                    },
                                )
                            ],
                        }
                    ]
                },
            }
        ],
    )
    loop_run_id = "run-task1036-loop"
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        ref = await _ref(loop)
        tq = f"task1036-loop-{uuid.uuid4()}"
        async with Worker(
            env.client, task_queue=tq, workflows=h.WORKFLOWS, activities=h.ACTIVITIES
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-fixture",
                    workflow_version_id="v-fixture",
                    config_ref=ref,
                    tenant_id=_TENANT,
                    run_id=loop_run_id,
                    payload={"items": [{"name": "first"}, {"name": "second"}]},
                ),
                id=f"interpreter-task1036-loop-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            print(f"task1036 loop: status={result.status}")
            _write(out_dir, "interpreter_task1036_loop_history", await handle.fetch_history())
            parent = await handle.fetch_history()
            loop_id = core_loop_workflow_id(loop_run_id, "n_loop")
            first_run = _child_first_run_id(parent, loop_id)
            _write(
                out_dir,
                "loop_workflow_task1036_bindings_history",
                await env.client.get_workflow_handle(loop_id, run_id=first_run).fetch_history(),
            )


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a not in ("--task1038", "--task1036")]
    target = (
        Path(args[0]) if args else Path("apps/harness/src/harness/tests/unit/temporal/fixtures")
    )
    if "--task1036" in sys.argv[1:]:
        asyncio.run(capture_task1036_era(target))
    elif "--task1038" in sys.argv[1:]:
        asyncio.run(capture_task1038_era(target))
    else:
        asyncio.run(capture(target))
