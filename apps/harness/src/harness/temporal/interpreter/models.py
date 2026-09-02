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
    # TASK-849 lane A, additive-optional. The DELTA lane's stream key is per-RUN
    # (`wf:run:<runId>:events`), so an activity that streams tokens has to know which run it
    # belongs to — `trajectory` carries a workflow VERSION id and a stage/node id, never a run
    # id. Empty default keeps every pre-existing fixture byte-identical; an activity that
    # cannot resolve a run id simply does not stream, which costs observability and nothing
    # else. Lanes B (binary audio) and C (debug canvas) both consume this.
    run_id: str = ""


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


# ---------------------------------------------------------------------------
# HITL gate (TASK-731 Phase B) — the ONE durable human wait in this substrate.
# ---------------------------------------------------------------------------


class ConsultationGateInput(BaseModel):
    """Input for ``ConsultationGateWorkflow`` — the child the interpreter starts for a
    ``gate``-classed node.

    Carries run identity plus the COMPILED gate row (`CompiledGate`), never the graph: the child
    waits, escalates and records a decision; it does not walk anything. SLA knobs are NOT carried
    here — the child resolves them from the tenant's effective policy through `fetch_policy`, the
    same activity `HarnessDocWorkflow` uses, so a tenant's gate SLA is honoured without the
    interpreter's deterministic body doing any I/O.
    """

    model_config = ConfigDict(extra="forbid")

    run_id: str
    node_id: str
    tenant_id: str
    consultation_id: str
    user_id: str | None = None
    job_id: str | None = None
    context_item_id: str | None = None
    # The compiled gate row's own fields (already clamped by the TS compiler).
    gate_type: str
    timeout_seconds: int
    on_timeout: str
    trajectory: TrajectoryContext | None = None


class ConsultationGateResult(BaseModel):
    """What the gate child returns to the interpreter.

    ``approved`` is the ONLY field that can mean sign-off, and it is set from a real
    ``approval`` signal or not at all. An abandoned gate returns ``approved=False`` with the
    escalation count — never a value a caller could read as approval
    (`03-compliance-posture.md` §3, the forgery shape this must never resemble).
    """

    model_config = ConfigDict(extra="forbid")

    approved: bool
    outcome: Literal["APPROVED", "ABANDONED"]
    decision: str | None = None
    clinician_id: str | None = None
    context_item_version_id: str | None = None
    escalations: int = 0


class GateApprovalSignal(BaseModel):
    """The ``approval`` signal payload. Mirrors ``harness.temporal.models.ApprovalSignal``'s
    fields; declared here so the interpreter package never widens that frozen surface."""

    model_config = ConfigDict(extra="forbid")

    decision: str | None = None
    clinician_id: str | None = None
    context_item_version_id: str | None = None
    attestation_hash: str | None = None
    tenant_id: str | None = None


