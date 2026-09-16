"""Pydantic payloads for the interpreter workflow + its activities.

Kept separate from the shared ``harness.temporal.models`` (which backs
``HarnessDocWorkflow``/``ConsultationLoopWorkflow``) so this new, additive package never touches
that frozen/near-frozen surface — see ``contracts/execution-semantics.md`` and rule
03/06's "surgical changes" guidance.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.models import TrajectoryContext

# ---------------------------------------------------------------------------
# Node-level lifecycle (contracts/execution-semantics.md)
# ---------------------------------------------------------------------------
NodeStatus = Literal["SUCCEEDED", "DEGRADED", "SKIPPED", "FAILED"]

# ---------------------------------------------------------------------------
# Run-level terminal states (contracts/execution-semantics.md)
# ---------------------------------------------------------------------------
RunStatus = Literal["SUCCEEDED", "DEGRADED", "FAILED", "CANCELLED"]


class NodeActivityInput(BaseModel):
    """What every interpreter node activity receives.

    ``config`` is the node's own compiled config object (already clamped/resolved by the
    TypeScript compiler — nothing here re-derives it). ``trajectory`` is additive-optional,
    matching the existing ``TrajectoryContext`` replay-safety posture (claim_check.py / models.py
    precedent): omitting it costs only observability, never correctness.

    bound_inputs/run_payload (additive) complete a mechanism that was
    already HALF built: the compiler unconditionally derives ``CompiledNode.inputs`` (the edge-
    derived ``fromNodeId``/``fromPort``/``toPort`` bindings) for every node, and
    ``NodeActivityResult.output`` already existed for an activity to publish a result — but
    ``workflow.py``'s dispatch loop never connected the two (see that module's own note, and
    `contracts/execution-semantics.md` "v1 does not thread" scope note, which this
    completes rather than overrides — see the reasoning recorded in
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
    # lane A, additive-optional. The DELTA lane's stream key is per-RUN
    # (`wf:run:<runId>:events`), so an activity that streams tokens has to know which run it
    # belongs to — `trajectory` carries a workflow VERSION id and a stage/node id, never a run
    # id. Empty default keeps every pre-existing fixture byte-identical; an activity that
    # cannot resolve a run id simply does not stream, which costs observability and nothing
    # else. Lanes B (binary audio) and C (debug canvas) both consume this.
    run_id: str = ""
    # TASK-864 §3.2, additive-optional. The RUN CONTEXT `{trigger, vars, nodes}` the `core`
    # vocabulary reads by path: CEL conditions (`core.condition`, `core.loop.until`), template
    # variables (`{{vars.key}}` on `core.agent`) and the loop's `over` path. Built by the workflow
    # from its own `_node_outputs` cache — pure derived state, replay-safe — and empty for every
    # legacy node, so pre-existing fixtures are byte-identical.
    run_context: dict[str, Any] = Field(default_factory=dict)


class NodeActivityResult(BaseModel):
    """What every interpreter node activity returns.

    ``status`` here is the ACTIVITY's own outcome (never ``FAILED`` — promotion of a degraded
    critical node to the run-level ``FAILED`` state happens in the workflow body, not the
    activity, since criticality is a registry/workflow-level property — see
    contracts/execution-semantics.md)
    """

    model_config = ConfigDict(extra="forbid")

    status: Literal["SUCCEEDED", "DEGRADED", "SKIPPED"]
    reason: str | None = None
    output: dict[str, Any] | None = None
    # TASK-864, additive-optional. The BRANCH HANDLE a router/review node took (`core.classify`:
    # a class key or `otherwise`; `core.condition`: a branch key or `else`; `core.humanReview`:
    # `approved` / `rejected` / `timedOut`). The workflow records it and dispatches a downstream
    # node carrying a `branchGuards` entry only when one of its guards names a taken handle.
    # `None` for every non-router node.
    taken_handle: str | None = None
    # TASK-947 OD-11, additive-optional. The KEYS of the prompt fragments that composed the
    # system prompt a `core.agent` step actually ran with — keys only, never a condition string
    # and never a fragment body. `None` for a non-composite instruction and for every other node.
    prompt_fragments: list[str] | None = None


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


