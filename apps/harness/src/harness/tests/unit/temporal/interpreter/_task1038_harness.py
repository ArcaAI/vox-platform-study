"""Shared, hermetic run harness for the TASK-1038 interpreter suites (not collected by pytest).

The same technique as ``test_core_interpreter.py``: a real time-skipping Temporal server, the real
``WorkflowInterpreter`` and its children, the real interpreter activities against the in-memory
claim-check store — and ONE programmable stub registered under ``interpreter.core_agent``, driven
by ``config["_stub"]``:

* ``ok`` (default) — SUCCEEDED, ``{"text": "agent-<nodeId>"}``;
* ``degraded_with_output`` — DEGRADED, but WITH an output (the finalize-persist-failed shape);
* ``client_error`` — raises ``ApiClientError`` (a 4xx: terminal);
* ``transient`` — raises ``ApiServiceError`` (retryable);
* ``sleep`` — sleeps ``_stub_seconds`` of REAL time, heartbeating, recording a cancellation;
* ``big`` — SUCCEEDED with a ``text`` of ``_stub_bytes`` bytes;
* ``echo`` — SUCCEEDED, echoing what it was handed (bound inputs, run payload, run context).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections import defaultdict
from typing import Any

from temporalio import activity
from temporalio.client import WorkflowHandle
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.api_client import ApiClientError, ApiServiceError
from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES, node_activity_envelope
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.core_loop_workflow import LoopWorkflow
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.models import (
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
    RunLimits,
    RunSubject,
)
from harness.temporal.interpreter.review_workflow import ReviewGateWorkflow
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter.test_core_interpreter import (
    _TENANT,
    _body,
    _edge,
    _node,
    _output,
    _trigger,
)

__all__ = [
    "ATTEMPTS",
    "CANCELLED",
    "SEEN",
    "TENANT",
    "agent",
    "body",
    "edge",
    "output",
    "reset",
    "run_graph",
    "trigger",
]

TENANT = _TENANT
body = _body
edge = _edge
output = _output
trigger = _trigger

#: Attempts per node id (every activity attempt, retries included).
ATTEMPTS: dict[str, int] = defaultdict(int)
#: Node ids whose stub saw an activity cancellation.
CANCELLED: set[str] = set()
#: The last input each node's stub was handed (AFTER the activity envelope ran).
SEEN: dict[str, NodeActivityInput] = {}


def reset() -> None:
    ATTEMPTS.clear()
    CANCELLED.clear()
    SEEN.clear()


async def _stub_core_agent(payload: NodeActivityInput) -> NodeActivityResult:
    ATTEMPTS[payload.node_id] += 1
    SEEN[payload.node_id] = payload
    mode = payload.config.get("_stub", "ok")
    if mode == "degraded_with_output":
        return NodeActivityResult(
            status="DEGRADED",
            reason="core.agent: persist failed (stub)",
            output={"text": f"kept-{payload.node_id}"},
        )
    if mode == "client_error":
        raise ApiClientError("apps/api /x failed: 422", status_code=422)
    if mode == "transient":
        raise ApiServiceError("apps/api /x failed: connection refused")
    if mode == "sleep":
        try:
            await asyncio.sleep(float(payload.config.get("_stub_seconds", 30)))
        except asyncio.CancelledError:
            CANCELLED.add(payload.node_id)
            raise
        return NodeActivityResult(status="SUCCEEDED", output={"text": "slept"})
    if mode == "big":
        return NodeActivityResult(
            status="SUCCEEDED", output={"text": "x" * int(payload.config["_stub_bytes"])}
        )
    if mode == "echo":
        return NodeActivityResult(
            status="SUCCEEDED",
            output={
                "text": "echo",
                "data": {"bound": payload.bound_inputs, "payload": payload.run_payload},
            },
        )
    return NodeActivityResult(status="SUCCEEDED", output={"text": f"agent-{payload.node_id}"})


#: The stub, wrapped in the SAME envelope production node activities run inside (claim-check
#: hydration on the way in, offload on the way out, heartbeating) and registered under the
#: production name.
stub_core_agent = activity.defn(name="interpreter.core_agent")(
    node_activity_envelope(_stub_core_agent)
)

ACTIVITIES = [
    *[
        a
        for a in INTERPRETER_ACTIVITIES
        if getattr(a, "__temporal_activity_definition").name != "interpreter.core_agent"
    ],
    *LOOP_ACTIVITIES,
    stub_core_agent,
]
WORKFLOWS = [WorkflowInterpreter, ConsultationGateWorkflow, ReviewGateWorkflow, LoopWorkflow]


def agent(node_id: str, *, inputs: list[dict] | None = None, **config: Any) -> dict:
    retry = config.pop("_retry", None)
    timeout = config.pop("_timeout", 30)
    node = _node(
        node_id,
        "core.agent",
        "interpreter.core_agent",
        config={"agentRef": {"slug": "a"}, **config},
        inputs=inputs,
        timeout=timeout,
    )
    if retry is not None:
        node["retry"] = retry
    return node


async def _store(graph: dict) -> Any:
    checksum = hashlib.sha256(canonical_json(graph).encode("utf-8")).hexdigest()
    return await store_blob(
        json.dumps({**graph, "checksum": checksum}),
        store=_MEMORY_STORE,
        bucket="harness-claim-check",
    )


async def run_graph(
    graph: dict,
    *,
    payload: dict | None = None,
    subject: RunSubject | None = None,
    limits: RunLimits | None = None,
    activities: list[Any] | None = None,
    during: Any = None,
    run_id: str | None = None,
) -> tuple[Any, dict[str, Any], Any]:
    """Run to completion. ``during(env, handle)`` runs once the workflow has started (signals).

    Returns ``(result, nodes_by_id, history)``.
    """
    ref = await _store(graph)
    run_id = run_id or str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"task1038-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=WORKFLOWS,
            activities=activities if activities is not None else ACTIVITIES,
        ):
            handle: WorkflowHandle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=TENANT,
                    run_id=run_id,
                    payload=payload or {},
                    subject=subject,
                    limits=limits,
                ),
                id=f"wf-task1038-{run_id}",
                task_queue=tq,
            )
            if during is not None:
                await during(env, handle)
            result = await handle.result()
            history = await handle.fetch_history()
    return result, {n.node_id: n for s in result.stages for n in s.nodes}, history
