"""The WorkflowInterpreter workflow (Task 6).

Deterministic, platform-owned. Walks a published WorkflowDefinition version's compiledConfig
(dereferenced via claim-check, S-2) stage by stage, dispatching each node to a code-owned,
registry-sanctioned activity (S-4). See
docs/implementation/TASK-718-Workflow-Interpreter/contracts/execution-semantics.md for the full
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
    from harness.temporal.interpreter.activities import load_config
    from harness.temporal.interpreter.compiled_config import (
        CompiledGate,
        CompiledNode,
        CompiledStage,
    )
    from harness.temporal.interpreter.gate_workflow import (
        ConsultationGateWorkflow,
        gate_workflow_id,
    )
    from harness.temporal.interpreter.models import (
        CancelSignal,
        ConsultationGateInput,
        ConsultationGateResult,
        InterpreterInput,
        InterpreterResult,
        InterpreterStateQueryResult,
        NodeActivityInput,
        NodeActivityResult,
        NodeResult,
        NodeStatus,
        RunStatus,
        StageResult,
    )
    from harness.temporal.interpreter.registry import NODE_REGISTRY
    from harness.temporal.models import TrajectoryContext

_CONFIG_LOAD_TIMEOUT = timedelta(seconds=30)
_CONFIG_LOAD_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))

# Stride between per-node trajectory-seq bases — same idiom as `workflows.py`'s
# `_SEQ_STRIDE` (Task 7): a workflow-owned monotonic counter stands in for a clock/UUID
# (determinism). No interpreter node activity emits more than one trajectory step today, so a
# small stride is enough headroom without claiming a wall-clock-derived value.
_SEQ_STRIDE = 4

# Deterministic, idempotent-on-start workflow id — mirrors
# `consultation_loop_workflow_id` (workflows.py:1623-1625).
INTERPRETER_WORKFLOW_ID_PREFIX = "workflow-interpreter-"

# The patch marker for the HITL-gate command (TASK-731 Phase B). Required by
# contracts/versioning.md rule 3: executing a gate adds a NEW command to the workflow body, which
# would change the command sequence for every replaying history if shipped ungated. The gate is
# guarded cheap-operand-first (`config.gates and workflow.patched(...)`), and the cheap operand is
# PROVABLY False on every pre-existing history: until this change, `parse_and_verify` refused any
# config whose `gates` was not `[]` (`gates_not_supported_v1`), so no admitted run can ever have
# carried one. `workflow.patched` is therefore never even called when replaying an old history —
# exactly what the idiom is for.
_GATE_PATCH = "task-731-hitl-gate"

# The patch marker for the agentic LOOP (TASK-848). Same rule as the gate above: dispatching an
# `agentic.loop` node as a CHILD WORKFLOW instead of as an activity changes the command sequence,
# so every recorded history that ran one as an activity must keep replaying it that way.
#
# Unlike the gate's, this one's cheap operand is NOT provably False on every pre-existing history:
# TASK-847 shipped `agentic.loop` as a registered, dispatchable activity, so a run that walked a
# graph containing one really did record an ActivityTaskScheduled for `interpreter.agentic_loop`.
# That is exactly the case `workflow.patched` exists for, and it is why this is a real gate rather
# than a formality.
_LOOP_PATCH = "task-848-agentic-loop-child"

# The loop's own node type. Named once: `_index_loop_body` and `_dispatch_node` must agree about
# it, and a second spelling is how the two drift.
_LOOP_NODE_TYPE = "agentic.loop"

# How a loop's stop reason lands on the node's own record. Both halves are observable and BOTH
# carry the reason string, so a reason is never distinguishable only in principle.
#
# * `termination_key` - the author's own exit condition fired. The loop finished the job it was
#   given, so this is the unambiguous SUCCEEDED.
# * `no_progress_iterations` - the loop CONVERGED: it stopped producing anything new, which is
#   the outcome that bound exists to detect (`node-config-schemas.ts`: "an orchestrator that has
#   converged and is now paraphrasing itself"). Also a success.
# * everything else - a CEILING truncated the deliberation (iterations, invoice, clock), or the
#   master agent could not run. A truncated clinical deliberation reported as SUCCEEDED is the
#   false-success claim this substrate is written to avoid, so those degrade.
_LOOP_SUCCESS_REASONS = frozenset({"termination_key", "no_progress_iterations"})

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
        # `node_id` (TASK-720 Task 5 — see `NodeActivityInput.bound_inputs`'s docstring for the
        # full rationale). Pure Python dict state built from already-deterministic activity
        # results — no wall-clock/random/I/O — so it is replay-safe exactly like `self._stages`.
        # A node in stage N can only bind from a node in stage < N (the compiler's topological
        # stage partitioning already guarantees this), so same-stage fan-out nodes never race
        # each other reading/writing this cache.
        self._node_outputs: dict[str, dict[str, Any]] = {}
        # `node_id -> node type`, built from the compiled config before the walk starts.
        # `_resolve_bound_inputs` needs the PRODUCER's type to look its declared output sockets up
        # in `NODE_REGISTRY` (TASK-809 OD-15); `_node_outputs` alone is keyed by id and says
        # nothing about which node type produced the dict. Pure derived state, so it is replay-safe
        # for the same reason `_stages` is.
        self._node_types: dict[str, str] = {}

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
        for indexed_gate in config.gates:
            self._node_types.setdefault(indexed_gate.node_id, "consultation.hitlGate")

        run_failed = False
        run_degraded = False

        for stage in config.stages:
            if self._cancelled:
                break
            node_results = await self._run_stage(stage, inp)
            self._stages.append(StageResult(stage_index=stage.stage_index, nodes=node_results))
            for node_result in node_results:
                if node_result.status == "FAILED":
                    run_failed = True
                elif node_result.status in ("DEGRADED", "SKIPPED"):
                    run_degraded = True
            if run_failed:
                # The current stage is already fully settled (all-settled join, §5); no
                # further stage is started once a critical node has failed.
                break

        # 2) The HITL gate (TASK-731 Phase B). The compiler LIFTS every `gate`-classed node out
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

        return InterpreterResult(run_id=inp.run_id, status=status, stages=self._stages)

    async def _run_stage(self, stage: CompiledStage, inp: InterpreterInput) -> list[NodeResult]:
        """All-settled join: every node's own coroutine catches its own ACTIVITY exceptions
        (§4/§5), so plain ``asyncio.gather`` (no ``return_exceptions``) is sufficient for the
        outcomes §4 defines.

        ONE thing does deliberately escape (TASK-809 OD-15): ``_resolve_bound_inputs`` raises a
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

        ## The socket -> output-key resolution (TASK-809 OD-15, option A)

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
            spec = NODE_REGISTRY.get(upstream_type) if upstream_type is not None else None
            if spec is None or binding.from_port not in spec.output_keys:
                raise ApplicationError(
                    f"unresolved input binding: node {node.node_id!r} ({node.type}) binds "
                    f"{binding.to_port!r} from {binding.from_node_id!r} "
                    f"({upstream_type or 'unknown node type'}) port {binding.from_port!r}, "
                    "which is not a declared output socket of that node type",
                    type="unresolved_input_binding",
                    non_retryable=True,
                )
            output_key = spec.output_keys[binding.from_port]
            if output_key is None:
                # An ORDERING edge. The stage partitioning already carries the dependency.
                continue
            upstream_output = self._node_outputs.get(binding.from_node_id)
            if upstream_output is None or output_key not in upstream_output:
                continue
            bound[binding.to_port] = upstream_output[output_key]
        return bound

    async def _dispatch_node(
        self, node: CompiledNode, inp: InterpreterInput, stage_index: int
    ) -> NodeResult:
        spec = NODE_REGISTRY.get(node.type)
        if spec is None or not spec.implemented:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="unsupported_node_type",
            )

        # TASK-806 lane A (item 7) — LANE OWNERSHIP. A `realtime` node belongs to TASK-811's
        # live executor, not to this durable interpreter, and exactly one runtime must execute
        # any given node: `consultation.realtimeSummary` is `external_write`, so both running it
        # means two engines writing one consultation's document.
        #
        # This loses nothing that was working. In THIS lane `consultation.captureBinding` emits no
        # transcript, so `consultation.extractEntities` and `consultation.realtimeSummary` already
        # degraded on `no_bound_text` every run. The skip turns a silent degrade into an
        # OBSERVABLE one that names the runtime which owns the work — the same discipline as
        # `unsupported_node_type` above, and never a silent no-op.
        if spec.lane == "realtime":
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="realtime_lane",
            )

        # TASK-852 item 4 — the per-node KILL SWITCH, honoured by BOTH runtimes.
        #
        # TASK-811's realtime executor has read this key since it shipped (`realtime-lane.ts`:
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
        )

        try:
            result: NodeActivityResult = await workflow.execute_activity(
                spec.activity,
                activity_input,
                start_to_close_timeout=timedelta(seconds=timeout_seconds),
                retry_policy=RetryPolicy(maximum_attempts=max_attempts),
            )
        except ActivityError:
            # Timeout OR an application-raised exception both surface here identically
            # (contracts/execution-semantics.md §Worked example).
            degraded_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status=degraded_status,
                reason="activity_error",
            )

        if result.status == "SUCCEEDED":
            if result.output is not None:
                self._node_outputs[node.node_id] = result.output
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

    async def _run_gate(
        self, gate: CompiledGate, inp: InterpreterInput, *, blocked: bool
    ) -> NodeResult:
        """Execute the one blocking HITL gate as a CHILD workflow.

        A child rather than an in-line `wait_condition` is what keeps the interpreter's own
        signal surface `cancel`-only for every palette (TASK-718 R-2) — see
        `gate_workflow.py`'s module docstring for why this is a new workflow type rather than the
        `HarnessDocWorkflow` delegation `palette-contract.md` §2 originally chose.

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
