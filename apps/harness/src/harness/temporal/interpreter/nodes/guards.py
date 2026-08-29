"""The ``guard.*`` node types (TASK-809 DD-7) — TASK-806 lane A, item 17.

A guard is the thing ``WorkflowNodeDescriptor.requires`` names: a node type that must be wired to
EVERY INSTANCE of the node that requires it before a graph containing it can be published
(``workflowPublishProblems``). Until these existed, ``requires`` was ``[]`` on all 36 node types
and the mechanism gated nothing.

Three guards, and each delegates to a check this platform already performs:

* ``guard.phi`` — the PHI redaction hop (``interpreter.consultation_phi_hop``).
* ``guard.moderation`` — content safety (``interpreter.guardrail_check``).
* ``guard.groundedness`` — the groundedness sensor pass (``interpreter.consultation_sensors``).
  ``realtime-lane.ts`` records the gap this closes verbatim: *"There is no groundedness NODE
  because the registry has no groundedness node type; the gate is a GUARD attached to the
  generation node"*.

## Why a guard's product is a VERDICT

A guard says whether something is acceptable; a transformer changes it. Declaring `verdict` as the
guard's primary output is what keeps the two apart, and it is also what lets ``requires`` be
satisfied by an edge in EITHER direction — a pre-guard reads what a node will produce FROM, a
post-guard reads what it produced.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes.consultation import interpreter_consultation_phi_hop
from harness.temporal.interpreter.nodes.consultation_verify import interpreter_consultation_sensors
from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check


@activity.defn(name="interpreter.guard_phi")
async def interpreter_guard_phi(payload: NodeActivityInput) -> NodeActivityResult:
    """PHI guard — redacts, and reports WHAT it redacted as a verdict.

    The redactor engine publishes ``{text, mode, entityCount}``. A guard has to answer a question,
    so this wrapper projects those same values into a ``verdict`` object rather than leaving the
    declared ``out: verdict`` socket naming a key its engine never emits. Nothing is recomputed —
    the verdict is a view of the redactor's own report.

    The fail-CLOSED property of PHI handling does NOT live here and must not be re-implemented
    here: ``ensure_egress_safe`` raises before any cloud call, and the redactor hop DEGRADES rather
    than passing unredacted text through (``consultation.py``'s own rule: "fail loudly, never pass
    through while claiming the hop ran").
    """
    result = await interpreter_consultation_phi_hop(payload)
    output: dict[str, Any] = dict(result.output or {})
    if result.status == "SUCCEEDED":
        output["verdict"] = {
            "guard": "phi",
            "mode": output.get("mode"),
            "entityCount": output.get("entityCount"),
            "redacted": bool(output.get("entityCount")),
        }
    return NodeActivityResult(status=result.status, reason=result.reason, output=output or None)


@activity.defn(name="interpreter.guard_moderation")
async def interpreter_guard_moderation(payload: NodeActivityInput) -> NodeActivityResult:
    """Content-safety guard. Delegates verbatim to the guardrail engine, which already publishes
    its decision under ``verdict`` — the key this node's ``out`` socket declares."""
    return await interpreter_guardrail_check(payload)


@activity.defn(name="interpreter.guard_groundedness")
async def interpreter_guard_groundedness(payload: NodeActivityInput) -> NodeActivityResult:
    """Groundedness guard over a GENERATED document.

    Its input is typed ``document`` rather than ``text``, and that is load-bearing: groundedness is
    a claim about generated prose against its sources, so scoring a raw transcript is a category
    error — the transcript IS the ground. ``transcript`` does not satisfy ``document`` in the port
    lattice, so that wiring is refused rather than relying on anyone remembering the distinction.
    """
    return await interpreter_consultation_sensors(payload)


GUARD_ACTIVITIES = [
    interpreter_guard_phi,
    interpreter_guard_moderation,
    interpreter_guard_groundedness,
]
