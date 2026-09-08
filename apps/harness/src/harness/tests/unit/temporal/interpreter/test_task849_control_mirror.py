"""lane A step 2 — the CONTROL lane, mirrored out of Temporal.

Runs the real ``WorkflowInterpreter`` in Temporal's time-skipping environment with the real
``INTERPRETER_ACTIVITIES``, and swaps only the Redis client the emit activity would open.
What is asserted is the thing the gateway depends on: that a run PUSHES its own node and run
outcomes, so the gateway never has to ask.

The stubbing boundary matters. Nothing about the interpreter, the emit activity, the envelope
or the idempotency keys is faked — only the socket. A test that stubbed the producer would
prove the workflow calls a function; this proves an envelope reaches a stream.
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
from harness.tests.unit.temporal.conftest import SCAFFOLD_ACTIVITIES
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES, interpreter_noop
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.run_events import (
    EVENT_NODE_COMPLETED,
    EVENT_NODE_FAILED,
    EVENT_NODE_STARTED,
    EVENT_RUN_COMPLETED,
    run_event_stream_key,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_BUCKET = "harness-claim-check"
TENANT = "22222222-2222-2222-2222-222222222222"


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
    """Install a fake Redis in the emit activity's process-wide producer slot."""
    redis = FakeRedisStream()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    return redis


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
        "slug": "stream-test",
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


async def _run(body: dict) -> tuple[str, object]:
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"stream-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, *SCAFFOLD_ACTIVITIES],
        ):
            handle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=TENANT,
                    run_id=run_id,
                ),
                id=f"wf-stream-{uuid.uuid4()}",
                task_queue=tq,
            )
            return run_id, await handle.result()


class TestTheRunPushesItsOwnProgress:
    @pytest.mark.asyncio
    async def test_a_walk_emits_started_then_settled_per_node_then_run_completed(self, fake_stream):
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
        assert [e["type"] for e in events] == [
            EVENT_NODE_STARTED,
            EVENT_NODE_COMPLETED,
            EVENT_NODE_STARTED,
            EVENT_NODE_COMPLETED,
            EVENT_RUN_COMPLETED,
        ]
        assert events[-1]["payload"]["status"] == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_every_emitted_event_carries_the_run_as_its_correlation_id(self, fake_stream):
        run_id, _ = await _run(_body([{"stageIndex": 0, "nodes": [_node("n1")]}]))
        events = fake_stream.by_key[run_event_stream_key(run_id)]
        assert {e["correlationId"] for e in events} == {run_id}
        assert {e["tenantId"] for e in events} == {TENANT}

    @pytest.mark.asyncio
    async def test_a_critical_node_failing_emits_node_failed_with_its_reason(
        self, fake_stream, monkeypatch
    ):
        """`node.failed` is reserved for the outcome that FAILS the run.

        Criticality is a registry property, never tenant config, so this registers a critical
        variant of the seed activity exactly as `test_interpreter_semantics.py` does. A debug
        canvas that can only ever see `completed` cannot draw a red outline — this is the event
        that lets it.
        """
        monkeypatch.setitem(
            NODE_REGISTRY,
            "critical-noop",
            NodeSpec(
                key="critical-noop",
                implemented=True,
                activity=interpreter_noop,
                critical=True,
            ),
        )
        run_id, result = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("bad", config={"raise_error": True}) | {"type": "critical-noop"}
                        ],
                    }
                ]
            )
        )
        assert result.status == "FAILED"
        events = fake_stream.by_key[run_event_stream_key(run_id)]
        failed = [e for e in events if e["type"] == EVENT_NODE_FAILED]
        assert len(failed) == 1
        assert failed[0]["payload"]["nodeId"] == "bad"
        # F13 — the reason NAMES the cause; a bare `activity_error` said only that
        # something failed, which is how two live blockers stayed invisible.
        assert failed[0]["payload"]["reason"] == (
            "activity_error: RuntimeError: interpreter.noop: simulated failure for node bad"
        )
        assert events[-1]["payload"]["status"] == "FAILED"

    @pytest.mark.asyncio
    async def test_a_degraded_node_settles_as_completed_carrying_its_real_status(self, fake_stream):
        """DEGRADED is not a run failure, so it is not a `node.failed` — but the outcome must
        still be legible. The TYPE says whether the run is dying; the PAYLOAD says what actually
        happened, and a consumer colours on the payload."""
        run_id, result = await _run(
            _body([{"stageIndex": 0, "nodes": [_node("soft", config={"raise_error": True})]}])
        )
        assert result.status == "DEGRADED"
        events = fake_stream.by_key[run_event_stream_key(run_id)]
        assert [e["type"] for e in events if e["type"] == EVENT_NODE_FAILED] == []
        settled = next(e for e in events if e["type"] == EVENT_NODE_COMPLETED)
        assert settled["payload"]["status"] == "DEGRADED"
        assert settled["payload"]["reason"] == (
            "activity_error: RuntimeError: interpreter.noop: simulated failure for node soft"
        )

    @pytest.mark.asyncio
    async def test_a_node_the_walk_declines_is_never_announced_as_started(self, fake_stream):
        """`_preflight_skip` is shared with `_dispatch_node`, so "will it run?" has ONE answer.
        A node disabled by config must settle as SKIPPED without ever having been announced —
        otherwise the canvas paints a node as in-flight that never ran."""
        run_id, _ = await _run(
            _body(
                [
                    {
                        "stageIndex": 0,
                        "nodes": [
                            _node("live"),
                            _node("off", config={"enabled": False}),
                        ],
                    }
                ]
            )
        )
        events = fake_stream.by_key[run_event_stream_key(run_id)]
        started = [e["payload"]["nodeId"] for e in events if e["type"] == EVENT_NODE_STARTED]
        settled = {
            e["payload"]["nodeId"]: e["payload"]
            for e in events
            if e["type"] in (EVENT_NODE_COMPLETED, EVENT_NODE_FAILED)
        }
        assert started == ["live"]
        assert settled["off"]["status"] == "SKIPPED"
        assert settled["off"]["reason"] == "disabled_by_config"


class TestTheMirrorCannotFailTheRun:
    @pytest.mark.asyncio
    async def test_a_dead_redis_does_not_change_the_run_outcome(self, monkeypatch):
        """The whole posture in one test. Temporal history is the record; this stream is a
        mirror, and an unreachable mirror costs a client its live push and nothing else."""

        class ExplodingRedis:
            async def xadd(self, *_args, **_kwargs):  # noqa: ANN002, ANN003
                raise RuntimeError("redis is down")

        monkeypatch.setattr(
            interpreter_activities, "_RUN_EVENT_REDIS", ExplodingRedis(), raising=False
        )
        monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
        _run_id, result = await _run(
            _body(
                [
                    {"stageIndex": 0, "nodes": [_node("n1")]},
                    {"stageIndex": 1, "nodes": [_node("n2", activity="interpreter.passthrough")]},
                ]
            )
        )
        assert result.status == "SUCCEEDED"
        assert [s.nodes[0].status for s in result.stages] == ["SUCCEEDED", "SUCCEEDED"]
