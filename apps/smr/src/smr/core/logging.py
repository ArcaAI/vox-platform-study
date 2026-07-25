"""Structured logging configuration using structlog."""

from __future__ import annotations

import logging
import sys
from typing import TYPE_CHECKING, cast

import structlog

if TYPE_CHECKING:
    from structlog.typing import EventDict, WrappedLogger


def _add_otel_context(
    logger: WrappedLogger, method_name: str, event_dict: EventDict
) -> EventDict:
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


def _configure_uvicorn_logging() -> None:
    """Tame uvicorn loggers to prevent duplicate and unstructured output.

    - Disables the uvicorn access logger (our RequestLoggingMiddleware
      already emits structured JSON for every request).
    - Makes uvicorn.error propagate to root so startup/shutdown messages
      are captured by the OTel LoggingHandler.
    """
    logging.getLogger("uvicorn.access").disabled = True
    uv_error = logging.getLogger("uvicorn.error")
    uv_error.handlers = []
    uv_error.propagate = True


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

    _configure_uvicorn_logging()


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a bound logger instance."""
    return cast("structlog.stdlib.BoundLogger", structlog.get_logger(name))
