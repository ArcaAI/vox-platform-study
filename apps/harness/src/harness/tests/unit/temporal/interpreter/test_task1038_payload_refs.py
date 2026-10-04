"""TASK-1038 R-3 — payloads by reference, and a named failure instead of a stuck retry loop.

Before:
* every node output lived inline in Temporal history, however large;
* every ``core.*`` activity input carried the run payload about FOUR times (``run_payload``,
  ``run_context.trigger`` flat AND under ``trigger.context``, and ``run_context.nodes.<trigger>``),
  so history grew with payload × node count;
* an activity input over Temporal's payload ceiling was never refused by name — the workflow task
  failed on the server's blob-size limit and the run wedged.

After:
* a node output above ``HARNESS_CLAIM_CHECK_NODE_OUTPUT_MIN_BYTES`` (20 KiB) is stored through the
  claim-check and replaced by a small reference; the reference is dereferenced INSIDE the
  consuming activity (the node-activity envelope), never in the workflow;
* the run payload travels ONCE per activity input (or as a reference, once the trigger offloaded
  it); the run context names it symbolically;
* a pre-flight guard fails the run with ``PAYLOAD_TOO_LARGE`` when an activity input would exceed
  ``HARNESS_CLAIM_CHECK_ACTIVITY_INPUT_MAX_BYTES``, before anything is scheduled.
"""

from __future__ import annotations

import json

import pytest
from temporalio.api.enums.v1 import EventType

from harness.core.config import ClaimCheckConfig
from harness.temporal.interpreter import payload_refs
from harness.temporal.interpreter.models import RunLimits
from harness.tests.unit.temporal.interpreter import _task1038_harness as h

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")


@pytest.fixture(autouse=True)
def _reset():
    h.reset()
    yield
    h.reset()


def _scheduled_inputs(history, activity_type: str) -> list[str]:
    """The raw JSON input of every scheduling of ``activity_type``, as recorded in history."""
    out: list[str] = []
    for event in history.events:
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
            attrs = event.activity_task_scheduled_event_attributes
            if attrs.activity_type.name == activity_type:
                out.append("".join(p.data.decode() for p in attrs.input.payloads))
    return out


def _completed_results(history) -> dict[int, str]:
    out: dict[int, str] = {}
    for event in history.events:
        if event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED:
            attrs = event.activity_task_completed_event_attributes
            out[attrs.scheduled_event_id] = "".join(p.data.decode() for p in attrs.result.payloads)
    return out


class TestSettings:
    def test_the_new_ceilings_ride_the_claim_check_config_with_their_defaults(self):
        config = ClaimCheckConfig()
        assert config.node_output_min_bytes == 20 * 1024
        assert config.result_inline_max_bytes == 64 * 1024
        assert config.activity_input_max_bytes == 1536 * 1024

    @pytest.mark.parametrize(
        "field", ["node_output_min_bytes", "result_inline_max_bytes", "activity_input_max_bytes"]
    )
    def test_a_non_positive_ceiling_is_refused(self, field: str):
        with pytest.raises(ValueError):
            ClaimCheckConfig(**{field: 0})


class TestLargeNodeOutputIsClaimChecked:
    @pytest.mark.asyncio
    async def test_a_300kb_output_becomes_a_reference_and_the_run_completes(self):
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        h.agent(
                            "n_big",
                            _stub="big",
                            _stub_bytes=300_000,
                            inputs=[h.edge("n_trigger", "out", "in")],
                        )
                    ],
                },
                {
                    "stageIndex": 2,
                    "nodes": [
                        h.agent("n_after", _stub="echo", inputs=[h.edge("n_big", "out", "in")])
                    ],
                },
            ]
        )
        result, nodes, history = await h.run_graph(graph, payload={"q": 1})

        assert result.status == "SUCCEEDED"
        assert nodes["n_after"].status == "SUCCEEDED"
        # The consumer was handed the WHOLE value — dereferenced inside its own activity.
        assert h.SEEN["n_after"].bound_inputs["in"] == "x" * 300_000
        # ...while history never carried it: no completed result and no scheduled input is
        # anywhere near the output's size.
        assert max(len(r) for r in _completed_results(history).values()) < 20_000
        assert max(len(i) for i in _scheduled_inputs(history, "interpreter.core_agent")) < 20_000


class TestRunPayloadTravelsOnce:
    @pytest.mark.asyncio
    async def test_a_small_payload_appears_once_per_activity_input(self):
        token = "UNIQUE-PAYLOAD-TOKEN"
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        h.agent("n_after", _stub="echo", inputs=[h.edge("n_trigger", "out", "in")])
                    ],
                },
            ]
        )
        _, _, history = await h.run_graph(graph, payload={"note": token})

        (scheduled,) = _scheduled_inputs(history, "interpreter.core_agent")
        assert scheduled.count(token) == 1
        # ...and the activity still sees every view of it, rebuilt inside the envelope.
        seen = h.SEEN["n_after"]
        assert seen.run_payload == {"note": token}
        assert seen.run_context["trigger"]["note"] == token
        assert seen.run_context["trigger"]["context"]["note"] == token
        assert seen.run_context["nodes"]["n_trigger"] == {"context": {"note": token}}
        assert seen.bound_inputs == {"in": {"note": token}}

    @pytest.mark.asyncio
    async def test_a_large_payload_travels_as_a_reference(self):
        big = "y" * 100_000
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        h.agent("n_after", _stub="echo", inputs=[h.edge("n_trigger", "out", "in")])
                    ],
                },
            ]
        )
        result, _, history = await h.run_graph(graph, payload={"note": big})

        assert result.status == "SUCCEEDED"
        (scheduled,) = _scheduled_inputs(history, "interpreter.core_agent")
        assert len(scheduled) < 20_000
        seen = h.SEEN["n_after"]
        assert seen.run_payload == {"note": big}
        assert seen.run_context["trigger"]["context"]["note"] == big
        assert seen.bound_inputs == {"in": {"note": big}}


