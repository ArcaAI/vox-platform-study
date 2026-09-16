"""TASK-982 §3.4.5 — settled-node counts on `workflow.run.completed`.

Three layers, narrowest first:

1. `_settled_node_counts` (workflow.py) — a PURE function over already-settled `StageResult`s,
   unit-tested directly with no Temporal machinery at all.
2. `_envelope_for` (activities.py) — the activity-side camelCase mapping, unit-tested directly
   against a `RunEventBatch`/`RunEventSpec`, again with no Temporal machinery.
3. An end-to-end run through the real `WorkflowInterpreter` in Temporal's time-skipping test
   environment (the same harness `test_task849_control_mirror.py` uses), asserting the terminal
   `workflow.run.completed` event's payload carries the four counts for a mixed
   SUCCEEDED/DEGRADED/SKIPPED/FAILED graph.
"""

from __future__ import annotations

import hashlib
import json
import uuid

import pytest
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import (
    INTERPRETER_ACTIVITIES,
    _envelope_for,
    interpreter_noop,
)
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import NodeResult, RunEventBatch, RunEventSpec, StageResult
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.run_events import EVENT_RUN_COMPLETED, run_event_stream_key
from harness.temporal.interpreter.workflow import WorkflowInterpreter, _settled_node_counts
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_BUCKET = "harness-claim-check"
TENANT = "22222222-2222-2222-2222-222222222222"


class TestSettledNodeCounts:
    """`_settled_node_counts` — pure, no Temporal."""

    def test_empty_run_counts_nothing(self):
        assert _settled_node_counts([]) == (0, 0, 0, 0)

    def test_counts_every_node_across_every_stage_including_a_trailing_gate_stage(self):
        stages = [
            StageResult(
                stage_index=0,
                nodes=[
                    NodeResult(node_id="n1", node_type="core.agent", status="SUCCEEDED"),
                    NodeResult(node_id="n2", node_type="core.agent", status="DEGRADED"),
                ],
            ),
            StageResult(
                stage_index=1,
                nodes=[
                    NodeResult(node_id="n3", node_type="core.agent", status="SKIPPED"),
                    NodeResult(node_id="n4", node_type="core.agent", status="FAILED"),
                ],
            ),
            # The HITL gate is appended as one more StageResult after the walk (workflow.py:451).
            StageResult(
                stage_index=2,
                nodes=[
                    NodeResult(
                        node_id="n_gate", node_type="consultation.hitlGate", status="SUCCEEDED"
                    )
                ],
            ),
        ]

        assert _settled_node_counts(stages) == (5, 1, 1, 1)

    def test_a_successful_run_reports_zero_for_every_failure_class(self):
        stages = [
            StageResult(
                stage_index=0,
                nodes=[
                    NodeResult(node_id="n1", node_type="core.agent", status="SUCCEEDED"),
                    NodeResult(node_id="n2", node_type="core.agent", status="SUCCEEDED"),
                ],
            )
        ]

        assert _settled_node_counts(stages) == (2, 0, 0, 0)


class TestEnvelopeForCarriesTheCounts:
    """`_envelope_for` (activities.py) — the camelCase mapping, no Temporal."""

    def _batch(self, spec: RunEventSpec) -> RunEventBatch:
        return RunEventBatch(run_id="run-1", tenant_id=TENANT, events=[spec])

    def test_every_count_present_maps_to_its_camelcase_key(self):
        spec = RunEventSpec(
            event_type=EVENT_RUN_COMPLETED,
            status="COMPLETED",
            node_count=5,
            failed_node_count=0,
            degraded_node_count=2,
            skipped_node_count=1,
        )
        envelope = _envelope_for(self._batch(spec), spec)

        assert envelope.payload["nodeCount"] == 5
        assert envelope.payload["failedNodeCount"] == 0
        assert envelope.payload["degradedNodeCount"] == 2
        assert envelope.payload["skippedNodeCount"] == 1
        assert envelope.payload["status"] == "COMPLETED"

    def test_absent_counts_are_omitted_from_the_payload_not_sent_as_null(self):
        """A replaying pre-TASK-982 history constructs a `RunEventSpec` with all four `None` —
        the payload must stay byte-identical to what that era's envelope looked like."""
        spec = RunEventSpec(event_type=EVENT_RUN_COMPLETED, status="FAILED")
        envelope = _envelope_for(self._batch(spec), spec)

        assert "nodeCount" not in envelope.payload
        assert "failedNodeCount" not in envelope.payload
        assert "degradedNodeCount" not in envelope.payload
        assert "skippedNodeCount" not in envelope.payload
        assert envelope.payload["status"] == "FAILED"

    def test_zero_is_a_real_value_not_treated_as_absent(self):
        """`is not None` is the guard `_envelope_for` uses — a zero failed-node count must reach
        the payload, not be dropped as falsy."""
        spec = RunEventSpec(event_type=EVENT_RUN_COMPLETED, status="COMPLETED", failed_node_count=0)
        envelope = _envelope_for(self._batch(spec), spec)

        assert envelope.payload["failedNodeCount"] == 0


