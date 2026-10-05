"""TASK-1038 R-5 (retries) and D-H (a DEGRADED node's output is kept).

R-5. Before: every node activity was scheduled with ``RetryPolicy(maximum_attempts=n)`` and
nothing else — the compiled per-node backoff (``initialIntervalSeconds`` /
``backoffCoefficient``) was ignored, and a deterministic refusal (a gateway 4xx, a schema
violation) was retried n times with the identical input before the node could settle. Now the
compiled backoff is honoured and deterministic failures are ``non_retryable_error_types``.

D-H. Before: the walk stored a node's output only when it SUCCEEDED. A ``core.agent`` that
generated (and billed) a note but degraded afterwards — e.g. the finalized-note persist failed —
returned that note with ``DEGRADED`` and the walk threw it away, so the review gate and the output
node downstream bound nothing. Now the output is kept, marked ``_degraded``.
"""

from __future__ import annotations

import pytest
from temporalio.api.enums.v1 import EventType

from harness.tests.unit.temporal.interpreter import _task1038_harness as h

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture(autouse=True)
def _reset():
    h.reset()
    yield
    h.reset()


def _scheduled_retry_policy(history, activity_type: str):
    for event in history.events:
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
            attrs = event.activity_task_scheduled_event_attributes
            if attrs.activity_type.name == activity_type:
                return attrs.retry_policy
    raise AssertionError(f"{activity_type} was never scheduled")


def _single_agent_graph(**config) -> dict:
    return h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [h.agent("n_agent", inputs=[h.edge("n_trigger", "out", "in")], **config)],
            },
        ]
    )


class TestRetryPolicy:
    @pytest.mark.asyncio
    async def test_a_gateway_4xx_is_not_retried(self):
        retry = {"maximumAttempts": 3, "initialIntervalSeconds": 1, "backoffCoefficient": 2}
        _, nodes, _ = await h.run_graph(_single_agent_graph(_stub="client_error", _retry=retry))

        assert h.ATTEMPTS["n_agent"] == 1
        assert nodes["n_agent"].status == "DEGRADED"
        assert "ApiClientError" in (nodes["n_agent"].reason or "")

    @pytest.mark.asyncio
    async def test_a_transient_failure_is_still_retried_up_to_the_compiled_attempts(self):
        retry = {"maximumAttempts": 3, "initialIntervalSeconds": 1, "backoffCoefficient": 2}
        _, nodes, _ = await h.run_graph(_single_agent_graph(_stub="transient", _retry=retry))

        assert h.ATTEMPTS["n_agent"] == 3
        assert nodes["n_agent"].status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_the_compiled_backoff_and_the_non_retryable_types_are_scheduled(self):
        retry = {"maximumAttempts": 4, "initialIntervalSeconds": 7, "backoffCoefficient": 3}
        _, _, history = await h.run_graph(_single_agent_graph(_retry=retry))

        policy = _scheduled_retry_policy(history, "interpreter.core_agent")
        assert policy.maximum_attempts == 4
        assert policy.initial_interval.seconds == 7
        assert policy.backoff_coefficient == 3
        assert {
            "ApiClientError",
            "ValidationError",
            "ClaimCheckIntegrityError",
            "PAYLOAD_TOO_LARGE",
        } <= set(policy.non_retryable_error_types)


class TestDegradedOutputIsKept:
    @pytest.mark.asyncio
    async def test_a_degraded_node_s_output_reaches_its_consumer(self):
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        h.agent(
                            "n_finalize",
                            _stub="degraded_with_output",
                            inputs=[h.edge("n_trigger", "out", "in")],
                        )
                    ],
                },
                {
                    "stageIndex": 2,
                    "nodes": [
                        h.agent("n_after", _stub="echo", inputs=[h.edge("n_finalize", "out", "in")])
                    ],
                },
            ]
        )
        result, nodes, _ = await h.run_graph(graph)

        assert nodes["n_finalize"].status == "DEGRADED"
        assert nodes["n_after"].status == "SUCCEEDED"
        # The note that was generated (and billed) is no longer thrown away.
        assert h.SEEN["n_after"].bound_inputs == {"in": "kept-n_finalize"}
        # ...and the run context marks it as a degraded output, so a template can tell.
        degraded = h.SEEN["n_after"].run_context["nodes"]["n_finalize"]
        assert degraded["text"] == "kept-n_finalize"
        assert degraded["_degraded"] == {"reason": "core.agent: persist failed (stub)"}
        assert result.status == "DEGRADED"

    @pytest.mark.asyncio
    async def test_a_degraded_node_without_an_output_still_binds_nothing(self):
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        h.agent(
                            "n_finalize",
                            _stub="client_error",
                            inputs=[h.edge("n_trigger", "out", "in")],
                        )
                    ],
                },
                {
                    "stageIndex": 2,
                    "nodes": [
                        h.agent("n_after", _stub="echo", inputs=[h.edge("n_finalize", "out", "in")])
                    ],
                },
            ]
        )
        _, _, _ = await h.run_graph(graph)

        assert h.SEEN["n_after"].bound_inputs == {}


def _final_attempt(history, activity_type: str) -> int:
    scheduled: dict[int, str] = {}
    attempt = 0
    for event in history.events:
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
            scheduled[event.event_id] = (
                event.activity_task_scheduled_event_attributes.activity_type.name
            )
        elif event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED:
            attrs = event.activity_task_started_event_attributes
            if scheduled.get(attrs.scheduled_event_id) == activity_type:
                attempt = attrs.attempt
    return attempt


class TestSchemaViolationsAreTerminal:
    @pytest.mark.asyncio
    async def test_an_output_schema_violation_fails_on_the_first_attempt(self):
        out = h.output([h.edge("n_trigger", "out", "in")])
        out["config"]["outputSchema"] = {"type": "object", "required": ["case_note"]}
        out["retry"] = {"maximumAttempts": 3, "initialIntervalSeconds": 1, "backoffCoefficient": 2}
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {"stageIndex": 1, "nodes": [out]},
            ]
        )
        result, nodes, history = await h.run_graph(graph, payload={"q": 1})

        assert nodes["n_output"].status == "FAILED"
        assert "OutputSchemaViolation" in (nodes["n_output"].reason or "")
        assert _final_attempt(history, "interpreter.core_output") == 1
        assert result.status == "FAILED"

    @pytest.mark.asyncio
    async def test_a_context_schema_violation_fails_on_the_first_attempt(self):
        trig = h.trigger()
        trig["config"]["contextSchema"] = {
            "inline": {"type": "object", "properties": {"q": {"type": "string"}}}
        }
        trig["retry"] = {
            "maximumAttempts": 3,
            "initialIntervalSeconds": 1,
            "backoffCoefficient": 2,
        }
        result, nodes, history = await h.run_graph(
            h.body([{"stageIndex": 0, "nodes": [trig]}]), payload={"q": 1}
        )

        assert nodes["n_trigger"].status == "FAILED"
        assert "ContextSchemaViolation" in (nodes["n_trigger"].reason or "")
        assert _final_attempt(history, "interpreter.core_trigger") == 1
