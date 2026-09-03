"""TEXT stream chunks adopt the async task/event envelope.

Additive and backward compatible : a chunk written with a
resolved tenant is enveloped (``AsyncEnvelope`` wrapping the existing
``StreamChunk`` as ``payload``); a chunk written without one keeps writing
the bare ``StreamChunk`` exactly as before. Both shapes read back correctly.

RED: written before ``TaskManager``/``stream.py`` learn the envelope.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from hope_async_contract import (
    RESUME_FROM_BEGINNING,
    decode_resume_token,
    encode_resume_token,
    parse_async_envelope,
)

from text.models.stream import StreamChunk
from text.services.task_manager import TaskManager

TENANT_ID = "50000000-0000-0000-0000-000000000000"


class _FakeRedis:
    """Records XADDs and replays them through XREAD/XRANGE, byte-shaped like redis.asyncio."""

    def __init__(self) -> None:
        self.writes: list[tuple[str, dict[str, Any]]] = []
        self._counter = 0

    async def xadd(self, key: str, fields: dict[str, Any], **_kwargs: Any) -> bytes:
        self.writes.append((key, fields))
        self._counter += 1
        return f"{self._counter}-0".encode()

    def _wire_entries(self, key: str) -> list[tuple[bytes, dict[bytes, bytes]]]:
        entries = []
        for index, (written_key, fields) in enumerate(self.writes, start=1):
            if written_key != key:
                continue
            wire = {
                (k.encode() if isinstance(k, str) else k): (v.encode() if isinstance(v, str) else v)
                for k, v in fields.items()
            }
            entries.append((f"{index}-0".encode(), wire))
        return entries

    async def xread(self, streams: dict[str, str], **_kwargs: Any) -> Any:
        key = next(iter(streams))
        after = streams[key]
        entries = self._wire_entries(key)
        if after not in ("0", "0-0", "$"):
            start_seq = int(after.split("-")[0])
            entries = [e for e in entries if int(e[0].decode().split("-")[0]) > start_seq]
        return [(key.encode(), entries)] if entries else []

    async def xrange(
        self, key: str, min: str = "-", max: str = "+", **_kwargs: Any
    ) -> Any:  # noqa: A002
        entries = self._wire_entries(key)
        if min != "-":
            start_seq = int(min.lstrip("(").split("-")[0])
            entries = [e for e in entries if int(e[0].decode().split("-")[0]) > start_seq]
        return entries


def _chunk(chunk_type: str = "chunk", text: str = "hello") -> StreamChunk:
    return StreamChunk(type=chunk_type, content=text)


class TestAppendChunkEnvelopesWhenTenantKnown:
    @pytest.mark.asyncio
    async def test_enveloped_write_wraps_the_stream_chunk_as_payload(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        await manager.append_chunk("t-1", _chunk(), tenant_id=TENANT_ID, correlation_id="req-1")

        _key, fields = redis.writes[0]
        doc = json.loads(fields["data"])
        assert doc["schemaVersion"] == 1
        assert doc["tenantId"] == TENANT_ID
        assert doc["correlationId"] == "req-1"
        assert doc["type"] == "text.stream.chunk"
        assert doc["payload"]["content"] == "hello"

        envelope = parse_async_envelope(doc)
        assert envelope is not None

    @pytest.mark.asyncio
    async def test_idempotency_key_is_stable_per_task_and_sequence(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        await manager.append_chunk("t-1", _chunk("chunk", "a"), tenant_id=TENANT_ID)
        await manager.append_chunk("t-1", _chunk("chunk", "b"), tenant_id=TENANT_ID)

        doc0 = json.loads(redis.writes[0][1]["data"])
        doc1 = json.loads(redis.writes[1][1]["data"])
        assert doc0["idempotencyKey"] == "text:task:t-1:chunk:0"
        assert doc1["idempotencyKey"] == "text:task:t-1:chunk:1"
        assert doc0["idempotencyKey"] != doc1["idempotencyKey"]

    @pytest.mark.asyncio
    async def test_traceparent_stays_a_sibling_field_not_inside_the_envelope(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        await manager.append_chunk("t-1", _chunk(), tenant_id=TENANT_ID)

        _key, fields = redis.writes[0]
        doc = json.loads(fields["data"])
        assert "traceparent" not in doc
        assert set(doc.keys()) <= {
            "schemaVersion",
            "id",
            "tenantId",
            "type",
            "occurredAt",
            "correlationId",
            "causationId",
            "idempotencyKey",
            "payload",
            "payloadRef",
        }


class TestAppendChunkStaysBareWithoutTenant:
    @pytest.mark.asyncio
    async def test_legacy_write_is_unchanged_when_tenant_is_unknown(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        await manager.append_chunk("t-1", _chunk())

        _key, fields = redis.writes[0]
        doc = json.loads(fields["data"])
        assert "schemaVersion" not in doc
        assert doc == {"type": "chunk", "content": "hello", "data": None}


class TestReadersAcceptBothEnvelopedAndBareEntries:
    @pytest.mark.asyncio
    async def test_get_chunks_reads_an_enveloped_entry(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)
        await manager.append_chunk("t-1", _chunk("chunk", "x"), tenant_id=TENANT_ID)

        chunks = await manager.get_chunks("t-1")

        assert [c.content for c in chunks] == ["x"]

    @pytest.mark.asyncio
    async def test_get_chunks_reads_a_legacy_bare_entry(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)
        await manager.append_chunk("t-1", _chunk("chunk", "y"))

        chunks = await manager.get_chunks("t-1")

        assert [c.content for c in chunks] == ["y"]

    @pytest.mark.asyncio
    async def test_read_chunk_entries_blocking_reads_mixed_stream(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)
        await manager.append_chunk("t-1", _chunk("chunk", "bare"))
        await manager.append_chunk("t-1", _chunk("chunk", "enveloped"), tenant_id=TENANT_ID)

        entries = await manager.read_chunk_entries_blocking("t-1")

        assert [c.content for _mid, c, _carrier in entries] == ["bare", "enveloped"]

    @pytest.mark.asyncio
    async def test_unknown_schema_version_is_refused_not_best_effort_parsed(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)
        # Hand-craft a "future" enveloped entry the reader cannot understand yet.
        redis.writes.append(
            (
                manager._stream_key("t-1"),  # noqa: SLF001 — test-only introspection
                {"data": json.dumps({"schemaVersion": 999, "payload": {"type": "chunk"}})},
            )
        )

        with pytest.raises(ValueError, match="schemaVersion"):
            await manager.get_chunks("t-1")


class TestResumeTokensOnTheStreamPath:
    def test_encode_decode_round_trips_a_redis_message_id(self) -> None:
        token = encode_resume_token("redis-stream", "42-0")
        decoded = decode_resume_token(token)
        assert decoded == {"transport": "redis-stream", "cursor": "42-0"}

    def test_from_beginning_sentinel_is_unchanged(self) -> None:
        assert RESUME_FROM_BEGINNING == "0-0"
