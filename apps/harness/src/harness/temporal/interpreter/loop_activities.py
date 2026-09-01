"""The ONE activity an ``agentic.loop`` iteration runs besides its own nodes (TASK-848).

``AgenticLoopWorkflow`` runs exactly one iteration per generation and then
``continue_as_new``s, so everything it needs on the next iteration must be carried forward as
INPUT. This activity is what turns one iteration's raw product into that carry-forward, and it
lives in an activity rather than in the workflow body for three separate reasons:

* **The digest must see the whole blob.** ``noProgressIterations`` compares a sha256 over the
  canonical form of the iteration's product — which means holding a clinical deliberation's
  full text, exactly what the workflow body must not do.
* **The token read is a read of a provider-shaped dict.** Where usage lives is a property of the
  engine, not of the loop, and it is the kind of thing that changes without a graph change.
* **It is the seam the claim-check offload lands on (848b step 6).** Making it an activity now
  means that offload is an implementation change inside this function rather than a change to
  the workflow's command sequence.

Nothing here reads a clock, a random or a network, so it is also a PURE function of its input —
which is what makes the loop's bound arithmetic reproducible under replay.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from temporalio import activity

from harness.temporal.interpreter.models import LoopCheckpointInput, LoopStateCheckpoint

#: Where a provider's usage lands, in the order we look. Every entry is a key an engine in this
#: platform actually emits; an unknown shape contributes ZERO rather than a guess, because a
#: fabricated token count would silently relax the one bound that caps the invoice.
_USAGE_KEYS = ("usage", "tokenUsage", "token_usage")
_TOTAL_KEYS = ("total_tokens", "totalTokens")


def canonical_digest(value: Any) -> str:
    """sha256 over the canonical JSON form of ``value``. Pure.

    ``sort_keys`` is what makes this a digest of the CONTENT rather than of the dict ordering:
    two iterations that produced the same finding in a different key order have made no
    progress, and must not be able to fake some by re-ordering.
    """
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def extract_tokens(output: Any) -> int:
    """Total tokens this output reports, or 0 when it reports none. Pure.

    Never estimates. A provider that does not report usage contributes nothing to
    ``maxTotalTokens`` — an honest under-count, where an estimate would be an invented number
    the bound is then enforced against.
    """
    if not isinstance(output, dict):
        return 0
    for usage_key in _USAGE_KEYS:
        usage = output.get(usage_key)
        if not isinstance(usage, dict):
            continue
        for total_key in _TOTAL_KEYS:
            total = usage.get(total_key)
            if isinstance(total, bool):
                continue
            if isinstance(total, int):
                return max(total, 0)
    return 0


@activity.defn(name="interpreter.loop_state_checkpoint")
async def loop_state_checkpoint(payload: LoopCheckpointInput) -> LoopStateCheckpoint:
    """Fold one iteration's product into the next generation's carry-forward."""
    combined: dict[str, Any] = {"orchestrator": payload.orchestrator_output}
    if payload.sub_agent_outputs:
        combined["subAgents"] = payload.sub_agent_outputs

    tokens = extract_tokens(payload.orchestrator_output)
    for sub_output in payload.sub_agent_outputs:
        tokens += extract_tokens(sub_output)

    # The early exit is keyed on the ORCHESTRATOR's output alone. A worker cannot declare the
    # deliberation finished — only the master agent can, which is what makes this
    # orchestrator-workers rather than a swarm.
    terminated = False
    if payload.termination_key:
        terminated = bool(payload.orchestrator_output.get(payload.termination_key))

    return LoopStateCheckpoint(
        inline=combined,
        ref=None,  # 848b step 6 — see the module docstring.
        digest=canonical_digest(combined),
        tokens=tokens,
        terminated=terminated,
    )


LOOP_ACTIVITIES = [loop_state_checkpoint]
