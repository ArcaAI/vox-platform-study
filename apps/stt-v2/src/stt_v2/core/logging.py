"""Structured logging configuration using structlog.

Provides JSON-formatted logging for production and bridges stdlib logging
so that all log output (structlog + stdlib) flows through the same
pipeline and is parseable by Loki.
"""

from __future__ import annotations

import logging
import sys

import structlog


def setup_logging(log_level: str = "info") -> None:
    """Configure structlog with JSON output for production.

    Must be called once at application startup — before any logger is used.
    After this call, both ``structlog.get_logger()`` and stdlib
    ``logging.getLogger()`` produce JSON lines on stdout with merged
    contextvars (request_id, trace context, etc.).
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
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
