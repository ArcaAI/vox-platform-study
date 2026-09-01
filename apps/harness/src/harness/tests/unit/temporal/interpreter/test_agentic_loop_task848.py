"""The ``agentic.loop`` body: bounds, determinism, and history growth (TASK-848).

`test_agentic_nodes_task847.py` covers the loop node's CONTRACT and its pre-TASK-848 refusal to
run. This file covers what it does now that it runs — and it exercises the REAL
``AgenticLoopWorkflow``, the REAL bound arithmetic and the REAL ``continue_as_new`` boundary. Only
the model call is stubbed (`_agentic_loop_stubs.py`), because a bound is only proven if the thing
being bounded is the production code path.

Three properties here are worth more than the individual cases:

* **every stop reason is distinguishable.** A loop that stopped because it converged and a loop
  that was truncated by a ceiling must not report the same thing — see `TestBoundsAreDistinguishable`.
* **the loop touches no clock and no RNG.** `TestDeterminism` poisons `workflow.now` and
  `workflow.random` and dispatches anyway; a workflow that reads either cannot be replayed, which
  in this product means a clinical run that cannot be reproduced.
* **history stays bounded.** `TestHistoryStaysBounded` MEASURES it across iterations rather than
  asserting the shape of the code that is supposed to produce it.
"""

from __future__ import annotations

import hashlib
import json
import uuid

import pytest
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.loop_workflow import (
    AgenticLoopWorkflow,
    AgenticSubAgentWorkflow,
    agentic_loop_workflow_id,
)
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.workflow import WorkflowInterpreter

from ._agentic_loop_stubs import stub_agentic_agent, stub_agentic_agent_failing

_BUCKET = "harness-claim-check"
_LOOP_NODE = "n_loop"
_ORCHESTRATOR = "n_master"


def _body(
    *,
    bounds: dict,
    termination_key: str | None = None,
    stub_mode: str = "progress",
    stub_tokens: int = 0,
    terminate_at: int | None = None,
    sub_agent_ids: list[str] | None = None,
) -> dict:
    """One stage carrying the loop plus the orchestrator it names.

    The orchestrator is an ordinary stage node — that is how the contract says a loop body is
    authored, and it is why the interpreter has to skip it (see `reason="loop_body"`).
    """
    orchestrator_config: dict = {"_stub_mode": stub_mode, "_stub_tokens": stub_tokens}
    if terminate_at is not None:
        orchestrator_config["_stub_terminate_at"] = terminate_at

    loop_config: dict = {"bounds": bounds, "orchestratorNodeId": _ORCHESTRATOR}
    if termination_key is not None:
        loop_config["terminationKey"] = termination_key
    if sub_agent_ids is not None:
        loop_config["subAgentNodeIds"] = sub_agent_ids

    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "loop-test",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "consultation",
        "compiledAt": "2026-09-01T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": _ORCHESTRATOR,
                        "type": "agentic.agent",
                        "activity": "interpreter.agentic_agent",
                        "config": orchestrator_config,
                        "inputs": [],
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    },
                    {
                        "nodeId": _LOOP_NODE,
                        "type": "agentic.loop",
                        "activity": "interpreter.agentic_loop",
                        "config": loop_config,
                        "inputs": [],
                        "timeoutSeconds": 60,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    },
                ],
            }
        ],
        "gates": [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }


async def _config_ref(body: dict):
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )


@pytest.fixture
async def env():
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as environment:
        yield environment


