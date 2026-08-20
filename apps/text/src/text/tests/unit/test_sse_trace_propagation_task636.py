"""Trace context survives Text's SSE / task-stream boundary.

THE BREAK THIS CLOSES
Text's streaming is two SEPARATE HTTP requests plus a Redis Stream between them:

    POST /api/v1/generate        -> creates a task, generation runs async
        (worker) append_chunk -> XADD text:stream:{task_id}
    GET /api/v1/tasks/{id}/stream (a DIFFERENT request, often a different
        connection) -> XREAD -> sse_starlette EventSourceResponse

`FastAPIInstrumentor` continues the trace for each of those two requests
independently. Nothing joined them, so the SSE stream a caller watches had no
relationship to the generation that produced it — the chunks arrive in a trace
of their own.

Chunks are the low-volume leg here (tokens are batched into chunks, not
per-token entries), so the carrier is injected per chunk: unlike an STT audio
frame, each chunk genuinely belongs to a distinct producing span.
"""

from __future__ import annotations

from typing import Any

import pytest
from hope_otel.trace_propagation import (
    TRACEPARENT_HEADER,
    carrier_from_redis_fields,
    extract_trace_context,
    inject_trace_carrier,
)
from opentelemetry import context as context_api
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

from text.models.stream import StreamChunk
from text.services.task_manager import TaskManager

GOLDEN_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
GOLDEN_SPAN_ID = "00f067aa0ba902b7"
GOLDEN_TRACEPARENT = f"00-{GOLDEN_TRACE_ID}-{GOLDEN_SPAN_ID}-01"


def _golden_context():
    return trace.set_span_in_context(
        NonRecordingSpan(
            SpanContext(
                trace_id=int(GOLDEN_TRACE_ID, 16),
                span_id=int(GOLDEN_SPAN_ID, 16),
                is_remote=False,
                trace_flags=TraceFlags(TraceFlags.SAMPLED),
            )
        )
    )


class _FakeRedis:
    """Records XADDs and replays them through XREAD, byte-shaped like redis.asyncio."""

    def __init__(self) -> None:
        self.writes: list[tuple[str, dict[str, Any]]] = []
        self._counter = 0

    async def xadd(self, key: str, fields: dict[str, Any], **_kwargs: Any) -> bytes:
        self.writes.append((key, fields))
        self._counter += 1
        return f"{self._counter}-0".encode()

    async def xread(self, streams: dict[str, str], **_kwargs: Any) -> Any:
        key = next(iter(streams))
        entries = []
        for index, (written_key, fields) in enumerate(self.writes, start=1):
            if written_key != key:
                continue
            wire = {
                (k.encode() if isinstance(k, str) else k): (
                    v.encode() if isinstance(v, str) else v
                )
                for k, v in fields.items()
            }
            entries.append((f"{index}-0".encode(), wire))
        return [(key.encode(), entries)] if entries else []


def _chunk(text: str = "hello") -> StreamChunk:
    return StreamChunk(type="chunk", content=text)


