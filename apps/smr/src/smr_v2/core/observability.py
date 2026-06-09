"""Consolidated OpenTelemetry setup for SMR V2.

Manages traces, logs, and auto-instrumentation.  Replaces the traces-only
``telemetry.py`` module (which is kept as a compatibility shim).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from opentelemetry import trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

try:
    from opentelemetry.instrumentation.logging import LoggingInstrumentor
except ImportError:
    LoggingInstrumentor = None  # type: ignore[assignment, misc]

if TYPE_CHECKING:
    from fastapi import FastAPI

_TRACER_VERSION = "2.0.0"

_EXCLUDED_URLS = (
    "/health,"
    "/health/live,"
    "/health/ready,"
    "/api/v1/health,"
    "/api/v1/health/live,"
    "/api/v1/health/ready,"
    "/api/v1/docs,"
    "/api/v1/redoc,"
    "/api/v1/openapi.json,"
    "/metrics"
)


def _phi_sanitization_hook(span: Any, scope: dict[str, Any]) -> None:
    """Redact potentially sensitive request/response body attributes."""
    if not span.is_recording():
        return
    for attr in ("http.request.body.content", "http.response.body.content"):
        if span.attributes and attr in span.attributes:
            span.set_attribute(attr, "[REDACTED]")


def setup_opentelemetry(
    app: FastAPI,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "smr-v2",
    service_namespace: str = "hope",
    deployment_environment: str = "production",
    insecure: bool = True,
    logs_enabled: bool = True,
) -> None:
    """Configure OTel tracing, log export, and auto-instrumentation.

    Stores ``tracer_provider`` and ``logger_provider`` on ``app.state``
    for graceful shutdown in the lifespan teardown.
    """
    resource = Resource.create({
        "service.name": service_name,
        "service.version": _TRACER_VERSION,
        "service.namespace": service_namespace,
        "deployment.environment": deployment_environment,
        "telemetry.sdk.language": "python",
    })

    # --- Traces ---
    tracer_provider = TracerProvider(resource=resource)
    span_exporter = OTLPSpanExporter(endpoint=endpoint, insecure=insecure)
    tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))
    trace.set_tracer_provider(tracer_provider)
    app.state.tracer_provider = tracer_provider

    # --- Logs ---
    logger_provider = None
    if logs_enabled:
        log_exporter = OTLPLogExporter(endpoint=endpoint, insecure=insecure)
        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
        set_logger_provider(logger_provider)

        handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
        logging.getLogger().addHandler(handler)

        if LoggingInstrumentor is not None:
            LoggingInstrumentor().instrument(set_logging_format=False)
        else:
            logging.getLogger(__name__).warning(
                "OpenTelemetry logging instrumentation package not installed; continuing without LoggingInstrumentor"
            )

    app.state.logger_provider = logger_provider

    # --- Auto-instrumentation ---
    FastAPIInstrumentor.instrument_app(
        app,
        excluded_urls=_EXCLUDED_URLS,
        server_request_hook=_phi_sanitization_hook,
    )
    HTTPXClientInstrumentor().instrument()

    logging.getLogger(__name__).info(
        "OpenTelemetry initialised: traces=True logs=%s endpoint=%s service=%s",
        logs_enabled, endpoint, service_name,
    )


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush and shut down all OTel providers, then uninstrument."""
    logger = logging.getLogger(__name__)

    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is not None:
        try:
            tracer_provider.force_flush(timeout_millis=5000)
            tracer_provider.shutdown()
        except Exception as exc:
            logger.warning("otel.tracer_shutdown_failed: %s", exc)

    logger_provider = getattr(app.state, "logger_provider", None)
    if logger_provider is not None:
        try:
            logger_provider.force_flush(timeout_millis=5000)
            logger_provider.shutdown()
        except Exception as exc:
            logger.warning("otel.logger_shutdown_failed: %s", exc)

    if LoggingInstrumentor is not None:
        try:
            LoggingInstrumentor().uninstrument()
        except Exception:
            pass

    try:
        FastAPIInstrumentor().uninstrument_app(app)
    except Exception:
        pass

    logger.info("OpenTelemetry shutdown complete")


def get_tracer(name: str = "smr_v2") -> trace.Tracer:
    """Get a tracer instance for creating spans."""
    return trace.get_tracer(name, _TRACER_VERSION)
