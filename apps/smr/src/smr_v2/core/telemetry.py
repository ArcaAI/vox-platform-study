"""OpenTelemetry setup for SMR V2."""

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
    service_name: str = "smr-v2",
    service_namespace: str = "hope",
    deployment_environment: str = "production",
    insecure: bool = True,
) -> TracerProvider:
    """Configure OpenTelemetry tracing with OTLP gRPC exporter.

    Returns the TracerProvider so callers can shut it down gracefully.
    """
    resource = Resource.create({
        "service.name": service_name,
        "service.version": _TRACER_VERSION,
        "service.namespace": service_namespace,
        "deployment.environment": deployment_environment,
    })

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, insecure=insecure)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()

    return provider


def get_tracer(name: str = "smr_v2") -> trace.Tracer:
    """Get a tracer instance for creating spans.

    Returns a proxy that always resolves against the current global
    TracerProvider, so tests can swap providers without stale references.
    """
    return trace.get_tracer(name, _TRACER_VERSION)
