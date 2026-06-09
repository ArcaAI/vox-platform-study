"""Structured logging configuration using structlog.

Provides JSON-formatted logging for production and bridges stdlib logging
so that all log output (structlog + stdlib) flows through the same
pipeline and is parseable by Loki.

Architecture:
  1. structlog loggers → shared processor chain → JSONRenderer → stdout
  2. stdlib loggers   → ProcessorFormatter    → same chain    → stdout
  3. Both paths inject trace context via _add_otel_context when spans are active
"""

from __future__ import annotations

import logging
import sys
from typing import Any, cast

import structlog

try:
    from opentelemetry import trace
except ImportError:  # pragma: no cover
    trace = None  # type: ignore[assignment]

_SETUP_DONE = False


def _add_otel_context(
    _logger: object,
    _method_name: str,
    event_dict: dict[str, Any],
) -> dict[str, Any]:
    """Structlog processor that injects OpenTelemetry traceId/spanId."""
    try:
        if trace is None:
            return event_dict

        span = trace.get_current_span()
        if span is None:
            return event_dict

        ctx = span.get_span_context()
        if ctx is None or not ctx.is_valid:
            return event_dict

        event_dict["traceId"] = format(ctx.trace_id, "032x")
        event_dict["spanId"] = format(ctx.span_id, "016x")
    except Exception:
        pass

    return event_dict


_shared_processors: list[Any] = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_logger_name,
    structlog.stdlib.add_log_level,
    structlog.stdlib.PositionalArgumentsFormatter(),
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.StackInfoRenderer(),
    structlog.processors.format_exc_info,
    _add_otel_context,
    structlog.processors.UnicodeDecoder(),
]


def setup_logging(log_level: str = "info") -> None:
    """Configure structlog with JSON output for production.

    Must be called once at application startup — before any logger is used.
    After this call, both ``structlog.get_logger()`` and stdlib
    ``logging.getLogger()`` produce JSON lines on stdout with merged
    contextvars (request_id, trace context, etc.).
    """
    global _SETUP_DONE
    if _SETUP_DONE:
        return
    _SETUP_DONE = True

    level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            *_shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=_shared_processors,
    )

    root = logging.getLogger()
    for h in root.handlers[:]:
        root.removeHandler(h)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root.addHandler(handler)
    root.setLevel(level)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Get a bound logger instance."""
    return cast("structlog.stdlib.BoundLogger", structlog.get_logger(name))
