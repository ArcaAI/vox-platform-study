"""Shared helpers for the summarization-palette node activities.

Not itself an activity module — imported by the five ``interpreter.*`` activities under this
package. Keeps the trajectory-recording boilerplate (identical to
``interpreter/activities.py``'s own ``_record_and_flush``) and the small, dependency-free dotted-
path resolver (used by N-1's ``bindings[].from`` and, generically, by any node that wants to read
a nested value out of ``bound_inputs``) in one place rather than five near-duplicate copies.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from harness.core.config import get_settings
from harness.temporal.activities import (
    FAILED_ATTEMPT_OFFSET_BASE,
    MAX_FAILED_ATTEMPT_STEPS,
    STATUS_DEGRADED,
    STATUS_ERROR,
    STATUS_OK,
    STEP_LLM_CALL,
    STEP_NODE,
    _now,
    record_failed_attempts,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter — noqa: SLF001
)
from harness.temporal.interpreter.models import NodeActivityInput

__all__ = [
    "FAILED_ATTEMPT_OFFSET_BASE",
    "MAX_FAILED_ATTEMPT_STEPS",
    "MISSING",
    "STATUS_DEGRADED",
    "STATUS_ERROR",
    "STATUS_OK",
    "now",
    "record_and_flush",
    "record_generation_and_flush",
    "resolve_dotted_path",
]

now = _now

# Sentinel distinct from `None` — a bound value can legitimately BE `None`/absent-shaped JSON;
# `MISSING` means "the path did not resolve at all".
MISSING = object()


async def record_and_flush(
    payload: NodeActivityInput,
    *,
    status: str,
    started: Any,
    error_code: str | None = None,
    stats: dict[str, Any] | None = None,
    failed_attempts: Sequence[dict[str, Any]] | None = None,
) -> None:
    """One NODE trajectory step per node activity (mirrors `interpreter/activities.py`'s own
    seed-node helper — deliberately not imported from there to keep this package's five node
    modules free of a dependency on the seed noop/passthrough module).

    ``stats`` is node-level PROVENANCE (TASK-947 OD-11: ``{"prompt_fragments": [keys]}``), never
    a billable block — the gateway bills LLM_CALL steps only (``harness-usage.mapper.ts``).

    ``failed_attempts`` rides the SAME batch when a node degraded after trying (and losing) one
    or more candidates: the attempts still cost platform compute, and this is the only path they
    have to the ledger."""
    batch = TrajectoryBatch(get_settings(), payload.trajectory)
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=status,
        started=started,
        error_code=error_code,
        stats=stats,
    )
    record_failed_attempts(batch, failed_attempts, started)
    await batch.flush()


async def record_generation_and_flush(
    payload: NodeActivityInput,
    *,
    started: Any,
    stats: dict[str, Any],
    node_stats: dict[str, Any] | None = None,
    failed_attempts: Sequence[dict[str, Any]] | None = None,
) -> None:
    """The node step PLUS the LLM_CALL step a generation is BILLED from (F14).

    The gateway co-emits one usage-ledger row per persisted LLM_CALL step that carries billable
    AD-1 ``GenerationStats`` (``buildHarnessUsageEvent``, called from
    ``AgentTrajectoryService.recordSteps``). The durable consultation lane has recorded that
    step since F-19; the interpreter lane recorded a NODE step with ``stats = null``, so every
    workflow-lane generation was invisible to the ledger — a real ~30 s gemma call that produced
    no row at all, against OD-E ("count every inference").

    Both steps ride ONE batch, so the generation cannot be billed without the node that ran it
    being recorded. The LLM_CALL sits at ``offset=1`` within the node's own strided seq base
    (``_SEQ_STRIDE`` in ``interpreter/workflow.py``), which is what keeps the ledger's
    ``harness:step:<sessionId>:<runId>:<seq>`` idempotency key stable across a Temporal
    redelivery — the same tuple the trajectory table dedupes on.
    """
    batch = TrajectoryBatch(get_settings(), payload.trajectory)
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=STATUS_OK,
        started=started,
        # TASK-947 OD-11 — provenance on the NODE step only; the LLM_CALL step below keeps the
        # billable block verbatim.
        stats=node_stats,
    )
    batch.record(
        step_type=STEP_LLM_CALL,
        name="generate",
        status=STATUS_OK,
        started=started,
        stats=stats,
        offset=1,
    )
    # §6.2 Gap A — the candidates that were TRIED and lost, on the same batch as the one that
    # served, so a chain's full cost is one atomic report.
    record_failed_attempts(batch, failed_attempts, started)
    await batch.flush()


def resolve_dotted_path(root: dict[str, Any], path: str) -> Any:
    """Walk ``path`` (dot-separated, e.g. ``'payload.text'``) into ``root``.

    Returns ``MISSING`` (not ``None``) when any segment is absent or the value at a
    non-terminal segment is not itself a ``dict`` — so "the field is `null`" and "the field does
    not exist" stay distinguishable to the caller.
    """
    current: Any = root
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return MISSING
        current = current[segment]
    return current
