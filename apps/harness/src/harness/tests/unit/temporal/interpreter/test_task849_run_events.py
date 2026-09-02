"""TASK-849 lane A step 1 — the TASK-717 Phase C producer.

What these tests are FOR: TASK-717 shipped the envelope and the resume-token convention
and deferred the producer. Everything here asserts that the producer harness now has
really does emit the already-specified contract — conforming envelopes, intent-derived
idempotency keys, one bounded stream per run — rather than a second, harness-shaped
event format that happens to look similar.

Hermetic: no Redis server. ``FakeRedisStream`` is the smallest thing that can record an
``XADD`` and hand back a monotonic message id, which is all the producer's own contract
depends on.
"""

from __future__ import annotations

import json

import pytest
from hope_async_contract import envelope_problems

from harness.temporal.interpreter.run_events import (
    CONTROL_EVENT_TYPES,
    DELTA_EVENT_TYPES,
    EVENT_NODE_COMPLETED,
    EVENT_NODE_FAILED,
    EVENT_NODE_STARTED,
    EVENT_RUN_COMPLETED,
    EVENT_TOKEN_DELTA,
    RUN_EVENT_STREAM_MAX_LEN,
    RunEventProducer,
    build_run_event,
    encode_run_event,
    loop_iteration_key,
    node_settled_key,
    node_started_key,
    run_completed_key,
    run_event_stream_key,
    token_delta_key,
)

TENANT = "22222222-2222-2222-2222-222222222222"
RUN = "33333333-3333-3333-3333-333333333333"


class FakeRedisStream:
    """Records XADDs; hands back monotonic ``<n>-0`` ids, like a real stream."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, dict, int | None, bool | None]] = []
        self._seq = 0

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self._seq += 1
        self.entries.append((key, fields, maxlen, approximate))
        return f"{self._seq}-0"

    def payloads(self) -> list[dict]:
        return [json.loads(fields["data"]) for _, fields, _, _ in self.entries]


class ExplodingRedis:
    async def xadd(self, *_args, **_kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("redis is down")


class TestStreamIdentity:
    def test_one_stream_per_run_never_a_shared_partitioned_stream(self):
        assert run_event_stream_key(RUN) == f"wf:run:{RUN}:events"
        assert run_event_stream_key("other") != run_event_stream_key(RUN)

    @pytest.mark.asyncio
    async def test_every_write_is_maxlen_bounded(self):
        """An unbounded stream is an unbounded memory commitment on a shared Redis, and the
        delta lane is deliberately high-volume. The bound is also what CREATES the trimmed-id
        gap the client contract has to handle — so it must actually be sent."""
        redis = FakeRedisStream()
        producer = RunEventProducer(redis)
        await producer.emit_token_delta(
            tenant_id=TENANT, run_id=RUN, node_id="n1", sequence=0, text="hi"
        )
        _key, _fields, maxlen, approximate = redis.entries[0]
        assert maxlen == RUN_EVENT_STREAM_MAX_LEN
        assert approximate is True


class TestEnvelopeConformance:
    """Every event this producer writes must pass the SAME validator the TypeScript twin
    uses. A harness-shaped near-miss would be worse than no producer: it would look like
    the contract while quietly failing `parseAsyncEnvelope` at the gateway."""

    @pytest.mark.parametrize(
        "event_type",
        sorted(CONTROL_EVENT_TYPES | DELTA_EVENT_TYPES),
    )
    def test_every_event_type_produces_a_conforming_envelope(self, event_type: str):
        envelope = build_run_event(
            tenant_id=TENANT,
            run_id=RUN,
            event_type=event_type,
            idempotency_key=f"wf:run:{RUN}:probe",
            payload={"nodeId": "n1"},
        )
        wire = json.loads(encode_run_event(envelope))
        assert envelope_problems(wire) == []

    def test_correlation_id_is_the_run_id_so_every_event_joins_to_its_run(self):
        envelope = build_run_event(
            tenant_id=TENANT,
            run_id=RUN,
            event_type=EVENT_NODE_STARTED,
            idempotency_key=node_started_key(RUN, "n1", 1),
            payload={"nodeId": "n1"},
        )
        assert envelope.correlation_id == RUN

    def test_wire_form_is_camel_case_matching_the_typescript_twin(self):
        wire = json.loads(
            encode_run_event(
                build_run_event(
                    tenant_id=TENANT,
                    run_id=RUN,
                    event_type=EVENT_RUN_COMPLETED,
                    idempotency_key=run_completed_key(RUN),
                    payload={"status": "SUCCEEDED"},
                )
            )
        )
        assert {
            "schemaVersion",
            "tenantId",
            "occurredAt",
            "correlationId",
            "idempotencyKey",
        } <= set(wire)


class TestIdempotencyKeysAreDerivedFromIntent:
    """async-contract §3.5's one rule: a key is a pure function of WHAT happened."""

    def test_the_same_intent_reproduces_the_same_key(self):
        assert node_settled_key(RUN, "n1", 1) == node_settled_key(RUN, "n1", 1)
        assert token_delta_key(RUN, "n1", 7) == token_delta_key(RUN, "n1", 7)

    def test_completed_and_failed_share_one_key_for_the_same_node(self):
        """The corollary in ``idempotency.py``'s header, stated as a test: inventing an
        ``…:aborted`` suffix double-delivers, so the settle key must not know the outcome."""
        completed = build_run_event(
            tenant_id=TENANT,
            run_id=RUN,
            event_type=EVENT_NODE_COMPLETED,
            idempotency_key=node_settled_key(RUN, "n1", 1),
            payload={"nodeId": "n1", "status": "SUCCEEDED"},
        )
        failed = build_run_event(
            tenant_id=TENANT,
            run_id=RUN,
            event_type=EVENT_NODE_FAILED,
            idempotency_key=node_settled_key(RUN, "n1", 1),
            payload={"nodeId": "n1", "status": "FAILED"},
        )
        assert completed.idempotency_key == failed.idempotency_key

    def test_started_and_settled_are_different_intents_and_different_keys(self):
        assert node_started_key(RUN, "n1", 1) != node_settled_key(RUN, "n1", 1)

    def test_distinct_iterations_and_sequences_never_collapse(self):
        assert loop_iteration_key(RUN, "n1", 3) != loop_iteration_key(RUN, "n1", 4)
        assert token_delta_key(RUN, "n1", 3) != token_delta_key(RUN, "n1", 4)