async def _run(env, body: dict, *, orchestrator=stub_agentic_agent):
    """Run the interpreter over `body` and return (result, run_id)."""
    ref = await _config_ref(body)
    run_id = str(uuid.uuid4())
    tq = f"interp-loop-{uuid.uuid4()}"
    async with Worker(
        env.client,
        task_queue=tq,
        workflows=[
            WorkflowInterpreter,
            ConsultationGateWorkflow,
            AgenticLoopWorkflow,
            AgenticSubAgentWorkflow,
        ],
        # The stub registers under the REAL name `interpreter.agentic_agent` — that is what
        # makes this exercise the production dispatch path rather than a parallel one. Temporal
        # refuses two activities with the same name outright (it does not last-wins), so the real
        # one is filtered out rather than shadowed.
        activities=[
            *(a for a in INTERPRETER_ACTIVITIES if _activity_name(a) != "interpreter.agentic_agent"),
            # LOOP_ACTIVITIES rather than a hand-picked name: the loop gained
            # `loop_state_rehydrate` for the claim-check offload, and a hand-maintained list here
            # silently omitted it — the loop failed at runtime with the activity unregistered.
            # Referencing the production list means this cannot drift again.
            *LOOP_ACTIVITIES,
            orchestrator,
        ],
    ):
        handle = await env.client.start_workflow(
            WorkflowInterpreter.run,
            InterpreterInput(
                session_id="s-1",
                workflow_version_id="v-1",
                config_ref=ref,
                tenant_id="t-1",
                run_id=run_id,
                sandbox=False,
                payload={},
            ),
            id=f"wf-interp-{run_id}",
            task_queue=tq,
        )
        return await handle.result(), run_id


def _activity_name(fn) -> str:
    """The name an activity is registered under, from Temporal's own definition metadata."""
    defn = activity._Definition.must_from_callable(fn)
    return defn.name


def _node(result, node_id: str):
    for stage in result.stages:
        for node in stage.nodes:
            if node.node_id == node_id:
                return node
    return None


class TestBoundsAreDistinguishable:
    """Each bound stops the loop, and each says something DIFFERENT about why.

    This is the property the whole taxonomy rests on. A ceiling truncating a clinical
    deliberation and an orchestrator converging are opposite outcomes, and a caller that cannot
    tell them apart cannot act on either.
    """

    async def test_max_iterations_truncates_and_degrades(self, env):
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 3,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                }
            ),
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.status == "DEGRADED"
        assert loop.reason == "max_iterations"

    async def test_max_total_tokens_truncates_and_degrades(self, env):
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 99,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 250,
                    "noProgressIterations": 99,
                },
                stub_tokens=100,
            ),
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.status == "DEGRADED"
        assert loop.reason == "max_total_tokens"

    async def test_no_progress_is_CONVERGENCE_and_therefore_succeeds(self, env):
        """The one bound that is not a ceiling.

        An orchestrator emitting an identical answer twice has finished thinking, not run out of
        budget. Reporting that as DEGRADED would tell a clinician their documentation was
        truncated when it was complete.
        """
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 99,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 2,
                },
                stub_mode="frozen",
            ),
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.status == "SUCCEEDED"

    async def test_termination_key_succeeds(self, env):
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 99,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                },
                termination_key="done",
                terminate_at=2,
            ),
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.status == "SUCCEEDED", f"stopped for: {loop.reason}"

    async def test_an_orchestrator_that_cannot_run_is_its_own_reason(self, env):
        """`orchestrator_failed` must never be laundered into one of the four bounds — "the model
        was unreachable" and "the deliberation hit its ceiling" are different incidents."""
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 3,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                }
            ),
            orchestrator=stub_agentic_agent_failing,
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.status == "DEGRADED"
        assert loop.reason not in ("max_iterations", "max_total_tokens", "no_progress_iterations")

    async def test_every_stop_reason_observed_here_is_unique(self, env):
        """The cases above, read together: no two outcomes share a (status, reason) pair."""
        seen: list[tuple[str, str | None]] = []
        for bounds, kwargs in (
            (
                {
                    "maxIterations": 2,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                },
                {},
            ),
            (
                {
                    "maxIterations": 99,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 150,
                    "noProgressIterations": 99,
                },
                {"stub_tokens": 100},
            ),
            (
                {
                    "maxIterations": 99,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 2,
                },
                {"stub_mode": "frozen"},
            ),
        ):
            result, _ = await _run(env, _body(bounds=bounds, **kwargs))
            loop = _node(result, _LOOP_NODE)
            assert loop is not None
            seen.append((loop.status, loop.reason))
        assert len(set(seen)) == len(seen), f"stop outcomes collide: {seen}"


