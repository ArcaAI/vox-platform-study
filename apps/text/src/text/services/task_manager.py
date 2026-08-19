"""TaskManager — Redis-backed task state + Redis Streams for chunk persistence."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any, cast

import structlog
from hope_async_contract import (
    ASYNC_ENVELOPE_SCHEMA_VERSION,
    AsyncEnvelope,
    AsyncIdempotencyKey,
    parse_async_envelope,
)
from hope_otel.trace_propagation import carrier_from_redis_fields, inject_trace_carrier
from uuid_extensions import uuid7

from text.models.stream import StreamChunk
from text.models.task import TaskState, TaskStatus

logger = structlog.get_logger(__name__)

_TASK_KEY_PREFIX = "text:task:"
_STREAM_KEY_PREFIX = "text:stream:"

_UPDATE_TASK_LUA = """
local key = KEYS[1]
local updates_json = ARGV[1]
local ttl = tonumber(ARGV[2])

local raw = redis.call('GET', key)
if not raw then
    return nil
end

local task = cjson.decode(raw)
local updates = cjson.decode(updates_json)

for k, v in pairs(updates) do
    task[k] = v
end

local updated_json = cjson.encode(task)
redis.call('SET', key, updated_json, 'EX', ttl)
return updated_json
"""


class TaskManager:
    """Manages task lifecycle and chunk streaming via Redis."""

    def __init__(self, redis: Any, task_ttl: int = 3600, stream_max_len: int = 10_000) -> None:
        self._redis = redis
        self._task_ttl = task_ttl
        self._stream_max_len = stream_max_len
        # TASK-717: per-task chunk sequence counter, for the enveloped write's
        # idempotency key (`text:task:<taskId>:chunk:<sequence>`). Scoped to this
        # instance/process, matching the existing per-request TaskManager lifecycle
        # (see `core/dependencies.py:get_task_manager`) — a chunk stream is always
        # produced by one worker for one task.
        self._chunk_sequences: dict[str, int] = {}

    def _task_key(self, task_id: str) -> str:
        return f"{_TASK_KEY_PREFIX}{task_id}"

    def _stream_key(self, task_id: str) -> str:
        return f"{_STREAM_KEY_PREFIX}{task_id}"

    async def create_task(self, provider: str, model: str, max_retries: int = 3) -> TaskState:
        task_id = str(uuid.uuid4())
        state = TaskState(
            task_id=task_id,
            status=TaskStatus.PENDING,
            provider=provider,
            model=model,
            max_retries=max_retries,
            created_at=datetime.now(UTC),
        )
        await self._redis.set(
            self._task_key(task_id),
            state.model_dump_json(),
            ex=self._task_ttl,
        )
        return state

    async def get_task(self, task_id: str) -> TaskState | None:
        raw = await self._redis.get(self._task_key(task_id))
        if raw is None:
            return None
        return TaskState.model_validate_json(raw)

    async def update_task(self, task_id: str, **updates: Any) -> TaskState | None:
        result = await self._redis.eval(
            _UPDATE_TASK_LUA,
            1,
            self._task_key(task_id),
            json.dumps(updates, default=str),
            str(self._task_ttl),
        )
        if result is None:
            return None
        if isinstance(result, bytes):
            result = result.decode()
        return TaskState.model_validate_json(result)

    async def cancel_task(self, task_id: str) -> TaskState | None:
        return await self.update_task(task_id, status=TaskStatus.CANCELLED)

    async def append_chunk(
        self,
        task_id: str,
        chunk: StreamChunk,
        *,
        tenant_id: str | None = None,
        correlation_id: str | None = None,
    ) -> str:
        # Stamp the GENERATING context onto the entry. The SSE
        # reader is a different HTTP request (often a different connection), so
        # this field is the only thing that can join a streamed chunk to the
        # generation that produced it. Empty (and the entry byte-identical to
        # prior) when tracing is off.
        fields: dict[str, str] = {"data": self._encode_chunk_data(task_id, chunk, tenant_id, correlation_id)}
        fields.update(inject_trace_carrier())
        msg_id = await self._redis.xadd(
            self._stream_key(task_id),
            fields,
            maxlen=self._stream_max_len,
        )
        return cast(str, msg_id)

    def _encode_chunk_data(
        self,
        task_id: str,
        chunk: StreamChunk,
        tenant_id: str | None,
        correlation_id: str | None,
    ) -> str:
        """Envelope the chunk (TASK-717) when a tenant is resolved; bare JSON otherwise.

        Additive and backward compatible (design doc §3.7): a caller with no
        resolved tenant (an untenanted internal caller) keeps writing the bare
        ``StreamChunk`` exactly as before — the envelope's ``tenantId`` is
        mandatory, so there is nothing sound to write without one.
        """
        if tenant_id is None:
            return chunk.model_dump_json()

        sequence = self._chunk_sequences.get(task_id, 0)
        self._chunk_sequences[task_id] = sequence + 1

        envelope = AsyncEnvelope(
            schema_version=ASYNC_ENVELOPE_SCHEMA_VERSION,
            id=str(uuid7()),
            tenant_id=tenant_id,
            type=f"smr.stream.{chunk.type}",
            occurred_at=datetime.now(UTC).isoformat(),
            correlation_id=correlation_id or task_id,
            causation_id=None,
            idempotency_key=AsyncIdempotencyKey.text_chunk(task_id, sequence),
            payload=chunk.model_dump(mode="json"),
        )
        # `exclude_unset=True`: `payload_ref` was never assigned (only `payload`
        # was), so it is omitted from the wire form entirely — a `payloadRef:
        # null` key WOULD otherwise satisfy the XOR-by-presence check on
        # re-parse (`_validate_payload_xor_ref` reads `model_fields_set`, and
        # the round trip through `model_validate(dict)` marks any present key
        # as "set" even when its value is `null`). `causation_id`, explicitly
        # passed as `None` above, stays present — the schema requires the key.
        return envelope.model_dump_json(by_alias=True, exclude_unset=True)

    @staticmethod
    def _decode_chunk_data(raw: str) -> StreamChunk:
        """Parse a stream entry's ``data`` field — enveloped (TASK-717) or legacy bare.

        A `schemaVersion` probe distinguishes the two. An enveloped entry whose
        `schemaVersion` this reader does not understand is REFUSED, never
        best-effort parsed (design doc §3.2) — cutover of the acceptance path to
        require the envelope is a follow-up, not this ticket.
        """
        doc = json.loads(raw)
        if isinstance(doc, dict) and "schemaVersion" in doc:
            envelope = parse_async_envelope(doc)
            if envelope is None:
                raise ValueError(
                    f"unrecognized async envelope schemaVersion in stream data: {doc.get('schemaVersion')!r}"
                )
            if envelope.payload is None:
                raise ValueError("enveloped SMR stream chunk carries no inline payload")
            return StreamChunk.model_validate(envelope.payload)
        return StreamChunk.model_validate_json(raw)

    async def get_chunks(self, task_id: str, after_id: str | None = None) -> list[StreamChunk]:
        start = f"({after_id}" if after_id else "-"
        entries = await self._redis.xrange(self._stream_key(task_id), min=start, max="+")
        chunks = []
        for _msg_id, fields in entries:
            raw = fields.get(b"data") or fields.get("data")
            if raw:
                if isinstance(raw, bytes):
                    raw = raw.decode()
                chunks.append(self._decode_chunk_data(raw))
        return chunks

    async def read_chunks_blocking(
        self, task_id: str, last_id: str = "0-0", block_ms: int = 5000
    ) -> list[tuple[str, StreamChunk]]:
        """Block-read new chunks from the stream via XREAD BLOCK.

        Returns list of (msg_id, chunk) tuples. Returns empty list on timeout.

        Kept at its original two-tuple shape so existing callers are untouched;
        :meth:`read_chunk_entries_blocking` is the trace-aware variant.
        """
        return [
            (msg_id, chunk)
            for msg_id, chunk, _carrier in await self.read_chunk_entries_blocking(
                task_id, last_id=last_id, block_ms=block_ms
            )
        ]

    async def read_chunk_entries_blocking(
        self, task_id: str, last_id: str = "0-0", block_ms: int = 5000
    ) -> list[tuple[str, StreamChunk, dict[str, str]]]:
        """Block-read chunks, returning each entry's producer trace carrier too.

        ``(msg_id, chunk, carrier)``. The carrier is ``{}`` when the producing
        side was untraced. Built from the RAW Redis fields — the generated text
        in ``data`` is never handed to a propagator.
        """
        stream_key = self._stream_key(task_id)
        result = await self._redis.xread(
            {stream_key: last_id},
            block=block_ms,
            count=100,
        )
        if not result:
            return []

        chunks: list[tuple[str, StreamChunk, dict[str, str]]] = []
        for _stream_name, entries in result:
            for msg_id, fields in entries:
                raw = fields.get(b"data") or fields.get("data")
                if raw:
                    if isinstance(raw, bytes):
                        raw = raw.decode()
                    if isinstance(msg_id, bytes):
                        msg_id = msg_id.decode()
                    chunks.append(
                        (
                            msg_id,
                            self._decode_chunk_data(raw),
                            carrier_from_redis_fields(fields),
                        )
                    )
        return chunks
