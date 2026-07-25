"""OpenTelemetry setup for STT.

Configures distributed tracing and log export with OTLP gRPC export to
the central OTel Collector. Auto-instruments FastAPI (inbound), HTTPX
(outbound), and stdlib logging so that trace context propagates across
service boundaries and all logs reach Loki via the Collector.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

if TYPE_CHECKING:
    from fastapi import FastAPI

_TRACER_VERSION = "2.0.0"


@dataclass
class TelemetryResult:
    """Holds references to OTel providers for lifecycle management."""

    tracer_provider: TracerProvider | None = None
    logger_provider: LoggerProvider | None = None


def _build_resource(service_name: str) -> Resource:
    return Resource.create(
        {
            "service.name": service_name,
            "service.version": _TRACER_VERSION,
            "service.namespace": "hope",
            "deployment.environment": "production",
        }
    )


def setup_telemetry_logs(
    *,
    enabled: bool = True,
    endpoint: str = "http://localhost:4317",
    service_name: str = "stt",
) -> LoggerProvider | None:
    """Set up OTel log export pipeline (usable without FastAPI, e.g. workers).

    Returns the LoggerProvider so callers can shut it down, or None if disabled.
    """
    if not enabled:
        return None

    resource = _build_resource(service_name)

    logger_provider = LoggerProvider(resource=resource)
    log_exporter = OTLPLogExporter(endpoint=endpoint, insecure=True)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

    otel_handler = LoggingHandler(
        level=logging.NOTSET,
        logger_provider=logger_provider,
    )
    logging.getLogger().addHandler(otel_handler)

    LoggingInstrumentor().instrument(set_logging_format=False)

    return logger_provider


def setup_telemetry(
    app: FastAPI,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "stt",
) -> TelemetryResult:
    """Configure OpenTelemetry tracing + log export with OTLP gRPC exporter."""
    resource = _build_resource(service_name)

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(
        app,
        excluded_urls="docs,redoc,openapi.json,metrics,health,live,ready",
    )
    HTTPXClientInstrumentor().instrument()

    logger_provider = setup_telemetry_logs(
        enabled=True,
        endpoint=endpoint,
        service_name=service_name,
    )

    return TelemetryResult(
        tracer_provider=provider,
        logger_provider=logger_provider,
    )


def get_tracer(name: str = "stt") -> trace.Tracer:
    """Get a tracer instance for creating spans.

    Returns a proxy that always resolves against the current global
    TracerProvider, so tests can swap providers without stale references.
    """
    return trace.get_tracer(name, _TRACER_VERSION)