#: The keys the consultation palette reads as RUN IDENTITY — ``RunIdentity``
#: (``nodes/_consultation_shared.py``) plus the two ``nodes/consultation.py`` reads. This tuple
#: IS the contract: the dispatcher strips exactly these from a caller's payload and re-stamps
#: exactly these from :class:`RunSubject`, so the thirteen ``run_identity(...)`` call sites and
#: the consent gate keep reading ``run_payload`` with no edit while becoming incapable of
#: reading a caller's value. Adding a key here without adding it to ``RunSubject`` would strip
#: an identity nothing can then supply — ``test_task850_run_subject.py`` pins both halves.
RESERVED_RUN_IDENTITY_KEYS: tuple[str, ...] = (
    "consultationId",
    "externalPatientId",
    "userId",
    "jobId",
    "sessionId",
)


class RunSubject(BaseModel):
    """The SERVER-RESOLVED clinical subject a run acts on ( lane A, closing C-8 link 1).

    This exists because ``payload`` cannot be trusted to carry identity. The exposure plane
    forwards a caller's ``input`` into ``payload`` verbatim with ``sandbox=False``, and the
    interpreter's ``external_write`` suppression fires only in sandbox — so a payload-sourced
    ``consultationId`` let a caller name any live consultation and reach the same
    ``persist_draft`` activity the real consultation workflow uses.

    The invariant this field carries, from : *consultation identity comes from the URL
    and is re-resolved against the caller's tenant — never from a caller-composed payload.* The
    gateway populates it ONLY from a path parameter it has re-resolved through a tenant-scoped
    read; there is no request shape that lets a caller write it and no field on
    ``InvokeWorkflowRequest`` that reaches it.

    Absent (``None``) means the run has no clinical subject — which is a real state, not a
    default to fill in: an unbound exposure-plane run legitimately has none, and every
    consultation activity then degrades with ``no_consultation_id`` rather than writing
    somewhere arbitrary.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    consultation_id: str = Field(alias="consultationId")
    external_patient_id: str | None = Field(default=None, alias="externalPatientId")
    user_id: str | None = Field(default=None, alias="userId")

    def as_run_payload_identity(self) -> dict[str, Any]:
        """The identity keys as the consultation palette already spells them.

        Only non-``None`` values are emitted: ``RunIdentity`` maps a missing key and an explicit
        ``None`` to the same ``None``, but emitting the key would make a
        ``"externalPatientId": None`` look like a supplied-and-empty value to any future reader.
        """
        stamped: dict[str, Any] = {"consultationId": self.consultation_id}
        if self.external_patient_id is not None:
            stamped["externalPatientId"] = self.external_patient_id
        if self.user_id is not None:
            stamped["userId"] = self.user_id
        return stamped


def sanitize_run_payload(
    payload: dict[str, Any] | None, subject: RunSubject | None
) -> dict[str, Any]:
    """A run payload that cannot carry identity, plus the server's own identity re-stamped.

    Pure, and deliberately unconditional — it does NOT ask whether the caller "looked
    trustworthy", whether the graph is a consultation graph, or whether ``sandbox`` is set. A
    conditional strip is a strip somebody eventually reasons their way around; this one has no
    branch to argue with.
    """
    clean = {k: v for k, v in (payload or {}).items() if k not in RESERVED_RUN_IDENTITY_KEYS}
    if subject is not None:
        clean.update(subject.as_run_payload_identity())
    return clean


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
    # lane A, additive-optional. The run's SERVER-RESOLVED clinical subject — see
    # `RunSubject`. Carried alongside `payload` rather than inside it so the two channels are
    # visibly different things in a Temporal history: `payload` is what a caller sent, `subject`
    # is what the server resolved. `payload` is sanitized against this field by
    # `sanitize_run_payload` BEFORE the workflow starts, so the two can never disagree.
    subject: RunSubject | None = None
    # Additive-optional: the raw invocation payload, threaded generically
    # into every node's `NodeActivityInput.run_payload` — see that field's docstring.
    # NOTE (honesty, not fabrication): `WorkflowExposureService.invoke()`
    # (`packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts`)
    # accepts `InvokeWorkflowRequest.input` but does NOT yet forward it to
    # `HarnessGatewayService.startWorkflowRun(...)` — confirmed by reading that call site. So
    # today this field is always `{}` in a real invoke; wiring the dispatcher side is
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
# HITL gate — the ONE durable human wait in this substrate.
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
    """Live snapshot returned by the state query (contracts/"""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    status: RunStatus | Literal["RUNNING"]
    stages: list[StageResult]


# ---------------------------------------------------------------------------
# The LOOP — the durable construct that ITERATES (`core.loop`, `core_loop_workflow.py`).
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
# continue-as-new chain. See ``core_loop_workflow.py``'s module docstring.
# ---------------------------------------------------------------------------

#: Why a loop stopped. Six values, deliberately DISTINGUISHABLE: an operator
#: reading a trajectory must be able to tell "it converged" from "it ran out of
#: money" from "it ran out of clock" without inspecting anything else. Four of
# them are the bounds; termination_key is the authored early exit;
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

    # the `workflow.loop.iteration` run event ( follow-up)
    #
    # Identity and counters the checkpoint needs in order to EMIT, not to compute. The
    # checkpoint already runs exactly once per iteration, so emitting from inside it costs no
    # new Temporal command — what changes is this payload, and every field below is defaulted
    # so a history recorded before they existed still deserializes.
    #
    # `tokens_used_before` is the loop's cumulative total as of the START of this iteration.
    # The activity adds its own `tokens` to it so the event reports the same running figure
    # the workflow will put on `CoreLoopState.tokens_used` a moment later — the ONE piece
    # of the bound arithmetic the activity cannot see for itself.
    #
    # Everything here is a scalar. The carry-forward itself must never join them: it may be
    # megabytes and may be claim-check offloaded, and putting it on a per-iteration event
    # would undo the offload b exists for.
    run_id: str = ""
    node_id: str = ""
    tenant_id: str = ""
    iteration: int = 0
    max_iterations: int = 0
    max_total_tokens: int = 0
    tokens_used_before: int = 0


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
    #: Settled-node counts for a `workflow.run.completed` event only. Additive-optional fields
    #: on an ACTIVITY INPUT, not a new `execute_activity` call, so no `workflow.patched` era is
    #: needed (the same argument `_SEQ_STRIDE`'s docstring makes in `workflow.py`) — a replaying
    #: history that predates these fields simply constructs a `RunEventSpec` with all four `None`.
    node_count: int | None = None
    failed_node_count: int | None = None
    degraded_node_count: int | None = None
    skipped_node_count: int | None = None


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


# ---------------------------------------------------------------------------
# TASK-864 — the `core` vocabulary's payloads.
# ---------------------------------------------------------------------------

# TASK-930 — NAMED_ENTITY_RECOGNITION joins the three. Widening this Literal is not
# cosmetic: `ResolvedAgent.model_validate` REFUSES an unknown task, so a NER agent would
# have degraded its node as `agent_unresolvable` — an error about resolution, raised for an
# agent the gateway resolved perfectly well.
AgentTask = Literal[
    "SPEECH_TO_TEXT", "TEXT_GENERATION", "TEXT_TO_SPEECH", "NAMED_ENTITY_RECOGNITION"
]


class ResolvedAgentModel(BaseModel):
    """One registry model of a resolved agent (the primary, or a fallback) — TASK-860's
    ``AiModelConfig`` projection as TASK-863 §3.4 materialises it. Every field is a REFERENCE or
    a registry fact; nothing here is a credential."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    slug: str
    provider: str | None = None
    source_uri: str | None = Field(default=None, alias="sourceUri")
    format: str | None = None
    compute_type: str | None = Field(default=None, alias="computeType")
    local_path: str | None = Field(default=None, alias="localPath")
    checksum: str | None = None


class ResolvedPromptFragment(BaseModel):
    """TASK-947 §4.1 (OD-3) — one fragment of a COMPOSITE instruction, frozen at publish.

    ``when`` is the authored CEL condition, or ``None`` for an unconditional fragment. The
    ``promptTemplateId`` / ``promptVersionNumber`` of a ``template`` fragment are PROVENANCE:
    the activity renders ``content`` and never re-resolves the template (the TASK-890 freeze,
    per fragment).
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    key: str
    source: Literal["template", "inline"]
    content: str
    when: str | None = None
    prompt_template_id: str | None = Field(default=None, alias="promptTemplateId")
    prompt_version_number: int | None = Field(default=None, alias="promptVersionNumber")


class ResolvedPrompt(BaseModel):
    """``compiledConfig.resolvedPrompt`` — the instruction text the gateway already resolved: a
    pinned, approved template version's content, the inline system prompt, or (TASK-947, OD-3)
    a COMPOSITE of ordered fragments each carrying an optional CEL ``when``.

    The activity interpolates it; it never re-resolves a template itself.

    For a composite, ``content`` is the STATIC PROJECTION — the unconditional fragments joined —
    so a reader that predates this ticket renders the base prompt rather than none at all. A
    reader that DOES understand fragments must compose them (``prompt_composition.py``);
    rendering the projection would mean a conditional fragment silently never runs.

    ``join`` and ``fragments`` are absent from every artifact published before TASK-947, which
    is why both default rather than being required.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    source: Literal["template", "inline", "composite"]
    content: str
    join: str | None = None
    fragments: list[ResolvedPromptFragment] = Field(default_factory=list)
    prompt_template_id: str | None = Field(default=None, alias="promptTemplateId")
    prompt_version_number: int | None = Field(default=None, alias="promptVersionNumber")


def _registry_models(data: dict[str, Any]) -> list[dict[str, Any]]:
    models = data.get("models")
    return [m for m in models if isinstance(m, dict)] if isinstance(models, list) else []


def _by_priority(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: (row.get("priority") is None, row.get("priority") or 0))


class ResolvedAgent(BaseModel):
    """The gateway's answer to ``GET /internal/agents/resolve`` — TASK-863's ``ResolvedAgent``
    (``packages/types/src/agent.ts``), the ONE producer being ``AgentResolverService.resolve``.

    On the wire the SELECTION lives under ``compiledConfig`` (``model`` / ``fallbacks`` /
    ``instruction`` / ``resolvedPrompt`` / ``parameters`` / schemas) and the REGISTRY FACTS of
    every model in the chain (``sourceUri``, ``localPath``, ``format``, ``computeType``,
    ``checksum``) under ``models[]`` keyed by ``role``. The before-validator lifts both into the
    flat ``model`` / ``fallbacks`` / ``instruction`` … fields the activities read, merging a
    fallback's selection with its registry row by slug. A payload that already carries the flat
    fields (older fixtures) validates unchanged.

    ``extra="ignore"`` on purpose: the resolver may grow fields (availability detail, tools,
    protocols) this activity has no use for, and a stricter mirror would fail a run over a field
    it never reads. Nothing here is a credential except ``providerOverride`` — forwarded to the
    Python service for ONE hop and never persisted.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    agent_id: str = Field(alias="agentId")
    agent_version_id: str | None = Field(default=None, alias="agentVersionId")
    slug: str
    version_number: int = Field(alias="versionNumber")
    task: AgentTask
    #: The tenant that OWNS the resolved row (the caller's, or SYSTEM for a platform default).
    tenant_id: str | None = Field(default=None, alias="tenantId")
    #: How the row was chosen: `explicit` | `department` | `tenant` | `platform-default`.
    source: str | None = None
    instruction: dict[str, Any] | None = None
    resolved_prompt: ResolvedPrompt | None = Field(default=None, alias="resolvedPrompt")
    parameters: dict[str, Any] = Field(default_factory=dict)
    input_schema: dict[str, Any] | None = Field(default=None, alias="inputSchema")
    output_schema: dict[str, Any] | None = Field(default=None, alias="outputSchema")
    model: ResolvedAgentModel
    fallbacks: list[ResolvedAgentModel] = Field(default_factory=list)
    #: TASK-862's credential resolver output for a CLOUD provider — forwarded to ``apps/text``
    #: as ``provider_overrides``; ``None`` for a self-hosted model. Never persisted.
    provider_override: dict[str, Any] | None = Field(default=None, alias="providerOverride")
    funding_tier: str | None = Field(default=None, alias="fundingTier")
    compiled_config: dict[str, Any] | None = Field(default=None, alias="compiledConfig")

    @model_validator(mode="before")
    @classmethod
    def _lift_compiled_config(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        compiled = data.get("compiledConfig")
        if not isinstance(compiled, dict):
            return data
        lifted: dict[str, Any] = dict(data)
        for key in ("instruction", "resolvedPrompt", "parameters", "inputSchema", "outputSchema"):
            if lifted.get(key) is None and compiled.get(key) is not None:
                lifted[key] = compiled[key]

        registry = _registry_models(data)
        if lifted.get("model") is None:
            raw_model = compiled.get("model")
            selection: dict[str, Any] = raw_model if isinstance(raw_model, dict) else {}
            primary = next((m for m in registry if m.get("role") == "primary"), {})
            merged = {**selection, **{k: v for k, v in primary.items() if v is not None}}
            if merged.get("slug"):
                lifted["model"] = merged

        if not lifted.get("fallbacks"):
            selections = compiled.get("fallbacks")
            selected = (
                _by_priority([s for s in selections if isinstance(s, dict)])
                if isinstance(selections, list)
                else []
            )
            rows = _by_priority([m for m in registry if m.get("role") == "fallback"])
            by_slug = {row.get("slug"): row for row in rows}
            if selected:
                lifted["fallbacks"] = [
                    {
                        **s,
                        **{
                            k: v for k, v in by_slug.get(s.get("slug"), {}).items() if v is not None
                        },
                    }
                    for s in selected
                ]
            elif rows:
                lifted["fallbacks"] = rows
        return lifted


class ResolvedClassificationModel(BaseModel):
    """The gateway's answer to the registry-model resolve the ``core.classify`` activity needs:
    the NLP service loads a model by ``sourceUri`` (its ``model_name``) and an optional
    ``localPath`` — both registry facts, gateway-injected, never authored on a node."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    slug: str
    task_type: str = Field(alias="taskType")
    source_uri: str | None = Field(default=None, alias="sourceUri")
    local_path: str | None = Field(default=None, alias="localPath")
    #: F14 — `AiModel._metadata.labelTaxonomy`, resolved by the gateway on the SAME
    #: tenant -> SYSTEM cascade that chose the model. An OPEN-taxonomy extractor
    #: (a `gliner2` checkpoint) has no label set of its own and `apps/nlp` fails
    #: closed without one, so this is what the node sends when the graph names no
    #: labels of its own. Absent for a closed-taxonomy checkpoint, whose labels
    #: are its own — never substituted here.
    label_taxonomy: dict[str, Any] | None = Field(default=None, alias="labelTaxonomy")


class ReviewGateInput(BaseModel):
    """Input for ``ReviewGateWorkflow`` — the generic durable human wait behind
    ``core.humanReview``. Carries the payload under review and the node's own config
    (timeout, escalation); no consultation identity is required."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    node_id: str
    tenant_id: str
    workflow_version_id: str
    review_type: str = "approval"
    instructions: str | None = None
    assign_role: str | None = None
    timeout_seconds: int
    escalation_after_seconds: int | None = None
    max_escalations: int = 0
    allow_edit: bool = False
    payload: dict[str, Any] = Field(default_factory=dict)
    trajectory: TrajectoryContext | None = None


class ReviewDecisionSignal(BaseModel):
    """The ``review`` signal payload. ``decision`` is the ONLY field that can mean approval, and
    it is set from a real signal or not at all — a timeout never approves."""

    model_config = ConfigDict(extra="forbid")

    decision: Literal["approved", "rejected"]
    reviewer_id: str | None = None
    comment: str | None = None
    edited_payload: dict[str, Any] | None = None


class ReviewGateResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: Literal["approved", "rejected", "timedOut"]
    reviewer_id: str | None = None
    comment: str | None = None
    edited_payload: dict[str, Any] | None = None
    escalations: int = 0


class CoreLoopBounds(BaseModel):
    """The four loop bounds, already clamped by the TypeScript compiler."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    max_iterations: int = Field(alias="maxIterations")
    max_duration_seconds: int = Field(alias="maxDurationSeconds")
    max_total_tokens: int = Field(alias="maxTotalTokens")
    no_progress_iterations: int = Field(default=2, alias="noProgressIterations")


class CoreLoopState(BaseModel):
    """Carried across ``continue_as_new`` — the loop's entire memory."""

    model_config = ConfigDict(extra="forbid")

    iterations: int = 0
    tokens_used: int = 0
    no_progress_streak: int = 0
    digest: str = ""
    #: The collected per-iteration results (`collect` path applied), delivered on `done`.
    collected: list[Any] = Field(default_factory=list)
    #: The previous iteration's product — what a `while` loop's body sees on `each`.
    carried: Any = None
    body_failures: int = 0


class CoreLoopInput(BaseModel):
    """``LoopWorkflow``'s input and, via ``continue_as_new``, its own carry-forward."""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    node_id: str
    tenant_id: str
    workflow_version_id: str
    sandbox: bool = False
    mode: Literal["foreach", "while"]
    #: `foreach`: the array to iterate, already read off the run context by the parent.
    items: list[Any] = Field(default_factory=list)
    #: `while`: the CEL expression that ends the loop, re-evaluated after every iteration.
    until: str | None = None
    collect: str | None = None
    bounds: CoreLoopBounds
    #: The compiled BODY (`compiledConfig.loops[].body.stages`), verbatim.
    body: dict[str, Any] = Field(default_factory=dict)
    #: Nested loops' bodies, by loop node id, for a body that contains a loop.
    nested: dict[str, dict[str, Any]] = Field(default_factory=dict)
    #: What the graph bound into the loop node's own `in` port.
    seed_inputs: dict[str, Any] = Field(default_factory=dict)
    run_payload: dict[str, Any] = Field(default_factory=dict)
    #: The run context at loop start (`trigger`, `vars`, outer `nodes`) — the CEL `until` and
    #: template variables inside the body read it.
    run_context: dict[str, Any] = Field(default_factory=dict)
    state: CoreLoopState = Field(default_factory=CoreLoopState)


class CoreLoopResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    stop_reason: LoopStopReason | Literal["items_exhausted", "until"]
    iterations: int
    tokens_used: int
    result: Any = None
    body_failures: int = 0


class EvaluateExpressionInput(BaseModel):
    """``interpreter.core_evaluate`` — evaluate ONE CEL condition against a run context."""

    model_config = ConfigDict(extra="forbid")

    expression: str
    context: dict[str, Any] = Field(default_factory=dict)


class EvaluateExpressionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    taken: bool
    error: str | None = None


# ---------------------------------------------------------------------------
# TASK-932 R-16a — the LIVE HANDOFF.
# ---------------------------------------------------------------------------


class LiveOutputsRequest(BaseModel):
    """``interpreter.load_live_outputs`` — ask the gateway for the LIVE lane's final outputs.

    The durable interpreter SKIPS every ``realtime`` node of a consultation-bound run
    (``_has_live_owner``), so the outputs those nodes produced live in the gateway's live
    session, not in this workflow's own cache. A durable consumer of one of them
    (``n_finalize``, ``execution: {lane: durable, cadence: onEnd}``) therefore resolved
    ``bound_inputs: {}`` and degraded ``no_bound_text`` on EVERY consultation. This request is
    the handoff that closes it.

    ``node_ids`` is what the walk actually skipped, so the gateway answers about the nodes this
    run has, never about a lane it has to guess at.
    """

    model_config = ConfigDict(extra="forbid")

    run_id: str
    tenant_id: str
    consultation_id: str
    node_ids: list[str] = Field(default_factory=list)


class LiveOutputsResult(BaseModel):
    """The gateway's answer to :class:`LiveOutputsRequest`.

    ``ended`` is the ONLY thing the poll loop waits on: ``False`` means the live session has not
    handed off yet (the clinician is still recording, or has not started), ``True`` means the
    live lane is finished and ``outputs`` is everything it produced — possibly nothing, for a
    consultation that never recorded, which keeps the pre-existing ``no_bound_text`` degrade
    exactly as it was.

    ``outputs`` is keyed by NODE ID and each value is that node's own output dict in the same
    shape the durable lane would have stored (``core.agent`` → ``{"text": …}`` and friends), so
    ``_resolve_bound_inputs`` reads it through the declared socket table with no special case.

    ``context`` is overlaid onto the run's ``trigger`` context for prompt rendering only — it
    carries the clinician's effective DNA writing style (``dna_style_text`` / ``dna_style_id``),
    which is resolved gateway-side at read time and never travels in the run payload a caller
    composed.
    """

    # `ignore`, not `forbid`: the gateway may add descriptive fields (it already sends
    # `endedAt`), and a rejected answer is indistinguishable from "not ended yet" to the
    # poll loop — an extra field must never park a clinical run for the whole handoff window
    # (reproduced live 2026-09-09: every poll logged `live_handoff_malformed … endedAt`).
    model_config = ConfigDict(extra="ignore")

    ended: bool = False
    ended_at: str | None = Field(default=None, alias="endedAt")
    outputs: dict[str, dict[str, Any]] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