class TestAppendChunkInjectsProducerContext:
    @pytest.mark.asyncio
    async def test_chunk_entry_carries_the_generating_trace_context(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk())
        finally:
            context_api.detach(token)

        _key, fields = redis.writes[0]
        assert fields[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT

    @pytest.mark.asyncio
    async def test_entry_is_unchanged_when_tracing_is_off(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        await manager.append_chunk("t-1", _chunk())

        _key, fields = redis.writes[0]
        assert set(fields) == {"data"}

    @pytest.mark.asyncio
    async def test_generated_text_never_reaches_the_carrier(self) -> None:
        """PHI guard: model output is payload and stays inside `data`."""
        redis = _FakeRedis()
        manager = TaskManager(redis)

        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk("patient presented with chest pain"))
        finally:
            context_api.detach(token)

        _key, fields = redis.writes[0]
        assert fields[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT
        assert "chest pain" not in fields[TRACEPARENT_HEADER]


class TestSseReaderRecoversProducerContext:
    @pytest.mark.asyncio
    async def test_read_chunk_entries_blocking_returns_the_producer_carrier(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)

        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk())
        finally:
            context_api.detach(token)

        entries = await manager.read_chunk_entries_blocking("t-1")

        assert len(entries) == 1
        _msg_id, chunk, carrier = entries[0]
        assert chunk.content == "hello"
        assert carrier[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT

        ctx = extract_trace_context(carrier)
        assert ctx is not None
        assert format(trace.get_current_span(ctx).get_span_context().trace_id, "032x") == GOLDEN_TRACE_ID

    @pytest.mark.asyncio
    async def test_carrier_is_empty_when_the_producer_was_untraced(self) -> None:
        redis = _FakeRedis()
        manager = TaskManager(redis)
        await manager.append_chunk("t-1", _chunk())

        entries = await manager.read_chunk_entries_blocking("t-1")

        assert entries[0][2] == {}

    @pytest.mark.asyncio
    async def test_legacy_read_chunks_blocking_is_untouched(self) -> None:
        """Existing callers keep the two-tuple shape — this change is additive."""
        redis = _FakeRedis()
        manager = TaskManager(redis)

        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk())
        finally:
            context_api.detach(token)

        chunks = await manager.read_chunks_blocking("t-1")

        assert len(chunks) == 1
        msg_id, chunk = chunks[0]
        assert msg_id == "1-0"
        assert chunk.content == "hello"

    @pytest.mark.asyncio
    async def test_get_chunks_still_parses_entries_that_carry_a_traceparent(self) -> None:
        """The resume path must not choke on the added field."""
        redis = _FakeRedis()
        manager = TaskManager(redis)

        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk())
        finally:
            context_api.detach(token)

        # xrange shape, mirroring _FakeRedis.xread's byte encoding.
        async def xrange(_key: str, **_kw: Any) -> Any:
            _k, fields = redis.writes[0]
            wire = {k.encode(): v.encode() for k, v in fields.items()}
            return [(b"1-0", wire)]

        redis.xrange = xrange  # type: ignore[attr-defined]
        chunks = await manager.get_chunks("t-1")

        assert [c.content for c in chunks] == ["hello"]


class TestEndToEndTaskStreamHop:
    @pytest.mark.asyncio
    async def test_generation_context_reaches_the_sse_reader(self) -> None:
        """The whole point: two separate HTTP requests, one trace."""
        redis = _FakeRedis()
        manager = TaskManager(redis)

        # --- request 1: POST /generate, worker produces chunks ---
        token = context_api.attach(_golden_context())
        try:
            await manager.append_chunk("t-1", _chunk("a"))
            await manager.append_chunk("t-1", _chunk("b"))
        finally:
            context_api.detach(token)

        # --- request 2: GET /tasks/t-1/stream, an unrelated context ---
        assert trace.get_current_span().get_span_context().is_valid is False

        observed: list[str] = []
        for _msg_id, _chunk_obj, carrier in await manager.read_chunk_entries_blocking("t-1"):
            ctx = extract_trace_context(carrier)
            assert ctx is not None
            reader_token = context_api.attach(ctx)
            try:
                observed.append(format(trace.get_current_span().get_span_context().trace_id, "032x"))
            finally:
                context_api.detach(reader_token)

        assert observed == [GOLDEN_TRACE_ID, GOLDEN_TRACE_ID]


class TestSharedHelperMatchesTheGoldenWireFormat:
    def test_text_helper_emits_the_same_traceparent_as_stt_and_the_gateway(self) -> None:
        assert inject_trace_carrier(_golden_context()) == {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}

    def test_carrier_from_redis_fields_ignores_payload(self) -> None:
        fields = {b"data": b'{"type":"chunk"}', TRACEPARENT_HEADER.encode(): GOLDEN_TRACEPARENT.encode()}
        assert carrier_from_redis_fields(fields) == {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}
