"""OpenTelemetry setup for STT.

Configures distributed tracing and log export with OTLP gRPC export to
the central OTel Collector. Auto-instruments FastAPI (inbound), HTTPX
(outbound), and stdlib logging so that trace context propagates across
service boundaries and all logs reach Loki via the Collector.
"""

from __future__ import annotations

import logging
import os
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


def _deployment_environment() -> str:
    """Resolve the deployment environment for the telemetry resource.

    TASK-636 OBS-18: this used to be the literal string ``"production"``,
    stamped on every span and log record wherever the service ran — including
    developer laptops. The OTel collector separately upserted ``"dev"`` over
    everything, so the two disagreed inside a single pipeline and telemetry
    outside dev was wrong from both directions.

    Precedence: ``DEPLOYMENT_ENVIRONMENT`` (what the collector and the k8s
    overlays set) then ``NODE_ENV`` (the repo-wide selector, TASK-558).

    The default is **development**, not production. An unset environment on a
    laptop tagging local traces as production is the dangerous direction: a
    mislabelled dev span is noise, a mislabelled prod span corrupts an audit
    trail.
    """
    return os.getenv("DEPLOYMENT_ENVIRONMENT") or os.getenv("NODE_ENV") or "development"


def _build_resource(service_name: str) -> Resource:
    environment = _deployment_environment()
    return Resource.create(
        {
            "service.name": service_name,
            "service.version": _TRACER_VERSION,
            "service.namespace": "hope",
            # Both spellings: `.name` is the current semantic convention, the
            # bare key is the legacy one existing queries still use.
            "deployment.environment": environment,
            "deployment.environment.name": environment,
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
