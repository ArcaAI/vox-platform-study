"""OpenTelemetry tracing setup for Guardrail.

Guardrail — the platform's content-safety / PII / prompt-injection engine —
previously shipped with ZERO OTel code, so none of its request paths were
traceable in Tempo/Grafana. It is also the most compliance-sensitive service
in the fleet: every request carries raw clinical text on
``/api/guardrail/analyze`` and ``/api/medical/*``.

Mirrors ``apps/text/src/text/core/observability.py`` (the fleet's reference
implementation): resource attributes, ``BatchSpanProcessor`` +
``OTLPSpanExporter`` for traces, FastAPI + httpx auto-instrumentation, and a
mandatory PHI-sanitization ``server_request_hook``. The hook existing but
never being *passed* to the instrumentor was the exact defect already fixed
in NLP (``apps/nlp/src/nlp/core/observability.py``) — this module
wires it from the start so it cannot regress the same way.

Default-OFF invariant: ``setup_opentelemetry`` is only invoked by
``guardrail.main.create_app`` when BOTH ``Settings.otel_enabled`` is true AND
``Settings.otel_exporter_endpoint`` is non-empty. Every failure mode inside
this module (unreachable/misconfigured collector, instrumentation error) is
caught and logged — a reachable collector is never a boot- or request-path
dependency, so ``setup_opentelemetry`` never raises.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from guardrail.core.logging import get_logger

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = get_logger(__name__)

_TRACER_VERSION = "1.0.0"

_EXCLUDED_URLS = (
    "/api/health,"
    "/api/health/live,"
    "/api/health/ready,"
    "/api/v1/health,"
    "/api/v1/health/live,"
    "/api/v1/health/ready,"
    "/docs,"
    "/redoc,"
    "/openapi.json,"
    "/metrics"
)


def _phi_sanitization_hook(span: Any, scope: dict[str, Any]) -> None:
    """Redact potentially PHI-bearing request/response body span attributes.

    Guardrail receives raw clinical text on every content-safety/medical
    validation call. Without this hook wired into the instrumentor, FastAPI
    auto-instrumentation is free to attach request/response bodies to spans
    that land in Tempo.
    """
    if not span.is_recording():
        return
    for attr in ("http.request.body.content", "http.response.body.content"):
        if span.attributes and attr in span.attributes:
            span.set_attribute(attr, "[REDACTED]")


def setup_opentelemetry(
    app: FastAPI,
    *,
    endpoint: str,
    service_name: str = "guardrail",
    service_namespace: str = "hope",
    insecure: bool = True,
) -> None:
    """Configure OTel tracing plus FastAPI/httpx auto-instrumentation.

    Stores ``tracer_provider`` on ``app.state`` (``None`` on failure) for the
    lifespan teardown to check. Never raises — any error constructing the
    exporter/provider or instrumenting the app is caught and logged, and the
    service continues with tracing degraded to a no-op rather than failing
    startup.
    """
    app.state.tracer_provider = None
    try:
        resource = Resource.create(
            {
                "service.name": service_name,
                "service.version": _TRACER_VERSION,
                "service.namespace": service_namespace,
                "telemetry.sdk.language": "python",
            }
        )

        tracer_provider = TracerProvider(resource=resource)
        span_exporter = OTLPSpanExporter(endpoint=endpoint, insecure=insecure)
        tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))
        trace.set_tracer_provider(tracer_provider)

        FastAPIInstrumentor.instrument_app(
            app,
            excluded_urls=_EXCLUDED_URLS,
            server_request_hook=_phi_sanitization_hook,
        )
        HTTPXClientInstrumentor().instrument()

        app.state.tracer_provider = tracer_provider
        logger.info(
            "guardrail.otel_initialized",
            endpoint=endpoint,
            service_name=service_name,
        )
    except Exception as exc:  # noqa: BLE001 — a reachable collector is never a boot dependency
        logger.warning("guardrail.otel_setup_failed", error=str(exc))


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush and shut down the tracer provider, then uninstrument. Never raises."""
    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is not None:
        try:
            tracer_provider.force_flush(timeout_millis=5000)
            tracer_provider.shutdown()
        except Exception as exc:
            logger.warning("guardrail.otel_tracer_shutdown_failed", error=str(exc))

    try:
        FastAPIInstrumentor().uninstrument_app(app)
    except Exception:
        pass
    try:
        HTTPXClientInstrumentor().uninstrument()
    except Exception:
        pass

    logger.info("guardrail.otel_shutdown_complete")


def get_tracer(name: str = "guardrail") -> trace.Tracer:
    """Get a tracer instance for creating spans."""
    return trace.get_tracer(name, _TRACER_VERSION)
