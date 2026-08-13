"""OpenTelemetry tracing setup for harness.

Before this module, harness had NO ``TracerProvider`` anywhere: the only
``opentelemetry`` reference in the service was a comment in ``core/config.py``
explaining that none was ever constructed. ``core/logging.py``'s
``_add_otel_context`` structlog processor was consequently always reading
``INVALID_SPAN`` (trace_id 0) and never stamping a trace/span id onto a log
line.

Two processes need a provider:

* the FastAPI app (``harness/main.py``) — traces inbound HTTP requests.
* the Temporal worker (``temporal/worker.py``) — a SEPARATE process; without
  its own provider, spans created by ``temporalio.contrib.opentelemetry
  .TracingInterceptor`` (wired in ``temporal/client.py``) would resolve
  against the SDK's default no-op provider and never export.

Both call :func:`build_tracer_provider`. Default OFF: tracing
requires ``HARNESS_OTEL_ENABLED=true`` AND a configured
``HARNESS_OTEL_EXPORTER_ENDPOINT`` (``Settings.otel_tracing_enabled``), and a
collector that is unreachable or an exporter that fails to construct degrades
to no-tracing rather than blocking startup.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from harness.core.logging import get_logger

if TYPE_CHECKING:
    from fastapi import FastAPI

    from harness.core.config import Settings

logger = get_logger(__name__)

_SERVICE_VERSION = "0.1.0"

# Health/docs/metrics endpoints are noise in a trace backend — excluded the
# same way SMR excludes them (apps/smr/src/smr/core/observability.py).
_EXCLUDED_URLS = (
    "/api/v1/health,"
    "/api/v1/health/live,"
    "/api/v1/health/ready,"
    "/api/v1/docs,"
    "/api/v1/redoc,"
    "/api/v1/openapi.json,"
    "/metrics"
)


def _phi_sanitization_hook(span: Any, scope: dict[str, Any]) -> None:
    """Redact request/response body attributes on the FastAPI server span.

    A clinical-documentation service must never let a raw transcript/note
    body reach the trace backend. Mirrors
    ``apps/smr/src/smr/core/observability.py``'s hook.
    """
    if not span.is_recording():
        return
    for attr in ("http.request.body.content", "http.response.body.content"):
        if span.attributes and attr in span.attributes:
            span.set_attribute(attr, "[REDACTED]")


def build_tracer_provider(settings: Settings) -> TracerProvider | None:
    """Build the process ``TracerProvider`` and install it as the global provider.

    Returns ``None`` — never raises — when tracing is off
    (``Settings.otel_tracing_enabled`` is False, the default) or when the
    OTLP exporter cannot be constructed, so a bad/unreachable collector
    degrades to no-tracing instead of blocking startup.

    Shared by the FastAPI app (``main.py``) and the Temporal worker
    (``temporal/worker.py``): those are separate processes, so each must call
    this itself to get its own provider installed as the process-global one
    that ``opentelemetry.trace.get_tracer`` (used internally by
    ``temporalio.contrib.opentelemetry.TracingInterceptor``, wired in
    ``temporal/client.py``) resolves against.
    """
    if not settings.otel_tracing_enabled:
        logger.info("harness.otel.tracing_disabled")
        return None

    try:
        resource = Resource.create(
            {
                "service.name": settings.otel_service_name,
                "service.version": _SERVICE_VERSION,
                "service.namespace": settings.otel_service_namespace,
                "deployment.environment": settings.otel_deployment_environment,
                "telemetry.sdk.language": "python",
            }
        )
        tracer_provider = TracerProvider(resource=resource)
        span_exporter = OTLPSpanExporter(
            endpoint=settings.otel_exporter_endpoint,
            insecure=settings.otel_insecure,
        )
        tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))
        trace.set_tracer_provider(tracer_provider)
    except Exception as exc:  # noqa: BLE001 - an unreachable collector must not block startup
        logger.warning(
            "harness.otel.tracer_provider_setup_failed",
            endpoint=settings.otel_exporter_endpoint,
            error=str(exc),
        )
        return None

    logger.info(
        "harness.otel.tracer_provider_ready",
        endpoint=settings.otel_exporter_endpoint,
        service_name=settings.otel_service_name,
    )
    return tracer_provider


def setup_opentelemetry(app: FastAPI, settings: Settings) -> None:
    """Build the tracer provider and instrument the FastAPI app.

    Stores the provider (or ``None``) on ``app.state.tracer_provider`` for
    :func:`shutdown_opentelemetry` to flush on teardown. A no-op — including
    leaving ``app.state.tracer_provider`` as ``None`` — when tracing is off or
    provider construction fails.
    """
    tracer_provider = build_tracer_provider(settings)
    app.state.tracer_provider = tracer_provider
    if tracer_provider is None:
        return

    try:
        FastAPIInstrumentor.instrument_app(
            app,
            excluded_urls=_EXCLUDED_URLS,
            server_request_hook=_phi_sanitization_hook,
        )
    except Exception as exc:  # noqa: BLE001 - instrumentation must not block startup
        logger.warning("harness.otel.fastapi_instrumentation_failed", error=str(exc))


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush and shut down the tracer provider, then uninstrument FastAPI.

    Safe to call unconditionally from the lifespan teardown: no-ops when
    ``app.state.tracer_provider`` is ``None`` (tracing was off or setup failed).
    """
    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is None:
        return

    try:
        tracer_provider.force_flush(timeout_millis=5000)
        tracer_provider.shutdown()
    except Exception as exc:  # noqa: BLE001
        logger.warning("harness.otel.tracer_provider_shutdown_failed", error=str(exc))

    try:
        FastAPIInstrumentor().uninstrument_app(app)
    except Exception:  # noqa: BLE001 - best-effort cleanup
        pass

    logger.info("harness.otel.shutdown_complete")