class TestTheStageWalkDefersToTheLoop:
    """The orchestrator is an ordinary stage node. It must run ONLY inside the loop."""

    async def test_the_orchestrator_is_skipped_by_the_walk_with_an_observable_reason(self, env):
        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 2,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                }
            ),
        )
        orchestrator = _node(result, _ORCHESTRATOR)
        assert orchestrator is not None
        assert orchestrator.status == "SKIPPED"
        assert orchestrator.reason == "loop_body"

    async def test_a_declared_sub_agent_is_also_deferred(self, env):
        body = _body(
            bounds={
                "maxIterations": 2,
                "maxDurationSeconds": 300,
                "maxTotalTokens": 1_000_000,
                "noProgressIterations": 99,
            },
            sub_agent_ids=["n_worker"],
        )
        body["stages"][0]["nodes"].append(
            {
                "nodeId": "n_worker",
                "type": "agentic.agent",
                "activity": "interpreter.agentic_agent",
                "config": {"_stub_mode": "progress"},
                "inputs": [],
                "timeoutSeconds": 30,
                "retry": {
                    "maximumAttempts": 1,
                    "initialIntervalSeconds": 1,
                    "backoffCoefficient": 2,
                },
                "onError": "degrade",
                "emitsTrajectory": True,
            }
        )
        result, _ = await _run(env, body)
        worker_node = _node(result, "n_worker")
        assert worker_node is not None
        assert worker_node.status == "SKIPPED"
        assert worker_node.reason == "loop_body"


class TestDeterminism:
    """The loop must read no clock and no RNG.

    A workflow that reads either cannot be replayed, and in this product an unreplayable run is a
    clinical deliberation that cannot be reproduced. Asserting "we did not call it" by reading the
    source is not evidence; poisoning the calls and running anyway is.
    """

    async def test_the_loop_path_touches_neither_clock_nor_rng(self, env, monkeypatch):
        import temporalio.workflow as temporal_workflow

        def _poisoned(*_args, **_kwargs):  # pragma: no cover - raising IS the assertion
            raise AssertionError(
                "the loop read a clock or an RNG inside @workflow.defn — that breaks replay"
            )

        monkeypatch.setattr(temporal_workflow, "now", _poisoned, raising=False)
        monkeypatch.setattr(temporal_workflow, "random", _poisoned, raising=False)
        monkeypatch.setattr(temporal_workflow, "uuid4", _poisoned, raising=False)

        result, _ = await _run(
            env,
            _body(
                bounds={
                    "maxIterations": 3,
                    "maxDurationSeconds": 300,
                    "maxTotalTokens": 1_000_000,
                    "noProgressIterations": 99,
                }
            ),
        )
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.reason == "max_iterations"

    async def test_the_child_workflow_id_is_derived_not_random(self):
        """One id for the whole continue_as_new chain, derived from the parent's run id.

        A uuid here would produce a different id on every replay, which is the same defect as
        reading a clock — it just fails later and less obviously.
        """
        first = agentic_loop_workflow_id("run-1", "n_loop")
        second = agentic_loop_workflow_id("run-1", "n_loop")
        assert first == second
        assert agentic_loop_workflow_id("run-2", "n_loop") != first
        # The iteration must NOT appear: continue-as-new keeps the workflow id and changes only
        # the run id, so an iteration-suffixed id would start a new chain every generation.
        assert "0" not in first.removeprefix("agentic-loop-run-1-")


class TestHistoryStaysBounded:
    """`continue_as_new` per iteration is what keeps a long loop's history flat.

    MEASURED, not asserted from the shape of the code: a loop that runs N times as long must not
    produce a history N times as large, or a long deliberation eventually exceeds Temporal's
    history limits and dies mid-run.
    """

    @staticmethod
    async def _final_history_length(env, run_id: str, node_id: str) -> int:
        handle = env.client.get_workflow_handle(agentic_loop_workflow_id(run_id, node_id))
        events = [event async for event in handle.fetch_history_events()]
        return len(events)

    async def test_a_longer_loop_does_not_grow_its_history_proportionally(self, env):
        def _bounds(iterations: int) -> dict:
            return {
                "maxIterations": iterations,
                "maxDurationSeconds": 300,
                "maxTotalTokens": 1_000_000,
                "noProgressIterations": 99,
            }

        _, short_run = await _run(env, _body(bounds=_bounds(2)))
        _, long_run = await _run(env, _body(bounds=_bounds(8)))

        short_len = await self._final_history_length(env, short_run, _LOOP_NODE)
        long_len = await self._final_history_length(env, long_run, _LOOP_NODE)

        # Four times the iterations. Without continue_as_new the final history would carry every
        # iteration's events; with it, each generation starts fresh and only the LAST one is
        # visible here. The bound is deliberately generous — this test is about the SHAPE of the
        # growth (flat, not linear), and pinning an exact event count would break on any
        # unrelated change to how one iteration is recorded.
        assert short_len > 0 and long_len > 0, (
            f"nothing was measured: {short_len}/{long_len} events — a history test that reads "
            "zero events proves nothing"
        )
        assert long_len < short_len * 2, (
            f"history grew with iteration count: {short_len} events for 2 iterations, "
            f"{long_len} for 8 — continue_as_new is not bounding it"
        )


