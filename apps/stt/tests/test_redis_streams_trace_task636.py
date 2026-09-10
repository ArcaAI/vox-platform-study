"""Trace context survives the Redis Streams boundary.

Three hops are pinned here:

* ``stt:audio:{sid}``   gateway (TS) -> :class:`IngestionConsumer`  (inbound)
* ``stt:control:{sid}`` gateway (TS) -> :class:`ControlListener`    (inbound)
* ``stt:result:{sid}``  :class:`ResultPublisher` -> gateway (TS)    (outbound)

The gateway side is simulated with the exact byte shape ``redis.asyncio``
produces, and the carriers used are the golden W3C traceparent the TypeScript
suite asserts, so "the gateway wrote it" is not an assumption.

The audio stream is the LATENCY-SENSITIVE hop (tens of frames a second), so the
consumer's contract is deliberately *capture once per session*, not
*span per frame*: the tests below assert both that the context is captured and
that no per-frame work happens once it has been.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from hope_otel.trace_propagation import TRACEPARENT_HEADER
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

from stt.streaming.redis_streams import ControlListener, IngestionConsumer, ResultPublisher
from stt.streaming.schemas import SegmentResult

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


def _audio_fields(seq: int, *, traceparent: str | None) -> dict[bytes, bytes]:
    """One ``stt:audio`` entry exactly as ``redis.asyncio`` returns it."""
    fields: dict[bytes, bytes] = {
        b"seq": str(seq).encode(),
        b"sr": b"16000",
        b"enc": b"pcm_s16le",
        b"ch": b"1",
        b"data": b"\x00\x01\x02\x03",
        b"final": b"0",
        b"ts": b"1754650000.0",
    }
    if traceparent is not None:
        fields[TRACEPARENT_HEADER.encode()] = traceparent.encode()
    return fields


# ---------------------------------------------------------------------------
# Inbound: stt:audio  (gateway -> IngestionConsumer)
# ---------------------------------------------------------------------------


class TestIngestionConsumerTraceCapture:
    @pytest.mark.asyncio
    async def test_captures_the_gateway_trace_context_from_an_audio_frame(self) -> None:
        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=_noop_frame)
        assert consumer.trace_context is None

        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent=GOLDEN_TRACEPARENT))

        ctx = consumer.trace_context
        assert ctx is not None
        span_context = trace.get_current_span(ctx).get_span_context()
        assert format(span_context.trace_id, "032x") == GOLDEN_TRACE_ID
        assert format(span_context.span_id, "016x") == GOLDEN_SPAN_ID

    @pytest.mark.asyncio
    async def test_stays_none_when_the_gateway_sent_no_trace_context(self) -> None:
        """Tracing off end-to-end must remain the previous behaviour."""
        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=_noop_frame)
        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent=None))
        assert consumer.trace_context is None

    @pytest.mark.asyncio
    async def test_captures_once_per_session_not_once_per_frame(self) -> None:
        """The hot-path contract: after frame 1 there is no extraction work.

        A streaming session pushes tens of frames a second for the length of a
        consultation. Re-deriving a context per frame would put propagator work
        on the clinical audio path for no benefit — the session's parent does
        not change mid-stream.
        """
        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=_noop_frame)
        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent=GOLDEN_TRACEPARENT))
        first = consumer.trace_context

        # A later frame carrying a DIFFERENT parent must not re-key the session.
        other = "00-" + "1" * 32 + "-" + "2" * 16 + "-01"
        await consumer._dispatch_frame("2-0", _audio_fields(2, traceparent=other))

        assert consumer.trace_context is first

    @pytest.mark.asyncio
    async def test_a_malformed_traceparent_never_breaks_frame_delivery(self) -> None:
        seen: list[int] = []

        async def on_frame(frame: Any) -> None:
            seen.append(frame.seq)

        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=on_frame)
        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent="garbage"))

        assert seen == [1]
        assert consumer.trace_context is None

    @pytest.mark.asyncio
    async def test_frame_callback_runs_under_the_captured_context(self) -> None:
        observed: list[str] = []

        async def on_frame(_frame: Any) -> None:
            span_context = trace.get_current_span().get_span_context()
            observed.append(format(span_context.trace_id, "032x"))

        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=on_frame)
        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent=GOLDEN_TRACEPARENT))

        assert observed == [GOLDEN_TRACE_ID]

    @pytest.mark.asyncio
    async def test_context_is_detached_after_the_frame(self) -> None:
        """No context leak into whatever the event loop runs next."""
        consumer = IngestionConsumer(redis=object(), session_id="s1", on_frame=_noop_frame)
        await consumer._dispatch_frame("1-0", _audio_fields(1, traceparent=GOLDEN_TRACEPARENT))
        assert trace.get_current_span().get_span_context().is_valid is False


# ---------------------------------------------------------------------------
# Inbound: stt:control  (gateway -> ControlListener)
# ---------------------------------------------------------------------------


class TestControlListenerTracePropagation:
    @pytest.mark.asyncio
    async def test_control_callback_runs_under_the_gateway_context(self) -> None:
        observed: list[str] = []

        async def on_control(_control: Any) -> None:
            span_context = trace.get_current_span().get_span_context()
            observed.append(format(span_context.trace_id, "032x"))

        listener = ControlListener(redis=object(), session_id="s1", on_control=on_control)
        fields = {
            b"action": b"finalize",
            TRACEPARENT_HEADER.encode(): GOLDEN_TRACEPARENT.encode(),
        }
        await listener._handle_entry("5-0", fields)

        assert observed == [GOLDEN_TRACE_ID]

    @pytest.mark.asyncio
    async def test_control_callback_still_runs_without_a_context(self) -> None:
        calls: list[str] = []

        async def on_control(control: Any) -> None:
            calls.append(control.action.value)

        listener = ControlListener(redis=object(), session_id="s1", on_control=on_control)
        await listener._handle_entry("5-0", {b"action": b"finalize"})

        assert calls == ["finalize"]


# ---------------------------------------------------------------------------
# Outbound: stt:result  (ResultPublisher -> gateway)
# ---------------------------------------------------------------------------


class _CapturingRedis:
    """Records every XADD field dict written to a result stream."""

    def __init__(self) -> None:
        self.writes: list[tuple[str, dict[str, Any]]] = []

    async def xadd(self, key: str, fields: dict[str, Any], **_kwargs: Any) -> bytes:
        self.writes.append((key, fields))
        return b"1-0"


class TestResultPublisherTraceInjection:
    @pytest.mark.asyncio
    async def test_publish_stamps_the_current_trace_context(self) -> None:
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        token = _attach_golden()
        try:
            await publisher.publish(SegmentResult(text="hello", is_final=True))
        finally:
            _detach(token)

        _key, fields = redis.writes[0]
        assert fields[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT

    @pytest.mark.asyncio
    async def test_publish_adds_no_field_when_tracing_is_off(self) -> None:
        """No-op: the wire is byte-identical to the previous behaviour."""
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        await publisher.publish(SegmentResult(text="hello", is_final=True))

        _key, fields = redis.writes[0]
        assert TRACEPARENT_HEADER not in fields

    @pytest.mark.asyncio
    async def test_status_and_error_entries_are_stamped_too(self) -> None:
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        token = _attach_golden()
        try:
            await publisher.publish_status("finalizing")
            await publisher.publish_error("boom")
            await publisher.publish_provider_switched(
                from_pipeline="a", to_pipeline="b", reason="auto"
            )
            # TASK-946 — the degraded status is a status entry like the others, so it
            # carries the trace context like the others.
            await publisher.publish_degraded(reason="script_mismatch", utterance_index=3)
        finally:
            _detach(token)

        assert all(f[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT for _k, f in redis.writes)
        assert len(redis.writes) == 4

    @pytest.mark.asyncio
    async def test_task946_degraded_reuses_the_status_type_and_carries_no_text(self) -> None:
        """OD-1's sibling signal. It rides the EXISTING `status` result type — the bridge
        already projects `reason` and `utterance_index` onto the client-facing status
        frame — so the caller learns the session degraded with zero protocol change, and
        the entry carries no transcript."""
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        await publisher.publish_degraded(reason="script_mismatch", utterance_index=7)

        _key, fields = redis.writes[0]
        assert fields["type"] == "status"
        assert fields["status"] == "degraded"
        assert fields["reason"] == "script_mismatch"
        assert fields["utterance_index"] == "7"
        assert set(fields) == {"type", "status", "reason", "utterance_index"}

    @pytest.mark.asyncio
    async def test_task946_degraded_omits_the_utterance_index_when_absent(self) -> None:
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        await publisher.publish_degraded(reason="script_mismatch")

        _key, fields = redis.writes[0]
        assert "utterance_index" not in fields

    @pytest.mark.asyncio
    async def test_no_transcript_text_ever_reaches_the_carrier(self) -> None:
        """PHI guard: the carrier is context, never payload."""
        redis = _CapturingRedis()
        publisher = ResultPublisher(redis, "s1", maxlen=100)

        token = _attach_golden()
        try:
            await publisher.publish(SegmentResult(text="patient reports chest pain", is_final=True))
        finally:
            _detach(token)

        _key, fields = redis.writes[0]
        assert fields[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT
        assert "chest pain" not in fields[TRACEPARENT_HEADER]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _noop_frame(_frame: Any) -> None:
    return None


def _attach_golden() -> Any:
    from opentelemetry import context as context_api

    return context_api.attach(_golden_context())


def _detach(token: Any) -> None:
    from opentelemetry import context as context_api

    context_api.detach(token)


# `asyncio` is imported for the event-loop policy pytest-asyncio installs; the
# reference keeps linters from stripping it.
assert asyncio is not None
