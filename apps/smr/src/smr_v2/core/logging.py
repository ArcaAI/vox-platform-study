"""Structured logging configuration using structlog."""

from __future__ import annotations

import logging
import sys

import structlog


def _add_otel_context(
    logger: object, method_name: str, event_dict: dict
) -> dict:
    """Inject OpenTelemetry trace context into every log entry.

    When OTel is not active the import succeeds but ``get_current_span()``
    returns ``INVALID_SPAN`` whose trace_id is 0 — we skip injection in
    that case so logs stay clean when tracing is disabled.
    """
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        ctx = span.get_span_context()
        if ctx and ctx.trace_id != 0:
            event_dict["traceId"] = format(ctx.trace_id, "032x")
            event_dict["spanId"] = format(ctx.span_id, "016x")
    except Exception:
        pass
    return event_dict


def setup_logging(log_level: str = "info") -> None:
    """Configure structlog with JSON output for production."""

    level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _add_otel_context,
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a bound logger instance."""
    return structlog.get_logger(name)
