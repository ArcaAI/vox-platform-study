"""Structured logging for the HOPE Python services (TASK-987 R-3).

One chain, two entrances. structlog loggers and stdlib loggers both render
through the SAME processor chain to JSON on stdout, so a ``httpx``,
``uvicorn.error`` or ``transformers`` record is as queryable in Loki as a line
the service wrote itself.

That bridge is finding F-05: only one of six services had it, so in the other
five a third-party record landed as unparsed text beside the JSON. The shape
here is STT's — ``structlog.stdlib.ProcessorFormatter`` with the shared chain as
``foreign_pre_chain`` — because it was the only one that worked.

Logs leave the process on **stdout only**. Alloy tails every pod in the
namespace and writes to Loki, so an OTLP log exporter would be a second copy
with a different shape (finding F-10). There is deliberately no
``LoggerProvider`` and no ``OTLPLogExporter`` in this package; correlation
survives because ``traceId``/``spanId`` are fields on the JSON line and Grafana
joins Loki → Tempo on them.

Event names are ``<service>.<area>.<event>``: a stable snake_case literal, with
every variable as a field. ``logger.info("stt.session.started",
session=redact_id(sid), ms=12)`` — never an f-string, which turns a groupable
event into a million distinct ones.
"""

from __future__ import annotations

import logging
import sys
from typing import cast

import structlog
from opentelemetry import trace
from structlog.typing import EventDict, Processor, WrappedLogger

from hope_obs.config import ObservabilityConfig

# Guard for R-3's idempotence requirement. A second call — from a test, from a
# worker re-entry, from a service that configures logging early and then calls
# `configure_observability` — must not add a second root handler and double
# every line.
_SETUP_DONE = False

_FALLBACK_LEVEL = logging.INFO


def _add_otel_context(
    _logger: WrappedLogger, _method_name: str, event_dict: EventDict
) -> EventDict:
    """Stamp ``traceId``/``spanId`` when a span is active, nothing when not.

    Absent keys rather than ``"0"``/``None`` placeholders: a line with no trace
    id is a line that ran outside a trace, and Grafana's derived-field join
    should not be offered an id that leads nowhere.

    Never raises — a telemetry failure must not lose a log line.
    """
    try:
        span = trace.get_current_span()
        context = span.get_span_context() if span is not None else None
        if context is None or not context.is_valid:
            return event_dict
        event_dict["traceId"] = format(context.trace_id, "032x")
        event_dict["spanId"] = format(context.span_id, "016x")
    except Exception:  # noqa: S110, BLE001 - a log line is never lost to telemetry
        # Deliberately silent: logging from inside a log processor is how a
        # recursion loop starts, and a missing trace id is not worth one.
        pass
    return event_dict


def _service_stamp(service_name: str) -> Processor:
    """Every line carries ``service``; an explicit binding still wins."""

    def add_service(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
        event_dict.setdefault("service", service_name)
        return event_dict

    return add_service


def _shared_processors(service_name: str) -> list[Processor]:
    """The R-3 chain, in the order R-3 fixes it.

    Order is part of the contract: ``merge_contextvars`` first so bound request
    context is present for everything after it, ``format_exc_info`` after
    ``StackInfoRenderer``, ``JSONRenderer`` last (added by the caller, because
    the structlog and stdlib entrances terminate differently).
    """
    return [
        structlog.contextvars.merge_contextvars,
        _service_stamp(service_name),
        _add_otel_context,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]


def resolve_log_level(value: str) -> int:
    """Accept a level name (``INFO``, ``info``) or a number (``20``).

    Both spellings are in live use across the fleet's env files, and an
    unrecognised value falls back to INFO rather than raising: a typo in
    ``LOG_LEVEL`` must not stop a service from starting.
    """
    text = str(value).strip()
    if text.isdigit():
        return int(text)
    named = logging.getLevelName(text.upper())
    return named if isinstance(named, int) else _FALLBACK_LEVEL


def configure_logging(config: ObservabilityConfig) -> None:
    """Install the JSON logging chain on the root logger. Idempotent.

    Call it once at startup, before any logger is used.
    ``configure_observability`` and ``configure_worker_observability`` both call
    it, so a service that already called it directly pays nothing.
    """
    global _SETUP_DONE
    if _SETUP_DONE:
        return
    _SETUP_DONE = True

    shared = _shared_processors(config.service_name)

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
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
        # The stdlib entrance: third-party records run the same chain (F-05).
        foreign_pre_chain=shared,
    )

    root = logging.getLogger()
    for existing in root.handlers[:]:
        root.removeHandler(existing)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root.addHandler(handler)
    root.setLevel(resolve_log_level(config.log_level))

    # `AccessLogMiddleware` replaces uvicorn's access log with a structured one
    # that carries request_id/tenant_id and a latency field; leaving both on
    # would log every request twice in two different shapes.
    logging.getLogger("uvicorn.access").disabled = True

    # uvicorn installs its own handlers on `uvicorn.error` and turns off
    # propagation. Clearing them and propagating routes uvicorn's own startup,
    # shutdown and exception records through the chain above instead of out to
    # a second, unstructured stream.
    uvicorn_error = logging.getLogger("uvicorn.error")
    uvicorn_error.handlers.clear()
    uvicorn_error.propagate = True


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Return a bound logger. Safe at import time, before ``configure_logging``.

    structlog returns a lazy proxy that binds on first USE, so the usual
    module-level ``logger = get_logger(__name__)`` picks up the configuration
    installed later in ``main``.
    """
    return cast("structlog.stdlib.BoundLogger", structlog.get_logger(name))


def bind_request_context(**fields: str) -> None:
    """Bind fields onto every log line emitted in this context.

    Contextvars, so the binding follows the request through ``await`` points and
    does not leak to a concurrent one. ``RequestContextMiddleware`` binds
    ``request_id`` and ``tenant_id``; a handler may add its own, subject to the
    PHI rules — an identifier goes through ``redact_id`` first.
    """
    structlog.contextvars.bind_contextvars(**fields)


def clear_request_context() -> None:
    """Drop everything ``bind_request_context`` bound in this context."""
    structlog.contextvars.clear_contextvars()
