"""OpenTelemetry setup for TTS (TASK-636 OBS-13).

Manages traces, logs, and FastAPI/httpx auto-instrumentation. Mirrors the
pattern in ``apps/smr/src/smr/core/observability.py`` (the reference
implementation for this fleet), with one deliberate hardening: the whole
setup is wrapped so a broken/unreachable collector degrades to no-tracing
instead of taking the process down (TASK-411 invariant — a service may
expose telemetry but must never require a reachable observability backend to
start or serve traffic).

TTS receives clinical text on every synthesis request, so the PHI
sanitisation hook is MANDATORY and is always passed to
``FastAPIInstrumentor.instrument_app`` via ``server_request_hook`` — a hook
that exists but isn't wired in is exactly the OBS-19 bug found (and fixed)
in NLP.
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

_TRACER_VERSION = "0.1.0"

# TTS's WebSocket streaming endpoint (`api/endpoints/stream_ws.py`) is
# deliberately NOT instrumented here — cross-service trace-context
# propagation over WebSocket is separate, out-of-scope work.
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
    """Redact potentially sensitive request/response body attributes.

    TTS synthesises clinical text — an unhooked instrumentor is free to
    attach request/response bodies to spans that land in the trace backend.
    """
    if not span.is_recording():
        return
    for attr in ("http.request.body.content", "http.response.body.content"):
        if span.attributes and attr in span.attributes:
            span.set_attribute(attr, "[REDACTED]")


def setup_opentelemetry(
    app: FastAPI,
    *,
    endpoint: str = "http://localhost:4317",
    service_name: str = "tts",
    service_namespace: str = "hope",
    deployment_environment: str = "production",
    insecure: bool = True,
    logs_enabled: bool = True,
) -> None:
    """Configure OTel tracing, log export, and auto-instrumentation.

    Stores ``tracer_provider`` and ``logger_provider`` on ``app.state`` for
    graceful shutdown in the lifespan teardown. Never raises: any failure
    (unreachable collector, bad endpoint, exporter construction error) is
    caught, logged, and treated as "tracing stays off" — callers (``main.py``)
    only invoke this when the master switch AND an endpoint are both set, but
    a reachable collector is still not a boot precondition.
    """
    logger = logging.getLogger(__name__)
    try:
        resource = Resource.create(
            {
                "service.name": service_name,
                "service.version": _TRACER_VERSION,
                "service.namespace": service_namespace,
                "deployment.environment": deployment_environment,
                "telemetry.sdk.language": "python",
            }
        )

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
                logger.warning(
                    "tts.otel_logging_instrumentor_missing: continuing without LoggingInstrumentor"
                )

        app.state.logger_provider = logger_provider

        # --- Auto-instrumentation ---
        FastAPIInstrumentor.instrument_app(
            app,
            excluded_urls=_EXCLUDED_URLS,
            server_request_hook=_phi_sanitization_hook,
        )
        HTTPXClientInstrumentor().instrument()

        logger.info(
            "tts.otel_initialised: traces=True logs=%s endpoint=%s service=%s",
            logs_enabled,
            endpoint,
            service_name,
        )
    except Exception as exc:  # noqa: BLE001 — degrade to no-tracing, never crash boot
        logger.warning("tts.otel_setup_failed: %s", exc)
        if not hasattr(app.state, "tracer_provider"):
            app.state.tracer_provider = None
        if not hasattr(app.state, "logger_provider"):
            app.state.logger_provider = None


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush and shut down all OTel providers, then uninstrument."""
    logger = logging.getLogger(__name__)

    tracer_provider = getattr(app.state, "tracer_provider", None)
    if tracer_provider is not None:
        try:
            tracer_provider.force_flush(timeout_millis=5000)
            tracer_provider.shutdown()
        except Exception as exc:
            logger.warning("tts.otel_tracer_shutdown_failed: %s", exc)

    logger_provider = getattr(app.state, "logger_provider", None)
    if logger_provider is not None:
        try:
            logger_provider.force_flush(timeout_millis=5000)
            logger_provider.shutdown()
        except Exception as exc:
            logger.warning("tts.otel_logger_shutdown_failed: %s", exc)

    if LoggingInstrumentor is not None:
        try:
            LoggingInstrumentor().uninstrument()
        except Exception:
            pass

    try:
        FastAPIInstrumentor().uninstrument_app(app)
    except Exception:
        pass

    logger.info("tts.otel_shutdown_complete")


def get_tracer(name: str = "tts") -> trace.Tracer:
    """Get a tracer instance for creating spans."""
    return trace.get_tracer(name, _TRACER_VERSION)
