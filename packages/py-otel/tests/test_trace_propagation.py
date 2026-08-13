"""W3C trace-context propagation seam (Python side).

Mirrors ``…/observability/__tests__/trace-propagation.task636.test.ts`` under
``packages/applications/src/services/baseServices``.

The two suites share the SAME golden traceparent literal. The Python side runs
it through the REAL ``TraceContextTextMapPropagator``, so this file is what
proves the TypeScript carrier is a genuine W3C carrier and not merely
self-consistent — the gateway writes the audio/control streams, STT and SMR
read them, and a wire-format disagreement would silently sever every trace.

This is the ONE copy of these tests (previously duplicated verbatim in
``apps/stt/tests/test_trace_propagation_task636.py`` alongside the module it
tested — see ``packages/py-otel/README.md``). STT's and SMR's own test suites
still cover their service-specific glue (Redis Stream field shapes, SSE
chunk relaying) against this shared module.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from hope_otel.trace_propagation import (
    TRACEPARENT_HEADER,
    TRACESTATE_HEADER,
    carrier_from_redis_fields,
    extract_trace_context,
    has_trace_context,
    inject_trace_carrier,
)

# Golden W3C traceparent — byte-identical to the TypeScript suite's constant.
GOLDEN_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
GOLDEN_SPAN_ID = "00f067aa0ba902b7"
GOLDEN_TRACEPARENT = f"00-{GOLDEN_TRACE_ID}-{GOLDEN_SPAN_ID}-01"


def _golden_context():
    """A context holding the golden span — no SDK / exporter required."""
    span_context = SpanContext(
        trace_id=int(GOLDEN_TRACE_ID, 16),
        span_id=int(GOLDEN_SPAN_ID, 16),
        is_remote=False,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )
    return trace.set_span_in_context(NonRecordingSpan(span_context))


class TestGoldenWireFormat:
    """The cross-language contract."""

    def test_real_w3c_propagator_emits_the_golden_traceparent(self) -> None:
        carrier: dict[str, str] = {}
        TraceContextTextMapPropagator().inject(carrier, context=_golden_context())
        assert carrier[TRACEPARENT_HEADER] == GOLDEN_TRACEPARENT

    def test_helper_emits_the_same_string_as_the_typescript_side(self) -> None:
        assert inject_trace_carrier(_golden_context()) == {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}

    def test_extracts_a_carrier_produced_by_the_typescript_side(self) -> None:
        ctx = extract_trace_context({TRACEPARENT_HEADER: GOLDEN_TRACEPARENT})
        assert ctx is not None
        span_context = trace.get_current_span(ctx).get_span_context()
        assert format(span_context.trace_id, "032x") == GOLDEN_TRACE_ID
        assert format(span_context.span_id, "016x") == GOLDEN_SPAN_ID
        assert span_context.is_remote is True


class TestNoOpPosture:
    """Zero cost and zero new failure modes when tracing is off."""

    def test_inject_is_empty_when_there_is_no_active_span(self) -> None:
        assert inject_trace_carrier() == {}

    def test_extract_returns_none_for_an_empty_carrier(self) -> None:
        assert extract_trace_context({}) is None

    def test_extract_returns_none_for_a_malformed_traceparent(self) -> None:
        assert extract_trace_context({TRACEPARENT_HEADER: "nonsense"}) is None

    def test_extract_returns_none_for_an_all_zero_trace_id(self) -> None:
        zeroed = "00-" + ("0" * 32) + "-" + ("0" * 16) + "-01"
        assert extract_trace_context({TRACEPARENT_HEADER: zeroed}) is None

    def test_extract_never_raises_on_junk(self) -> None:
        for junk in (None, "", 42, [], {TRACEPARENT_HEADER: None}):
            assert extract_trace_context(junk) is None  # type: ignore[arg-type]

    def test_has_trace_context_reflects_span_validity(self) -> None:
        assert has_trace_context(_golden_context()) is True
        assert has_trace_context(trace.set_span_in_context(trace.INVALID_SPAN)) is False


class TestCarrierFromRedisFields:
    """Redis returns ``bytes`` keys and values under ``redis.asyncio``."""

    def test_reads_bytes_keys_and_values(self) -> None:
        fields = {
            b"seq": b"7",
            b"data": b"\x00\x01binary-audio",
            TRACEPARENT_HEADER.encode(): GOLDEN_TRACEPARENT.encode(),
        }
        assert carrier_from_redis_fields(fields) == {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}

    def test_reads_str_keys_and_values(self) -> None:
        fields = {"seq": "7", TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}
        assert carrier_from_redis_fields(fields) == {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT}

    def test_carries_tracestate_when_present(self) -> None:
        fields = {TRACEPARENT_HEADER: GOLDEN_TRACEPARENT, TRACESTATE_HEADER: "hope=1"}
        assert carrier_from_redis_fields(fields) == {
            TRACEPARENT_HEADER: GOLDEN_TRACEPARENT,
            TRACESTATE_HEADER: "hope=1",
        }

    def test_never_lets_a_payload_field_into_the_carrier(self) -> None:
        # `data` is raw clinical audio and `text` is a transcript: neither may
        # ever be handed to a propagator.
        fields = {
            b"text": b"patient reports chest pain",
            b"data": b"\x00\x01",
            TRACEPARENT_HEADER.encode(): GOLDEN_TRACEPARENT.encode(),
        }
        assert list(carrier_from_redis_fields(fields)) == [TRACEPARENT_HEADER]

    def test_empty_for_an_entry_with_no_trace_headers(self) -> None:
        assert carrier_from_redis_fields({b"seq": b"1"}) == {}

    def test_empty_for_none(self) -> None:
        assert carrier_from_redis_fields(None) == {}

    def test_skips_undecodable_bytes_rather_than_raising(self) -> None:
        fields = {TRACEPARENT_HEADER.encode(): b"\xff\xfe not utf8"}
        assert carrier_from_redis_fields(fields) == {}


class TestRoundTrip:
    """inject -> flat string map -> extract preserves the identifiers."""

    def test_round_trip_preserves_trace_and_span_ids(self) -> None:
        carrier = inject_trace_carrier(_golden_context())
        # Simulate the Redis hop: every value becomes bytes on the wire.
        on_the_wire = {k.encode(): v.encode() for k, v in carrier.items()}
        ctx = extract_trace_context(carrier_from_redis_fields(on_the_wire))
        assert ctx is not None
        span_context = trace.get_current_span(ctx).get_span_context()
        assert format(span_context.trace_id, "032x") == GOLDEN_TRACE_ID
        assert format(span_context.span_id, "016x") == GOLDEN_SPAN_ID
