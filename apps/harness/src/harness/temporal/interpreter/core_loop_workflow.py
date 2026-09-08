"""``LoopWorkflow`` — the ``core.loop`` body (TASK-864 §3.3): ``foreach`` / ``while`` over a
compiled SUB-GRAPH, one iteration per generation.

The Loop's body is a compiled sub-graph (``compiledConfig.loops[].body``, the nodes carrying
``parentId``), walked stage by stage exactly as the interpreter walks the top level, once per
iteration. The shape is:

* **One iteration per generation, then ``continue_as_new``.** History stays bounded whatever
  the iteration count; the loop's whole memory is its input (``CoreLoopState``).
* **The three carried bounds are pure arithmetic** (``max_iterations``, ``max_total_tokens``,
  ``no_progress_iterations``), checked on entry and after the iteration by
  ``exhausted_bound``. ``max_duration_seconds`` cannot be one of them and is the PARENT's
  timer: a workflow timer does not survive ``continue_as_new``, and the only way to carry a
  deadline across the boundary would be a wall-clock read inside ``@workflow.defn``. See
  ``workflow.py::_run_core_loop``, which races the child handle against its own sleep.
* **The checkpoint is an activity** (``interpreter.loop_state_checkpoint``, reused): it digests
  the iteration, counts tokens, offloads a large carry-forward and emits the
  ``workflow.loop.iteration`` run event — nothing here hashes a blob or touches Redis.
* **``until`` is an activity** (``interpreter.core_evaluate``): the CEL evaluator is pure, but
  evaluating it in an activity keeps the workflow body free of the expression engine and makes
  the evaluation a recorded fact.

## Stop reasons

``items_exhausted`` (foreach ran off the end) and ``until`` (the author's condition fired) are
the two CONVERGED outcomes — the interpreter reports them, and ``no_progress_iterations``, as
SUCCEEDED. ``max_iterations`` / ``max_total_tokens`` truncated the loop and DEGRADE it, with the
ceiling named; ``orchestrator_failed`` is raised to ``body_failed`` semantics: a body whose
critical node failed ends the loop rather than iterating over a broken iteration.

## Determinism

No ``datetime.now``, no ``random``, no ``uuid4``, no I/O. Child ids for nested loops and
reviews carry the iteration counter, which is carried state, never a clock.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter import caps
    from harness.temporal.interpreter.compiled_config import CompiledLoopBody, CompiledNode
    from harness.temporal.interpreter.loop_activities import loop_state_checkpoint
    from harness.temporal.interpreter.models import (
        CoreLoopBounds,
        CoreLoopInput,
        CoreLoopResult,
        CoreLoopState,
        EvaluateExpressionInput,
        EvaluateExpressionResult,
        LoopCheckpointInput,
        LoopStateCheckpoint,
        LoopStopReason,
        NodeActivityInput,
        NodeActivityResult,
        ReviewGateInput,
        ReviewGateResult,
    )
    from harness.temporal.interpreter.nodes._shared import MISSING, resolve_dotted_path
    from harness.temporal.interpreter.nodes.core import interpreter_core_evaluate
    from harness.temporal.interpreter.registry import (
        CORE_LOOP_NODE_TYPE,
        CORE_REVIEW_NODE_TYPE,
        effective_spec,
        output_keys_for,
    )
    from harness.temporal.interpreter.review_workflow import (
        ReviewGateWorkflow,
        review_gate_workflow_id,
    )
    from harness.temporal.models import TrajectoryContext

_CHECKPOINT_TIMEOUT = timedelta(seconds=30)
_CHECKPOINT_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))
_EVALUATE_TIMEOUT = timedelta(seconds=10)
_EVALUATE_RETRY = RetryPolicy(maximum_attempts=2)

CORE_LOOP_WORKFLOW_ID_PREFIX = "core-loop-"


def core_loop_workflow_id(run_id: str, node_id: str, iteration_path: str = "") -> str:
    """The loop child's deterministic id (pure). ONE id for a whole ``continue_as_new`` chain;
    a NESTED loop adds its enclosing iteration to the path so each outer iteration starts a
    distinct inner chain."""
    suffix = f"-{iteration_path}" if iteration_path else ""
    return f"{CORE_LOOP_WORKFLOW_ID_PREFIX}{run_id}-{node_id}{suffix}"


def exhausted_bound(state: CoreLoopState, bounds: CoreLoopBounds) -> LoopStopReason | None:
    """Which of the three CARRIED bounds is exhausted, or ``None``. Pure.

    Fixed priority (see the module docstring): iterations, tokens, no-progress. ``>=`` rather
    than ``>`` throughout, because the counters record work already DONE — a loop that has run
    ``max_iterations`` iterations has spent its budget, it does not get one more.

    ``max_duration_seconds`` is absent by design and is the PARENT's; see the module docstring.
    """
    if state.iterations >= bounds.max_iterations:
        return "max_iterations"
    if state.tokens_used >= bounds.max_total_tokens:
        return "max_total_tokens"
    if state.no_progress_streak >= bounds.no_progress_iterations:
        return "no_progress_iterations"
    return None


def _collect(value: Any, path: str | None) -> Any:
    if not path:
        return value
    resolved = resolve_dotted_path(value if isinstance(value, dict) else {}, path)
    return None if resolved is MISSING else resolved


def _result(inp: CoreLoopInput, state: CoreLoopState, reason: str) -> CoreLoopResult:
    return CoreLoopResult(
        node_id=inp.node_id,
        stop_reason=reason,  # type: ignore[arg-type]
        iterations=state.iterations,
        tokens_used=state.tokens_used,
        result=list(state.collected),
        body_failures=state.body_failures,
    )


@workflow.defn(name="CoreLoop")
class LoopWorkflow:
    """One iteration of the body per generation, then ``continue_as_new``."""

    def __init__(self) -> None:
        # Per-iteration node outputs — the body's own `_node_outputs`. Rebuilt every generation.
        self._outputs: dict[str, dict[str, Any]] = {}
        self._taken: dict[str, set[str]] = {}
        self._branch_skipped: set[str] = set()
        self._seq = 0

    @workflow.run
    async def run(self, inp: CoreLoopInput) -> CoreLoopResult:
        bounds = inp.bounds

        # 1) Inherited bounds — a spent budget stops here without running anything.
        inherited = exhausted_bound(inp.state, bounds)
        if inherited is not None:
            return _result(inp, inp.state, inherited)

        # 2) The item this iteration works on.
        index = inp.state.iterations
        if inp.mode == "foreach":
            if index >= len(inp.items):
                return _result(inp, inp.state, "items_exhausted")
            item: Any = inp.items[index]
        else:
            item = (
                inp.state.carried
                if index > 0
                else (inp.seed_inputs.get("in") if inp.seed_inputs else None)
            )

        # The loop node itself is the body's ONE upstream: `each` carries the item.
        self._outputs = {inp.node_id: {"item": item, "index": index, "iteration": index + 1}}
        self._taken = {}
        self._branch_skipped = set()

        # 3) Walk the body, stage by stage — the interpreter's own shape, in miniature.
        body = CompiledLoopBody.model_validate(inp.body)
        body_failed = False
        for stage in body.stages:
            results = await asyncio.gather(
                *(self._dispatch(node, inp, index) for node in stage.nodes)
            )
            for _node, result in zip(stage.nodes, results, strict=True):
                if result.status == "FAILED":
                    body_failed = True
            if body_failed:
                break

        if body_failed:
            next_state = inp.state.model_copy(
                update={"iterations": index + 1, "body_failures": inp.state.body_failures + 1}
            )
            return _result(inp, next_state, "orchestrator_failed")

        # 4) The iteration's product: the outputs of the body's SINK nodes.
        produced = self._iteration_product(body, inp.node_id)

        checkpoint: LoopStateCheckpoint = await workflow.execute_activity(
            loop_state_checkpoint,
            LoopCheckpointInput(
                orchestrator_output=(
                    produced if isinstance(produced, dict) else {"result": produced}
                ),
                sub_agent_outputs=[],
                termination_key=None,
                run_id=inp.run_id,
                node_id=inp.node_id,
                tenant_id=inp.tenant_id,
                iteration=index + 1,
                max_iterations=inp.bounds.max_iterations,
                max_total_tokens=inp.bounds.max_total_tokens,
                tokens_used_before=inp.state.tokens_used,
            ),
            start_to_close_timeout=_CHECKPOINT_TIMEOUT,
            retry_policy=_CHECKPOINT_RETRY,
        )

        collected = [*inp.state.collected, _collect(produced, inp.collect)]
        next_state = CoreLoopState(
            iterations=index + 1,
            tokens_used=inp.state.tokens_used + checkpoint.tokens,
            no_progress_streak=(
                0 if checkpoint.digest != inp.state.digest else inp.state.no_progress_streak + 1
            ),
            digest=checkpoint.digest,
            collected=collected,
            carried=produced,
            body_failures=inp.state.body_failures,
        )

        # 5) The author's own exit outranks every bound.
        if inp.mode == "while" and inp.until:
            # The CALLABLE, never the bare name: called by name with no `result_type`, the data
            # converter hands back a dict, `.taken` raises inside the workflow task, and Temporal
            # retries that task forever — a silent hang, observed while writing this.
            evaluation: EvaluateExpressionResult = await workflow.execute_activity(
                interpreter_core_evaluate,
                EvaluateExpressionInput(
                    expression=inp.until,
                    context={
                        **inp.run_context,
                        "nodes": {**(inp.run_context.get("nodes") or {}), **self._outputs},
                        "loop": {
                            "iteration": index + 1,
                            "result": produced,
                            "collected": collected,
                        },
                    },
                ),
                start_to_close_timeout=_EVALUATE_TIMEOUT,
                retry_policy=_EVALUATE_RETRY,
            )
            if evaluation.taken:
                return _result(inp, next_state, "until")
        if inp.mode == "foreach" and index + 1 >= len(inp.items):
            return _result(inp, next_state, "items_exhausted")

        spent = exhausted_bound(next_state, bounds)
        if spent is not None:
            return _result(inp, next_state, spent)

        # 6) A FRESH history for the next iteration. Never returns.
        workflow.continue_as_new(inp.model_copy(update={"state": next_state}))

    # ------------------------------------------------------------------------------------------

    def _iteration_product(self, body: CompiledLoopBody, loop_id: str) -> Any:
        """The merged outputs of the body's SINK nodes (nodes no other body node binds from)."""
        bound_from: set[str] = set()
        for stage in body.stages:
            for node in stage.nodes:
                for binding in node.inputs:
                    bound_from.add(binding.from_node_id)
                for guard in node.branch_guards:
                    bound_from.add(guard.from_node_id)
        product: dict[str, Any] = {}
        for stage in body.stages:
            for node in stage.nodes:
                if node.node_id in bound_from:
                    continue
                output = self._outputs.get(node.node_id)
                if output:
                    product.update(output)
        return product

    def _resolve_bound_inputs(
        self, node: CompiledNode, body_types: dict[str, tuple[str, dict[str, Any]]], loop_id: str
    ) -> dict[str, Any]:
        bound: dict[str, Any] = {}
        for binding in node.inputs:
            if binding.from_node_id == loop_id:
                keys: Mapping[str, str | None] | None = {
                    "each": "item",
                    "done": "result",
                    "next": None,
                }
            else:
                upstream = body_types.get(binding.from_node_id)
                keys = output_keys_for(upstream[0], upstream[1]) if upstream else None
            if keys is None or binding.from_port not in keys:
                continue
            key = keys[binding.from_port]
            if key is None:
                continue
            upstream_output = self._outputs.get(binding.from_node_id)
            if upstream_output is None or key not in upstream_output:
                continue
            bound[binding.to_port] = upstream_output[key]
        return bound

    def _branch_skip(self, node: CompiledNode) -> bool:
        if node.branch_guards:
            if not any(
                guard.handle in self._taken.get(guard.from_node_id, set())
                for guard in node.branch_guards
            ):
                return True
        predecessors = {binding.from_node_id for binding in node.inputs} | {
            g.from_node_id for g in node.branch_guards
        }
        if predecessors and predecessors <= self._branch_skipped:
            return True
        return False

    async def _dispatch(
        self, node: CompiledNode, inp: CoreLoopInput, iteration: int
    ) -> NodeActivityResult:
        """Run ONE body node — activity, nested loop, or review — with the interpreter's rules."""
        body = CompiledLoopBody.model_validate(inp.body)
        body_types = {n.node_id: (n.type, n.config) for stage in body.stages for n in stage.nodes}

        spec = effective_spec(node.type, node.config)
        if spec is None or not spec.implemented:
            return NodeActivityResult(status="SKIPPED", reason="unsupported_node_type")
        if self._branch_skip(node):
            self._branch_skipped.add(node.node_id)
            return NodeActivityResult(status="SKIPPED", reason="branch_not_taken")
        if node.config.get("enabled") is False:
            return NodeActivityResult(status="SKIPPED", reason="disabled_by_config")
        if inp.sandbox and spec.external_write:
            return NodeActivityResult(status="SKIPPED", reason="sandbox")

        bound = self._resolve_bound_inputs(node, body_types, inp.node_id)
        run_context = {
            **inp.run_context,
            "nodes": {**(inp.run_context.get("nodes") or {}), **self._outputs},
        }
        iteration_path = f"{inp.node_id}-{iteration}"

        if node.type == CORE_REVIEW_NODE_TYPE:
            review: ReviewGateResult = await workflow.execute_child_workflow(
                ReviewGateWorkflow.run,
                ReviewGateInput(
                    run_id=inp.run_id,
                    node_id=node.node_id,
                    tenant_id=inp.tenant_id,
                    workflow_version_id=inp.workflow_version_id,
                    review_type=str(node.config.get("reviewType") or "approval"),
                    instructions=(
                        node.config.get("instructions")
                        if isinstance(node.config.get("instructions"), str)
                        else None
                    ),
                    assign_role=(
                        node.config.get("assignRole")
                        if isinstance(node.config.get("assignRole"), str)
                        else None
                    ),
                    timeout_seconds=int(node.config.get("timeoutSeconds") or node.timeout_seconds),
                    escalation_after_seconds=(
                        (node.config.get("escalation") or {}).get("afterSeconds")
                        if isinstance(node.config.get("escalation"), dict)
                        else None
                    ),
                    max_escalations=(
                        int((node.config.get("escalation") or {}).get("maxEscalations") or 0)
                        if isinstance(node.config.get("escalation"), dict)
                        else 0
                    ),
                    allow_edit=node.config.get("allowEdit") is True,
                    payload=bound,
                ),
                id=review_gate_workflow_id(inp.run_id, f"{node.node_id}-{iteration_path}"),
            )
            self._outputs[node.node_id] = {"decision": review.model_dump()}
            self._taken[node.node_id] = {review.outcome}
            return NodeActivityResult(status="SUCCEEDED", taken_handle=review.outcome)

        if node.type == CORE_LOOP_NODE_TYPE:
            nested_body = inp.nested.get(node.node_id)
            if nested_body is None:
                return NodeActivityResult(status="DEGRADED", reason="loop_body_missing")
            mode = node.config.get("mode")
            items: list[Any] = []
            if mode == "foreach":
                over = node.config.get("over")
                resolved = (
                    resolve_dotted_path(run_context, over) if isinstance(over, str) else MISSING
                )
                if not isinstance(resolved, list):
                    return NodeActivityResult(status="DEGRADED", reason="loop_over_unresolvable")
                items = resolved
            nested_input = CoreLoopInput(
                run_id=inp.run_id,
                node_id=node.node_id,
                tenant_id=inp.tenant_id,
                workflow_version_id=inp.workflow_version_id,
                sandbox=inp.sandbox,
                mode="foreach" if mode == "foreach" else "while",
                items=items,
                until=(
                    node.config.get("until") if isinstance(node.config.get("until"), str) else None
                ),
                collect=(
                    node.config.get("collect")
                    if isinstance(node.config.get("collect"), str)
                    else None
                ),
                bounds=CoreLoopBounds.model_validate(node.config.get("bounds") or {}),
                body=nested_body,
                nested=inp.nested,
                seed_inputs=bound,
                run_payload=inp.run_payload,
                run_context=run_context,
            )
            try:
                nested: CoreLoopResult = await workflow.execute_child_workflow(
                    LoopWorkflow.run,
                    nested_input,
                    id=core_loop_workflow_id(inp.run_id, node.node_id, iteration_path),
                )
            except Exception:  # noqa: BLE001
                return NodeActivityResult(status="DEGRADED", reason="loop_unavailable")
            self._outputs[node.node_id] = {"result": nested.result}
            return NodeActivityResult(status="SUCCEEDED")

        self._seq += 1
        try:
            result: NodeActivityResult = await workflow.execute_activity(
                spec.activity,
                NodeActivityInput(
                    node_id=node.node_id,
                    node_type=node.type,
                    config=node.config,
                    tenant_id=inp.tenant_id,
                    sandbox=inp.sandbox,
                    trajectory=TrajectoryContext(
                        tenant_id=inp.tenant_id,
                        seq=iteration * 64 + self._seq,
                        workflow_version_id=inp.workflow_version_id,
                        stage_id=f"loop:{inp.node_id}:{iteration}",
                        node_id=node.node_id,
                        node_type=node.type,
                    ),
                    bound_inputs=bound,
                    run_payload=inp.run_payload,
                    run_id=inp.run_id,
                    run_context=run_context,
                ),
                start_to_close_timeout=timedelta(seconds=caps.clamp_timeout(node.timeout_seconds)),
                retry_policy=RetryPolicy(
                    maximum_attempts=caps.clamp_attempts(node.retry.maximum_attempts)
                ),
            )
        except ActivityError:
            return NodeActivityResult(
                status="DEGRADED" if not spec.critical else "SKIPPED", reason="activity_error"
            )

        if result.status == "SUCCEEDED":
            if result.output is not None:
                self._outputs[node.node_id] = result.output
            if result.taken_handle is not None:
                self._taken[node.node_id] = {result.taken_handle}
        return result
