import logging
from typing import Any

from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import (
    DEPLOYMENT_ENVIRONMENT,
    SERVICE_NAME,
    SERVICE_VERSION,
    TELEMETRY_SDK_LANGUAGE,
    Resource,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_fastapi_instrumentator import metrics as prometheus_metrics

from nlp.core.config import settings
from nlp.core.logging import get_logger

logger = get_logger("observability")


def _phi_sanitization_hook(span: trace.Span, scope: dict[str, Any]) -> None:
    """Strip attributes that could contain PHI from OTel spans."""
    if span and span.is_recording():
        for attr in ("http.request.body", "http.response.body"):
            span.set_attribute(attr, "[REDACTED]")


def _instrument_fastapi(
    app: FastAPI,
    tracer_provider: Any | None,
    excluded_urls: str = "",
) -> None:
    """Instrument the app, ALWAYS with the PHI sanitisation hook attached.

    TASK-636 OBS-19: ``_phi_sanitization_hook`` existed since this module was
    written and was never passed to the instrumentor — dead code, while SMR's
    identical hook *was* wired. NLP receives clinical text on every request, so
    an unhooked instrumentor is free to attach request/response bodies to spans
    that land in Tempo.

    There used to be TWO ``instrument_app`` call sites (provider-configured and
    fallback), which is exactly how the hook came to be missing from both. They
    are collapsed here so the two cannot drift again.
    """
    kwargs: dict[str, Any] = {
        "excluded_urls": excluded_urls,
        "server_request_hook": _phi_sanitization_hook,
    }
    if tracer_provider is not None:
        kwargs["tracer_provider"] = tracer_provider

    FastAPIInstrumentor().instrument_app(app, **kwargs)


def setup_opentelemetry(app: FastAPI) -> None:
    if not settings.service.otel_enabled:
        logger.info("OpenTelemetry disabled (NLP_OTEL_ENABLED=false)")
        return

    if not settings.service.otlp_endpoint:
        logger.warning("OTEL_EXPORTER_OTLP_ENDPOINT not set — OpenTelemetry disabled")
        return

    otlp_endpoint = settings.service.otlp_endpoint

    resource = Resource(
        attributes={
            SERVICE_NAME: settings.service.name,
            SERVICE_VERSION: settings.service.version,
            TELEMETRY_SDK_LANGUAGE: "python",
            DEPLOYMENT_ENVIRONMENT: settings.service.environment.value,
            **settings.service.resource_attributes,
        },
    )

    tracer_provider = None

    if settings.service.traces_enabled:
        tracer_provider = TracerProvider(resource=resource)
        trace.set_tracer_provider(tracer_provider)
        app.state.tracer_provider = tracer_provider

        tracer_provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True),
                max_export_batch_size=512,
                export_timeout_millis=2000,
                schedule_delay_millis=500,
            ),
        )

    if settings.service.metrics_enabled:
        metric_readers = [
            PeriodicExportingMetricReader(
                OTLPMetricExporter(endpoint=otlp_endpoint, insecure=True),
                export_interval_millis=15000,
            )
        ]
        meter_provider = MeterProvider(resource=resource, metric_readers=metric_readers)
        metrics.set_meter_provider(meter_provider)
        app.state.meter_provider = meter_provider

    log_exporter = OTLPLogExporter(endpoint=otlp_endpoint, insecure=True)
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
    set_logger_provider(logger_provider)
    app.state.logger_provider = logger_provider

    otel_log_handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
    logging.getLogger().addHandler(otel_log_handler)

    excluded_endpoints = [
        "/docs",
        "/redoc",
        "/openapi.json",
        "/metrics",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
    ]

    excluded_urls = ",".join(excluded_endpoints)

    _instrument_fastapi(app, tracer_provider, excluded_urls)

    if tracer_provider is not None:
        LoggingInstrumentor().instrument(
            set_logging_format=False,
            tracer_provider=tracer_provider,
        )
    else:
        LoggingInstrumentor().instrument(set_logging_format=False)

    logger.info(
        "OpenTelemetry initialized",
        extra={
            "otlp_endpoint": otlp_endpoint,
            "traces": settings.service.traces_enabled,
            "metrics": settings.service.metrics_enabled,
        },
    )


def shutdown_opentelemetry(app: FastAPI) -> None:
    if not (settings.service.otel_enabled and settings.service.otlp_endpoint):
        return

    if hasattr(app.state, "tracer_provider") and app.state.tracer_provider:
        app.state.tracer_provider.shutdown()
    if hasattr(app.state, "meter_provider") and app.state.meter_provider:
        app.state.meter_provider.shutdown()
    if hasattr(app.state, "logger_provider") and app.state.logger_provider:
        app.state.logger_provider.shutdown()

    try:
        LoggingInstrumentor().uninstrument()
    except Exception:
        pass
    FastAPIInstrumentor().uninstrument_app(app)


def setup_prometheus(app: FastAPI) -> None:
    """Mount ``/metrics`` and instrument HTTP requests.

    Gated on ``settings.service.metrics_enabled`` — the same switch every other
    Python service uses. It previously used the instrumentator's own
    ``should_respect_env_var``/``ENABLE_METRICS`` gate, which no environment
    ever set, so ``/metrics`` 404'd everywhere (TASK-636 OBS-02).

    HTTP series are deliberately NOT namespaced (TASK-636 OBS-03): the
    fleet-wide contract is ``http_*``, which the Prometheus relabel rule
    (``__name__ =~ "http_.*"``) and ``PlatformMetricsService``'s
    ``sum by (service) (rate(http_requests_total[5m]))`` both depend on.
    """
    if not settings.service.metrics_enabled:
        logger.info("prometheus.disabled", extra={"reason": "metrics_enabled=false"})
        return

    Instrumentator(
        should_group_status_codes=False,
        should_ignore_untemplated=True,
        should_instrument_requests_inprogress=True,
        excluded_handlers=["/metrics", "/health"],
        inprogress_name="fastapi_inprogress",
        inprogress_labels=True,
    ).add(prometheus_metrics.default(), prometheus_metrics.combined_size()).instrument(
        app=app
    ).expose(
        app=app, should_gzip=True
    )