class TestCarryForwardOffload:
    """A loop carries its ENTIRE memory as workflow input on every generation.

    Temporal's ceiling is 2 MB per payload. A clinical deliberation that accumulates transcript
    across iterations reaches it and the loop dies mid-run — so above a threshold the carry-forward
    goes to object storage and only the claim-check ref travels.
    """

    async def test_a_large_carry_forward_is_offloaded_and_rehydrated(self, env):
        """The loop must still advance when its state travelled by reference.

        `_stub_bulk` makes one iteration's output exceed the inline budget, so iteration 2 can only
        read the previous `n` if the ref was stored, carried and resolved. Asserting the loop
        reached its iteration ceiling proves the whole round trip, because a broken rehydrate
        would reset `n` to 0 every time and the loop would look frozen instead.
        """
        body = _body(
            bounds={
                "maxIterations": 3,
                "maxDurationSeconds": 300,
                "maxTotalTokens": 1_000_000,
                "noProgressIterations": 99,
            }
        )
        # Bigger than LOOP_STATE_INLINE_LIMIT_BYTES, so the checkpoint must offload.
        body["stages"][0]["nodes"][0]["config"]["_stub_bulk_bytes"] = 300 * 1024

        result, _ = await _run(env, body)
        loop = _node(result, _LOOP_NODE)
        assert loop is not None
        assert loop.reason == "max_iterations", (
            f"the loop did not advance through an offloaded carry-forward: {loop.reason}"
        )

    async def test_the_threshold_is_a_real_boundary_not_always_on(self, env):
        """A small loop must NOT pay for object storage it does not need."""
        from harness.temporal.interpreter.loop_activities import (
            LOOP_STATE_INLINE_LIMIT_BYTES,
            loop_state_checkpoint,
        )
        from harness.temporal.interpreter.models import LoopCheckpointInput

        small = await loop_state_checkpoint(
            LoopCheckpointInput(orchestrator_output={"text": "short"}, sub_agent_outputs=[])
        )
        assert small.inline is not None and small.ref is None

        big = await loop_state_checkpoint(
            LoopCheckpointInput(
                orchestrator_output={"text": "x" * (LOOP_STATE_INLINE_LIMIT_BYTES + 1)},
                sub_agent_outputs=[],
            )
        )
        assert big.ref is not None and big.inline is None

    async def test_offloading_does_not_change_what_no_progress_means(self, env):
        """The digest is computed over the same value either way.

        If offloading changed the digest, a converged loop would stop looking converged the moment
        its state grew — the bound would silently stop working at exactly the scale it matters.
        """
        from harness.temporal.interpreter.loop_activities import (
            LOOP_STATE_INLINE_LIMIT_BYTES,
            loop_state_checkpoint,
        )
        from harness.temporal.interpreter.models import LoopCheckpointInput

        payload = {"text": "y" * (LOOP_STATE_INLINE_LIMIT_BYTES + 1)}
        first = await loop_state_checkpoint(
            LoopCheckpointInput(orchestrator_output=payload, sub_agent_outputs=[])
        )
        second = await loop_state_checkpoint(
            LoopCheckpointInput(orchestrator_output=dict(payload), sub_agent_outputs=[])
        )
        assert first.ref is not None
        assert first.digest == second.digest