class InterpreterStateQueryResult(BaseModel):
    """Live snapshot returned by the ``state`` query (contracts/execution-semantics.md §8)."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    status: RunStatus | Literal["RUNNING"]
    stages: list[StageResult]


# ---------------------------------------------------------------------------
# The agentic LOOP (TASK-848) — the second durable construct in this substrate,
# and the first that ITERATES.
#
# Every field here exists because something in the loop must survive a
# ``continue_as_new`` boundary. That is the whole design constraint: the loop
# workflow runs EXACTLY ONE iteration per generation, so anything it needs on the
# next iteration has to be carried forward as INPUT rather than held in memory.
# What cannot be carried this way is the ``maxDurationSeconds`` deadline — a
# workflow timer does not survive ``continue_as_new`` and the only way to
# "carry" one would be to read a clock and subtract, which is exactly the
# wall-clock read rule 06 forbids inside ``@workflow.defn``. So that one bound is
# owned by the PARENT (the interpreter), whose single timer spans the whole
# continue-as-new chain. See ``loop_workflow.py``'s module docstring.
# ---------------------------------------------------------------------------

#: Why a loop stopped. Six values, deliberately DISTINGUISHABLE: an operator
#: reading a trajectory must be able to tell "it converged" from "it ran out of
#: money" from "it ran out of clock" without inspecting anything else. Four of
#: them are the TASK-847 bounds; ``termination_key`` is the authored early exit;
#: ``orchestrator_failed`` is the honest outcome when the master agent could not
#: run at all (never silently re-tried into one of the bound reasons).
LoopStopReason = Literal[
    "max_iterations",
    "max_duration_seconds",
    "max_total_tokens",
    "no_progress_iterations",
    "termination_key",
    "orchestrator_failed",
]


class AgenticLoopBounds(BaseModel):
    """The four ``agentic.loop`` bounds, already clamped by the TypeScript compiler.

    Mirrors ``AGENTIC_LOOP_BOUNDS_PROPERTY`` in
    ``packages/workflow-contract/src/node-config-schemas.ts``. Three are REQUIRED by that
    schema; ``noProgressIterations`` carries the schema's own default of 2 so a config
    compiled before the field existed still parses to the documented behaviour rather than
    to "unbounded".
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    max_iterations: int = Field(alias="maxIterations")
    max_duration_seconds: int = Field(alias="maxDurationSeconds")
    max_total_tokens: int = Field(alias="maxTotalTokens")
    no_progress_iterations: int = Field(default=2, alias="noProgressIterations")


class AgenticLoopNodeSpec(BaseModel):
    """One compiled graph node the loop dispatches — the orchestrator, or one sub-agent.

    A projection of ``CompiledNode``, not the node itself: the loop needs the node's identity,
    its config and its already-clamped execution envelope, and nothing else. ``activity_name``
    travels so the child can repeat the interpreter's own S-4 cross-check (the registry decides
    what runs; the wire's activity string is only ever a consistency check).
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    node_type: str
    activity_name: str
    config: dict[str, Any] = Field(default_factory=dict)
    timeout_seconds: int
    max_attempts: int


class AgenticLoopState(BaseModel):
    """The accumulator carried ACROSS ``continue_as_new`` — the loop's entire memory.

    ``inline``/``ref`` are the claim-check pair (TASK-837 §3.4 rule 15): the orchestrator's
    working state stays inline while it is small and moves to MinIO the moment it is not, so a
    long clinical deliberation never marches the 2 MB payload ceiling. ``digest`` is a sha256
    over the canonical form of that state, computed in the ACTIVITY that offloads it — it is
    what ``noProgressIterations`` compares, and computing it in the activity is what keeps the
    workflow body free of both the blob and the hashing.
    """

    model_config = ConfigDict(extra="forbid")

    iterations: int = 0
    tokens_used: int = 0
    no_progress_streak: int = 0
    digest: str = ""
    inline: Any = None
    #: RESERVED, and deliberately never set in this pass. The claim-check offload is TASK-848b
    #: step 6; the field exists now so the carry-forward shape does not change when it lands
    #: (a state model change is a replay-visible change to every in-flight loop).
    ref: ClaimCheckRef | None = None
    #: Sub-agent CHILD workflows that did not succeed, summed across every generation. A loop
    #: is not failed by a failing worker — the orchestrator is free to route around it — but the
    #: count travels so the outcome is never silently clean.
    sub_agent_failures: int = 0


class AgenticLoopInput(BaseModel):
    """``AgenticLoopWorkflow``'s input — and, because of ``continue_as_new``, also its
    own carry-forward between iterations. Every generation receives one of these."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    node_id: str
    tenant_id: str
    workflow_version_id: str
    sandbox: bool = False
    bounds: AgenticLoopBounds
    orchestrator: AgenticLoopNodeSpec
    sub_agents: list[AgenticLoopNodeSpec] = Field(default_factory=list)
    #: Truthiness of this key on the orchestrator's output ends the loop early.
    termination_key: str | None = None
    #: What the graph bound into the loop node's own ``in`` port — the loop's seed, threaded
    #: to the orchestrator on iteration 0 and never again (after that the orchestrator reads
    #: its own previous working state).
    seed_inputs: dict[str, Any] = Field(default_factory=dict)
    run_payload: dict[str, Any] = Field(default_factory=dict)
    state: AgenticLoopState = Field(default_factory=AgenticLoopState)


