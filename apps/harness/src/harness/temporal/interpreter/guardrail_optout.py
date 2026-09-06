"""TASK-890 §3.14 (OD-R clause 3) — the guardrail opt-out's precedence, Python half.

Hand-written mirror of ``packages/workflow-contract/src/guardrail-optout.ts``, held to
``tests/contracts/guardrail-optout.fixture.json`` by two loaders. The gateway folds this decision
for the REALTIME ``core.agent`` lane; this module folds it for the DURABLE lane. Both lanes
execute the same node, so a divergence here means one lane screens a call the other does not —
which is a safety difference, not a formatting one.

What this does NOT change: guardrail POLICY (the eight catalogue checks, ``TenantGuardrailPolicy``,
the ``guardrail.*`` routing selection) stays platform-managed and resolves inside ``apps/guardrail``.
This answers one question — for THIS call, does the platform's guardrail run — and the tenant's
only move is to opt OUT.

Precedence is ``node > workflow > agent > True``. The most specific opinion wins because it is the
most deliberate. ABSENT is INHERIT at every level; there is no "unset false". The floor is ``True``,
and nothing here can turn screening on that the PLATFORM turned off — ``apps/text`` keeps
``platform.enabled`` as the hard floor.

It returns the SOURCE as well as the answer because "this consultation ran without its guard" has
to be answerable from a record rather than reconstructed from three JSON columns afterwards.

Pure, total and dependency-free. Activity-side, like ``templating.py``: it carries no
replay-determinism obligation of its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = [
    "GUARDRAIL_DECISION_SOURCES",
    "GuardrailDecision",
    "guardrail_opt_out_of",
    "resolve_guardrail_decision",
]

GUARDRAIL_DECISION_SOURCES = ("node", "workflow", "agent", "default")


@dataclass(frozen=True)
class GuardrailDecision:
    """Whether guardrail screens this call, and WHICH level decided."""

    enabled: bool
    source: str


def _opinion(value: Any) -> bool | None:
    """A boolean is an opinion; everything else — ``None``, a string, a number — is silence.

    Defensive on purpose: a malformed value must never read as an opt-out. Publish refuses one
    (the node and agent schemas close their ``guardrail``/``guards`` objects), and a runtime that
    somehow saw one screens the call.
    """
    return value if isinstance(value, bool) else None


def resolve_guardrail_decision(
    *, node: Any = None, workflow: Any = None, agent: Any = None
) -> GuardrailDecision:
    """Fold the three levels into one decision: ``node > workflow > agent > True``."""
    for value, source in ((node, "node"), (workflow, "workflow"), (agent, "agent")):
        opinion = _opinion(value)
        if opinion is not None:
            return GuardrailDecision(enabled=opinion, source=source)
    return GuardrailDecision(enabled=True, source="default")


def guardrail_opt_out_of(config: Any) -> bool | None:
    """Read ``config.guardrail.enabled`` off an authored node config; ``None`` when it says
    nothing."""
    if not isinstance(config, dict):
        return None
    guardrail = config.get("guardrail")
    if not isinstance(guardrail, dict):
        return None
    return _opinion(guardrail.get("enabled"))
