"""Shared OpenTelemetry helpers for the HOPE Python services.

Currently one module: W3C trace-context propagation across the Redis-Stream
boundaries that FastAPI's own auto-instrumentation cannot see. See
``hope_otel.trace_propagation`` for the contract.
"""

from hope_otel.trace_propagation import (
    TRACEPARENT_HEADER,
    TRACESTATE_HEADER,
    carrier_from_redis_fields,
    extract_trace_context,
    has_trace_context,
    inject_trace_carrier,
)

__all__ = [
    "TRACEPARENT_HEADER",
    "TRACESTATE_HEADER",
    "carrier_from_redis_fields",
    "extract_trace_context",
    "has_trace_context",
    "inject_trace_carrier",
]
