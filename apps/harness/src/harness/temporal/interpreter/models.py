"""Pydantic payloads for the interpreter workflow + its activities.

Kept separate from the shared ``harness.temporal.models`` (which backs
``HarnessDocWorkflow``/``ConsultationLoopWorkflow``) so this new, additive package never touches
that frozen/near-frozen surface — see ``contracts/execution-semantics.md`` and rule
03/06's "surgical changes" guidance.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.models import TrajectoryContext

# ---------------------------------------------------------------------------
# Node-level lifecycle (contracts/execution-semantics.md §4)
# ---------------------------------------------------------------------------
NodeStatus = Literal["SUCCEEDED", "DEGRADED", "SKIPPED", "FAILED"]

# ---------------------------------------------------------------------------
# Run-level terminal states (contracts/execution-semantics.md §6)
# ---------------------------------------------------------------------------
RunStatus = Literal["SUCCEEDED", "DEGRADED", "FAILED", "CANCELLED"]


class NodeActivityInput(BaseModel):
    """What every interpreter node activity receives.

    ``config`` is the node's own compiled config object (already clamped/resolved by the
    TypeScript compiler — nothing here re-derives it). ``trajectory`` is additive-optional,
    matching the existing ``TrajectoryContext`` replay-safety posture (claim_check.py / models.py
    precedent): omitting it costs only observability, never correctness.

    ``bound_inputs``/``run_payload`` (TASK-720 Task 5, additive) complete a mechanism that was
    already HALF built: the compiler unconditionally derives ``CompiledNode.inputs`` (the edge-
    derived ``fromNodeId``/``fromPort``/``toPort`` bindings) for every node, and
    ``NodeActivityResult.output`` already existed for an activity to publish a result — but
    ``workflow.py``'s dispatch loop never connected the two (see that module's own note, and
    ``contracts/execution-semantics.md`` §3's "v1 does not thread" scope note, which this
    completes rather than overrides — see the reasoning recorded in this ticket's README §7).
    Both fields are additive-optional with an empty-dict default, so a node with no incoming
    edges (``inputs: []``, e.g. every pre-existing ``noop``/``passthrough`` test fixture) gets
    byte-identical behavior to before this change — this is opt-in wiring, not a new dynamic
    sub-graph mechanism (the topology stays fixed at compile time; only VALUES flow, never
    control).

    ``bound_inputs`` is keyed by ``toPort``: for each ``CompiledInputBinding`` on this node, the
    workflow looks up the completed predecessor's own ``NodeActivityResult.output`` dict (the
    workflow-owned ``_node_outputs`` cache in ``workflow.py``) and, if that dict carries the
    binding's ``fromPort`` as a key, threads that single value in; otherwise it threads the WHOLE
    predecessor output dict (this palette's authored graph uses the trivial single-port
    convention ``fromPort: 'out'`` / ``toPort: 'in'`` for every edge — see the seeded
    ``packages/database/.../seed/21-workflow-definition.ts`` — under which no predecessor output
    dict has a literal ``'out'`` key, so every edge resolves to "pass the whole predecessor
    output").

    ``run_payload`` is the run's own opaque invocation payload (``InterpreterInput.payload``,
    itself additive-optional), threaded identically to every node — generic, not palette-
    specific, exactly like ``tenant_id``/``sandbox`` already are. Only ``input.context_binding``
    reads it today; every other activity is free to ignore it.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    node_type: str
    config: dict[str, Any]
    tenant_id: str
    sandbox: bool = False
    trajectory: TrajectoryContext | None = None
    bound_inputs: dict[str, Any] = Field(default_factory=dict)
    run_payload: dict[str, Any] = Field(default_factory=dict)


class NodeActivityResult(BaseModel):
    """What every interpreter node activity returns.

    ``status`` here is the ACTIVITY's own outcome (never ``FAILED`` — promotion of a degraded
    critical node to the run-level ``FAILED`` state happens in the workflow body, not the
    activity, since criticality is a registry/workflow-level property — see
    contracts/execution-semantics.md §4).
    """

    model_config = ConfigDict(extra="forbid")

    status: Literal["SUCCEEDED", "DEGRADED", "SKIPPED"]
    reason: str | None = None
    output: dict[str, Any] | None = None


class NodeResult(BaseModel):
    """One node's terminal record on ``InterpreterResult`` (also the trajectory row source)."""

    model_config = ConfigDict(extra="forbid")

    node_id: str
    node_type: str
    status: NodeStatus
    reason: str | None = None


class StageResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage_index: int
    nodes: list[NodeResult]


class InterpreterInput(BaseModel):
    """WorkflowInterpreter's ``@workflow.run`` input.

    Per S-1, the logical input is only ``(sessionId, workflowVersionId)`` — everything else
    (``config_ref``, ``tenant_id``, ``sandbox``, ``run_id``) is plumbing the dispatcher (Task 10)
    resolves BEFORE starting the workflow, so the workflow body itself never has to.
    """

    model_config = ConfigDict(extra="forbid")

    session_id: str
    workflow_version_id: str
    config_ref: ClaimCheckRef
    tenant_id: str
    run_id: str
    sandbox: bool = False
    # Additive-optional (TASK-720 Task 5): the raw invocation payload, threaded generically
    # into every node's `NodeActivityInput.run_payload` — see that field's docstring.
    # NOTE (honesty, not fabrication): `WorkflowExposureService.invoke()`
    # (`packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts`)
    # accepts `InvokeWorkflowRequest.input` but does NOT yet forward it to
    # `HarnessGatewayService.startWorkflowRun(...)` — confirmed by reading that call site. So
    # today this field is always `{}` in a real invoke; wiring the dispatcher side is TASK-722's
    # gap, not this ticket's fix (a different, actively-reviewed ticket's files) — recorded here
    # so the gap is traceable, not silently papered over.
    payload: dict[str, Any] = Field(default_factory=dict)


class InterpreterResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    status: RunStatus
    stages: list[StageResult]


class CancelSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = None


class InterpreterStateQueryResult(BaseModel):
    """Live snapshot returned by the ``state`` query (contracts/execution-semantics.md §8)."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    status: RunStatus | Literal["RUNNING"]
    stages: list[StageResult]