class TestPreflightGuard:
    @pytest.mark.asyncio
    async def test_an_oversized_activity_input_fails_the_run_by_name(self):
        graph = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [h.agent("n_after", inputs=[h.edge("n_trigger", "out", "in")])],
                },
            ]
        )
        result, nodes, history = await h.run_graph(
            graph,
            payload={"note": "z" * 60_000},
            limits=RunLimits(activityInputMaxBytes=50_000),
        )

        assert result.status == "FAILED"
        assert nodes["n_trigger"].status == "FAILED"
        assert (nodes["n_trigger"].reason or "").startswith("PAYLOAD_TOO_LARGE")
        # Refused BEFORE scheduling — no attempt was ever made, so nothing can retry.
        assert _scheduled_inputs(history, "interpreter.core_trigger") == []

    @pytest.mark.asyncio
    async def test_a_3mb_payload_is_refused_with_the_default_ceiling(self):
        # The run input itself stays under Temporal's own 2 MB ceiling by splitting it across
        # two keys of the input; the trigger's activity input (payload + config) is what crosses
        # the default 1.5 MiB pre-flight ceiling.
        payload = {"a": "p" * 900_000, "b": "q" * 900_000}
        limits = RunLimits(activityInputMaxBytes=ClaimCheckConfig().activity_input_max_bytes)
        result, nodes, _ = await h.run_graph(
            h.body([{"stageIndex": 0, "nodes": [h.trigger()]}]), payload=payload, limits=limits
        )

        assert result.status == "FAILED"
        assert (nodes["n_trigger"].reason or "").startswith("PAYLOAD_TOO_LARGE")

    @pytest.mark.asyncio
    async def test_a_run_without_limits_has_no_guard(self):
        """Every run started before TASK-1038 carries no limits — and must walk as before."""
        result, nodes, _ = await h.run_graph(
            h.body([{"stageIndex": 0, "nodes": [h.trigger()]}]), payload={"note": "z" * 60_000}
        )
        assert nodes["n_trigger"].status == "SUCCEEDED"
        assert result.status == "SUCCEEDED"


class TestLoopOverAReference:
    @pytest.mark.asyncio
    async def test_a_foreach_over_an_offloaded_trigger_still_iterates(self):
        items = [f"item-{i}-" + "w" * 9_000 for i in range(3)]
        loop = h.body(
            [
                {"stageIndex": 0, "nodes": [h.trigger()]},
                {
                    "stageIndex": 1,
                    "nodes": [
                        {
                            **h.agent("n_loop", inputs=[h.edge("n_trigger", "out", "in")]),
                            "type": "core.loop",
                            "activity": "interpreter.core_loop",
                            "config": {
                                "mode": "foreach",
                                "over": "trigger.items",
                                "bounds": {
                                    "maxIterations": 5,
                                    "maxDurationSeconds": 600,
                                    "maxTotalTokens": 100000,
                                },
                                "collect": "text",
                            },
                            "timeoutSeconds": 3600,
                        }
                    ],
                },
            ],
            loops=[
                {
                    "nodeId": "n_loop",
                    "body": {
                        "stages": [
                            {
                                "stageIndex": 0,
                                "nodes": [
                                    h.agent(
                                        "n_body",
                                        _stub="echo",
                                        inputs=[h.edge("n_loop", "each", "context")],
                                    )
                                ],
                            }
                        ]
                    },
                }
            ],
        )
        result, nodes, _ = await h.run_graph(loop, payload={"items": items})

        assert nodes["n_loop"].status == "SUCCEEDED"
        assert h.ATTEMPTS["n_body"] == 3
        assert h.SEEN["n_body"].bound_inputs == {"context": items[2]}


class TestPureHelpers:
    def test_publish_trigger_matches_the_documented_namespace(self):
        published = payload_refs.publish_trigger({"a": 1}, {"dna": "x"})
        assert published == {"a": 1, "dna": "x", "context": {"a": 1, "dna": "x"}}

    def test_publish_trigger_unwraps_a_single_kind_envelope(self):
        published = payload_refs.publish_trigger({"context": {"a": 1}}, {})
        assert published == {"context": {"a": 1}}

    def test_a_marker_round_trips(self):
        marker = payload_refs.make_marker(
            {"store": "memory", "bucket": "b", "key": "k", "size": 3, "sha256": "s"}
        )
        assert payload_refs.is_marker(marker)
        assert not payload_refs.is_marker({"store": "memory"})
        assert json.loads(json.dumps(marker)) == marker


class TestLoopUntilReadsThroughReferences:
    @pytest.mark.asyncio
    async def test_the_served_evaluate_activity_dereferences_its_context(self):
        """`core.loop`'s `until` runs in `interpreter.core_evaluate`, which is not a node
        activity; a body output it reads may have been offloaded, so it too must see values."""
        from harness.temporal.claim_check import _MEMORY_STORE, store_blob
        from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
        from harness.temporal.interpreter.models import EvaluateExpressionInput

        ref = await store_blob(json.dumps({"done": True}), store=_MEMORY_STORE, bucket="b")
        (served,) = [
            a
            for a in INTERPRETER_ACTIVITIES
            if getattr(a, "__temporal_activity_definition").name == "interpreter.core_evaluate"
        ]
        result = await served(
            EvaluateExpressionInput(
                expression="nodes.n_body.data.done == true",
                context={"nodes": {"n_body": {"data": payload_refs.make_marker(ref.model_dump())}}},
            )
        )
        assert result.taken is True
