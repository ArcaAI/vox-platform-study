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

from harness.core.config import get_settings
from harness.temporal.claim_check import ClaimCheckRef, load_blob, open_store, store_blob
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


# TASK-848b step 6 — the carry-forward offload threshold.
#
# Temporal's ceiling is 2 MB per payload / 4 MB per gRPC message, and the loop carries its ENTIRE
# memory as input on every generation. A clinical deliberation that accumulates transcript across
# iterations reaches that ceiling and the loop dies mid-run, which is the failure this exists to
# prevent. 256 KiB leaves an order of magnitude of headroom for the rest of `AgenticLoopInput`
# (bounds, node specs, seed inputs) rather than sailing close to the limit.
LOOP_STATE_INLINE_LIMIT_BYTES = 256 * 1024


@activity.defn(name="interpreter.loop_state_rehydrate")
async def loop_state_rehydrate(ref: ClaimCheckRef) -> Any:
    """Load a carry-forward that was offloaded by the previous iteration's checkpoint.

    An ACTIVITY because a workflow cannot do I/O. The loop calls it only when
    ``AgenticLoopState.ref`` is set, so an under-threshold loop pays nothing.

    Integrity failures propagate unmodified — `load_blob` raises on a size or sha256 mismatch, and
    a loop that silently resumed from a corrupted or substituted state would produce clinical
    output nobody could account for. Fail loud, exactly as `load_config` does.
    """
    settings = get_settings()
    store, _ = await open_store(settings.claim_check)
    raw = await load_blob(ref, store=store)
    return json.loads(raw)


async def _emit_iteration_event(
    payload: LoopCheckpointInput, *, digest: str, tokens: int, terminated: bool
) -> None:
    """Mirror this iteration onto the run's event stream. Best-effort, never raises.

    **Why here.** This is the ONE place that runs exactly once per loop iteration and is
    allowed to do I/O. Emitting from the workflow body would need a new activity — a new
    Temporal command per iteration, therefore a ``workflow.patched`` era and a recaptured
    replay fixture — to publish a fact this activity already holds. Emitting here changes no
    command sequence at all: activity bodies are never replayed.

    **Best-effort by contract**, exactly like the rest of the run-event lane
    (``run_events.py``'s module docstring, ``emit_run_events``' own guard). The durable record
    of this iteration is Temporal history; a Redis outage, or an envelope this run's ids cannot
    satisfy, costs the live view and nothing else. A checkpoint that failed because an
    observability mirror was unreachable would abort a clinical deliberation to protect a
    debug canvas.

    A run with no ``run_id`` simply does not stream — the fields are additive-optional, so a
    caller from before they existed (or a fixture-capture script) is silently a no-op rather
    than an error. Same posture ``agentic.tts`` takes on the delta lane.
    """
    if not payload.run_id:
        return
    # Imported inside the function for the reason `nodes/agentic.py` records at its own
    # function-local import: `activities.py` pulls in the whole node tree, and a module-level
    # import from here would be a needless heavy edge out of the loop's own module.
    from harness.temporal.interpreter.activities import run_event_producer  # noqa: PLC0415

    try:
        await run_event_producer().emit_loop_iteration(
            tenant_id=payload.tenant_id,
            run_id=payload.run_id,
            node_id=payload.node_id,
            iteration=payload.iteration,
            max_iterations=payload.max_iterations,
            tokens_used=payload.tokens_used_before + tokens,
            max_total_tokens=payload.max_total_tokens,
            digest=digest,
            terminated=terminated,
        )
    except Exception as exc:  # noqa: BLE001 — see the docstring: a mirror never fails the loop
        activity.logger.warning(
            "harness.run_events.loop_iteration_failed "
            f"run_id={payload.run_id} node_id={payload.node_id} "
            f"iteration={payload.iteration} error={exc}"
        )


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

    # TASK-848b step 6 — offload the carry-forward when it outgrows the inline budget.
    #
    # The digest is computed over `combined` either way, so the no-progress bound compares the
    # same value whether the state travelled inline or by reference. Offloading must never change
    # what "no progress" means.
    digest = canonical_digest(combined)
    serialized = json.dumps(combined)
    if len(serialized.encode("utf-8")) > LOOP_STATE_INLINE_LIMIT_BYTES:
        settings = get_settings()
        store, location = await open_store(settings.claim_check)
        ref = await store_blob(serialized, store=store, bucket=location.bucket)
        checkpoint = LoopStateCheckpoint(
            inline=None,
            ref=ref,
            digest=digest,
            tokens=tokens,
            terminated=terminated,
        )
    else:
        checkpoint = LoopStateCheckpoint(
            inline=combined,
            ref=None,
            digest=digest,
            tokens=tokens,
            terminated=terminated,
        )

    # LAST, and after the offload rather than before it: the event announces an iteration that
    # actually checkpointed. If `store_blob` raises, the activity retries and no event claimed
    # an iteration that did not settle. A retry that gets this far twice re-emits under the SAME
    # per-(run, node, iteration) idempotency key, which is exactly what that key is for.
    await _emit_iteration_event(payload, digest=digest, tokens=tokens, terminated=terminated)
    return checkpoint


LOOP_ACTIVITIES = [loop_state_checkpoint, loop_state_rehydrate]
