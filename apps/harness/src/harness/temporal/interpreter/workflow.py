"""The WorkflowInterpreter workflow (Task 6).

Deterministic, platform-owned. Walks a published WorkflowDefinition version's compiledConfig
(dereferenced via claim-check, S-2) stage by stage, dispatching each node to a code-owned,
registry-sanctioned activity (S-4). See
for the full
contract this file implements.

Determinism checklist (enforced by review, not by a linter): no ``datetime.now``, no ``random``,
no ``uuid4``, no ``os.environ``, no ``httpx``, no DB, no file I/O in this module. Every side
effect goes through ``workflow.execute_activity``.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Literal

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter import caps
    from harness.temporal.interpreter.activities import emit_run_events, load_config
    from harness.temporal.interpreter.compiled_config import (
        CompiledGate,
        CompiledNode,
        CompiledStage,
    )
    from harness.temporal.interpreter.core_loop_workflow import (
        LoopWorkflow,
        core_loop_workflow_id,
    )
    from harness.temporal.interpreter.gate_workflow import (
        ConsultationGateWorkflow,
        gate_workflow_id,
    )
    from harness.temporal.interpreter.models import (
        CancelSignal,
        ConsultationGateInput,
        ConsultationGateResult,
        CoreLoopBounds,
        CoreLoopInput,
        CoreLoopResult,
        InterpreterInput,
        InterpreterResult,
        InterpreterStateQueryResult,
        NodeActivityInput,
        NodeActivityResult,
        NodeResult,
        NodeStatus,
        ReviewGateInput,
        ReviewGateResult,
        RunEventBatch,
        RunEventSpec,
        RunStatus,
        StageResult,
    )
    from harness.temporal.interpreter.nodes._shared import MISSING, resolve_dotted_path
    from harness.temporal.interpreter.registry import (
        CORE_LOOP_NODE_TYPE,
        CORE_REVIEW_NODE_TYPE,
        NODE_REGISTRY,
        effective_spec,
        output_keys_for,
    )
    from harness.temporal.interpreter.review_workflow import (
        ReviewGateWorkflow,
        review_gate_workflow_id,
    )
    from harness.temporal.interpreter.run_events import (
        EVENT_NODE_COMPLETED,
        EVENT_NODE_FAILED,
        EVENT_NODE_STARTED,
        EVENT_RUN_COMPLETED,
    )
    from harness.temporal.models import TrajectoryContext

_CONFIG_LOAD_TIMEOUT = timedelta(seconds=30)
_CONFIG_LOAD_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))

# Stride between per-node trajectory-seq bases — same idiom as `workflows.py`'s
# `_SEQ_STRIDE`: a workflow-owned monotonic counter stands in for a clock/UUID
# (determinism). A `core.agent` node emits TWO steps (the NODE step plus the LLM_CALL step the
# usage ledger bills from — F14, `nodes/_shared.record_generation_and_flush`); the stride is the
# headroom that keeps every node's steps inside its own base without claiming a
# wall-clock-derived value.
_SEQ_STRIDE = 4

# Deterministic, idempotent-on-start workflow id — mirrors
# `consultation_loop_workflow_id` (workflows.py:1623-1625).
INTERPRETER_WORKFLOW_ID_PREFIX = "workflow-interpreter-"

# The patch marker for the HITL-gate command. Required by
# contracts/versioning.md rule 3: executing a gate adds a NEW command to the workflow body, which
# would change the command sequence for every replaying history if shipped ungated. The gate is
# guarded cheap-operand-first (`config.gates and workflow.patched(...)`), and the cheap operand is
# PROVABLY False on every pre-existing history: until this change, `parse_and_verify` refused any
# config whose `gates` was not `[]` (`gates_not_supported_v1`), so no admitted run can ever have
# carried one. `workflow.patched` is therefore never even called when replaying an old history —
# exactly what the idiom is for.
_GATE_PATCH = "task-731-hitl-gate"

# The patch marker for the run-event MIRROR. Third gate, same rule as the two
# above: `interpreter.emit_run_events` is a NEW `execute_activity` call in the shared per-stage
# path, so every history recorded before this change must keep replaying without it.
#
# Unlike the gate's, this one's cheap operand cannot be proven False from the config — the emit
# happens on EVERY stage boundary of EVERY graph. `workflow.patched` is therefore the only thing
# standing between this change and a non-determinism error on every in-flight clinical run, which
# is exactly the situation the idiom exists for. Recapture the replay fixture alongside it
# (`_capture_interpreter_replay_fixture.py`), per contracts/versioning.md rule 3.
_STREAM_PATCH = "task-849-run-event-stream"

# The emit is a MIRROR of state Temporal already holds, so it gets the cheapest possible
# envelope: one attempt, a short deadline, and a caller that swallows the failure. Retrying an
# observability write would spend a clinical run's latency budget re-sending a token nobody is
# waiting on any more.
_EMIT_TIMEOUT = timedelta(seconds=10)
_EMIT_RETRY = RetryPolicy(maximum_attempts=1)

# TASK-864 — the `core` vocabulary's patch marker. FOURTH gate, same rule: dispatching a
# `core.humanReview` as a `ReviewGateWorkflow` child and a `core.loop` as a `LoopWorkflow` child
# are NEW commands. The cheap operand (the node's TYPE) is provably False on every pre-existing
# history — no history recorded before this ticket carries a `core.*` node, because the types did
# not exist — so `workflow.patched` is consulted only for a graph that actually uses them. The
# branch gating and the run context add NO command (a skip removes one only on graphs that carry
# `branchGuards`, which likewise predate nothing), so they need no marker.
_CORE_PATCH = "task-864-core-vocabulary"

# The parent-owned duration bound's own reason. It is NOT a `LoopStopReason`, because the loop
# child never produces it: the child is cancelled by the parent's timer and never gets to say
# why. Spelled identically to the contract's own field name so an operator reading a trajectory
# sees the same word the graph author wrote.
_LOOP_DURATION_REASON = "max_duration_seconds"


def interpreter_workflow_id(run_id: str) -> str:
    """The deterministic interpreter workflow id for a run (pure)."""
    return f"{INTERPRETER_WORKFLOW_ID_PREFIX}{run_id}"


def _opt_str(value: Any) -> str | None:
    """A non-empty string, or None. Pure."""
    return value if isinstance(value, str) and value else None


def _configured_realtime(node: CompiledNode) -> bool:
    """TASK-864 — lane is per INSTANCE on `core.agent`/`core.action` (`execution.lane`), no
    longer only per type. Pure read of the compiled config."""
    if node.type not in ("core.agent", "core.action"):
        return False
    execution = node.config.get("execution")
    return isinstance(execution, dict) and execution.get("lane") == "realtime"


#: Ceiling for a formatted activity-error reason. Long enough for a provider's own message,
#: short enough that a reason line stays a line — a node result is a REPORT, not a log sink.
_ACTIVITY_REASON_MAX_CHARS = 320


def _activity_error_reason(error: BaseException) -> str:
    """``activity_error[: <Type>[: <message>]]`` — the cause of an ``ActivityError``, bounded.

    PURE, and deliberately so: this runs inside the workflow body, where the same failure must
    format to the same string on the original run and on every replay. It reads only what the
    failure converter already put on the exception — no clock, no environment, no payloads (an
    activity's arguments never reach here, so nothing carrying PHI or a credential can).

    A typed ``ApplicationError`` names the activity's own exception class (``TextServiceError``,
    ``ApiServiceError``, …); a ``TimeoutError`` names WHICH timeout fired. Anything else falls
    back to the cause's class name.
    """
    cause = error.__cause__
    if cause is None:
        return "activity_error"

    declared = getattr(cause, "type", None)
    if isinstance(declared, str) and declared:
        kind = declared
    else:
        kind = type(cause).__name__
        variant = getattr(declared, "name", None)
        if isinstance(variant, str) and variant:
            kind = f"{kind}({variant})"

    raw = getattr(cause, "message", None)
    message = " ".join(str(raw if isinstance(raw, str) else cause).split())
    if not message:
        return f"activity_error: {kind}"
    reason = f"activity_error: {kind}: {message}"
    if len(reason) <= _ACTIVITY_REASON_MAX_CHARS:
        return reason
    return reason[: _ACTIVITY_REASON_MAX_CHARS - 3] + "..."


@workflow.defn(name="WorkflowInterpreter")
class WorkflowInterpreter:
    """Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)."""

    def __init__(self) -> None:
        self._run_id = ""
        self._status: RunStatus | Literal["RUNNING"] = "RUNNING"
        self._stages: list[StageResult] = []
        self._cancelled = False
        self._cancel_reason: str | None = None
        self._seq = 0
        # Workflow-owned cache of completed nodes' own `NodeActivityResult.output`, keyed by
        # `node_id` — see `NodeActivityInput.bound_inputs`'s docstring for the
        # full rationale). Pure Python dict state built from already-deterministic activity
        # results — no wall-clock/random/I/O — so it is replay-safe exactly like `self._stages`.
        # A node in stage N can only bind from a node in stage < N (the compiler's topological
        # stage partitioning already guarantees this), so same-stage fan-out nodes never race
        # each other reading/writing this cache.
        self._node_outputs: dict[str, dict[str, Any]] = {}
        # `node_id -> CompiledNode`, so a node referenced by id (an edge's producer) is
        # resolvable without a second traversal. Indexed once in `run`, alongside `_node_types`.
        self._nodes_by_id: dict[str, CompiledNode] = {}
        # `node_id -> node type`, built from the compiled config before the walk starts.
        # `_resolve_bound_inputs` needs the PRODUCER's type to look its declared output sockets up
        # in `NODE_REGISTRY`; `_node_outputs` alone is keyed by id and says
        # nothing about which node type produced the dict. Pure derived state, so it is replay-safe
        # for the same reason `_stages` is.
        self._node_types: dict[str, str] = {}
        # TASK-864 — the BRANCH handles each router/review node took, and the nodes skipped
        # because no guard of theirs fired (so their own successors are skipped too). Pure
        # derived state built from activity results, replay-safe like `_node_outputs`.
        self._taken_handles: dict[str, set[str]] = {}
        self._branch_skipped: set[str] = set()
        # TASK-864 — `compiledConfig.loops[]` by loop node id: the compiled BODY each
        # `core.loop` hands to its `LoopWorkflow` child.
        self._loops_by_id: dict[str, dict[str, Any]] = {}

    def _next_seq(self) -> int:
        """Allocate the next monotonic trajectory-seq BASE (strided; deterministic)."""
        seq = self._seq
        self._seq += _SEQ_STRIDE
        return seq

    @workflow.run
    async def run(self, inp: InterpreterInput) -> InterpreterResult:
        self._run_id = inp.run_id

        config = await workflow.execute_activity(
            load_config,
            inp.config_ref,
            start_to_close_timeout=_CONFIG_LOAD_TIMEOUT,
            retry_policy=_CONFIG_LOAD_RETRY,
        )

        # Index every node's TYPE before the walk. Gates are included: the compiler lifts them out
        # of `stages` into `gates`, so a graph that names one as an edge source would otherwise
        # look like an unregistered producer.
        for indexed_stage in config.stages:
            for indexed_node in indexed_stage.nodes:
                self._node_types[indexed_node.node_id] = indexed_node.type
                # A loop's body nodes are named by id, so the index IS the resolution:
                # no second traversal, and no chance of the two disagreeing.
                self._nodes_by_id[indexed_node.node_id] = indexed_node
        for indexed_gate in config.gates:
            self._node_types.setdefault(indexed_gate.node_id, "consultation.hitlGate")
        for indexed_loop in config.loops:
            self._loops_by_id[indexed_loop.node_id] = indexed_loop.body.model_dump(by_alias=True)

        run_failed = False
        run_degraded = False

        for stage in config.stages:
            if self._cancelled:
                break
            await self._emit_stage_started(stage, inp)
            node_results = await self._run_stage(stage, inp)
            self._stages.append(StageResult(stage_index=stage.stage_index, nodes=node_results))
            await self._emit_stage_settled(stage, node_results, inp)
            for node_result in node_results:
                if node_result.status == "FAILED":
                    run_failed = True
                elif node_result.status in ("DEGRADED", "SKIPPED"):
                    run_degraded = True
            if run_failed:
                # The current stage is already fully settled (all-settled join,; no
                # further stage is started once a critical node has failed.
                break

        # 2) The HITL gate. The compiler LIFTS every `gate`-classed node out
        # of `stages` into `gates` (compiler.ts:204-210), so a gate never reaches `_run_stage` —
        # it runs here, after the walk, which is also what the graph means: `WF-CONS-004` makes
        # the gate terminal for everything except the palette-agnostic `core.end` marker.
        # Skipped when a critical node already failed: there is nothing to sign off.
        if config.gates and workflow.patched(_GATE_PATCH):
            gate_result = await self._run_gate(config.gates[0], inp, blocked=run_failed)
            self._stages.append(StageResult(stage_index=len(self._stages), nodes=[gate_result]))
            if gate_result.status == "FAILED":
                run_failed = True
            elif gate_result.status in ("DEGRADED", "SKIPPED"):
                run_degraded = True

        status: RunStatus
        if self._cancelled:
            status = "CANCELLED"
        elif run_failed:
            status = "FAILED"
        elif run_degraded:
            status = "DEGRADED"
        else:
            status = "SUCCEEDED"
        self._status = status

        await self._emit_run_completed(inp, status)

        return InterpreterResult(run_id=inp.run_id, status=status, stages=self._stages)

    # Run-event mirror
    #
    # The CONTROL lane. Node/stage/run outcomes are already durable in Temporal history and
    # readable through the `state` query; these three helpers MIRROR them onto the run's Redis
    # Stream so the gateway can PUSH instead of poll. Token deltas never come through here —
    # they go straight from the producing activity to Redis, which is the whole two-lane split
    # (program rule 17: signals land in history, ceiling 51,200 events / 50 MB per run).

    async def _emit_run_events(self, inp: InterpreterInput, events: list[RunEventSpec]) -> None:
        """Fire one emit activity, or do nothing. Never fails the run.

        `workflow.patched` is consulted only when there is something to emit, so an empty
        stage cannot record a marker a replaying history would not have.
        """
        if not events or not workflow.patched(_STREAM_PATCH):
            return
        try:
            await workflow.execute_activity(
                emit_run_events,
                RunEventBatch(run_id=inp.run_id, tenant_id=inp.tenant_id, events=events),
                start_to_close_timeout=_EMIT_TIMEOUT,
                retry_policy=_EMIT_RETRY,
            )
        except ActivityError:
            # The mirror is unreachable. The run's record is Temporal's and is unaffected; a
            # connected client falls back to its snapshot. Failing a clinical run because an
            # observability write timed out would invert which lane matters.
            return

    async def _emit_stage_started(self, stage: CompiledStage, inp: InterpreterInput) -> None:
        """`workflow.node.started`, for the nodes this walk will ACTUALLY dispatch.

        `_preflight_skip` is the same predicate `_dispatch_node` uses — one spelling, so a node
        can never be announced as started and then reported SKIPPED for a reason the walk
        already knew before it began.
        """
        await self._emit_run_events(
            inp,
            [
                RunEventSpec(
                    event_type=EVENT_NODE_STARTED,
                    node_id=node.node_id,
                    node_type=node.type,
                    stage_index=stage.stage_index,
                )
                for node in stage.nodes
                if self._preflight_skip(node, inp) is None
            ],
        )

    async def _emit_stage_settled(
        self, stage: CompiledStage, node_results: list[NodeResult], inp: InterpreterInput
    ) -> None:
        """One settle event per node, carrying the status the all-settled join produced."""
        await self._emit_run_events(
            inp,
            [
                RunEventSpec(
                    event_type=(
                        EVENT_NODE_FAILED if result.status == "FAILED" else EVENT_NODE_COMPLETED
                    ),
                    node_id=result.node_id,
                    node_type=result.node_type,
                    stage_index=stage.stage_index,
                    status=result.status,
                    reason=result.reason,
                )
                for result in node_results
            ],
        )

    async def _emit_run_completed(self, inp: InterpreterInput, status: str) -> None:
        """The terminal event. This is what lets a connected client close its stream on a
        PUSH rather than by noticing, one poll later, that the status stopped changing."""
        await self._emit_run_events(
            inp, [RunEventSpec(event_type=EVENT_RUN_COMPLETED, status=status)]
        )

    async def _run_stage(self, stage: CompiledStage, inp: InterpreterInput) -> list[NodeResult]:
        """All-settled join: every node's own coroutine catches its own ACTIVITY exceptions
        (so plain asyncio.gather (no return_exceptions) is sufficient for the
        outcomes defines.

        ONE thing does deliberately escape : _resolve_bound_inputs raises a
        non-retryable ``ApplicationError`` when a graph binds a socket the producing node type does
        not declare. That is a CONTRACT violation rather than a node outcome — there is no honest
        value to thread and no retry that would change it — so it fails the run loudly instead of
        being flattened into a per-node ``DEGRADED``."""
        return list(
            await asyncio.gather(
                *(self._dispatch_node(node, inp, stage.stage_index) for node in stage.nodes)
            )
        )

    def _resolve_bound_inputs(self, node: CompiledNode) -> dict[str, Any]:
        """Thread completed predecessors' outputs into this node's input, via `node.inputs`
        (the compiler-derived edge bindings) — see `NodeActivityInput.bound_inputs`'s docstring
        for the full design rationale. Keyed by `toPort`; a later binding with the same `toPort`
        overwrites an earlier one (last-write-wins — v1 does not detect/reject the collision, the
        same "no dynamic sub-graph, wire it and see" posture as everything else here).

        ## The socket -> output-key resolution (option A)

        An edge's ``fromPort`` is an AUTHORING handle — ``out``, ``entities``, ``contextItemId`` —
        and NOT a key in the producing activity's output dict. No activity in this platform emits
        a key called ``"out"``, so until OD-15 the real code path here was the whole-object
        fallback: hand the downstream node the ENTIRE predecessor output. That is the untyped
        bundle the port vocabulary exists to abolish, and it is why a node had to grope around
        inside its bound inputs looking for the key it wanted.

        Each socket now declares the key it carries (``NodeSpec.output_keys``, mirrored from the
        TypeScript port table through the committed parity fixture), which gives three outcomes,
        deliberately distinct:

        * **``None`` — a `control` socket.** Ordering, no payload. Binds nothing.
        * **a key that is absent from THIS run's output.** A runtime data condition (a DEGRADED
          predecessor stores no output at all; ``consultation.captureBinding`` declares a
          transcript socket its activity does not populate yet). Contributes nothing — never a
          ``KeyError``, and never a fabricated value, exactly as before.
        * **a port the producer does not declare at all.** A CONTRACT violation: the graph names
          a socket that does not exist, and no honest value can be threaded for it. Raises,
          naming the node and the port, instead of quietly substituting something.
        """
        bound: dict[str, Any] = {}
        for binding in node.inputs:
            upstream_type = self._node_types.get(binding.from_node_id)
            upstream_node = self._nodes_by_id.get(binding.from_node_id)
            # TASK-864: a `core.action` publishes its DELEGATE's sockets, so the keys are resolved
            # per instance (`output_keys_for`), not per type. Every other type is unchanged.
            output_keys = (
                output_keys_for(upstream_type, upstream_node.config if upstream_node else None)
                if upstream_type is not None
                else None
            )
            if output_keys is None or binding.from_port not in output_keys:
                raise ApplicationError(
                    f"unresolved input binding: node {node.node_id!r} ({node.type}) binds "
                    f"{binding.to_port!r} from {binding.from_node_id!r} "
                    f"({upstream_type or 'unknown node type'}) port {binding.from_port!r}, "
                    "which is not a declared output socket of that node type",
                    type="unresolved_input_binding",
                    non_retryable=True,
                )
            output_key = output_keys[binding.from_port]
            if output_key is None:
                # An ORDERING edge. The stage partitioning already carries the dependency.
                continue
            upstream_output = self._node_outputs.get(binding.from_node_id)
            if upstream_output is None or output_key not in upstream_output:
                continue
            bound[binding.to_port] = upstream_output[output_key]
        return bound

    def _preflight_skip(self, node: CompiledNode, inp: InterpreterInput) -> NodeResult | None:
        """Every reason this walk declines a node BEFORE dispatching anything (pure).

        Extracted from `_dispatch_node` so the run-event producer can ask "will
        this node actually run?" without a second spelling of the answer — two spellings is
        exactly how the walk and the mirror drift. `None` means "dispatch it"; the returned
        `NodeResult` IS the outcome, so `_dispatch_node` returns it unchanged.

        The ORDER of these is load-bearing and unchanged; each comment explains its own
        position.
        """
        # TASK-864: a `core.action`'s SAFETY properties are its delegate's (`effective_spec`);
        # every other type resolves to its own spec exactly as before.
        spec = effective_spec(node.type, node.config)
        if spec is None or not spec.implemented:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="unsupported_node_type",
            )

        # lane A — LANE OWNERSHIP. A `realtime` node belongs to
        # live executor, not to this durable interpreter, and exactly one runtime must execute
        # any given node: `consultation.realtimeSummary` is `external_write`, so both running it
        # means two engines writing one consultation's document.
        #
        # This loses nothing that was working. In THIS lane `consultation.captureBinding` emits no
        # transcript, so `consultation.extractEntities` and `consultation.realtimeSummary` already
        # degraded on `no_bound_text` every run. The skip turns a silent degrade into an
        # OBSERVABLE one that names the runtime which owns the work — the same discipline as
        # `unsupported_node_type` above, and never a silent no-op.
        if spec.lane == "realtime" or _configured_realtime(node):
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="realtime_lane",
            )

        # TASK-864 — BRANCH GATING. A node behind a router/review handle runs only when one of
        # its guards was TAKEN; a node whose every predecessor was skipped that way is skipped
        # too, so an untaken branch's whole tail is skipped, not just its first node. A join
        # (the Output fed by both branches) runs as long as ONE predecessor ran. Pure: every
        # input is a recorded activity result. Legacy configs carry no guards, so nothing here
        # changes their command sequence.
        if self._branch_skip(node):
            self._branch_skipped.add(node.node_id)
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="branch_not_taken",
            )

        # item 4 — the per-node KILL SWITCH, honoured by BOTH runtimes.
        #
        # realtime executor has read this key since it shipped (`realtime-lane.ts`:
        # `enabled: node.config?.enabled !== false`); this interpreter never did. A toggle one
        # runtime honours and the other ignores is worse than no toggle: an admin switches a node
        # off, watches the live lane stop running it, and the durable lane keeps executing it on
        # every finalize — including the `external_write` nodes.
        #
        # AFTER the lane check on purpose. Lane ownership decides WHICH runtime speaks for a node
        # at all, so a disabled `realtime` node is still reported as `realtime_lane` here and as
        # disabled by the runtime that actually owns it. Reporting it twice, under two different
        # reasons, is the ambiguity `lane` was made load-bearing to remove.
        #
        # The literal `is False`, never a truthiness test: absent must mean ENABLED (every graph
        # published before this ticket carries no `enabled` key), and the schema types it as a
        # boolean, so a non-boolean is MALFORMED rather than "off" — silently disabling a node
        # because its config carried the string "false" is the failure mode this avoids.
        #
        # A pure read of an already-deserialised `CompiledNode`: no I/O, no clock, no env, no
        # `workflow.*` call — replay-safe exactly like the two skips around it.
        if node.config.get("enabled") is False:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="disabled_by_config",
            )

        # S-4: the callable that gets invoked always comes from the registry; the wire's
        # `activity` string is only a consistency check, never trusted for routing.
        if node.activity != spec.activity_name:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="activity_mismatch",
            )

        if inp.sandbox and spec.external_write:
            return NodeResult(
                node_id=node.node_id, node_type=node.type, status="SKIPPED", reason="sandbox"
            )

        return None

    async def _dispatch_node(
        self, node: CompiledNode, inp: InterpreterInput, stage_index: int
    ) -> NodeResult:
        skipped = self._preflight_skip(node, inp)
        if skipped is not None:
            return skipped

        # Present after `_preflight_skip` by construction — an unregistered/unimplemented type
        # is its first refusal, so reaching here means the registry has a real spec.
        spec = effective_spec(node.type, node.config) or NODE_REGISTRY[node.type]

        # TASK-864 — the two `core` constructs that run as CHILD WORKFLOWS. Cheap operand (the
        # node type) first, exactly as the loop gate below: `workflow.patched` is consulted only
        # for a graph that actually carries one, and no pre-existing history can.
        if node.type == CORE_REVIEW_NODE_TYPE and workflow.patched(_CORE_PATCH):
            return await self._run_review(node, inp)
        if node.type == CORE_LOOP_NODE_TYPE and workflow.patched(_CORE_PATCH):
            return await self._run_core_loop(node, inp)

        timeout_seconds = caps.clamp_timeout(node.timeout_seconds)
        max_attempts = caps.clamp_attempts(node.retry.maximum_attempts)
        trajectory = TrajectoryContext(
            tenant_id=inp.tenant_id,
            seq=self._next_seq(),
            workflow_version_id=inp.workflow_version_id,
            stage_id=str(stage_index),
            node_id=node.node_id,
            node_type=node.type,
        )
        activity_input = NodeActivityInput(
            node_id=node.node_id,
            node_type=node.type,
            config=node.config,
            tenant_id=inp.tenant_id,
            sandbox=inp.sandbox,
            trajectory=trajectory,
            bound_inputs=self._resolve_bound_inputs(node),
            run_payload=inp.payload,
            run_id=inp.run_id,
            # TASK-864 — the run context, for `core.*` nodes only: a legacy node's payload stays
            # byte-identical to every run before this ticket.
            run_context=self._run_context() if node.type.startswith("core.") else {},
        )

        try:
            result: NodeActivityResult = await workflow.execute_activity(
                spec.activity,
                activity_input,
                start_to_close_timeout=timedelta(seconds=timeout_seconds),
                retry_policy=RetryPolicy(maximum_attempts=max_attempts),
            )
        except ActivityError as exc:
            # Timeout OR an application-raised exception both surface here identically
            # (contracts/ example) — so the CAUSE is the only thing that says which, and it
            # travels onto the reason rather than being discarded (F13).
            degraded_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status=degraded_status,
                reason=_activity_error_reason(exc),
            )

        if result.status == "SUCCEEDED":
            if result.output is not None:
                self._node_outputs[node.node_id] = result.output
            if result.taken_handle is not None:
                self._taken_handles[node.node_id] = {result.taken_handle}
            return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")
        if result.status == "DEGRADED":
            promoted_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status=promoted_status,
                reason=result.reason or "activity_error",
            )
        # result.status == "SKIPPED" (the activity itself declined, e.g. a future
        # activity-internal sandbox check) — never critical-promoted; a skip is not a failure.
        return NodeResult(
            node_id=node.node_id, node_type=node.type, status="SKIPPED", reason=result.reason
        )

    # TASK-864 — the `core` vocabulary's helpers. All pure except the two child dispatches.

    def _branch_skip(self, node: CompiledNode) -> bool:
        """Whether branch gating declines this node (pure). See `_preflight_skip`."""
        if node.branch_guards and not any(
            guard.handle in self._taken_handles.get(guard.from_node_id, set())
            for guard in node.branch_guards
        ):
            return True
        predecessors = {binding.from_node_id for binding in node.inputs} | {
            guard.from_node_id for guard in node.branch_guards
        }
        return bool(predecessors) and predecessors <= self._branch_skipped

    def _run_context(self) -> dict[str, Any]:
        """The run context `{trigger, vars, nodes}` (TASK-864 §3.2), from the output cache.

        `trigger` is the `core.trigger` node's published context; `vars` is every
        `core.variable` node's declared map, merged in stage order; `nodes` is the whole cache
        keyed by node id. Pure derived state.
        """
        trigger: dict[str, Any] = {}
        variables: dict[str, Any] = {}
        for node_id, output in self._node_outputs.items():
            node_type = self._node_types.get(node_id)
            if node_type == "core.trigger" and isinstance(output.get("context"), dict):
                trigger = output["context"]
            elif node_type == "core.variable" and isinstance(output.get("vars"), dict):
                variables.update(output["vars"])
        return {"trigger": trigger, "vars": variables, "nodes": dict(self._node_outputs)}

    async def _run_review(self, node: CompiledNode, inp: InterpreterInput) -> NodeResult:
        """Dispatch a `core.humanReview` as a `ReviewGateWorkflow` child and TAKE its outcome
        as a branch. `approved` and `rejected` are both decisions the graph routes (SUCCEEDED);
        `timedOut` is the absence of one (DEGRADED, reason `review_timed_out`) — never approval."""
        config = node.config
        raw_escalation = config.get("escalation")
        escalation: dict[str, Any] = raw_escalation if isinstance(raw_escalation, dict) else {}
        review_input = ReviewGateInput(
            run_id=inp.run_id,
            node_id=node.node_id,
            tenant_id=inp.tenant_id,
            workflow_version_id=inp.workflow_version_id,
            review_type=str(config.get("reviewType") or "approval"),
            instructions=(
                config.get("instructions") if isinstance(config.get("instructions"), str) else None
            ),
            assign_role=(
                config.get("assignRole") if isinstance(config.get("assignRole"), str) else None
            ),
            timeout_seconds=int(config.get("timeoutSeconds") or node.timeout_seconds),
            escalation_after_seconds=(
                int(escalation["afterSeconds"])
                if isinstance(escalation.get("afterSeconds"), int)
                else None
            ),
            max_escalations=(
                int(escalation["maxEscalations"])
                if isinstance(escalation.get("maxEscalations"), int)
                else 0
            ),
            allow_edit=config.get("allowEdit") is True,
            payload=self._resolve_bound_inputs(node),
            trajectory=TrajectoryContext(
                tenant_id=inp.tenant_id,
                seq=self._next_seq(),
                workflow_version_id=inp.workflow_version_id,
                stage_id="review",
                node_id=node.node_id,
                node_type=node.type,
            ),
        )
        try:
            result: ReviewGateResult = await workflow.execute_child_workflow(
                ReviewGateWorkflow.run,
                review_input,
                id=review_gate_workflow_id(inp.run_id, node.node_id),
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="review_unavailable",
            )

        self._node_outputs[node.node_id] = {"decision": result.model_dump()}
        self._taken_handles[node.node_id] = {result.outcome}
        if result.outcome == "timedOut":
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="review_timed_out",
            )
        return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")

    async def _run_core_loop(self, node: CompiledNode, inp: InterpreterInput) -> NodeResult:
        """Dispatch a `core.loop` as a `LoopWorkflow` child over its compiled body, racing it
        against the parent-owned `maxDurationSeconds` timer (the one bound a continue-as-new
        chain cannot carry itself — see `loop_workflow.py`)."""
        body = self._loops_by_id.get(node.node_id)
        if body is None:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="loop_body_missing",
            )
        config = node.config
        mode = config.get("mode")
        run_context = self._run_context()
        items: list[Any] = []
        if mode == "foreach":
            over = config.get("over")
            resolved = resolve_dotted_path(run_context, over) if isinstance(over, str) else MISSING
            if not isinstance(resolved, list):
                return NodeResult(
                    node_id=node.node_id,
                    node_type=node.type,
                    status="DEGRADED",
                    reason="loop_over_unresolvable",
                )
            items = resolved

        loop_input = CoreLoopInput(
            run_id=inp.run_id,
            node_id=node.node_id,
            tenant_id=inp.tenant_id,
            workflow_version_id=inp.workflow_version_id,
            sandbox=inp.sandbox,
            mode="foreach" if mode == "foreach" else "while",
            items=items,
            until=config.get("until") if isinstance(config.get("until"), str) else None,
            collect=config.get("collect") if isinstance(config.get("collect"), str) else None,
            bounds=CoreLoopBounds.model_validate(config.get("bounds") or {}),
            body=body,
            nested=dict(self._loops_by_id),
            seed_inputs=self._resolve_bound_inputs(node),
            run_payload=inp.payload,
            run_context=run_context,
        )
        max_duration = int(loop_input.bounds.max_duration_seconds)
        try:
            result: CoreLoopResult = await asyncio.wait_for(
                workflow.execute_child_workflow(
                    LoopWorkflow.run,
                    loop_input,
                    id=core_loop_workflow_id(inp.run_id, node.node_id),
                ),
                timeout=max_duration,
            )
        except TimeoutError:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason=_LOOP_DURATION_REASON,
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="loop_unavailable",
            )

        self._node_outputs[node.node_id] = {
            "result": result.result,
            "iterations": result.iterations,
            "stopReason": result.stop_reason,
        }
        if result.stop_reason in ("items_exhausted", "until", "no_progress_iterations"):
            return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")
        return NodeResult(
            node_id=node.node_id,
            node_type=node.type,
            status="DEGRADED",
            reason=result.stop_reason,
        )

    async def _run_gate(
        self, gate: CompiledGate, inp: InterpreterInput, *, blocked: bool
    ) -> NodeResult:
        """Execute the one blocking HITL gate as a CHILD workflow.

        A child rather than an in-line `wait_condition` is what keeps the interpreter's own
        signal surface `cancel`-only for every palette — see
        `gate_workflow.py`'s module docstring for why this is a new workflow type rather than the
        `HarnessDocWorkflow` delegation `palette-contract.md` originally chose.

        Three refusals, all of them loud and none of them a wait:

        * **Sandbox.** A Workbench run must never park on a human. The gate node is
          `external_write: true`, but the stage-level sandbox suppression cannot reach it (the
          gate is not in `stages`), so the check is repeated here — this is the one place it can
          be made.
        * **A failed critical node upstream.** There is no draft to sign off; asking a clinician
          to approve a run that already failed would be asking them to attest to nothing.
        * **A missing consultation id.** The gate's whole side effect (escalations, the WORM
          `GATE_DECISION`) is consultation-scoped; without one there is nothing to record
          against, and inventing a target would put a decision on the wrong record.
        """
        spec = NODE_REGISTRY.get(gate.gate_type)
        node_type = gate.gate_type

        if spec is None or not spec.implemented:
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="SKIPPED",
                reason="unsupported_node_type",
            )

        if inp.sandbox:
            return NodeResult(
                node_id=gate.node_id, node_type=node_type, status="SKIPPED", reason="sandbox"
            )

        if blocked:
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="SKIPPED",
                reason="upstream_failed",
            )

        consultation_id = inp.payload.get("consultationId")
        if not isinstance(consultation_id, str) or not consultation_id:
            # `critical: true` on the gate node makes this a run-level FAILED, which is correct:
            # a consultation graph that reached its gate with no consultation to gate is not a
            # run that succeeded.
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="FAILED",
                reason="no_consultation_id",
            )

        gate_input = ConsultationGateInput(
            run_id=inp.run_id,
            node_id=gate.node_id,
            tenant_id=inp.tenant_id,
            consultation_id=consultation_id,
            user_id=_opt_str(inp.payload.get("userId")),
            job_id=_opt_str(inp.payload.get("jobId")),
            context_item_id=_opt_str(self._gate_context_item_id()),
            gate_type=node_type,
            timeout_seconds=gate.timeout_seconds,
            on_timeout=gate.on_timeout,
            trajectory=TrajectoryContext(
                tenant_id=inp.tenant_id,
                seq=self._next_seq(),
                workflow_version_id=inp.workflow_version_id,
                stage_id="gate",
                node_id=gate.node_id,
                node_type=node_type,
            ),
        )

        try:
            result: ConsultationGateResult = await workflow.execute_child_workflow(
                ConsultationGateWorkflow.run,
                gate_input,
                # Deterministic, derived from the parent's run id — never `uuid4()` inside a
                # workflow body. Same task queue by inheritance (worker.py hosts both types).
                id=gate_workflow_id(inp.run_id),
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            # A gate that could not run is NOT an approval. `critical: true` promotes this to a
            # run-level FAILED, which is the only safe reading.
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="FAILED",
                reason="gate_unavailable",
            )

        if result.approved:
            self._node_outputs[gate.node_id] = {
                "approved": True,
                "decision": result.decision,
                "clinicianId": result.clinician_id,
                "contextItemVersionId": result.context_item_version_id,
            }
            return NodeResult(node_id=gate.node_id, node_type=node_type, status="SUCCEEDED")

        # ABANDONED — the SLA ladder ran out without a clinician decision. DEGRADED here would be
        # promoted to FAILED anyway (the gate is `critical: true`); naming it FAILED directly
        # keeps the reason honest rather than routing an unsigned gate through a "degraded" word.
        return NodeResult(
            node_id=gate.node_id, node_type=node_type, status="FAILED", reason="gate_abandoned"
        )

    def _gate_context_item_id(self) -> str | None:
        """The `contextItemId` a `consultation.persistDraft` node published upstream, if any —
        read from the workflow-owned node-output cache, never re-derived."""
        for output in self._node_outputs.values():
            candidate = output.get("contextItemId")
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    @workflow.signal(name="cancel")
    async def cancel(self, signal: CancelSignal | None = None) -> None:
        """The ONLY signal this workflow accepts — a code allow-list, never a name pass-through
        (F-09, orchestration.md, is the anti-pattern this must not repeat)."""
        self._cancelled = True
        self._cancel_reason = signal.reason if signal else None

    @workflow.query(name="state")
    def state(self) -> InterpreterStateQueryResult:
        return InterpreterStateQueryResult(
            run_id=self._run_id, status=self._status, stages=self._stages
        )
