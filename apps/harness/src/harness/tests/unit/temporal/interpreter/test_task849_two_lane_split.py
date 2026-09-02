"""TASK-849 lane A step 3 — the two-lane split, MEASURED.

This is the test the ticket's §5 risk table asks for by name: *"Enforce the split with a
test, not a convention — assert history size against delta count."* Everything else about the
split is a comment; this is the part that fails when someone routes a token stream through
Temporal.

**The measurement.** The SAME graph runs twice against a real ephemeral Temporal server, once
emitting 10 deltas and once emitting 10 000, and the two runs' `fetch_history()` event counts
are compared. Equal counts at a 1000x difference in deltas is the property: the delta lane does
not touch Temporal at all. A run that signalled, or scheduled an activity per chunk, would grow
by ~3 events per delta and blow through the 51,200-event / 50 MB per-run ceiling long before a
long clinical deliberation finished.

**Why this is not tautological.** The graph is a real compiled config walked by the real
`WorkflowInterpreter`, dispatching a real registered activity through
`workflow.execute_activity`. Only the Redis socket is faked. The test also asserts that the
10 000 envelopes genuinely LANDED — so it cannot pass by emitting nothing — and that no
Temporal history payload contains delta text, which is what catches a well-meaning future
change that starts folding deltas into an activity result.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid

import pytest
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES, run_event_producer
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.models import (
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
)
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec
from harness.temporal.interpreter.run_events import (
    EVENT_TOKEN_DELTA,
    run_event_stream_key,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_BUCKET = "harness-claim-check"
TENANT = "22222222-2222-2222-2222-222222222222"

#: 10 and 10 000. The ticket's criterion names 10k; the small run is the CONTROL that turns
#: "history is small" into "history is INDEPENDENT of delta count".
SMALL_DELTAS = 10
LARGE_DELTAS = 10_000


@activity.defn(name="interpreter.token_stream_probe")
async def token_stream_probe(payload: NodeActivityInput) -> NodeActivityResult:
    """A node that streams N token deltas down the DELTA lane and returns a plain result.

    This is exactly the shape a real streaming node takes (lane B's audio nodes included): the
    deltas go straight from the activity to Redis via `run_event_producer()`, and the only thing
    that ever reaches Temporal is the node's own settled outcome.
    """
    producer = run_event_producer()
    count = int(payload.config.get("delta_count", 0))
    for sequence in range(count):
        await producer.emit_token_delta(
            tenant_id=payload.tenant_id,
            run_id=payload.run_id,
            node_id=payload.node_id,
            sequence=sequence,
            text=f"tok{sequence} ",
        )
    return NodeActivityResult(status="SUCCEEDED", output={"deltas": count})


def _decoded_history_payloads(history_json: str) -> str:
    """Every payload body in a history, base64-decoded and concatenated.

    Temporal serialises payload `data` as base64, so searching the raw JSON for delta text
    finds nothing whether or not the text is in there. This is the difference between a test
    and a test-shaped no-op.
    """
    chunks: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "data" and isinstance(value, str):
                    try:
                        chunks.append(base64.b64decode(value).decode("utf-8", "replace"))
                    except (ValueError, binascii.Error):
                        pass
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(json.loads(history_json))
    return "".join(chunks)


class FakeRedisStream:
    def __init__(self) -> None:
        self.by_key: dict[str, list[dict]] = {}
        self._seq = 0

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self._seq += 1
        self.by_key.setdefault(key, []).append(json.loads(fields["data"]))
        return f"{self._seq}-0"


def _body(delta_count: int) -> dict:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "split-test",
        "versionNumber": 1,
        "tenantId": TENANT,
        "paletteKey": "fixture",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "streamer",
                        "type": "token-stream-probe",
                        "activity": "interpreter.token_stream_probe",
                        "config": {"delta_count": delta_count},
                        "timeoutSeconds": 120,
                        "retry": {
                            "maximumAttempts": 1,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "degrade",
                        "emitsTrajectory": True,
                    }
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


async def _run_with(delta_count: int, redis: FakeRedisStream, monkeypatch) -> tuple[str, dict]:
    """Run the graph once. Returns `(run_id, {"events": n, "history_json": str})`."""
    monkeypatch.setitem(
        NODE_REGISTRY,
        "token-stream-probe",
        NodeSpec(
            key="token-stream-probe",
            implemented=True,
            activity=token_stream_probe,
            critical=False,
            default_timeout_seconds=120,
        ),
    )
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)

    body = _body(delta_count)
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())

    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"split-test-{uuid.uuid4()}"
        async with Worker(
            env.client,
            task_queue=tq,
            workflows=[WorkflowInterpreter],
            activities=[*INTERPRETER_ACTIVITIES, token_stream_probe],
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
                id=f"wf-split-{uuid.uuid4()}",
                task_queue=tq,
            )
            result = await handle.result()
            assert result.status == "SUCCEEDED"
            history = await handle.fetch_history()

    return run_id, {"events": len(history.events), "history_json": history.to_json()}


class TestTokenDeltasNeverEnterTemporalHistory:
    @pytest.mark.asyncio
    async def test_ten_thousand_deltas_add_no_proportional_temporal_history(self, monkeypatch):
        """THE measurement. 10 deltas and 10 000 deltas must produce the SAME history size."""
        small_redis = FakeRedisStream()
        small_run, small = await _run_with(SMALL_DELTAS, small_redis, monkeypatch)

        large_redis = FakeRedisStream()
        large_run, large = await _run_with(LARGE_DELTAS, large_redis, monkeypatch)

        # The deltas really were produced — without this the equality below would also hold
        # for a producer that silently emitted nothing.
        small_deltas = [
            e
            for e in small_redis.by_key[run_event_stream_key(small_run)]
            if e["type"] == EVENT_TOKEN_DELTA
        ]
        large_deltas = [
            e
            for e in large_redis.by_key[run_event_stream_key(large_run)]
            if e["type"] == EVENT_TOKEN_DELTA
        ]
        assert len(small_deltas) == SMALL_DELTAS
        assert len(large_deltas) == LARGE_DELTAS

        # Printed, not just asserted: the ticket asks for this to be MEASURED, and a number
        # nobody can read is not a measurement. Visible under `pytest -s`.
        print(
            f"\n[TASK-849 two-lane split, measured] "
            f"deltas={SMALL_DELTAS} -> temporal_history_events={small['events']} | "
            f"deltas={LARGE_DELTAS} -> temporal_history_events={large['events']} | "
            f"history_bytes={len(large['history_json'])}"
        )

        # A 1000x increase in deltas, and Temporal history is byte-count-independent of it.
        assert large["events"] == small["events"], (
            f"Temporal history grew with delta count: {small['events']} events for "
            f"{SMALL_DELTAS} deltas vs {large['events']} for {LARGE_DELTAS}. "
            "Something is routing the delta lane through Temporal — see program §3.4 rule 17."
        )

        # And the history is genuinely small, not merely equal: a per-delta signal or activity
        # would put this in the tens of thousands, against a 51,200-event ceiling.
        assert large["events"] < 100

    @pytest.mark.asyncio
    async def test_no_history_payload_carries_delta_text(self, monkeypatch):
        """Catches the subtler regression: folding the accumulated stream into an activity
        result or a signal payload. That adds no EVENTS at all — it blows the OTHER half of
        the same limit, the 50 MB per-run byte ceiling — so the event-count test above cannot
        see it.

        Payload bodies are base64 in the history JSON, so a naive substring search over
        `to_json()` finds nothing and passes whatever happens (verified: with 10 000 tokens
        deliberately folded into the node's `output`, the raw-string version of this test still
        passed). Both assertions here are on DECODED bytes.
        """
        small_redis = FakeRedisStream()
        _small_run, small = await _run_with(SMALL_DELTAS, small_redis, monkeypatch)
        large_redis = FakeRedisStream()
        _large_run, large = await _run_with(LARGE_DELTAS, large_redis, monkeypatch)

        decoded = _decoded_history_payloads(large["history_json"])
        assert "tok9999" not in decoded
        assert "tok5000" not in decoded

        # And the byte measure, which is what the 50 MB ceiling is actually counted in.
        print(
            f"\n[TASK-849 two-lane split, measured bytes] "
            f"deltas={SMALL_DELTAS} -> history_bytes={len(small['history_json'])} | "
            f"deltas={LARGE_DELTAS} -> history_bytes={len(large['history_json'])}"
        )
        assert len(large["history_json"]) < len(small["history_json"]) * 2

    @pytest.mark.asyncio
    async def test_the_control_lane_still_reports_the_streaming_node(self, monkeypatch):
        """The split is not "deltas are invisible" — the node's own outcome still travels the
        control lane, so a debug surface can still show the node completing."""
        redis = FakeRedisStream()
        run_id, _ = await _run_with(SMALL_DELTAS, redis, monkeypatch)
        types = [e["type"] for e in redis.by_key[run_event_stream_key(run_id)]]
        assert "workflow.node.started" in types
        assert "workflow.node.completed" in types
        assert "workflow.run.completed" in types
