"""``ReviewGateWorkflow`` — the GENERIC durable human wait behind ``core.humanReview`` (TASK-864).

``ConsultationGateWorkflow`` (``gate_workflow.py``) is the consultation palette's HITL gate: it
needs a consultation id, resolves SLA knobs from the tenant's harness policy, records a WORM
``GATE_DECISION`` and escalates through the gateway. The ``core`` vocabulary's Human-review node
is the same DURABLE WAIT with none of those bindings — it holds out ANY payload, for any run,
and hands the decision back to the graph as a BRANCH (``approved`` / ``rejected`` / ``timedOut``)
rather than as a sign-off. So this is a sibling workflow type, deliberately thin, and a NEW
type: it has no recorded histories, so no ``workflow.patched`` era of its own (the
``ConsultationLoopWorkflow`` precedent).

## The property this file exists to hold

**A timeout never approves.** The wait ends in exactly one of three outcomes: a real ``review``
signal said ``approved``, a real signal said ``rejected``, or the deadline passed (``timedOut``).
There is no default, no fallback and no field a caller could read as approval that was not set
from a signal.

## In-stage, not lifted

The interpreter starts this child IN the stage the node sits in (the node is ``review``-classed,
not ``gate``-classed), which is what lets a review sit between an Agent and an Output. Every
node downstream of a review handle is skipped (``branch_not_taken``) unless that handle fired.

## Determinism

No clock, no random, no I/O in this module. The escalation ladder is counted, not written: the
``core`` node has no consultation to escalate against, so an escalation is a fact on the
workflow's ``state`` query (and on the returned result) that an operator surface reads.
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.models import (
        ReviewDecisionSignal,
        ReviewGateInput,
        ReviewGateResult,
    )

REVIEW_GATE_WORKFLOW_ID_INFIX = "-review-"


def review_gate_workflow_id(run_id: str, node_id: str) -> str:
    """The deterministic child id for ONE review node of a run (pure).

    Derived from the run id and the node id alone, so the decision route can address the child
    without reading run state — and so a graph may carry more than one review node.
    """
    return f"{run_id}{REVIEW_GATE_WORKFLOW_ID_INFIX}{node_id}"


@workflow.defn(name="ReviewGate")
class ReviewGateWorkflow:
    """Waits for a human decision; times out into ``timedOut``, never into approval."""

    def __init__(self) -> None:
        self._decision: ReviewDecisionSignal | None = None
        self._phase = "WAITING"
        self._escalations = 0

    @workflow.signal(name="review")
    async def review(self, payload: ReviewDecisionSignal) -> None:
        """The ONLY signal this workflow accepts — a code allow-list. A second signal after the
        first is ignored: a review is decided once."""
        if self._decision is None:
            self._decision = payload

    @workflow.query(name="state")
    def state(self) -> dict[str, object]:
        return {
            "phase": self._phase,
            "escalations": self._escalations,
            "decided": self._decision is not None,
            "decision": self._decision.decision if self._decision else None,
        }

    @workflow.run
    async def run(self, inp: ReviewGateInput) -> ReviewGateResult:
        remaining = float(inp.timeout_seconds)
        step = (
            float(inp.escalation_after_seconds)
            if inp.escalation_after_seconds and inp.escalation_after_seconds > 0
            else remaining
        )
        # The ladder: wait in `escalation_after_seconds` slices, counting an escalation at each
        # expiry, until the total deadline is spent. `max_escalations` caps the count, never the
        # wait — the deadline is the node's `timeoutSeconds` and nothing shortens it.
        while self._decision is None and remaining > 0:
            slice_seconds = min(step, remaining)
            try:
                await workflow.wait_condition(
                    lambda: self._decision is not None, timeout=timedelta(seconds=slice_seconds)
                )
            except TimeoutError:
                remaining -= slice_seconds
                if remaining > 0 and self._escalations < inp.max_escalations:
                    self._escalations += 1
                    self._phase = "ESCALATED"

        decision = self._decision
        if decision is None:
            # TIMED OUT. Nothing is approved and nothing is invented; the graph routes `timedOut`.
            self._phase = "TIMED_OUT"
            return ReviewGateResult(outcome="timedOut", escalations=self._escalations)

        self._phase = "DECIDED"
        return ReviewGateResult(
            outcome=decision.decision,
            reviewer_id=decision.reviewer_id,
            comment=decision.comment,
            edited_payload=decision.edited_payload if inp.allow_edit else None,
            escalations=self._escalations,
        )