class TestBestEffortMirrorPosture:
    """The stream is a mirror, not the record. A Redis outage must never be able to fail a
    clinical run — the same posture ``_TrajectoryBatch.flush()`` already has."""

    @pytest.mark.asyncio
    async def test_a_redis_failure_returns_none_and_does_not_raise(self):
        producer = RunEventProducer(ExplodingRedis())
        result = await producer.emit_token_delta(
            tenant_id=TENANT, run_id=RUN, node_id="n1", sequence=0, text="x"
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_no_redis_client_at_all_is_a_supported_outcome(self):
        producer = RunEventProducer(None)
        assert (
            await producer.emit_token_delta(
                tenant_id=TENANT, run_id=RUN, node_id="n1", sequence=0, text="x"
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_emit_many_reports_only_what_was_actually_written(self):
        producer = RunEventProducer(ExplodingRedis())
        envelopes = [
            build_run_event(
                tenant_id=TENANT,
                run_id=RUN,
                event_type=EVENT_NODE_STARTED,
                idempotency_key=node_started_key(RUN, f"n{i}", 1),
                payload={"nodeId": f"n{i}"},
            )
            for i in range(3)
        ]
        assert await producer.emit_many(envelopes) == []


class TestTheMessageIdIsTheTransportCursor:
    @pytest.mark.asyncio
    async def test_emit_returns_the_redis_message_id(self):
        """Redis assigns the cursor; the producer never invents one (async-contract §3.6 —
        the token is transport-assigned, and the gateway wraps THIS id)."""
        redis = FakeRedisStream()
        producer = RunEventProducer(redis)
        first = await producer.emit_token_delta(
            tenant_id=TENANT, run_id=RUN, node_id="n1", sequence=0, text="a"
        )
        second = await producer.emit_token_delta(
            tenant_id=TENANT, run_id=RUN, node_id="n1", sequence=1, text="b"
        )
        assert first == "1-0"
        assert second == "2-0"

    @pytest.mark.asyncio
    async def test_a_token_delta_carries_its_node_and_sequence(self):
        redis = FakeRedisStream()
        await RunEventProducer(redis).emit_token_delta(
            tenant_id=TENANT, run_id=RUN, node_id="gen", sequence=41, text="lo"
        )
        (event,) = redis.payloads()
        assert event["type"] == EVENT_TOKEN_DELTA
        assert event["payload"] == {"nodeId": "gen", "sequence": 41, "text": "lo"}