def _node(node_id: str, *, activity: str = "interpreter.noop", config: dict | None = None) -> dict:
    return {
        "nodeId": node_id,
        "type": "noop" if activity == "interpreter.noop" else "passthrough",
        "activity": activity,
        "config": config or {},
        "timeoutSeconds": 30,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "inputs": [],
        "onError": "degrade",
        "emitsTrajectory": True,
    }


def _body(stages: list[dict]) -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "run-completed-counts-test",
        "versionNumber": 1,
        "tenantId": TENANT,
        "paletteKey": "fixture",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": stages,
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


class FakeRedisStream:
    def __init__(self) -> None:
        self.by_key: dict[str, list[dict]] = {}
        self._seq = 0

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self._seq += 1
        self.by_key.setdefault(key, []).append(json.loads(fields["data"]))
        return f"{self._seq}-0"


@pytest.fixture
def fake_stream(monkeypatch):
    redis = FakeRedisStream()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    return redis


async def _run(body: dict) -> tuple[str, object]:
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"run-completed-counts-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, *SCAFFOLD_ACTIVITIES],
        ):
            from harness.temporal.interpreter.models import InterpreterInput

            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=TENANT,
                    run_id=run_id,
                ),
                id=f"wf-run-completed-counts-{uuid.uuid4()}",
                task_queue=tq,
            )
            return run_id, await handle.result()


class TestRunCompletedCountsEndToEnd:
    @pytest.mark.asyncio
    async def test_a_fully_succeeded_run_reports_the_node_count_and_zero_everywhere_else(
        self, fake_stream
    ):
        run_id, result = await _run(
            _body(
                [
                    {"stageIndex": 0, "nodes": [_node("n1")]},
                    {"stageIndex": 1, "nodes": [_node("n2")]},
                ]
            )
        )
        assert result.status == "SUCCEEDED"

        events = fake_stream.by_key[run_event_stream_key(run_id)]
        completed = next(e for e in events if e["type"] == EVENT_RUN_COMPLETED)
        assert completed["payload"]["nodeCount"] == 2
        assert completed["payload"]["failedNodeCount"] == 0
        assert completed["payload"]["degradedNodeCount"] == 0
        assert completed["payload"]["skippedNodeCount"] == 0

    @pytest.mark.asyncio
    async def test_a_degraded_and_a_skipped_node_both_count_in_the_terminal_event(
        self, fake_stream
    ):
        run_id, result = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("ok"),
                            _node("soft", config={"raise_error": True}),
                            _node("off", config={"enabled": False}),
                        ],
                    }
                ]
            )
        )
        assert result.status == "DEGRADED"

        events = fake_stream.by_key[run_event_stream_key(run_id)]
        completed = next(e for e in events if e["type"] == EVENT_RUN_COMPLETED)
        assert completed["payload"]["nodeCount"] == 3
        assert completed["payload"]["failedNodeCount"] == 0
        assert completed["payload"]["degradedNodeCount"] == 1
        assert completed["payload"]["skippedNodeCount"] == 1

    @pytest.mark.asyncio
    async def test_a_critical_node_failing_still_counts_every_settled_node_in_that_stage(
        self, fake_stream, monkeypatch
    ):
        monkeypatch.setitem(
            NODE_REGISTRY,
            "critical-noop",
            NodeSpec(
                key="critical-noop", implemented=True, activity=interpreter_noop, critical=True
            ),
        )
        run_id, result = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("ok"),
                            _node("bad", config={"raise_error": True}) | {"type": "critical-noop"},
                        ],
                    },
                    # A second stage would be dispatched had the first not failed critically —
                    # it must never be counted, matching the walk's own break-on-failure.
                    {"stageIndex": 1, "nodes": [_node("never_reached")]},
                ]
            )
        )
        assert result.status == "FAILED"

        events = fake_stream.by_key[run_event_stream_key(run_id)]
        completed = next(e for e in events if e["type"] == EVENT_RUN_COMPLETED)
        assert completed["payload"]["nodeCount"] == 2
        assert completed["payload"]["failedNodeCount"] == 1
        assert completed["payload"]["degradedNodeCount"] == 0
        assert completed["payload"]["skippedNodeCount"] == 0
