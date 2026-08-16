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
from typing import Literal

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter import caps
    from harness.temporal.interpreter.activities import load_config
    from harness.temporal.interpreter.compiled_config import CompiledNode, CompiledStage
    from harness.temporal.interpreter.models import (
        CancelSignal,
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


def interpreter_workflow_id(run_id: str) -> str:
    """The deterministic interpreter workflow id for a run (pure)."""
    return f"{INTERPRETER_WORKFLOW_ID_PREFIX}{run_id}"


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
        """All-settled join: every node's own coroutine already catches its own exceptions
        (§4/§5), so plain ``asyncio.gather`` (no ``return_exceptions``) is sufficient — nothing
        here can raise past a single node's own dispatch wrapper."""
        return list(
            await asyncio.gather(
                *(self._dispatch_node(node, inp, stage.stage_index) for node in stage.nodes)
            )
        )

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

    @workflow.signal(name="cancel")
    async def cancel(self, signal: CancelSignal | None = None) -> None:
        """The ONLY signal this workflow accepts — a code allow-list, never a name pass-through
        (F-09, orchestration.md, is the anti-pattern this must not repeat)."""
        self._cancelled = True
        self._cancel_reason = signal.reason if signal else None

    @workflow.query(name="state")
    def state(self) -> InterpreterStateQueryResult:
        return InterpreterStateQueryResult(run_id=self._run_id, status=self._status, stages=self._stages)
