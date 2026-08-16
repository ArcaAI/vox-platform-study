"""Pydantic payloads for the interpreter workflow + its activities.

Kept separate from the shared ``harness.temporal.models`` (which backs
``HarnessDocWorkflow``/``ConsultationLoopWorkflow``) so this new, additive package never touches
that frozen/near-frozen surface — see ``contracts/execution-semantics.md`` and rule
03/06's "surgical changes" guidance.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

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
    """

    model_config = ConfigDict(extra="forbid")

    node_id: str
    node_type: str
    config: dict[str, Any]
    tenant_id: str
    sandbox: bool = False
    trajectory: TrajectoryContext | None = None


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