class AgenticLoopResult(BaseModel):
    """What the loop child returns to the interpreter.

    ``stop_reason`` is the load-bearing field and it is never absent: a loop that ended
    always says WHY, and the four bound reasons never collapse into one another.
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    stop_reason: LoopStopReason
    iterations: int
    tokens_used: int
    result: Any = None
    sub_agent_failures: int = 0


class LoopCheckpointInput(BaseModel):
    """What ``interpreter.loop_state_checkpoint`` receives — ONE iteration's whole product.

    The orchestrator's output and the sub-agents' outputs are digested TOGETHER, on purpose:
    ``noProgressIterations`` asks whether the ITERATION produced anything new, and an
    orchestrator that paraphrases itself while its workers return new findings has made
    progress. Tokens are summed over the same set, because ``maxTotalTokens`` is the contract's
    invoice ceiling — *"summed across every iteration and every sub-agent"* — not the
    orchestrator's own bill.
    """

    model_config = ConfigDict(extra="forbid")

    orchestrator_output: dict[str, Any] = Field(default_factory=dict)
    sub_agent_outputs: list[dict[str, Any]] = Field(default_factory=list)
    termination_key: str | None = None


class AgenticSubAgentInput(BaseModel):
    """``AgenticSubAgentWorkflow``'s input — ONE sub-agent, ONE iteration.

    A sub-agent runs as a CHILD WORKFLOW rather than an activity so it gets its own history
    and its own retry envelope: a sub-agent that thrashes cannot fill the orchestrator's
    history, and a sub-agent that fails is a child-level failure the loop can absorb rather
    than a workflow-task failure that wedges the whole loop.
    """

    model_config = ConfigDict(extra="forbid")

    node: AgenticLoopNodeSpec
    tenant_id: str
    sandbox: bool = False
    iteration: int = 0
    bound_inputs: dict[str, Any] = Field(default_factory=dict)
    bound_input_refs: dict[str, ClaimCheckRef] = Field(default_factory=dict)
    run_payload: dict[str, Any] = Field(default_factory=dict)
    trajectory: TrajectoryContext | None = None


class LoopStateCheckpoint(BaseModel):
    """What ``interpreter.loop_state_checkpoint`` returns — the one activity per iteration
    that turns a raw orchestrator output into the next generation's carry-forward.

    It does THREE things the workflow body must not: the claim-check offload (I/O), the
    canonical-form digest (cheap, but it must see the whole blob, which is precisely what the
    workflow must not hold), and the token extraction (a read of a provider-shaped dict).
    """

    model_config = ConfigDict(extra="forbid")

    inline: Any = None
    ref: ClaimCheckRef | None = None
    digest: str
    tokens: int = 0
    #: Truthy iff the loop's ``terminationKey`` resolved truthy on this output.
    terminated: bool = False


class RunEventSpec(BaseModel):
    """One control event the workflow asks ``interpreter.emit_run_events`` to mirror.

    Deliberately a DESCRIPTION of what happened, never a built envelope: `uuid4` and
    `datetime.now` are both forbidden inside `@workflow.defn`, so the workflow can name the
    fact but cannot stamp it. The activity stamps identity and time — which is also why two
    replays of the same history produce two envelope ids and one `idempotencyKey` (the key is
    derived from intent, the id is not).
    """

    model_config = ConfigDict(extra="forbid")

    event_type: str
    node_id: str | None = None
    node_type: str | None = None
    stage_index: int | None = None
    status: str | None = None
    reason: str | None = None
    iteration: int | None = None


class RunEventBatch(BaseModel):
    """A whole stage boundary's worth of control events, mirrored in ONE activity call.

    Batched on purpose. Every `execute_activity` is three history events, so a per-NODE emit
    would make the control lane grow with node count for no gain — the events are already
    ordered within a stage boundary and a consumer reads them as one burst.
    """

    model_config = ConfigDict(extra="forbid")

    run_id: str
    tenant_id: str
    events: list[RunEventSpec] = Field(default_factory=list)
