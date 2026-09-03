"""TaskManager — Redis-backed task state + Redis Streams as the replay buffer.

Two concerns, deliberately kept in one class because they share a key space and
a TTL:

* **Task state** — ``text:task:{id}``, the lifecycle record. Unchanged.
* **The replay buffer** — ``text:stream:{id}``, from which a reconnecting client
  resumes. restructured this half : a durable entry is now a
  **coalesced batch** of deltas rather than one entry per token, and the batch
  readers hand back the producer's already-encoded wire JSON instead of
  re-validating every delta through pydantic on the way out.

The per-chunk API (:meth:`append_chunk`, :meth:`get_chunks`,
:meth:`read_chunks_blocking`, :meth:`read_chunk_entries_blocking`) is retained
unchanged: it is how the terminal frame is written, and it is the typed view of a
stream. The batch readers below understand **both** entry shapes, so a stream
written by either path replays correctly.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
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
from text.routing.hub import GenerationEvent

logger = structlog.get_logger(__name__)

_TASK_KEY_PREFIX = "text:task:"
_STREAM_KEY_PREFIX = "text:stream:"
_CANCEL_KEY_PREFIX = "text:gen:cancel:"

#: Compact separators so a replayed delta is **byte-identical** to the one the
#: live subscriber received. ``StreamChunk.model_dump_json()`` emits no spaces;
#: matching it here is what lets AC-15 diff a resumed stream against an
#: uninterrupted one and get an exact match rather than a whitespace diff.
_COMPACT = (",", ":")

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
        # per-task chunk sequence counter, for the enveloped write's
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
        fields: dict[str, str] = {
            "data": self._encode_chunk_data(task_id, chunk, tenant_id, correlation_id)
        }
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
        """Envelope the chunk when a tenant is resolved; bare JSON otherwise.

        Additive and backward compatible : a caller with no
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
            type=f"text.stream.{chunk.type}",
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
        """Parse a stream entry's data field — enveloped or legacy bare.

        A `schemaVersion` probe distinguishes the two. An enveloped entry whose
        `schemaVersion` this reader does not understand is REFUSED, never
        best-effort parsed  — cutover of the acceptance path to
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
                raise ValueError("enveloped text stream chunk carries no inline payload")
            return StreamChunk.model_validate(envelope.payload)
        return StreamChunk.model_validate_json(raw)

    # ── The replay buffer (───────────────────────
    #
    # One entry per coalesced BATCH. Everything below is on the resume path or
    # the flush task — never between the provider and the client.

    async def append_batch(
        self,
        task_id: str,
        events: Sequence[GenerationEvent],
        *,
        tenant_id: str | None = None,
        correlation_id: str | None = None,
    ) -> str | None:
        """Write one batch of deltas as a **single** ``XADD`` (AC-5).

        The deltas are stored as their decoded dicts under a ``deltas`` key,
        alongside the batch's first sequence number. Envelope and trace-carrier
        semantics are the per-chunk path's, unchanged — they are properties of an
        *entry*, and a batch is still one entry.
        """
        if not events:
            return None

        payload = {
            "seq": events[0].seq,
            "deltas": [
                {"seq": e.seq, "event": e.event, "payload": json.loads(e.payload)} for e in events
            ],
        }
        fields: dict[str, str] = {
            "data": self._encode_batch_data(task_id, payload, tenant_id, correlation_id)
        }
        fields.update(inject_trace_carrier())
        msg_id = await self._redis.xadd(
            self._stream_key(task_id),
            fields,
            maxlen=self._stream_max_len,
        )
        return cast(str, msg_id)

    def _encode_batch_data(
        self,
        task_id: str,
        payload: dict[str, Any],
        tenant_id: str | None,
        correlation_id: str | None,
    ) -> str:
        """Envelope a batch when a tenant is resolved; bare JSON otherwise.

        Mirrors :meth:`_encode_chunk_data` exactly — the only differences are the
        event ``type`` and that the payload holds N deltas. The idempotency key
        is derived from the batch's FIRST sequence number, so a replayed batch
        converges on the same key rather than minting a new one.
        """
        if tenant_id is None:
            return json.dumps(payload, separators=_COMPACT)

        envelope = AsyncEnvelope(
            schema_version=ASYNC_ENVELOPE_SCHEMA_VERSION,
            id=str(uuid7()),
            tenant_id=tenant_id,
            type="text.stream.batch",
            occurred_at=datetime.now(UTC).isoformat(),
            correlation_id=correlation_id or task_id,
            causation_id=None,
            idempotency_key=AsyncIdempotencyKey.text_chunk(task_id, int(payload["seq"])),
            payload=payload,
        )
        return envelope.model_dump_json(by_alias=True, exclude_unset=True)

    @staticmethod
    def _decode_batch_data(raw: str) -> list[GenerationEvent]:
        """Decode one entry into its events — batch shape **or** per-chunk shape.

        No pydantic on the delta path: the stored dict is re-encoded straight
        back to the wire form the live subscriber saw. A per-chunk entry (written
        by :meth:`append_chunk`, e.g. the terminal frame) decodes to a single
        event whose sequence is unknown here — ``seq=0`` marks it, and the caller
        assigns the running cursor.
        """
        doc = json.loads(raw)
        if isinstance(doc, dict) and "schemaVersion" in doc:
            envelope = parse_async_envelope(doc)
            if envelope is None:
                raise ValueError(
                    f"unrecognized async envelope schemaVersion in stream data: {doc.get('schemaVersion')!r}"
                )
            if envelope.payload is None:
                raise ValueError("enveloped text stream entry carries no inline payload")
            doc = envelope.payload

        if isinstance(doc, dict) and "deltas" in doc:
            return [
                GenerationEvent(
                    seq=int(delta["seq"]),
                    event=str(delta["event"]),
                    payload=json.dumps(delta["payload"], separators=_COMPACT),
                )
                for delta in doc["deltas"]
            ]

        # A per-chunk entry: `{"type": ..., "content": ..., "data": ...}`.
        return [
            GenerationEvent(
                seq=0,
                event=str(doc.get("type", "chunk")),
                payload=json.dumps(doc, separators=_COMPACT),
            )
        ]

    async def read_events(self, task_id: str, after_seq: int = 0) -> list[GenerationEvent]:
        """The durable backlog after ``after_seq`` — ``XRANGE`` over whole batches.

        Reads from the start of the stream rather than from a Redis message id:
        the client's cursor is a **sequence number**, which is stable across a
        router restart, whereas a Redis id is not a thing the client should ever
        have to hold. ``MAXLEN`` bounds the scan.
        """
        entries = await self._redis.xrange(self._stream_key(task_id), min="-", max="+")
        events: list[GenerationEvent] = []
        cursor = 0
        for _msg_id, fields in entries:
            raw = fields.get(b"data") or fields.get("data")
            if not raw:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode()
            for event in self._decode_batch_data(raw):
                # A per-chunk entry carries no sequence of its own; number it
                # from the running cursor so mixed streams stay monotonic.
                seq = event.seq or cursor + 1
                cursor = max(cursor, seq)
                if seq > after_seq:
                    events.append(
                        GenerationEvent(seq=seq, event=event.event, payload=event.payload)
                    )
        return events

    async def read_events_blocking(
        self, task_id: str, last_id: str = "0-0", block_ms: int = 1000
    ) -> tuple[str, list[GenerationEvent]]:
        """``XREAD BLOCK`` over the replay buffer, decoded as :class:`GenerationEvent`.

        The batch-aware sibling of :meth:`read_chunk_entries_blocking`. That one
        decodes the **per-chunk** shape (``_decode_chunk_data``) and returns
        ``StreamChunk``s, which is the wrong shape for the coalesced batches
        :meth:`append_batch` writes — so this is a new method rather than a change
        to that one, whose two-tuple/three-tuple contracts other callers still hold.

        Returns ``(last_id, events)``. ``last_id`` is where the next call resumes;
        pass ``"0-0"`` on the first call to read the whole buffer from the start,
        which is what makes an ``XRANGE`` backlog followed by an ``XREAD`` tail
        unnecessary — one mechanism covers both, so the two cannot leave a gap
        between them.

        ``seq`` is left EXACTLY as decoded, including the ``0`` a per-chunk entry
        carries: only the caller knows the running cursor a per-chunk entry must
        be numbered from. :meth:`read_events` does that assignment for the
        ``XRANGE`` path, and the tailing caller does the identical thing.
        """
        result = await self._redis.xread(
            {self._stream_key(task_id): last_id},
            block=block_ms,
            count=100,
        )
        if not result:
            return last_id, []

        events: list[GenerationEvent] = []
        cursor = last_id
        for _stream_name, entries in result:
            for msg_id, fields in entries:
                if isinstance(msg_id, bytes):
                    msg_id = msg_id.decode()
                cursor = msg_id
                raw = fields.get(b"data") or fields.get("data")
                if not raw:
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode()
                events.extend(self._decode_batch_data(raw))
        return cursor, events

    async def stream_exists(self, task_id: str) -> bool:
        """Whether any replay buffer exists for this id.

        Distinguishes "finished a while ago, here is the backlog" from "never
        heard of it", which is the **204** in
        """
        return bool(await self._redis.exists(self._stream_key(task_id)))

    # ── Explicit cancellation ( ────────────────────────────────────
    #
    # Persisted, so a producer on another pod (or after a restart) observes it.
    # A dropped socket never writes this flag.

    def _cancel_key(self, task_id: str) -> str:
        return f"{_CANCEL_KEY_PREFIX}{task_id}"

    async def request_cancel(self, task_id: str) -> None:
        await self._redis.set(self._cancel_key(task_id), "1", ex=self._task_ttl)

    async def is_cancel_requested(self, task_id: str) -> bool:
        return bool(await self._redis.get(self._cancel_key(task_id)))

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
