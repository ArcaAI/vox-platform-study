"""AgenticLoopWorkflow + AgenticSubAgentWorkflow — the agentic.loop body.

shipped the CONTRACT (four bounds, an orchestrator reference, sub-agent references, a
truthiness-keyed early exit) and an activity that observably refused to run. This module is the
body, and it is the FIRST construct in this substrate that iterates.

## One iteration per generation

``AgenticLoopWorkflow`` runs **exactly one iteration** and then ``continue_as_new``s. That is
the whole shape, and it is what keeps history bounded: an iteration appends a fixed, small number
of events (one orchestrator activity, N sub-agent child workflows, one checkpoint activity), and
``continue_as_new`` starts the next generation with a FRESH history rather than appending to the
old one. A loop that runs 100 iterations therefore has 100 short histories, not one history 100
times as long. This is measured, not asserted — see
``tests/unit/temporal/interpreter/test_agentic_loop_task848.py::TestHistoryStaysBounded``.

The price of that shape is that the loop has **no memory except its input**: anything needed on
the next iteration is carried on ``AgenticLoopInput.state``. Every field on
``AgenticLoopState`` exists for that reason and no other.

## The four bounds, and why one of them is not here

Three bounds are pure arithmetic over the carried state, so they live in this workflow and are
checked by ONE pure function (``exhausted_bound``) at two points — on entry, against the state
this generation was handed, and after the iteration, against the state the next generation would
be handed:

===========================  =====================================================
``maxIterations``            ``state.iterations``
``maxTotalTokens``           ``state.tokens_used`` (orchestrator + every sub-agent)
``noProgressIterations``     ``state.no_progress_streak``, from the checkpoint digest
===========================  =====================================================

``maxDurationSeconds`` **cannot be one of them, and this is the design finding that shapes the
whole file.** A workflow timer does not survive ``continue_as_new``: the new generation starts
with no timers, so a deadline set in generation 1 is simply gone by generation 2. The only way
to "carry" a deadline across the boundary would be to record an absolute instant and compare it
to the current time — a wall-clock read inside ``@workflow.defn``, which is exactly what rule 06
forbids and what would make a clinical run non-reproducible under replay.

So that bound is **owned by the PARENT**. ``WorkflowInterpreter`` starts this loop as a child and
races the child handle against its own ``asyncio.sleep`` — a Temporal workflow timer in a
workflow that is never continued-as-new, so it spans the entire generation chain. See
``workflow.py::_run_loop``.

## Stop reasons are DISTINGUISHABLE, and their priority is fixed

Six reasons, never collapsed into each other. When two bounds are exhausted on the same
iteration the order in ``exhausted_bound`` decides, and it is fixed rather than incidental so
the same loop always reports the same reason: **iterations, then tokens, then no-progress** —
cheapest-to-explain first. ``termination_key`` outranks all three (the author's own exit
condition fired, which is a converged loop, not a truncated one), and ``orchestrator_failed`` is
never reachable from a bound at all: a master agent that could not run is reported as such and is
never laundered into "it ran out of iterations".

## Sub-agents are CHILD WORKFLOWS

Not activities. Each gets its own history and its own retry envelope, which buys two things an
activity cannot: a worker that thrashes fills its OWN history rather than the orchestrator's, and
a worker that fails is a child-level failure the loop absorbs (counted, carried, never hidden)
rather than a workflow-task failure that wedges the loop.

## Determinism

No ``datetime.now``, no ``random``, no ``uuid4``, no ``os.environ``, no I/O anywhere in this
module. Child workflow ids are derived from ``(run_id, loop node id, sub-agent node id,
iteration)``, all of which are already in the input. A poison test monkeypatches
``workflow.now``/``workflow.random`` to raise and drives a full multi-iteration loop through
them.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter.loop_activities import loop_state_checkpoint
    from harness.temporal.interpreter.models import (
        AgenticLoopBounds,
        AgenticLoopInput,
        AgenticLoopNodeSpec,
        AgenticLoopResult,
        AgenticLoopState,
        AgenticSubAgentInput,
        LoopCheckpointInput,
        LoopStateCheckpoint,
        LoopStopReason,
        NodeActivityInput,
        NodeActivityResult,
    )
    from harness.temporal.interpreter.registry import NODE_REGISTRY
    from harness.temporal.models import TrajectoryContext

#: The checkpoint is small, pure and local — a short timeout with a couple of attempts is the
#: right envelope. It is deliberately NOT the orchestrator's envelope: a slow model must not
#: make the bookkeeping look flaky.
_CHECKPOINT_TIMEOUT = timedelta(seconds=30)
_CHECKPOINT_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))

AGENTIC_LOOP_WORKFLOW_ID_PREFIX = "agentic-loop-"
AGENTIC_SUB_AGENT_WORKFLOW_ID_PREFIX = "agentic-subagent-"


def agentic_loop_workflow_id(run_id: str, node_id: str) -> str:
    """The loop child's deterministic workflow id (pure).

    ONE id for the whole ``continue_as_new`` chain — that is what continue-as-new means: the
    chain keeps the workflow id and only the run id changes. The iteration number must NOT
    appear here (it does appear in the sub-agent ids below, which are genuinely different
    executions).
    """
    return f"{AGENTIC_LOOP_WORKFLOW_ID_PREFIX}{run_id}-{node_id}"


def agentic_sub_agent_workflow_id(
    run_id: str, loop_node_id: str, sub_agent_node_id: str, iteration: int
) -> str:
    """One sub-agent, one iteration — a distinct execution each time (pure).

    The iteration IS part of the id: the same worker node runs again on the next iteration, and
    Temporal would reject a second start under an id already used. Deriving it from the carried
    iteration counter rather than from a uuid is what keeps this replay-safe.
    """
    return (
        f"{AGENTIC_SUB_AGENT_WORKFLOW_ID_PREFIX}{run_id}-{loop_node_id}"
        f"-{sub_agent_node_id}-{iteration}"
    )


def exhausted_bound(state: AgenticLoopState, bounds: AgenticLoopBounds) -> LoopStopReason | None:
    """Which of the three CARRIED bounds is exhausted, or ``None``. Pure.

    Fixed priority (see the module docstring): iterations, tokens, no-progress. ``>=`` rather
    than ``>`` throughout, because the counters record work already DONE — a loop that has run
    ``maxIterations`` iterations has spent its budget, it does not get one more.

    ``maxDurationSeconds`` is absent by design and is the parent's; see the module docstring.
    """
    if state.iterations >= bounds.max_iterations:
        return "max_iterations"
    if state.tokens_used >= bounds.max_total_tokens:
        return "max_total_tokens"
    if state.no_progress_streak >= bounds.no_progress_iterations:
        return "no_progress_iterations"
    return None


def _result(
    inp: AgenticLoopInput, state: AgenticLoopState, reason: LoopStopReason
) -> AgenticLoopResult:
    """The loop's terminal record. Pure.

    ``result`` is the last iteration's product, whatever the reason — a loop stopped by a bound
    still made whatever it made, and discarding it would throw away work a clinician may need to
    see. What it never does is claim a reason it did not have.
    """
    return AgenticLoopResult(
        node_id=inp.node_id,
        stop_reason=reason,
        iterations=state.iterations,
        tokens_used=state.tokens_used,
        result=state.inline,
        sub_agent_failures=state.sub_agent_failures,
    )


@workflow.defn(name="AgenticLoop")
class AgenticLoopWorkflow:
    """One iteration, then ``continue_as_new``. See the module docstring."""

    @workflow.run
    async def run(self, inp: AgenticLoopInput) -> AgenticLoopResult:
        # 1) The bounds this generation INHERITED. A loop whose budget was already spent stops
        # here without running anything — which is also what makes `maxIterations: 1` mean one
        # iteration rather than two.
        inherited = exhausted_bound(inp.state, inp.bounds)
        if inherited is not None:
            return _result(inp, inp.state, inherited)

        # 2) The ORCHESTRATOR decides. Its seed arrives on iteration 0 only; from then on it
        # reads the previous iteration's product, which is what makes this a loop rather than a
        # fan-out repeated N times.
        # b step 6 — the carry-forward may have been OFFLOADED by the previous
        # iteration's checkpoint. A workflow cannot load a blob, so rehydration is an activity;
        # it runs only when a ref is actually set, so an under-threshold loop pays nothing.
        carried: Any = inp.state.inline
        if inp.state.ref is not None:
            carried = await workflow.execute_activity(
                "interpreter.loop_state_rehydrate",
                inp.state.ref,
                start_to_close_timeout=_CHECKPOINT_TIMEOUT,
                retry_policy=_CHECKPOINT_RETRY,
            )

        bound_inputs = dict(inp.seed_inputs) if inp.state.iterations == 0 else {"in": carried}
        orchestrator_output = await self._run_node(
            inp, inp.orchestrator, bound_inputs, stage_id="orchestrator"
        )
        if orchestrator_output is None:
            # Never a bound. A master agent that could not run is its own outcome.
            return _result(inp, inp.state, "orchestrator_failed")

        # 3) The WORKERS execute, under the orchestrator's own output. All-settled: one worker
        # failing does not cancel its siblings, and does not end the loop.
        sub_outputs: list[dict[str, Any]] = []
        failures = 0
        if inp.sub_agents:
            settled = await asyncio.gather(
                *(
                    self._run_sub_agent(inp, sub_agent, orchestrator_output)
                    for sub_agent in inp.sub_agents
                )
            )
            for output in settled:
                if output is None:
                    failures += 1
                else:
                    sub_outputs.append(output)

        # 4) Fold the iteration into the next generation's carry-forward.
        checkpoint: LoopStateCheckpoint = await workflow.execute_activity(
            loop_state_checkpoint,
            LoopCheckpointInput(
                orchestrator_output=orchestrator_output,
                sub_agent_outputs=sub_outputs,
                termination_key=inp.termination_key,
                # Identity + counters for the `workflow.loop.iteration` run event the
                # checkpoint emits. These are INPUT fields on a command that was already being
                # issued, so the command sequence is untouched and no `workflow.patched` era is
                # needed — the emission itself happens inside the activity, which is never
                # replayed. All of it is already in this generation's input: no clock, no RNG,
                # no read that could differ on replay.
                run_id=inp.run_id,
                node_id=inp.node_id,
                tenant_id=inp.tenant_id,
                # ONE-BASED and naming the iteration that is completing: `state.iterations` is
                # the count of iterations finished BEFORE this one, so the first pass reports
                # `1`. That is what makes the client's `3/12` read as the third iteration.
                iteration=inp.state.iterations + 1,
                max_iterations=inp.bounds.max_iterations,
                max_total_tokens=inp.bounds.max_total_tokens,
                tokens_used_before=inp.state.tokens_used,
            ),
            start_to_close_timeout=_CHECKPOINT_TIMEOUT,
            retry_policy=_CHECKPOINT_RETRY,
        )

        next_state = AgenticLoopState(
            iterations=inp.state.iterations + 1,
            tokens_used=inp.state.tokens_used + checkpoint.tokens,
            # An identical digest means the iteration produced nothing new. The streak RESETS on
            # progress rather than accumulating, so `noProgressIterations` means "N consecutive",
            # exactly as the schema's own description says.
            no_progress_streak=(
                0 if checkpoint.digest != inp.state.digest else inp.state.no_progress_streak + 1
            ),
            digest=checkpoint.digest,
            inline=checkpoint.inline,
            ref=checkpoint.ref,
            sub_agent_failures=inp.state.sub_agent_failures + failures,
        )

        # 5) The author's own exit outranks every bound: this loop converged, it was not cut off.
        if checkpoint.terminated:
            return _result(inp, next_state, "termination_key")

        spent = exhausted_bound(next_state, inp.bounds)
        if spent is not None:
            return _result(inp, next_state, spent)

        # 6) A FRESH history for the next iteration. Never returns.
        workflow.continue_as_new(inp.model_copy(update={"state": next_state}))

    async def _run_node(
        self,
        inp: AgenticLoopInput,
        node: AgenticLoopNodeSpec,
        bound_inputs: dict[str, Any],
        *,
        stage_id: str,
    ) -> dict[str, Any] | None:
        """Run ONE loop-body node as an activity. ``None`` means it did not produce.

        S-4 applies here exactly as it does in the interpreter: the callable comes from the
        registry, and the wire's activity string is only ever a consistency check.
        """
        spec = NODE_REGISTRY.get(node.node_type)
        if spec is None or not spec.implemented:
            return None
        if node.activity_name != spec.activity_name:
            return None
        if inp.sandbox and spec.external_write:
            return None

        try:
            result: NodeActivityResult = await workflow.execute_activity(
                spec.activity,
                NodeActivityInput(
                    node_id=node.node_id,
                    node_type=node.node_type,
                    config=node.config,
                    tenant_id=inp.tenant_id,
                    sandbox=inp.sandbox,
                    trajectory=TrajectoryContext(
                        tenant_id=inp.tenant_id,
                        # The iteration IS the sequence here: a loop emits one trajectory row per
                        # body node per iteration, and the counter is carried state, never a
                        # clock.
                        seq=inp.state.iterations,
                        workflow_version_id=inp.workflow_version_id,
                        stage_id=stage_id,
                        node_id=node.node_id,
                        node_type=node.node_type,
                    ),
                    bound_inputs=bound_inputs,
                    run_payload=inp.run_payload,
                ),
                start_to_close_timeout=timedelta(seconds=node.timeout_seconds),
                retry_policy=RetryPolicy(maximum_attempts=node.max_attempts),
            )
        except ActivityError:
            return None

        if result.status != "SUCCEEDED":
            return None
        return result.output or {}

    async def _run_sub_agent(
        self, inp: AgenticLoopInput, node: AgenticLoopNodeSpec, orchestrator_output: dict[str, Any]
    ) -> dict[str, Any] | None:
        """One worker, as a CHILD WORKFLOW. ``None`` means it did not produce."""
        try:
            result: NodeActivityResult = await workflow.execute_child_workflow(
                AgenticSubAgentWorkflow.run,
                AgenticSubAgentInput(
                    node=node,
                    tenant_id=inp.tenant_id,
                    sandbox=inp.sandbox,
                    iteration=inp.state.iterations,
                    bound_inputs={"in": orchestrator_output},
                    run_payload=inp.run_payload,
                    trajectory=TrajectoryContext(
                        tenant_id=inp.tenant_id,
                        seq=inp.state.iterations,
                        workflow_version_id=inp.workflow_version_id,
                        stage_id="sub_agent",
                        node_id=node.node_id,
                        node_type=node.node_type,
                    ),
                ),
                id=agentic_sub_agent_workflow_id(
                    inp.run_id, inp.node_id, node.node_id, inp.state.iterations
                ),
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            # A worker that could not run is COUNTED, never fatal and never invented. The
            # orchestrator sees one fewer finding on the next iteration and is free to route
            # around it; the count travels on the result so the outcome is not silently clean.
            return None

        if result.status != "SUCCEEDED":
            return None
        return result.output or {}


@workflow.defn(name="AgenticSubAgent")
class AgenticSubAgentWorkflow:
    """ONE sub-agent, ONE iteration — its own history, its own retry envelope.

    Deliberately thin: it repeats the interpreter's own registry cross-check and sandbox
    suppression and then runs the node's activity. It holds no loop logic, because a worker that
    could iterate on its own would be a second orchestrator.
    """

    @workflow.run
    async def run(self, inp: AgenticSubAgentInput) -> NodeActivityResult:
        spec = NODE_REGISTRY.get(inp.node.node_type)
        if spec is None or not spec.implemented:
            return NodeActivityResult(status="SKIPPED", reason="unsupported_node_type")
        # S-4 — the registry decides what runs; the wire's activity string is only a check.
        if inp.node.activity_name != spec.activity_name:
            return NodeActivityResult(status="SKIPPED", reason="activity_mismatch")
        if inp.sandbox and spec.external_write:
            return NodeActivityResult(status="SKIPPED", reason="sandbox")

        return await workflow.execute_activity(
            spec.activity,
            NodeActivityInput(
                node_id=inp.node.node_id,
                node_type=inp.node.node_type,
                config=inp.node.config,
                tenant_id=inp.tenant_id,
                sandbox=inp.sandbox,
                trajectory=inp.trajectory,
                bound_inputs=inp.bound_inputs,
                run_payload=inp.run_payload,
            ),
            start_to_close_timeout=timedelta(seconds=inp.node.timeout_seconds),
            retry_policy=RetryPolicy(maximum_attempts=inp.node.max_attempts),
        )
