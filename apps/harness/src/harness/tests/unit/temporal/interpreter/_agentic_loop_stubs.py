"""Programmable stub activities for the ``agentic.loop`` workflow tests (TASK-848).

Registers under the SAME activity name the real registry dispatches for an
``agentic.agent`` node (``interpreter.agentic_agent``), so a test worker built from these
exercises the REAL loop workflow, the REAL bound arithmetic and the REAL ``continue_as_new``
boundary — only the model call is replaced. Same technique, and the same reason, as
``_loop_stubs.py`` does for ``ConsultationLoopWorkflow``: the harness suite is hermetic
(rule 06 §Pitfalls), and a bound is only proven if the thing being bounded is the production
code path.

Not collected by pytest (does not match ``test_*``).

The stub reads THREE keys off the node config, all prefixed ``_stub_`` so they can never be
mistaken for the tenant-authored schema:

``_stub_mode``
    ``progress`` (default) — emits a NEW value every iteration, so the no-progress bound never
    trips and another bound must be the one that stops the loop.
    ``frozen`` — emits the IDENTICAL value every iteration: the converged-but-still-paraphrasing
    orchestrator ``noProgressIterations`` exists to catch.
``_stub_tokens``
    Tokens this call reports, in the provider-shaped ``usage`` dict the real ``agentic.agent``
    output carries.
``_stub_terminate_at``
    Iteration at which the stub sets the loop's ``terminationKey`` truthy.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult


def _previous_iteration(payload: NodeActivityInput) -> int:
    """How many iterations the loop has already threaded into this orchestrator.

    The loop hands the previous orchestrator output back on the ``in`` port, so the counter
    lives in the DATA rather than in the stub — which is what makes the stub itself stateless
    and therefore safe under Temporal activity retries.
    """
    previous = payload.bound_inputs.get("in")
    if not isinstance(previous, dict):
        return 0
    # The carry-forward is an ENVELOPE, not the bare orchestrator output:
    # `loop_state_checkpoint` folds one iteration into `{"orchestrator": ..., "subAgents": [...]}`
    # so a worker's product is addressable alongside the master's. Reading `n` straight off `in`
    # silently always returns 0 — which looks like a loop that never advances rather than a stub
    # that is looking in the wrong place.
    orchestrator = previous.get("orchestrator")
    source = orchestrator if isinstance(orchestrator, dict) else previous
    value = source.get("n")
    return value if isinstance(value, int) else 0


@activity.defn(name="interpreter.agentic_agent")
async def stub_agentic_agent(payload: NodeActivityInput) -> NodeActivityResult:
    config: dict[str, Any] = payload.config
    mode = config.get("_stub_mode", "progress")
    tokens = int(config.get("_stub_tokens", 0))
    n = _previous_iteration(payload) + 1

    if mode == "frozen":
        # Byte-identical every iteration => identical digest => the no-progress streak grows.
        output: dict[str, Any] = {"text": "converged", "usage": {"total_tokens": tokens}}
    else:
        output = {"text": f"draft-{n}", "n": n, "usage": {"total_tokens": tokens}}

    bulk_bytes = config.get("_stub_bulk_bytes")
    if isinstance(bulk_bytes, int) and bulk_bytes > 0:
        # Pushes the carry-forward past the inline budget so the checkpoint must offload it.
        output["bulk"] = "z" * bulk_bytes

    terminate_at = config.get("_stub_terminate_at")
    if isinstance(terminate_at, int) and n >= terminate_at:
        output["done"] = True

    return NodeActivityResult(status="SUCCEEDED", output=output)


@activity.defn(name="interpreter.agentic_agent")
async def stub_agentic_agent_failing(payload: NodeActivityInput) -> NodeActivityResult:
    """An orchestrator that cannot run. Proves ``orchestrator_failed`` is its own stop reason
    and is never laundered into one of the four bounds."""
    raise RuntimeError("stub orchestrator: simulated failure")
