"""OpenTelemetry setup for STT-v2.

Configures distributed tracing with OTLP gRPC export to the central
OTel Collector. Auto-instruments FastAPI (inbound) and HTTPX (outbound)
so that trace context propagates across service boundaries.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_TRACER_VERSION = "2.0.0"


def setup_telemetry(
    app,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "stt-v2",
) -> None:
    """Configure OpenTelemetry tracing with OTLP gRPC exporter."""
    resource = Resource.create(
        {
            "service.name": service_name,
            "service.version": _TRACER_VERSION,
            "service.namespace": "hope",
            "deployment.environment": "production",
        }
    )

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(
        app,
        excluded_urls="docs,redoc,openapi.json,metrics,health,live,ready",
    )
    HTTPXClientInstrumentor().instrument()


def get_tracer(name: str = "stt_v2") -> trace.Tracer:
    """Get a tracer instance for creating spans.

    Returns a proxy that always resolves against the current global
    TracerProvider, so tests can swap providers without stale references.
    """
    return trace.get_tracer(name, _TRACER_VERSION)
